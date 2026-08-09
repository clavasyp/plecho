/**
 * Линии игрока на карте.
 *
 * Линия — замкнутое кольцо остановок, но игрок задаёт только ГОРОДА, а едет
 * машина по ДОРОГАМ. Между «Москва → Смоленск» в списке остановок и реальным
 * ходом по М-1 лежит поиск пути, и разница видна не всегда: кольцо, которое на
 * бумаге выглядит компактным, может идти через полкарты. Поэтому линия рисуется
 * по фактическому маршруту, ребро за ребром, тем же findRoute, каким её ведёт
 * диспетчер (src/sim/logistics/line.ts). Иначе карта показывала бы замысел, а
 * счёт за топливо приходил бы за исполнение.
 *
 * ─── ГЛАВНОЕ РЕШЕНИЕ ФАЙЛА: ЧЕМ ЛИНИИ ОТЛИЧАЮТСЯ ДРУГ ОТ ДРУГА ──────────────
 *
 * Обычный ответ — цвет: метро всего мира так и устроено. Здесь он запрещён, и
 * запрет не каприз: в palette.ts тёплый цвет ровно один и означает он «сюда
 * смотри». Раздай линиям красный, синий и зелёный — и карта, где до сих пор
 * светилась только техника, превратится в схему из методички. Значит, различать
 * надо чем-то, кроме тона.
 *
 * Взяты ДВА независимых канала, оба геометрические:
 *
 *   ПОЛОСА. Линия идёт не по оси дороги, а со смещением вбок на свою полосу —
 *   как параллельные маршруты на транспортной схеме. Это не украшение, а
 *   единственный способ увидеть, что по М-2 идут ТРИ кольца, а не одно: лежащие
 *   в одной точке ленты неразличимы в принципе, сколько их ни раскрашивай.
 *   Полоса у линии одна на всю карту, поэтому кольцо опознаётся по положению в
 *   пучке, а не только по форме.
 *
 *   ФАЗА ШТРИХА. Линия штриховая, и штрихи разных линий сдвинуты по фазе. Канал
 *   работает там, где кончаются полосы: при четвёртой линии полосы идут по
 *   второму кругу, и совпавшие по полосе кольца расходятся штрихом. Полос три и
 *   фаз три — девять различимых видов, дальше рисунок повторяется. Это предел
 *   честности приёма, и он записан здесь, а не выясняется на карте.
 *
 * Штрих несёт и второй смысл: он КЛИНОВИДНЫЙ, широким концом вперёд по ходу
 * кольца. Направление обхода — не мелочь (кольцо «Москва → Тула → Калуга» и то
 * же кольцо наоборот грузятся совершенно по-разному), а стрелок на карте нет и
 * заводить их незачем: сужающийся хвост читается как стрелка на любом зуме и
 * при этом остаётся штрихом, когда карта отдалена.
 *
 * ВЫБРАННАЯ ЛИНИЯ забирает акцент — единственный тёплый цвет палитры — и
 * становится СПЛОШНОЙ и вдвое шире. Три признака сразу, потому что один здесь не
 * работает: на общем плане кольцо занимает считаные пиксели, и «чуть ярче» на
 * нём не читается. Тёплый цвет линии не спорит с машинами: у машин он ещё и
 * светящийся (emissiveIntensity в VehicleMesh), они остаются самыми яркими
 * телами сцены. Замок цел — тёплое по-прежнему означает «сюда смотри», и теперь
 * это работает для линии, с которой игрок прямо сейчас работает.
 *
 * ЧУЖИЕ ЛИНИИ НЕ РИСУЮТСЯ ВОВСЕ. Сеть конкурента — это его коммерческая тайна и
 * содержание разведки среза 5, а не бесплатная подсказка на общей карте.
 *
 * ГЕОМЕТРИЯ. Все невыбранные линии сливаются в ОДИН буфер вершин, выбранная — во
 * второй: два вызова отрисовки на любое число линий. Инстансинг здесь не
 * подходит — у штрихов разная длина и разная ширина концов, то есть разная
 * форма, а не разное положение одной формы.
 */

import { useMemo } from 'react'
import type { JSX } from 'react'
import { useShallow } from 'zustand/shallow'

import { useGameStore } from '../app/store'
import { ringOrder } from '../ui/lineEconomy'
import { useLineSelection } from '../ui/lineSelection'
import { MIN_LINE_STOPS } from '../sim/logistics/line'
import { STARTER_CRUISE_KMH } from '../sim/state'
import type { City, CityId, Edge, EdgeId, Line, LineId } from '../sim/types'
import type { RoadGraph } from '../sim/world/graph'
import { buildGraph } from '../sim/world/graph'
import { findRoute } from '../sim/world/pathfind'
import { cityPoint } from './CityMesh'
import { layers } from './layers'
import { palette } from './palette'

// ─── Размеры, километры ────────────────────────────────────────────────────
// Все величины — в километрах сцены, как дороги в RoadMesh. Ориентиры для
// подгонки: федеральная трасса шириной 3.4, сцеп машины длиной 9, карта
// примерно 600 в поперечнике.

/**
 * Сколько полос в пучке.
 *
 * Три, а не шесть. Пучок обязан помещаться в ширину трассы, вокруг которой он
 * идёт: шесть полос дали бы коридор шире федеральной дороги втрое, и линии
 * читались бы как что-то, лежащее РЯДОМ с дорогой, а не на ней. Линий больше
 * трёх различает фаза штриха.
 */
const SLOT_COUNT = 3

/** Расстояние между осями соседних полос. */
const SLOT_STEP_KM = 1.5

/** Сколько различимых фаз штриха. Вместе с полосами даёт 9 видов линий. */
const PHASE_COUNT = 3

/**
 * Шаг штриховки и длина штриха.
 *
 * Период сопоставим с длиной машины (9 км): на рабочем зуме штрих и фура одного
 * порядка, поэтому линия читается как «путь машины», а не как заборчик. При
 * полностью отдалённой камере (около 0.75 км на пиксель) штрих занимает
 * десяток пикселей — ещё различим, уже не рябит.
 */
const DASH_PERIOD_KM = 15
const DASH_LENGTH_KM = 8.5

/** Обрезок короче этого не рисуем: он вырождается в невидимую полоску. */
const MIN_DASH_KM = 0.35

/**
 * Во сколько раз хвост штриха уже головы.
 *
 * Треть — на грани заметности при беглом взгляде и очевидна, стоит присмотреться.
 * Клин острее выглядел бы иглой и терял бы в толщине там, где линию и надо
 * читать; тупее — перестал бы указывать направление.
 */
const DASH_TAIL_SCALE = 0.34

/** Полуширина ленты: обычной и выбранной. */
const LINE_HALF_KM = 0.85
const SELECTED_HALF_KM = 1.6

/** Порог, ниже которого отрезок считается вырожденным. */
const EPSILON_KM = 1e-6

// ─── Кольцо в координатах сцены ────────────────────────────────────────────

type Point = { x: number; z: number }

/**
 * Линия, разобранная в ломаную по дорогам.
 *
 * Полоса и фаза считаются здесь же и от ПОРЯДКА линии в списке компании:
 * порядок этот стабилен (ключи объекта идут в порядке вставки, а nextLineId в
 * store.ts никогда не переиспользует номера), поэтому линия не меняет свой вид
 * при создании соседней. Привязать полосу к идентификатору хешем было бы
 * заманчиво, но тогда две первые линии игрока с изрядной вероятностью получили
 * бы одну полосу — а первые линии как раз и должны различаться безусловно.
 */
type Ring = {
  id: LineId
  /** Замкнутая ломаная по дорогам. Меньше двух точек — рисовать нечего. */
  points: Point[]
  /** Смещение вбок от оси дороги, км. */
  offsetKm: number
  /** Сдвиг штриховки вдоль кольца, км. */
  phaseKm: number
}

/**
 * Города кольца в том порядке, в котором их РЕАЛЬНО объезжает машина.
 *
 * Порядок остановок берётся у ringOrder (ui/lineEconomy.ts) — той же функции, по
 * которой панель компании считает экономику круга. Двух ответов на вопрос «по
 * каким плечам идёт кольцо» быть не должно: разойдясь, они дали бы карту, на
 * которой нарисовано одно, и отчёт, в котором посчитано другое, а расхождение
 * заметить нечем — обе картинки правдоподобны.
 *
 * Здесь к порядку добавляются ДОРОГИ: между остановками ищется тот же маршрут,
 * который выдаст машине диспетчер. Отсюда и крейсерская скорость в findRoute —
 * тихоходной машине выгодна другая дорога (разбор в шапке world/pathfind.ts).
 * Берётся скорость стартовой машины, а не парка линии: спрашивать парк значило
 * бы подписаться на состояние машин и перестраивать геометрию всей карты каждый
 * тик. Разные по скорости машины появятся в срезе 5 — тогда же здесь появится
 * выбор, чью дорогу показывать.
 */
function ringCities(graph: RoadGraph, line: Line): CityId[] {
  const order = ringOrder(graph, line)
  if (order.length < MIN_LINE_STOPS) return []

  const path: CityId[] = []

  for (let k = 0; k < order.length; k++) {
    const from = line.stops[order[k]].nodeId
    const to = line.stops[order[(k + 1) % order.length]].nodeId

    const leg = findRoute(graph, from, to, STARTER_CRUISE_KMH)
    // ringOrder отбирает остановки по достижимости, поэтому сюда попадают
    // только проезжие пары — кроме одного случая: ребро качеством в ноль
    // проходимо по расстоянию и непроходимо по времени. Обрываем ломаную, а не
    // пропускаем плечо: пропуск склеил бы соседние города прямой через поле, и
    // на карте появилась бы дорога, которой нет.
    if (leg === null) break

    // Первый город плеча уже стоит в конце ломаной как последний город
    // предыдущего — дублировать его нельзя, иначе появится отрезок нулевой
    // длины и лишний шов в штриховке.
    for (let i = path.length === 0 ? 0 : 1; i < leg.length; i++) {
      path.push(leg[i])
    }
  }

  return path
}

// ─── Лента ─────────────────────────────────────────────────────────────────

/**
 * Один четырёхугольник ленты с разной шириной на концах.
 *
 * Порядок вершин повторяет RoadMesh и выбран по той же причине: при обратном
 * обходе нормаль треугольника смотрит вниз, и лента отбраковывается как задняя
 * грань. Нормалей в буфере нет вовсе — материал у линий basic, освещение он не
 * считает, а лишний атрибут удваивал бы буфер ни за чем.
 */
function pushQuad(
  out: number[],
  ax: number,
  az: number,
  bx: number,
  bz: number,
  nx: number,
  nz: number,
  halfA: number,
  halfB: number,
  elevation: number,
): void {
  const anx = nx * halfA
  const anz = nz * halfA
  const bnx = nx * halfB
  const bnz = nz * halfB

  const quad = [
    ax - anx, az - anz,
    ax + anx, az + anz,
    bx - bnx, bz - bnz,
    bx - bnx, bz - bnz,
    ax + anx, az + anz,
    bx + bnx, bz + bnz,
  ]

  for (let v = 0; v < 6; v++) {
    out.push(quad[v * 2], elevation, quad[v * 2 + 1])
  }
}

type RibbonStyle = {
  halfWidthKm: number
  elevation: number
  /** Сплошная лента вместо штриховой — вид выбранной линии. */
  solid: boolean
}

/**
 * Ломаная, разложенная в ленту, — в общий буфер вершин.
 *
 * ФАЗА ШТРИХОВКИ СКВОЗНАЯ ПО ВСЕМУ КОЛЬЦУ, а не своя на каждом ребре. Считать
 * штрихи от начала каждого отрезка было бы вдвое проще, но тогда на каждом
 * перекрёстке ритм сбивался бы, и частая сетка дорог под Москвой превратила бы
 * линию в морзянку. Поэтому пройденный путь копится по всей ломаной, а штрих,
 * попавший на стык, разрезается на два куска с общим клином.
 */
function pushRibbon(out: number[], ring: Ring, style: RibbonStyle): void {
  const points = ring.points
  if (points.length < 2) return

  const half = style.halfWidthKm
  let traveled = 0

  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]
    const b = points[i + 1]

    const dx = b.x - a.x
    const dz = b.z - a.z
    const length = Math.hypot(dx, dz)
    // Два города в одной точке — вырожденное ребро. Не рисуем и путь не копим.
    if (length <= EPSILON_KM) continue

    const ux = dx / length
    const uz = dz / length
    // Нормаль к ходу в плоскости карты: по ней лента и набирает ширину, и
    // уезжает на свою полосу.
    const nx = -uz
    const nz = ux

    // Центр отрезка, сдвинутый на полосу линии.
    const ox = a.x + nx * ring.offsetKm
    const oz = a.z + nz * ring.offsetKm

    /** Кусок ленты между двумя расстояниями от начала ЭТОГО отрезка. */
    const emit = (from: number, to: number, halfA: number, halfB: number) => {
      // Продление концов на полуширину — тот же приём, что в RoadMesh: без него
      // на повороте между двумя лентами остаётся клиновидная щель.
      const start = from <= EPSILON_KM ? from - half : from
      const end = to >= length - EPSILON_KM ? to + half : to

      pushQuad(
        out,
        ox + ux * start,
        oz + uz * start,
        ox + ux * end,
        oz + uz * end,
        nx,
        nz,
        halfA,
        halfB,
        style.elevation,
      )
    }

    if (style.solid) {
      emit(0, length, half, half)
      traveled += length
      continue
    }

    /** Полуширина клина на доле пути от начала штриха. */
    const taper = (share: number): number =>
      half * (DASH_TAIL_SCALE + (1 - DASH_TAIL_SCALE) * share)

    // Штрихи стоят в точках m·период − фаза по ГЛОБАЛЬНОМУ пути вдоль кольца.
    // Начинаем с округления вниз, а не вверх: штрих, начавшийся на предыдущем
    // отрезке, обязан заехать на этот, иначе на каждом стыке появится дырка.
    const segmentEnd = traveled + length
    let m = Math.floor((traveled + ring.phaseKm) / DASH_PERIOD_KM)

    for (;;) {
      const dashStart = m * DASH_PERIOD_KM - ring.phaseKm
      if (dashStart >= segmentEnd) break
      m++

      const dashEnd = dashStart + DASH_LENGTH_KM
      if (dashEnd <= traveled) continue

      const from = Math.max(dashStart, traveled)
      const to = Math.min(dashEnd, segmentEnd)
      if (to - from <= MIN_DASH_KM) continue

      // Клин считается от границ ВСЕГО штриха, а не куска: разрезанный стыком
      // штрих обязан остаться одним клином, а не двумя маленькими.
      emit(
        from - traveled,
        to - traveled,
        taper((from - dashStart) / DASH_LENGTH_KM),
        taper((to - dashStart) / DASH_LENGTH_KM),
      )
    }

    traveled = segmentEnd
  }
}

// ─── Компонент ─────────────────────────────────────────────────────────────

/** Пустой реестр линий — чтобы селектор не отдавал новый объект каждый раз. */
const NO_LINES: Record<LineId, Line> = {}

function buildRings(
  lines: Record<LineId, Line>,
  cities: Record<CityId, City>,
  edges: Record<EdgeId, Edge>,
): Ring[] {
  const ids = Object.keys(lines) as LineId[]
  if (ids.length === 0) return []

  const graph = buildGraph(edges)
  const rings: Ring[] = []

  ids.forEach((id, order) => {
    const line = lines[id]
    // Недостроенная линия не кольцо и не работает (MIN_LINE_STOPS в
    // logistics/line.ts). Рисовать её значит показать работающей ту, по которой
    // ни одна машина не поедет.
    if (line.stops.length < MIN_LINE_STOPS) return

    const points: Point[] = []
    for (const cityId of ringCities(graph, line)) {
      const city = cities[cityId]
      // Город исчез из мира — то же правило, что в RoadMesh: остальная карта
      // важнее одного плеча.
      if (city === undefined) continue
      points.push(cityPoint(city))
    }
    if (points.length < 2) return

    const slot = order % SLOT_COUNT
    const phase = Math.floor(order / SLOT_COUNT) % PHASE_COUNT

    rings.push({
      id,
      points,
      // Полосы разложены симметрично относительно оси дороги: при одной линии
      // на трассе она идёт ровно по её середине, а не съезжает в кювет.
      offsetKm: (slot - (SLOT_COUNT - 1) / 2) * SLOT_STEP_KM,
      phaseKm: (phase / PHASE_COUNT) * DASH_PERIOD_KM,
    })
  })

  return rings
}

export function Lines(): JSX.Element | null {
  /*
   * Подписки поверхностные — как в RoadMesh. Реестры пересобираются каждый тик,
   * но сами города, дороги и линии при этом остаются прежними объектами:
   * без useShallow вся геометрия колец перестраивалась бы по несколько раз в
   * секунду, а в ней живёт поиск пути.
   */
  const cities = useGameStore(useShallow((store) => store.state.world.cities))
  const edges = useGameStore(useShallow((store) => store.state.world.edges))
  const lines = useGameStore(
    useShallow(
      (store) =>
        store.state.companies[store.state.playerId]?.lines ?? NO_LINES,
    ),
  )
  const selected = useLineSelection((store) => store.line)

  // Разбор колец отделён от сборки буферов НАМЕРЕННО: здесь живёт поиск пути,
  // и он не должен запускаться заново от того, что игрок ткнул в другую линию.
  const rings = useMemo(
    () => buildRings(lines, cities, edges),
    [lines, cities, edges],
  )

  const buffers = useMemo(() => {
    const plain: number[] = []
    const highlighted: number[] = []

    for (const ring of rings) {
      const chosen = ring.id === selected
      pushRibbon(chosen ? highlighted : plain, ring, {
        halfWidthKm: chosen ? SELECTED_HALF_KM : LINE_HALF_KM,
        elevation: chosen ? layers.lineSelected : layers.lineRoute,
        solid: chosen,
      })
    }

    return {
      plain: new Float32Array(plain),
      highlighted: new Float32Array(highlighted),
    }
  }, [rings, selected])

  if (buffers.plain.length === 0 && buffers.highlighted.length === 0) {
    return null
  }

  return (
    <group>
      {/*
        Материал basic, а не standard, и это не экономия. Линия — не асфальт, а
        замысел игрока, наложенный на карту: освещать её значит прятать часть
        кольца в тени высотной застройки ровно там, где сеть самая плотная.
        Отключённая тональная компрессия по той же причине — оттенок линии
        обязан совпадать с палитрой, а не зависеть от того, сколько яркого
        попало в кадр.

        Тени лента не принимает и не отбрасывает: плоскость нулевой толщины
        отбрасывает только артефакты самозатенения.

        Отсечение по пирамиде видимости выключено. Буфер пересобирается при
        каждой правке линии, а сфера охвата считается по нему лениво и один раз:
        устаревшая сфера убрала бы кольцо с экрана целиком, и выглядело бы это
        как «линия не сохранилась». Цена отказа — два вызова отрисовки на всю
        сеть, то есть ничто.
      */}
      {buffers.plain.length > 0 && (
        <mesh frustumCulled={false}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[buffers.plain, 3]}
            />
          </bufferGeometry>
          {/* Приглушённый холодный тон интерфейса: линия обязана читаться
              поверх полотна (roadFederal заметно темнее) и при этом не
              перебивать машины. */}
          <meshBasicMaterial color={palette.textDim} toneMapped={false} />
        </mesh>
      )}

      {buffers.highlighted.length > 0 && (
        <mesh frustumCulled={false}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[buffers.highlighted, 3]}
            />
          </bufferGeometry>
          <meshBasicMaterial color={palette.accent} toneMapped={false} />
        </mesh>
      )}
    </group>
  )
}
