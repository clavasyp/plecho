import { describe, expect, it } from 'vitest'
import {
  TICKS_PER_HOUR,
  cityId,
  companyId,
  driverId,
  edgeId,
  lineId,
  vehicleId,
} from '../types'
import type {
  City,
  Driver,
  DriverId,
  CityId,
  Company,
  CompanyId,
  Edge,
  EdgeId,
  GameState,
  Line,
  LineId,
  Stop,
  Vehicle,
  VehicleId,
} from '../types'
import { advanceVehicle } from './vehicle'
import {
  MIN_LINE_STOPS,
  advanceLineVehicles,
  nextStop,
  routeToStop,
} from './line'

/**
 * Мир здесь синтетический и крошечный, как в тестах погрузки: четыре города,
 * три дороги. Настоящие данные из src/data не тянутся намеренно — диспетчер не
 * должен падать оттого, что в справочнике переехал элеватор.
 *
 * Расстояния и качество покрытия при этом настоящие, из src/data/roads.ts:
 * Москва — Тула 185 км по М-2, Тула — Калуга 110 км по Р-132, Москва — Калуга
 * 190 км по М-3. Получается замкнутое кольцо из трёх плеч разной длины — именно
 * на нём проверяется расстановка парка, потому что на равных плечах любая
 * ошибка в арифметике интервала маскируется симметрией.
 *
 * ОСТРОВ — город без единой дороги. Он нужен как недостижимая остановка: путь
 * до него не существует ни при какой погоде, и это ровно тот случай, который не
 * имеет права подвесить машину.
 */

const MOSCOW = cityId('moscow')
const TULA = cityId('tula')
const KALUGA = cityId('kaluga')
const OSTROV = cityId('ostrov')

const PLAYER: CompanyId = companyId('player')
const RING: LineId = lineId('ring')

const TEST_EDGES: Edge[] = [
  {
    id: edgeId('moscow-tula'),
    from: MOSCOW,
    to: TULA,
    km: 185,
    class: 'федеральная',
    route: 'М-2 Крым',
    quality: 0.87,
  },
  {
    id: edgeId('tula-kaluga'),
    from: TULA,
    to: KALUGA,
    km: 110,
    class: 'региональная',
    route: 'Р-132 Золотое кольцо',
    quality: 0.65,
  },
  {
    id: edgeId('moscow-kaluga'),
    from: MOSCOW,
    to: KALUGA,
    km: 190,
    class: 'федеральная',
    route: 'М-3 Украина',
    quality: 0.86,
  },
]

/** Длина кольца Москва → Тула → Калуга → Москва. Выводится из данных выше. */
const RING_KM = TEST_EDGES.reduce((km, edge) => km + edge.km, 0)

/** Стартовый ЗИЛ: 70 км/ч крейсерских, 6 тонн, 30 литров на сотню. */
const ZIL_KMH = 70
const ZIL_TONS = 6
const ZIL_FUEL = 30

/** Длительность тика в часах. Выводится из календаря, а не вписывается. */
const HOURS_PER_TICK = 1 / TICKS_PER_HOUR

/**
 * Сколько тиков занимает самое длинное плечо кольца.
 *
 * Считается по данным теста, а не берётся числом: перебалансировка скоростей
 * или качества дорог не должна ронять тесты, в которых не менялось ни одного
 * правила. Формула скорости здесь переписана заново — линейка, собранная из
 * проверяемого кода, меряет только саму себя.
 */
const CLASS_LIMIT_KMH = { 'федеральная': 90, 'региональная': 70, 'местная': 50 }

function edgeTicks(edge: Edge, cruiseKmh: number): number {
  const speed = Math.min(cruiseKmh, CLASS_LIMIT_KMH[edge.class]) * edge.quality
  return Math.ceil(edge.km / speed / HOURS_PER_TICK)
}

/** Тиков на самое долгое плечо плюс тик простоя под погрузкой. */
const SLOWEST_LEG_TICKS =
  Math.max(...TEST_EDGES.map((edge) => edgeTicks(edge, ZIL_KMH))) + 1

// ─── Сборка мира ───────────────────────────────────────────────────────────

function makeCity(id: CityId): City {
  return {
    id,
    name: id,
    coord: { lat: 55, lon: 37 },
    population: 100_000,
    profile: 'промышленный',
    stock: {},
    suppliedDays: 0,
  }
}

/** Остановка без грузовых инструкций: диспетчер про грузы ничего не знает. */
function stop(nodeId: CityId): Stop {
  return { nodeId, unload: [], load: [] }
}

function makeLine(id: LineId, stops: Stop[], assigned: VehicleId[] = []): Line {
  return { id, name: id, stops, assignedVehicles: assigned }
}

function makeVehicle(
  id: VehicleId,
  at: CityId,
  patch: Partial<Vehicle> = {},
): Vehicle {
  return {
    id,
    ownerId: PLAYER,
    position: { kind: 'узел', nodeId: at },
    route: [],
    lineId: null,
    stopIndex: 0,
    blockedTicks: 0,
    // Свободна: под погрузкой машина никуда не едет, и тесты диспетчеризации
    // проверяли бы неподвижный парк. Простой под погрузкой — отдельный раздел
    // ниже, он ставит счётчик явно.
    serviceTicksLeft: 0,
    queuedTicks: 0,
    classId: 'zil-130',
    trailer: 'тент',
    // Водитель обязателен: без него машина не трогается, а здесь проверяется
    // именно диспетчеризация. Отсутствие водителя — предмет driver.test.ts.
    driverId: driverId(`drv-${id}`),
    wear: 0,
    kmSinceService: 0,
    brokenDown: false,
    cruiseKmh: ZIL_KMH,
    fuelPer100Km: ZIL_FUEL,
    odometer: 0,
    capacity: ZIL_TONS,
    cargo: null,
    loadedKm: 0,
    emptyKm: 0,
    ...patch,
  }
}

function makeCompany(lines: Line[]): Company {
  const table: Record<LineId, Line> = {}
  for (const line of lines) table[line.id] = line
  return {
    id: PLAYER,
    name: 'ТОО «Плечо»',
    money: 6_000,
    controller: 'человек',
    lines: table,
    drivers: {},
    // Ни одной постройки: в этом городе у компании ровно базовый пост, и
    // диспетчеризацию это не касается вовсе — постами занята фаза обслуживания.
    buildings: {},
    dailyRevenue: 0,
    dailyCosts: 0,
    bankrupt: false,
    daysInDebt: 0,
  }
}

function makeState(lines: Line[], vehicles: Vehicle[]): GameState {
  const cities: Record<CityId, City> = {}
  for (const id of [MOSCOW, TULA, KALUGA, OSTROV]) cities[id] = makeCity(id)

  const edges: Record<EdgeId, Edge> = {}
  for (const edge of TEST_EDGES) edges[edge.id] = { ...edge }

  const fleet: Record<VehicleId, Vehicle> = {}
  for (const vehicle of vehicles) fleet[vehicle.id] = vehicle

  // Отдохнувший водитель на каждую машину: тесты этого файла про кольцо и
  // расстановку, а не про режим труда, и упереться в него они не должны.
  const crew: Record<DriverId, Driver> = {}
  for (const vehicle of vehicles) {
    if (vehicle.driverId === null) continue
    crew[vehicle.driverId] = {
      id: vehicle.driverId,
      name: 'Водитель',
      employerId: PLAYER,
      vehicleId: vehicle.id,
      skill: 0.5,
      licenses: ['ДОПОГ', 'длинномер'],
      fatigue: 0,
      hoursOnDuty: 0,
      wagePerDay: 700,
      loyalty: 0.5,
    }
  }

  return {
    rngState: 1,
    tick: 0,
    startYear: 1994,
    world: { cities, edges, industries: {} },
    companies: { [PLAYER]: { ...makeCompany(lines), drivers: crew } },
    playerId: PLAYER,
    vehicles: fleet,
  }
}

/**
 * Два тика симуляции из tick.ts — диспетчеризация и движение, ровно в том
 * порядке, в каком они там стоят.
 *
 * Производство, прибытие и расходы сюда не входят: диспетчер их не читает, а
 * тянуть в тест соседние фазы значит уронить его на чужой правке. Порядок
 * «диспетчер до движения» воспроизведён точно — от него зависит, успевает ли
 * машина выехать в тот же тик, в котором получила маршрут.
 */
function step(state: GameState): GameState {
  const dispatched = advanceLineVehicles(state)

  const vehicles: Record<VehicleId, Vehicle> = {}
  for (const id of Object.keys(dispatched.vehicles) as VehicleId[]) {
    vehicles[id] = advanceVehicle(
      dispatched.vehicles[id],
      dispatched,
      HOURS_PER_TICK,
    )
  }

  return { ...dispatched, tick: dispatched.tick + 1, vehicles }
}

function run(state: GameState, ticks: number): GameState {
  let next = state
  for (let i = 0; i < ticks; i++) next = step(next)
  return next
}

/** Город, в котором машина стоит; null — она на ребре. */
function nodeOf(state: GameState, id: VehicleId): CityId | null {
  const position = state.vehicles[id].position
  return position.kind === 'узел' ? position.nodeId : null
}

/** Последовательность узлов, в которых машина побывала, без повторов подряд. */
function visitedNodes(state: GameState, id: VehicleId, ticks: number): CityId[] {
  const visited: CityId[] = []
  let next = state
  for (let i = 0; i < ticks; i++) {
    next = step(next)
    const node = nodeOf(next, id)
    if (node !== null && visited[visited.length - 1] !== node) visited.push(node)
  }
  return visited
}

/** Последовательность целевых остановок машины, без повторов подряд. */
function visitedStops(state: GameState, id: VehicleId, ticks: number): number[] {
  const seen: number[] = []
  let next = state
  for (let i = 0; i < ticks; i++) {
    next = step(next)
    const index = next.vehicles[id].stopIndex
    if (seen[seen.length - 1] !== index) seen.push(index)
  }
  return seen
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested)
  }
  return Object.freeze(value)
}

// ─── Кольцо остановок ──────────────────────────────────────────────────────

describe('nextStop', () => {
  const line = makeLine(RING, [stop(MOSCOW), stop(TULA), stop(KALUGA)])

  it('после последней остановки идёт нулевая', () => {
    const count = line.stops.length
    for (let index = 0; index < count; index++) {
      expect(nextStop(line, index)).toBe((index + 1) % count)
    }
    expect(nextStop(line, count - 1)).toBe(0)
  })

  it('индекс за пределами линии заворачивается, а не ломает обход', () => {
    const count = line.stops.length
    // Игрок укоротил линию, а машина осталась с индексом от прежней длины.
    expect(nextStop(line, count + 1)).toBe(nextStop(line, 1))
    expect(nextStop(line, -1)).toBe(nextStop(line, count - 1))
  })
})

// ─── Работа линии ──────────────────────────────────────────────────────────

describe('advanceLineVehicles', () => {
  const V1: VehicleId = vehicleId('zil-1')
  const V2: VehicleId = vehicleId('zil-2')
  const V3: VehicleId = vehicleId('zil-3')

  function shuttleState(): GameState {
    const line = makeLine(RING, [stop(MOSCOW), stop(TULA)], [V1])
    const truck = makeVehicle(V1, MOSCOW, { lineId: RING })
    return makeState([line], [truck])
  }

  it('машина на линии из двух остановок ходит между ними бесконечно', () => {
    // Шести плеч хватает на три полных круга — если машина встанет после
    // первого разворота, это будет видно.
    const legs = 6
    const visited = visitedNodes(shuttleState(), V1, SLOWEST_LEG_TICKS * legs)

    expect(visited.length).toBeGreaterThanOrEqual(legs)
    expect(visited.filter((node) => node === MOSCOW).length).toBeGreaterThan(2)
    expect(visited.filter((node) => node === TULA).length).toBeGreaterThan(2)
    // Ни одного повтора подряд: машина не топчется в одном городе.
    for (let i = 1; i < visited.length; i++) {
      expect(visited[i]).not.toBe(visited[i - 1])
    }
  })

  it('свободная машина уходит с остановки со следующим же тиком', () => {
    // Инвариант, на который опирается фаза прибытия: пока машина стоит,
    // stopIndex указывает на ЭТУ остановку, и грузиться она будет по её
    // инструкции. Сдвиг индекса происходит в момент отправления.
    //
    // «Свободная» — то есть с нулевыми счётчиками обслуживания. Настоящий
    // простой под погрузкой задаёт фаза обслуживания, и ей посвящён отдельный
    // раздел ниже; здесь проверяется, что БЕЗ неё диспетчер не тянет ни тика.
    let state = shuttleState()
    const line = state.companies[PLAYER].lines[RING]

    // Тик, в котором машина ещё стоит на нулевой остановке.
    expect(nodeOf(state, V1)).toBe(MOSCOW)
    expect(state.vehicles[V1].stopIndex).toBe(0)
    expect(line.stops[state.vehicles[V1].stopIndex].nodeId).toBe(MOSCOW)

    state = step(state)
    // Диспетчер отправил её дальше: индекс уже на следующей остановке.
    expect(state.vehicles[V1].stopIndex).toBe(nextStop(line, 0))
    expect(nodeOf(state, V1)).toBeNull()
  })

  /*
   * ─── СТЫК С ФАЗОЙ ОБСЛУЖИВАНИЯ ──────────────────────────────────────────
   *
   * Фаза обслуживания (logistics/service.ts) сюда не зовётся: тест про
   * ДИСПЕТЧЕРА, и он не должен краснеть оттого, что в соседнем модуле поменяли
   * оценку тоннажа. Счётчики выставляются руками ровно в те состояния, которые
   * та фаза создаёт, — «стоит под погрузкой» и «ждёт очереди», — и проверяется
   * единственное, за что диспетчер тут отвечает: он такую машину не трогает.
   */

  it('машина под погрузкой стоит и не уезжает', () => {
    const line = makeLine(RING, [stop(MOSCOW), stop(TULA)], [V1])
    // Три тика под погрузкой — столько держит пост шеститонная партия.
    const busy = makeVehicle(V1, MOSCOW, { lineId: RING, serviceTicksLeft: 3 })
    const state = makeState([line], [busy])

    const after = run(state, 3)

    // Никуда не уехала, маршрута не получила, цель не переехала на следующую
    // остановку. Увези её диспетчер сейчас — тонны так и остались бы на складе,
    // а погрузка снова стала бы мгновенной ровно для того, кто едет по линии.
    expect(nodeOf(after, V1)).toBe(MOSCOW)
    expect(after.vehicles[V1].route).toEqual([])
    expect(after.vehicles[V1].stopIndex).toBe(0)
    expect(after.vehicles[V1].odometer).toBe(0)
  })

  it('машина в очереди тоже стоит, хотя пост ей не достался', () => {
    const line = makeLine(RING, [stop(MOSCOW), stop(TULA)], [V1])
    // Обслуживание не начиналось: serviceTicksLeft честный ноль, растёт только
    // ожидание. Это состояние второй машины у завода с единственным постом.
    const waiting = makeVehicle(V1, MOSCOW, { lineId: RING, queuedTicks: 2 })
    const state = makeState([line], [waiting])

    const after = run(state, 3)

    /*
     * САМАЯ ЛЁГКАЯ ОШИБКА ЭТОГО СРЕЗА — проверить только serviceTicksLeft. У
     * ждущей машины он ноль, и диспетчер увёз бы её со своей же остановки
     * порожняком: очередь превратилась бы в разрешение проехать мимо завода, то
     * есть в свою противоположность. Никакой тест экономики этого бы не поймал —
     * линия просто возила бы меньше, чем должна.
     */
    expect(nodeOf(after, V1)).toBe(MOSCOW)
    expect(after.vehicles[V1].route).toEqual([])
    expect(after.vehicles[V1].odometer).toBe(0)
  })

  it('отстоявшая своё машина уезжает, ничего не потеряв', () => {
    const line = makeLine(RING, [stop(MOSCOW), stop(TULA)], [V1])
    // Обслуживание закончено: оба счётчика обнулены — так фаза обслуживания и
    // отпускает машину.
    const freed = makeVehicle(V1, MOSCOW, {
      lineId: RING,
      serviceTicksLeft: 0,
      queuedTicks: 0,
    })
    const state = makeState([line], [freed])

    const after = step(state)

    // Простой не должен превращаться в вечный: как только счётчики обнулены,
    // машина обязана поехать тем же тиком, а не «отдохнуть ещё немного».
    expect(after.vehicles[V1].stopIndex).toBe(nextStop(line, 0))
    expect(after.vehicles[V1].odometer).toBeGreaterThan(0)
  })

  it('стоящая под погрузкой машина не пропадает с кольца для соседей', () => {
    /*
     * Её координата считается как у всех, и выдержка интервала продолжает от
     * неё отталкиваться. Иначе занятый пост стал бы для остальных невидимым, и
     * весь парк линии съезжался бы к нему — то самое сбивание в колонну, ради
     * которого выдержка интервала и написана, только теперь ещё и с очередью.
     */
    const line = makeLine(RING, [stop(MOSCOW), stop(TULA), stop(KALUGA)], [
      V1,
      V2,
    ])
    const busy = makeVehicle(V1, MOSCOW, { lineId: RING, serviceTicksLeft: 8 })
    const behind = makeVehicle(V2, MOSCOW, { lineId: RING })
    const state = makeState([line], [busy, behind])

    const after = step(state)

    // Первая стоит под погрузкой, вторая стоит с ней в одной точке кольца:
    // интервал до передней нулевой, значит выезд запрещён обеим.
    expect(after.vehicles[V1].odometer).toBe(0)
    expect(after.vehicles[V2].odometer).toBe(0)
  })

  it('stopIndex закольцовывается', () => {
    const line = makeLine(RING, [stop(MOSCOW), stop(TULA), stop(KALUGA)], [V1])
    const state = makeState([line], [makeVehicle(V1, MOSCOW, { lineId: RING })])

    const laps = 3
    const seen = visitedStops(
      state,
      V1,
      SLOWEST_LEG_TICKS * line.stops.length * laps,
    )

    // Кольцо пройдено не меньше двух раз — значит переход «последняя → нулевая»
    // случился, и не однажды.
    expect(seen.length).toBeGreaterThan(line.stops.length * 2)
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBe(nextStop(line, seen[i - 1]))
    }
    expect(seen).toContain(0)
    expect(seen).toContain(line.stops.length - 1)
  })

  it('машина без линии стоит и разовый рейс у неё не отбирают', () => {
    const line = makeLine(RING, [stop(MOSCOW), stop(TULA)], [])
    const parked = makeVehicle(V1, MOSCOW)
    // Второй машине выдан разовый маршрут — линий она не знает.
    const dispatched = makeVehicle(V2, MOSCOW, { route: [TULA] })
    const state = makeState([line], [parked, dispatched])

    // Ни одной машины на линиях — состояние возвращается тем же объектом.
    expect(advanceLineVehicles(state)).toBe(state)

    const after = run(state, SLOWEST_LEG_TICKS * 3)
    expect(after.vehicles[V1].position).toEqual(state.vehicles[V1].position)
    expect(after.vehicles[V1].odometer).toBe(0)
    expect(after.vehicles[V1].route).toEqual([])
    // Разовый рейс доехал и на этом кончился: линия его не подхватила.
    expect(nodeOf(after, V2)).toBe(TULA)
    expect(after.vehicles[V2].route).toEqual([])
  })

  it('линия короче двух остановок не двигает машину', () => {
    const stops = Array.from({ length: MIN_LINE_STOPS - 1 }, () => stop(TULA))
    const line = makeLine(RING, stops, [V1])
    // Машина стоит в Москве, остановка в Туле: заработай линия — уехала бы.
    const state = makeState([line], [makeVehicle(V1, MOSCOW, { lineId: RING })])

    expect(advanceLineVehicles(state)).toBe(state)

    const after = run(state, SLOWEST_LEG_TICKS * 3)
    expect(nodeOf(after, V1)).toBe(MOSCOW)
    expect(after.vehicles[V1].odometer).toBe(0)
  })

  it('недостижимая остановка пропускается, а не вешает машину', () => {
    const line = makeLine(
      RING,
      [stop(MOSCOW), stop(OSTROV), stop(TULA)],
      [V1],
    )
    const state = makeState([line], [makeVehicle(V1, MOSCOW, { lineId: RING })])

    const visited = visitedNodes(state, V1, SLOWEST_LEG_TICKS * 6)

    // Остров недостижим — машина в нём не бывает, но кольцо продолжает работать
    // на оставшихся двух остановках.
    expect(visited).not.toContain(OSTROV)
    expect(visited.filter((node) => node === MOSCOW).length).toBeGreaterThan(1)
    expect(visited.filter((node) => node === TULA).length).toBeGreaterThan(1)
  })

  it('линия, недостижимая целиком, не роняет и не подвешивает фазу', () => {
    // Обе остановки на острове, машина в Москве: ехать некуда вообще.
    const line = makeLine(RING, [stop(OSTROV), stop(OSTROV)], [V1])
    const state = makeState([line], [makeVehicle(V1, MOSCOW, { lineId: RING })])

    const after = run(state, SLOWEST_LEG_TICKS * 3)

    expect(nodeOf(after, V1)).toBe(MOSCOW)
    expect(after.vehicles[V1].odometer).toBe(0)
    expect(after.vehicles[V1].route).toEqual([])
  })

  it('машина выходит на линию из чужого города', () => {
    // Линию построили в Туле и Калуге, а машина стоит в Москве — так бывает
    // после разового рейса и после покупки новой машины.
    const line = makeLine(RING, [stop(TULA), stop(KALUGA)], [V1])
    const state = makeState([line], [makeVehicle(V1, MOSCOW, { lineId: RING })])

    const visited = visitedNodes(state, V1, SLOWEST_LEG_TICKS * 5)

    expect(visited[0]).toBe(TULA)
    expect(visited).toContain(KALUGA)
  })

  it('routeToStop ведёт к текущей целевой остановке', () => {
    const line = makeLine(RING, [stop(MOSCOW), stop(KALUGA)], [V1])
    const truck = makeVehicle(V1, MOSCOW, { lineId: RING, stopIndex: 1 })
    const state = makeState([line], [truck])

    const route = routeToStop(state, truck, line)
    expect(route).not.toBeNull()
    expect(route?.[route.length - 1]).toBe(KALUGA)

    // До острова пути нет — и это не исключение, а null.
    const broken = makeLine(RING, [stop(MOSCOW), stop(OSTROV)], [V1])
    const stranded = makeVehicle(V1, MOSCOW, { lineId: RING, stopIndex: 1 })
    expect(routeToStop(makeState([broken], [stranded]), stranded, broken)).toBeNull()
  })

  // ─── Расстановка по кольцу ───────────────────────────────────────────────

  it('несколько машин на линии разъезжаются по кольцу, а не идут вплотную', () => {
    const fleet = [V1, V2, V3]
    const line = makeLine(
      RING,
      [stop(MOSCOW), stop(TULA), stop(KALUGA)],
      fleet,
    )
    // Все три куплены в Москве и назначены на линию одним движением — именно
    // так парк и собирается в колонну, если его никто не расталкивает.
    const state = makeState(
      [line],
      fleet.map((id) => makeVehicle(id, MOSCOW, { lineId: RING })),
    )

    // Двух кругов хватает, чтобы выдержка интервала вывела всех на линию.
    const after = run(state, SLOWEST_LEG_TICKS * line.stops.length * 2)

    // Норма интервала — кольцо, делённое на число машин. Требуем хотя бы
    // половину нормы: простой под погрузкой и разная длина плеч заставляют
    // промежутки дышать вокруг неё.
    const headwayKm = RING_KM / fleet.length
    for (const id of fleet) {
      expect(after.vehicles[id].odometer).toBeGreaterThan(0)
    }
    for (const a of fleet) {
      for (const b of fleet) {
        if (a === b) continue
        expect(ringGapKm(after, a, b)).toBeGreaterThan(headwayKm / 2)
      }
    }
  })

  it('машин больше, чем остановок, — линия не встаёт колом', () => {
    // Самый опасный для выдержки интервала случай: норма меньше плеча, и
    // наивное правило «жди, пока впереди освободится остановка» заперло бы
    // лишние машины навсегда. Промежутки в сумме дают длину кольца, поэтому
    // хотя бы один всегда не меньше нормы — выехать может всегда кто-то один.
    const fleet = [V1, V2, V3, vehicleId('zil-4'), vehicleId('zil-5')]
    const stops = [stop(MOSCOW), stop(TULA)]
    expect(fleet.length).toBeGreaterThan(stops.length)

    const line = makeLine(RING, stops, fleet)
    const state = makeState(
      [line],
      fleet.map((id) => makeVehicle(id, MOSCOW, { lineId: RING })),
    )

    const after = run(state, SLOWEST_LEG_TICKS * fleet.length * 2)
    for (const id of fleet) {
      expect(after.vehicles[id].odometer).toBeGreaterThan(0)
    }
  })

  it('одна машина на линии не ждёт никого', () => {
    // Проверка обратной стороны выдержки: она не должна тормозить парк из
    // одной машины, которой не с кем держать интервал.
    const line = makeLine(RING, [stop(MOSCOW), stop(TULA), stop(KALUGA)], [V1])
    const state = makeState([line], [makeVehicle(V1, MOSCOW, { lineId: RING })])

    const after = run(state, SLOWEST_LEG_TICKS)
    expect(after.vehicles[V1].odometer).toBeGreaterThan(0)
  })

  /**
   * Расстояние между машинами вдоль кольца, километры.
   *
   * Считается по ОДОМЕТРАМ, а не по координатам из line.ts: линейка, собранная
   * из проверяемого кода, меряет только саму себя. Машины одинаковы и идут по
   * одному кольцу, поэтому разность пробегов и есть расстояние между ними, а
   * остаток от длины кольца снимает разницу в числе пройденных кругов.
   */
  function ringGapKm(state: GameState, a: VehicleId, b: VehicleId): number {
    const diff = Math.abs(state.vehicles[a].odometer - state.vehicles[b].odometer)
    const along = diff % RING_KM
    return Math.min(along, RING_KM - along)
  }

  // ─── Чистота и детерминизм ───────────────────────────────────────────────

  it('фаза не мутирует вход', () => {
    const fleet = [V1, V2, V3]
    const line = makeLine(
      RING,
      [stop(MOSCOW), stop(TULA), stop(KALUGA)],
      fleet,
    )
    let state = makeState(
      [line],
      fleet.map((id, i) => makeVehicle(id, i === 0 ? KALUGA : MOSCOW, { lineId: RING })),
    )

    // Заморозка ловит мутацию на любом уровне вложенности, снимок JSON —
    // подмену значения на равное по форме. Прогон длинный, чтобы под проверку
    // попали все ветки: выезд, выдержка, вход на линию, разворот кольца.
    for (let i = 0; i < SLOWEST_LEG_TICKS * 4; i++) {
      deepFreeze(state)
      const before = JSON.stringify(state)
      advanceLineVehicles(state)
      expect(JSON.stringify(state)).toBe(before)
      state = step(state)
    }
  })

  it('детерминизм на длинном прогоне', () => {
    const fleet = [V1, V2, V3]
    const build = (): GameState => {
      const line = makeLine(
        RING,
        [stop(MOSCOW), stop(TULA), stop(KALUGA), stop(OSTROV)],
        fleet,
      )
      return makeState(
        [line],
        fleet.map((id) => makeVehicle(id, MOSCOW, { lineId: RING })),
      )
    }

    const ticks = SLOWEST_LEG_TICKS * 20
    const first = run(build(), ticks)
    const second = run(build(), ticks)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))

    // И то же самое через сохранение: состояние после JSON.parse обязано
    // считаться так же, иначе воспроизвести баг по сейву нельзя.
    const restored = run(JSON.parse(JSON.stringify(build())) as GameState, ticks)
    expect(JSON.stringify(restored)).toBe(JSON.stringify(first))

    // Прогон обязан быть содержательным: неподвижный парк тоже детерминирован.
    for (const id of fleet) {
      expect(first.vehicles[id].odometer).toBeGreaterThan(RING_KM)
    }
  })
})
