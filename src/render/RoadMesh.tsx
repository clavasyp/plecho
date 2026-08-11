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
import { useGameStore } from '../app/store'
import { cityPoint } from './CityMesh'
import { layers as sceneLayers } from './layers'
import { atmosphere } from './sky'
import { palette } from './palette'
import { shoulderProfile, surfaceSteps, surfaceTone } from './roadSurface'
import {
  attachPixelFloor,
  PIXEL_FLOOR,
  WIDEN_ATTRIBUTE,
} from './pixelFloor'
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
  { width: number; color: string; elevation: number; floorPx: number }
> = {
  федеральная: {
    width: 3.4,
    color: palette.roadFederal,
    elevation: sceneLayers.roadFederal,
    floorPx: PIXEL_FLOOR.roadFederal,
  },
  региональная: {
    width: 2.3,
    color: palette.roadRegional,
    elevation: sceneLayers.roadRegional,
    floorPx: PIXEL_FLOOR.roadRegional,
  },
  местная: {
    width: 1.4,
    color: palette.roadLocal,
    elevation: sceneLayers.roadLocal,
    floorPx: PIXEL_FLOOR.roadLocal,
  },
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
  /** Смещение вершины от оси ленты — им живёт пиксельный пол, см. pixelFloor.ts. */
  widen: Float32Array
}

/** Многоразовый разбор шестнадцатеричного цвета: в сборке буфера аллокаций нет. */
const toneColor = new Color()

/**
 * Во сколько раз полотно темнее земли. Держится весь год.
 *
 * Половина. Ниже — полотно проваливается в чёрное на и без того тёмной летней
 * земле; выше — отрыв становится меньше разброса плёночного зерна на снегу.
 * Число задаёт ОТНОСИТЕЛЬНЫЙ контраст, поэтому одно и то же значение работает
 * и на зимней земле яркостью 0.099, и на летней 0.022.
 */
const ROAD_OF_GROUND = 0.5

/** Яркость по Rec.709 — та же формула, что у дев-хуков и у прибора в Scene. */
function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * sRGB 0…1 → линейное.
 *
 * Нужно потому, что цвета в этом проекте живут в ДВУХ пространствах, и путать
 * их нельзя. Палитра и буфер атмосферы — строки и числа в sRGB; вершинный цвет
 * ленты и множитель материала three применяет в ЛИНЕЙНОМ. Сравнивать яркость
 * земли с яркостью полотна можно только приведя обе к одному, и приводить надо
 * к линейному: именно в нём происходит умножение.
 */
function toLinear(channel: number): number {
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4
}

/**
 * Линейная яркость федерального полотна — знаменатель множителя.
 *
 * Считается ОДИН раз и по федеральной, а не по каждому классу отдельно. Если
 * нормировать каждый класс на свою яркость, все три получат одинаковую
 * итоговую — и лестница классов, ради которой ширина и тон вообще
 * различаются, схлопнется. Общий множитель двигает всю лестницу целиком.
 *
 * `Color.set(строка)` переводит sRGB в линейное сам (управление цветом в three
 * включено по умолчанию), поэтому дополнительного преобразования тут нет.
 */
const FEDERAL_LUMINANCE = (() => {
  const base = new Color(palette.roadFederal)
  return luminance(base.r, base.g, base.b)
})()

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
  // Смещение копится В ТОМ ЖЕ ЦИКЛЕ, что и позиция, и из тех же слагаемых.
  // Разнести их по двум проходам значило бы завести два описания одной вершины,
  // которые разъедутся при первой же правке формы кромки.
  const widen: number[] = []
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

      // Ровно те же слагаемые, что и в quad, но без точки на оси: это и есть
      // «на сколько вершина отъехала вбок». Знак сохраняется — по нему шейдер
      // раздвигает кромки в РАЗНЫЕ стороны, а не сдвигает ленту целиком.
      const offsets = [
        -nx * aRight, -nz * aRight,
        nx * aLeft, nz * aLeft,
        -nx * bRight, -nz * bRight,
        -nx * bRight, -nz * bRight,
        nx * aLeft, nz * aLeft,
        nx * bLeft, nz * bLeft,
      ]

      for (let v = 0; v < 6; v++) {
        positions.push(quad[v * 2], elevation, quad[v * 2 + 1])
        colors.push(cr, cg, cb)
        widen.push(offsets[v * 2], 0, offsets[v * 2 + 1])
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
    widen: new Float32Array(widen),
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
        floorPx: style.floorPx,
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
          /*
           * СЕЗОННЫЙ МНОЖИТЕЛЬ, СНЯТЫЙ С ЖИВОГО МАТЕРИАЛА.
           *
           * Он тут не для полноты картины. Множитель ставится в кадре, по
           * списку материалов, собранному через ref, — а такой список умеет
           * оказаться пустым, и тогда зимнее затемнение просто не происходит,
           * не давая ни ошибки, ни предупреждения. Ровно этим и объясняется
           * замер, ради которого поле заведено: контраст полотна на снегу
           * 0.0006 при летних 0.11, то есть зимой дороги на карте нет.
           */
          tint: (mesh.material as MeshStandardMaterial).color.r,
          /** Есть ли у геометрии смещение, без которого пиксельный пол мёртв. */
          widened: mesh.geometry.getAttribute(WIDEN_ATTRIBUTE) !== undefined,
        }
      })
    }

    return () => {
      delete dev.__plechoRoads
    }
  }, [])

  /*
   * ПОЛОТНО ДЕРЖИТСЯ ТЕМНЕЕ ЗЕМЛИ ВЕСЬ ГОД, И ЭТО НЕ ВКУСОВЩИНА, А ЕДИНСТВЕННЫЙ
   * СПОСОБ НЕ ПОТЕРЯТЬ СЕТЬ.
   *
   * ЧТО БЫЛО. Здесь стоял сезонный множитель `1 − 0.62·зима`: зимой полотно
   * уводилось в тёмное, летом оставалось как в палитре. Довод был верный —
   * зимняя земля #4d5a68 и федеральная трасса #4d5a6b это один цвет с точностью
   * до разряда, — а лечение оказалось хуже болезни, и вот почему.
   *
   * Земля за год ходит по ЛИНЕЙНОЙ яркости от 0.022 (лето) до 0.099 (зима), а
   * федеральное полотно стоит на 0.0995 — ровно у верхнего края этого размаха.
   * Значит множитель, который весной возвращается от 0.42 к единице,
   * ОБЯЗАТЕЛЬНО проводит полотно СКВОЗЬ яркость земли. Замер понедельно на
   * ребре Орёл — Курск: контраст 0.06–0.09 летом и 0.005–0.015 на 42–56-е
   * сутки, при уровне плёночного зерна 0.012. То есть в конце зимы дорога
   * слабее шума, и сеть с карты исчезает — не из-за погоды (снежная пелена
   * лежит на layers.ground и до полотна не доходит), а из-за арифметики.
   *
   * ЧТО ТЕПЕРЬ. Множитель считается ОТ ЗЕМЛИ: полотно всегда держится на
   * ROAD_OF_GROUND от её яркости. Пересечения не бывает по построению — ни в
   * какой сезон, ни при какой погоде, ни при какой будущей правке палитры.
   * Тон при этом остаётся тоном полотна: множитель общий на все три класса и
   * считается по федеральной, поэтому лестница «федеральная светлее
   * региональной светлее местной» цела, а качество покрытия по-прежнему
   * приезжает вершинным цветом.
   *
   * ПОЧЕМУ ТЕМНЕЕ, А НЕ СВЕТЛЕЕ. «Всегда светлее земли» на зимнем снегу
   * потребовало бы яркости выше порога блума (0.55 в postFx) — полотно начало
   * бы светиться и отобрало бы у тёплого акцента его единственное право
   * (замок §15). Темнее — свободное направление в обе стороны.
   *
   * ЦЕНА РЕШЕНИЯ ЧЕСТНАЯ: три тёмных сезона палитры (весна, лето, осень) сами
   * почти чёрные, и полотно вдвое темнее них видно хуже, чем сегодня. Это
   * вопрос к seasonGround, а не к этому файлу, и он поднят отдельно.
   *
   * Множитель применяется в кадре, к уже созданным материалам, а не
   * пересборкой вершин: вершинный буфер хранит класс и качество дороги, и
   * трогать его ради сезона значило бы перезаливать полмегабайта на каждую
   * смену погоды.
   */
  /*
   * МНОЖЕСТВО, А НЕ МАССИВ, и это не вкусовщина.
   *
   * Здесь стоял массив, в который ref дописывал материал. Стрелка в ref — новая
   * функция на каждой перерисовке, а React на смену функции сначала отцепляет
   * старую, потом цепляет новую; отцепление в массив ничего не возвращало, и
   * список рос на три материала за перерисовку НАВСЕГДА. Сезонный множитель
   * после этого выставлялся одному и тому же материалу десятки раз за кадр, а
   * ссылки на выброшенные материалы держали их в памяти.
   *
   * Множество плюс функция очистки из ref (React 19) закрывают обе беды разом:
   * повторная запись ничего не добавляет, а отцепленный материал уходит сам.
   */
  const materials = useRef<Set<MeshStandardMaterial>>(new Set())

  useFrame(() => {
    const ground = luminance(
      toLinear(atmosphere.ground.r),
      toLinear(atmosphere.ground.g),
      toLinear(atmosphere.ground.b),
    )
    // Множитель не поднимается выше единицы: палитра задаёт ВЕРХНЮЮ границу
    // тона полотна, и превышать её — значит рисовать дорогу цветом, которого в
    // палитре нет. На тёмной летней земле это и делает полотно тусклее, чем
    // хотелось бы, — цена, записанная в разборе выше.
    const tint = Math.min(1, (ground * ROAD_OF_GROUND) / FEDERAL_LUMINANCE)
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
              {/* Смещение от оси ленты. Без него пиксельный пол не сработает
                  МОЛЧА: драйвер подставит нули, и каждая вершина решит, что она
                  и так лежит на оси. Разбор — в pixelFloor.ts. */}
              <bufferAttribute
                attach={`attributes-${WIDEN_ATTRIBUTE}`}
                args={[layer.ribbons.widen, 3]}
              />
            </bufferGeometry>
            {/* Тени лента принимает, но не отбрасывает: плоскость толщиной ноль
                отбрасывает только артефакты самозатенения.

                Тон приходит из ВЕРШИН (см. buildRibbons), а цвет материала —
                общий множитель поверх него. Он и ведёт сезон: зимой полотно
                уходит в тёмное. Разбор — у SEASON_TINT. */}
            <meshStandardMaterial
              ref={(material) => {
                if (material === null) return
                // Пол вешается здесь, а не в свойствах: он правит программу
                // материала, а не его поля, и ставится ровно один раз на
                // созданный материал.
                attachPixelFloor(material, layer.floorPx)
                materials.current.add(material)
                return () => {
                  materials.current.delete(material)
                }
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
