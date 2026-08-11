/**
 * Дорожная сеть.
 *
 * Дороги — это половина смысла карты: по ним видно, что округ радиальный и что
 * из Рязани в Брянск нет прямого хода. Значит, они обязаны читаться как объект,
 * а не как разметка.
 *
 * ПОЧЕМУ НЕ ЛИНИИ. Линия в WebGL имеет толщину в один пиксель и не имеет её в
 * мире: при отдалении дороги остаются одинаково тонкими, при приближении —
 * одинаково тонкими же, и вся сеть выглядит проволочным каркасом. Толщина
 * должна жить в километрах, а не в пикселях, иначе масштаб карты перестаёт
 * ощущаться.
 *
 * ПОЧЕМУ ЛЕНТЫ, А НЕ TubeGeometry. Труба даёт круглое сечение, а круглое сечение
 * видно только сбоку. Камера здесь изометрическая и смотрит сверху под 35
 * градусами — с этого ракурса труба проецируется в ту же полосу, что и плоская
 * лента, но стоит в восемь-шестнадцать раз дороже по вершинам. Хуже того, нижняя
 * половина трубы уходит под подложку и пересекает её, а лента лежит в одной
 * плоскости и поднимается над рельефом ровно на заданную высоту — z-fighting
 * исключён по построению, а не подобран.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ПОЧЕМУ ОСЬ ДОРОГИ ПРЯМАЯ, А САМА ДОРОГА — БОЛЬШЕ НЕТ.
 *
 * Здесь раньше стоял запрет: гнуть дороги нельзя, потому что машина
 * интерполируется по progress ЛИНЕЙНО между концами ребра (так устроен
 * VehiclePosition), а проекция аффинна, — значит фура едет ровно по отрезку, и
 * любой декоративный изгиб увёл бы полотно из-под неё. Запрет остаётся в силе
 * целиком: промежуточных точек у ребра в графе как не было, так и нет.
 *
 * Но требование «дорога не должна быть идеально прямой линией между двумя
 * точками» относится не к ОСИ, а к ПОКРЫТИЮ, и эти две вещи разделяются
 * полностью. Ось осталась прямой до последнего знака — по ней едет машина. А
 * лента разрезана на участки (SURFACE_STEP_KM), и на каждом узле левая и правая
 * кромки набирают свою ширину НЕЗАВИСИМО друг от друга и медленно дышат вдоль
 * трассы. Асфальт перестал быть прямоугольником: где-то шире, где-то уже,
 * обочина то подходит, то отходит. Разбор чисел — в roadSurface.ts, там же
 * проверка, что сцеп ни при каком сиде не съезжает с полотна.
 *
 * КАЧЕСТВО ПОКРЫТИЯ ТЕПЕРЬ ВИДНО. У ребра есть quality 0..1 — он решает скорость
 * (world/speed.ts) и износ (logistics/wear.ts), то есть половину экономики
 * рейса, и до сих пор на карте не был показан ничем: разбитая Р-92 (0.55) и
 * свежая М-1 (0.88) выглядели одинаково. Теперь качество говорит двумя каналами
 * сразу: ТОНОМ (убитое полотно подмешивает базовый цвет рельефа и темнеет — на
 * летней земле уходит в поле, на зимнем снегу выглядит грязнее) и КРОМКОЙ (чем
 * хуже покрытие, тем сильнее её ведёт). Ни одного нового цвета при этом не
 * заводится — только смешение двух уже существующих значений палитры.
 *
 * Вся сеть по-прежнему собирается в одну геометрию на класс дороги: три вызова
 * отрисовки вместо восемнадцати, и число вызовов не растёт при расширении графа
 * на новые регионы. Дробление ленты добавляет к этому меньше тысячи
 * четырёхугольников на всю карту — меньше, чем стоит один корпус завода.
 */

import { useEffect, useMemo, useRef } from 'react'
import type { JSX } from 'react'
import { Color } from 'three'
import type { Group, Mesh, MeshStandardMaterial } from 'three'
import { useFrame } from '@react-three/fiber'
import { useShallow } from 'zustand/shallow'
import { useGameStore } from '../app/store'
import { cityPoint } from './CityMesh'
import { layers as sceneLayers } from './layers'
import { atmosphere } from './sky'
import { palette } from './palette'
import { shoulderProfile, surfaceSteps, surfaceTone } from './roadSurface'
import type { CityId, RoadClass } from '../sim/types'

/**
 * Вид дороги по классу.
 *
 * Ширина — картографическая условность, а не реальные метры: настоящая полоса в
 * 15 метров на карте шириной 600 км тоньше пикселя. Числа подобраны так, чтобы
 * классы различались с одного взгляда при полностью отдалённой камере.
 *
 * Высота над нулём тоже несёт смысл. Классы разнесены по высоте, поэтому на
 * пересечениях федеральная трасса всегда проходит поверх региональной — иначе
 * порядок отрисовки в точке пересечения зависел бы от порядка вершин в буфере и
 * менялся бы от угла камеры. Разница в километр на изометрии смещает ленту на
 * доли пикселя, то есть глазом не видна.
 *
 * КЛАСС ОСТАЁТСЯ ПЕРВИЧНЫМ ПРИЗНАКОМ, А КАЧЕСТВО — ВТОРИЧНЫМ. Ширина зависит
 * только от класса, тон — от класса и качества, но так, что лестницы не
 * пересекаются: самая убитая федеральная карты остаётся светлее самой свежей
 * региональной (проверяется в roadSurface.test.ts на фактических данных).
 */
const ROAD_STYLE: Record<
  RoadClass,
  { width: number; color: string; elevation: number }
> = {
  федеральная: { width: 3.4, color: palette.roadFederal, elevation: sceneLayers.roadFederal },
  региональная: { width: 2.3, color: palette.roadRegional, elevation: sceneLayers.roadRegional },
  местная: { width: 1.4, color: palette.roadLocal, elevation: sceneLayers.roadLocal },
}

/** Порядок отрисовки: мелкие дороги ложатся первыми, крупные поверх. */
const ROAD_CLASSES: readonly RoadClass[] = [
  'местная',
  'региональная',
  'федеральная',
]

/**
 * Ребро, разложенное во всё, что нужно ленте.
 *
 * `seed` — ключ ребра: рисунок кромки обязан быть одинаковым в этой партии, в
 * следующей и на снимке в тесте (см. shoulderProfile). `quality` решает и тон, и
 * размах кромки.
 */
type Segment = {
  ax: number
  az: number
  bx: number
  bz: number
  quality: number
  seed: string
}

type Ribbons = {
  positions: Float32Array
  normals: Float32Array
  colors: Float32Array
}

/** Многоразовый разбор шестнадцатеричного цвета: в сборке буфера аллокаций нет. */
const toneColor = new Color()

/**
 * Ленты одного класса дорог, слитые в один буфер вершин.
 *
 * Индексов нет намеренно: четыре вершины на участок против шести — экономия в
 * треть на геометрии, которой в сцене от силы пара сотен треугольников. Прямая
 * запись читается вдвое проще, а цена нулевая.
 *
 * ЦВЕТ ЛЕЖИТ В ВЕРШИНАХ, А НЕ В МАТЕРИАЛЕ, и это единственный способ показать
 * качество, не заводя по материалу на дорогу. Материал на класс остаётся один
 * (правило «один материал на класс объектов»), а разница между М-1 и Р-92
 * приезжает атрибутом. Значение кладётся в ЛИНЕЙНОМ пространстве: буферный
 * атрибут Three берёт как есть, без преобразования из sRGB, которое делает
 * `Color` при разборе строки, — отсюда `toneColor.set(...)` и чтение полей, а не
 * запись байтов руками.
 */
function buildRibbons(
  segments: readonly Segment[],
  width: number,
  elevation: number,
  baseColor: string,
): Ribbons {
  const positions: number[] = []
  const colors: number[] = []
  const half = width / 2

  for (const segment of segments) {
    const dx = segment.bx - segment.ax
    const dz = segment.bz - segment.az
    const length = Math.hypot(dx, dz)
    if (length === 0) continue

    const ux = dx / length
    const uz = dz / length

    // Нормаль к отрезку в плоскости XZ — по ней лента набирает ширину.
    const nx = -uz
    const nz = ux

    const steps = surfaceSteps(length)
    const profile = shoulderProfile(segment.seed, steps + 1, segment.quality)

    toneColor.set(surfaceTone(baseColor, segment.quality))
    const cr = toneColor.r
    const cg = toneColor.g
    const cb = toneColor.b

    for (let i = 0; i < steps; i++) {
      /*
       * Продление концов на полуширину: без него стык двух дорог под углом даёт
       * клиновидную щель. Прячется под площадкой города, но щель видна и издали.
       * Продлевается только КРАЙНИЙ участок — внутренние стыки лежат на одной
       * прямой и щели не дают, а продлённые внутренние участки наезжали бы друг
       * на друга и давали бы двойную яркость на прозрачных материалах.
       */
      const from = i === 0 ? -half : (i / steps) * length
      const to = i === steps - 1 ? length + half : ((i + 1) / steps) * length

      const ax = segment.ax + ux * from
      const az = segment.az + uz * from
      const bx = segment.ax + ux * to
      const bz = segment.az + uz * to

      const aLeft = half * profile.left[i]
      const aRight = half * profile.right[i]
      const bLeft = half * profile.left[i + 1]
      const bRight = half * profile.right[i + 1]

      // Обход вершин выбран так, чтобы нормаль треугольника смотрела в +Y:
      // при обратном обходе лента отбраковывается как задняя грань и исчезает.
      const quad = [
        ax - nx * aRight, az - nz * aRight,
        ax + nx * aLeft, az + nz * aLeft,
        bx - nx * bRight, bz - nz * bRight,
        bx - nx * bRight, bz - nz * bRight,
        ax + nx * aLeft, az + nz * aLeft,
        bx + nx * bLeft, bz + nz * bLeft,
      ]

      for (let v = 0; v < 6; v++) {
        positions.push(quad[v * 2], elevation, quad[v * 2 + 1])
        colors.push(cr, cg, cb)
      }
    }
  }

  // Нормали у плоской ленты одинаковы во всех вершинах и считать их незачем.
  const normals = new Float32Array(positions.length)
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1

  return {
    positions: new Float32Array(positions),
    normals,
    colors: new Float32Array(colors),
  }
}

export function Roads(): JSX.Element {
  /*
   * ПОДПИСКА НА СПИСОК ИДЕНТИФИКАТОРОВ, А НЕ НА ОБЪЕКТЫ.
   *
   * Здесь стояло поверхностное сравнение по самим объектам City и Edge с
   * пояснением «сами города и рёбра неизменны». Про рёбра это правда и сейчас,
   * а вот города МЕНЯЮТСЯ каждый тик: население дрейфует у всех пятидесяти трёх
   * (рост и сжатие в economy/consumption.ts). Поверхностное сравнение видело
   * новые объекты и пересобирало ВСЮ дорожную сеть страны по несколько раз в
   * секунду — 294 буфера вершин за десять секунд по замеру, — выдавая при этом
   * бит в бит ту же геометрию: дороге от города нужны только координаты, а они
   * не меняются никогда.
   *
   * Ключ — только идентификаторы. Население в него не входит СОЗНАТЕЛЬНО: оно
   * на форму дороги не влияет.
   */
  const roster = useGameStore((store) =>
    Object.keys(store.state.world.cities).join('|'),
  )
  const edgeRoster = useGameStore((store) =>
    Object.keys(store.state.world.edges).join('|'),
  )
  const cities = useGameStore.getState().state.world.cities
  const edges = useGameStore.getState().state.world.edges

  const layers = useMemo(() => {
    const points = new Map<CityId, { x: number; z: number }>()
    for (const city of Object.values(cities)) {
      points.set(city.id, cityPoint(city))
    }

    return ROAD_CLASSES.map((roadClass) => {
      const style = ROAD_STYLE[roadClass]
      const segments: Segment[] = []

      for (const edge of Object.values(edges)) {
        if (edge.class !== roadClass) continue

        const from = points.get(edge.from)
        const to = points.get(edge.to)
        // Ребро в никуда — это ошибка в данных, но падать из-за неё рендер не
        // должен: остальная карта важнее одной дороги.
        if (!from || !to) continue

        segments.push({
          ax: from.x,
          az: from.z,
          bx: to.x,
          bz: to.z,
          quality: edge.quality,
          seed: edge.id,
        })
      }

      return {
        roadClass,
        ribbons: buildRibbons(segments, style.width, style.elevation, style.color),
        empty: segments.length === 0,
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roster, edgeRoster])

  const groupRef = useRef<Group>(null)

  /**
   * Дев-хук: что НА САМОМ ДЕЛЕ лежит в буферах дорог.
   *
   * Спрашивается у живой геометрии, а не у построения, и это принципиально — тот
   * же довод, что у __plechoRigs в VehicleMesh. Посчитать участки и тона и не
   * донести их до атрибута — ровно тот дефект, ради которого сквозные тесты в
   * этом проекте вообще пишутся, и проверка «по состоянию» его бы не заметила.
   *
   * ЧТО ОТСЮДА МОЖНО ДОКАЗАТЬ:
   *   • лента РАЗРЕЗАНА — четырёхугольников на класс столько, сколько даёт
   *     surfaceSteps по фактическим километрам рёбер, а не по одному на ребро;
   *   • КАЧЕСТВО ВИДНО — разных тонов в буфере ровно столько, сколько разных
   *     значений quality у рёбер класса, и разброс яркости ненулевой;
   *   • ЛЕСТНИЦА КЛАССОВ ЦЕЛА — самая тусклая федеральная светлее самой яркой
   *     региональной, и проверено это на числах со сцены, а не на палитре.
   *
   * В продакшен-сборке ветка вырезается целиком: import.meta.env.DEV — константа
   * этапа сборки.
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return

    const dev = globalThis as unknown as { __plechoRoads?: unknown }

    dev.__plechoRoads = () => {
      const group = groupRef.current
      if (group === null) return []

      return group.children.map((child) => {
        const mesh = child as Mesh
        const position = mesh.geometry.getAttribute('position')
        const color = mesh.geometry.getAttribute('color')

        const tones = new Set<string>()
        let dimmest = Number.POSITIVE_INFINITY
        let brightest = Number.NEGATIVE_INFINITY

        for (let i = 0; i < color.count; i++) {
          const r = color.getX(i)
          const g = color.getY(i)
          const b = color.getZ(i)
          tones.add(`${r.toFixed(5)}|${g.toFixed(5)}|${b.toFixed(5)}`)

          const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
          if (luminance < dimmest) dimmest = luminance
          if (luminance > brightest) brightest = luminance
        }

        return {
          roadClass: mesh.name,
          vertices: position.count,
          quads: position.count / 6,
          tones: tones.size,
          dimmest,
          brightest,
        }
      })
    }

    return () => {
      delete dev.__plechoRoads
    }
  }, [])

  /*
   * ЗИМОЙ ПОЛОТНО УХОДИТ В ТЁМНОЕ, И ЭТО НЕ ВКУСОВЩИНА, А ЧИТАЕМОСТЬ.
   *
   * Земля меняет цвет по сезону (seasonGround в palette.ts): зимой она белеет
   * до #4d5a68. Полотно федеральной трассы — #4d5a6b. Это ОДИН И ТОТ ЖЕ ЦВЕТ с
   * точностью до последнего разряда, и зимой дорожная сеть с карты исчезала
   * целиком: замер медианного отклика ленты дал 0.03 из 255 при уровне
   * плёночного зерна 3, то есть дорога была ровно вшестеро слабее шума. А
   * партия начинается 1 января.
   *
   * Лечится множителем материала, а не пересборкой вершин: вершинный буфер
   * хранит класс и качество дороги (разбор — в roadSurface.ts), трогать его
   * ради сезона значило бы перезаливать полмегабайта на каждую смену погоды.
   * Множитель применяется в кадре, к тем же материалам, что уже созданы.
   *
   * Землю светлее делать нельзя: снежная пелена и так поднимает её медиану, и
   * у части точек полярность уже перевёрнута — дорога светлее фона там, где
   * должна быть темнее.
   */
  const materials = useRef<MeshStandardMaterial[]>([])

  useFrame(() => {
    const winter = atmosphere.winter
    // Зимой втрое темнее, летом без изменений. Единица — это «как в палитре».
    const tint = 1 - 0.62 * winter
    for (const material of materials.current) {
      material.color.setRGB(tint, tint, tint)
    }
  })

  return (
    <group ref={groupRef}>
      {layers.map((layer) =>
        layer.empty ? null : (
          <mesh key={layer.roadClass} name={layer.roadClass} receiveShadow>
            <bufferGeometry>
              <bufferAttribute
                attach="attributes-position"
                args={[layer.ribbons.positions, 3]}
              />
              <bufferAttribute
                attach="attributes-normal"
                args={[layer.ribbons.normals, 3]}
              />
              <bufferAttribute
                attach="attributes-color"
                args={[layer.ribbons.colors, 3]}
              />
            </bufferGeometry>
            {/* Тени лента принимает, но не отбрасывает: плоскость толщиной ноль
                отбрасывает только артефакты самозатенения.

                Тон приходит из ВЕРШИН (см. buildRibbons), а цвет материала —
                общий множитель поверх него. Он и ведёт сезон: зимой полотно
                уходит в тёмное. Разбор — у SEASON_TINT. */}
            <meshStandardMaterial
              ref={(material) => {
                if (material !== null) materials.current.push(material)
              }}
              vertexColors
              roughness={0.95}
              metalness={0}
            />
          </mesh>
        ),
      )}
    </group>
  )
}
