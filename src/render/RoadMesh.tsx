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
 * исключён по построению, а не подобран. TubeGeometry по CatmullRomCurve3 имела
 * бы смысл, будь у рёбер промежуточные точки, но в графе их нет: ребро задано
 * парой городов, и сплайн через две точки — это отрезок.
 *
 * ПОЧЕМУ ДОРОГИ ПРЯМЫЕ. Соблазн изогнуть их процедурно (реальные трассы не
 * прямые) нужно давить: машина интерполируется по progress ЛИНЕЙНО между
 * концами ребра — так устроен VehiclePosition, — а проекция аффинна, поэтому
 * фура едет ровно по отрезку. Любой декоративный изгиб сдвинул бы дорогу
 * относительно машин, и грузовики поехали бы по полю рядом с трассой. Кривизна
 * появится тогда же, когда в данных появятся промежуточные точки ребра, — и не
 * раньше.
 *
 * Вся сеть собирается в одну геометрию на класс дороги: три вызова отрисовки
 * вместо восемнадцати, и, что важнее, число вызовов не растёт при расширении
 * графа на новые регионы.
 */

import { useMemo } from 'react'
import type { JSX } from 'react'
import { useShallow } from 'zustand/shallow'
import { useGameStore } from '../app/store'
import { cityPoint } from './CityMesh'
import { palette } from './palette'
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
 */
const ROAD_STYLE: Record<
  RoadClass,
  { width: number; color: string; elevation: number }
> = {
  федеральная: { width: 3.4, color: palette.roadFederal, elevation: 0.9 },
  региональная: { width: 2.3, color: palette.roadRegional, elevation: 0.6 },
  местная: { width: 1.4, color: palette.roadLocal, elevation: 0.3 },
}

/** Порядок отрисовки: мелкие дороги ложатся первыми, крупные поверх. */
const ROAD_CLASSES: readonly RoadClass[] = [
  'местная',
  'региональная',
  'федеральная',
]

type Segment = { ax: number; az: number; bx: number; bz: number }

/**
 * Ленты одного класса дорог, слитые в один буфер вершин.
 *
 * Индексов нет намеренно: четыре вершины на отрезок против шести — экономия в
 * треть на геометрии, которой в сцене от силы пара сотен треугольников. Прямая
 * запись читается вдвое проще, а цена нулевая.
 */
function buildRibbons(
  segments: readonly Segment[],
  width: number,
  elevation: number,
): { positions: Float32Array; normals: Float32Array } {
  const positions = new Float32Array(segments.length * 18)
  const normals = new Float32Array(segments.length * 18)
  const half = width / 2
  let offset = 0

  for (const segment of segments) {
    const dx = segment.bx - segment.ax
    const dz = segment.bz - segment.az
    const length = Math.hypot(dx, dz)
    if (length === 0) continue

    // Нормаль к отрезку в плоскости XZ — по ней лента набирает ширину.
    const nx = (-dz / length) * half
    const nz = (dx / length) * half

    // Продление концов на полуширину: без него стык двух дорог под углом даёт
    // клиновидную щель. Прячется под площадкой города, но щель видна и издали.
    const ex = (dx / length) * half
    const ez = (dz / length) * half

    const ax = segment.ax - ex
    const az = segment.az - ez
    const bx = segment.bx + ex
    const bz = segment.bz + ez

    // Обход вершин выбран так, чтобы нормаль треугольника смотрела в +Y:
    // при обратном обходе лента отбраковывается как задняя грань и исчезает.
    const quad = [
      ax - nx,
      az - nz,
      ax + nx,
      az + nz,
      bx - nx,
      bz - nz,
      bx - nx,
      bz - nz,
      ax + nx,
      az + nz,
      bx + nx,
      bz + nz,
    ]

    for (let v = 0; v < 6; v++) {
      positions[offset] = quad[v * 2]
      positions[offset + 1] = elevation
      positions[offset + 2] = quad[v * 2 + 1]
      normals[offset + 1] = 1
      offset += 3
    }
  }

  return { positions, normals }
}

export function Roads(): JSX.Element {
  // Поверхностное сравнение обязательно: реестры пересобираются каждый тик, а
  // сами города и рёбра неизменны — без него сеть перестраивалась бы по
  // несколько раз в секунду вместо одного раза за партию.
  const cities = useGameStore(useShallow((store) => store.state.world.cities))
  const edges = useGameStore(useShallow((store) => store.state.world.edges))

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

        segments.push({ ax: from.x, az: from.z, bx: to.x, bz: to.z })
      }

      return {
        roadClass,
        style,
        ribbons: buildRibbons(segments, style.width, style.elevation),
        empty: segments.length === 0,
      }
    })
  }, [cities, edges])

  return (
    <group>
      {layers.map((layer) =>
        layer.empty ? null : (
          <mesh key={layer.roadClass} receiveShadow>
            <bufferGeometry>
              <bufferAttribute
                attach="attributes-position"
                args={[layer.ribbons.positions, 3]}
              />
              <bufferAttribute
                attach="attributes-normal"
                args={[layer.ribbons.normals, 3]}
              />
            </bufferGeometry>
            {/* Тени лента принимает, но не отбрасывает: плоскость толщиной ноль
                отбрасывает только артефакты самозатенения. */}
            <meshStandardMaterial
              color={layer.style.color}
              roughness={0.95}
              metalness={0}
            />
          </mesh>
        ),
      )}
    </group>
  )
}
