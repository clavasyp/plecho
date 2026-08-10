import { describe, expect, it } from 'vitest'
import {
  BASE_POSTS,
  BUILDING_SPEC,
  TONS_PER_POST_HOUR,
} from '../../data/infrastructure'
import { RECIPE_BY_INDUSTRY } from '../../data/recipes'
import {
  TICKS_PER_HOUR,
  buildingId,
  cityId,
  companyId,
  edgeId,
  industryId,
  lineId,
  vehicleId,
} from '../types'
import type {
  Building,
  BuildingType,
  City,
  CityId,
  Company,
  CompanyId,
  Edge,
  EdgeId,
  GameState,
  Industry,
  IndustryId,
  IndustryType,
  Line,
  LineId,
  Stop,
  Tons,
  Vehicle,
  VehicleId,
} from '../types'
import { postsAt, runService, serviceTicksFor } from './service'

/**
 * Мир здесь синтетический и крошечный, как в тестах погрузки и линий: три
 * города, один элеватор. Настоящие данные из src/data не тянутся намеренно —
 * фаза обслуживания не должна падать оттого, что в справочнике переехал завод.
 *
 * ЧИСЛА ВЫВОДЯТСЯ ИЗ КОНСТАНТ. Длительность погрузки пересчитана здесь ЗАНОВО
 * по TONS_PER_POST_HOUR и TICKS_PER_HOUR, а не спрошена у serviceTicksFor:
 * линейка, собранная из проверяемого кода, меряет только саму себя. Тот же
 * приём и по той же причине применён к скорости в line.test.ts.
 */

const TULA = cityId('tula')
const MOSCOW = cityId('moscow')
const KALUGA = cityId('kaluga')

const PLAYER: CompanyId = companyId('player')
const RIVAL: CompanyId = companyId('rival')

const ELEVATOR = industryId('elev-tula')

const V1: VehicleId = vehicleId('v1')
const V2: VehicleId = vehicleId('v2')
const V3: VehicleId = vehicleId('v3')

const AWAY: LineId = lineId('away')
const HUB: LineId = lineId('hub')

/** Грузоподъёмность ЗИЛ-130 — стартовой машины партии. */
const ZIL_TONS = 6

/**
 * Сколько тиков занимает погрузка полного ЗИЛа.
 *
 * Формула переписана из данных: тонны, делённые на пропускную способность
 * поста, дают часы; часы, умноженные на длину часа в тиках, — тики; дробный
 * остаток округляется вверх, потому что тик неделим.
 */
const LOAD_TICKS = Math.ceil((ZIL_TONS / TONS_PER_POST_HOUR) * TICKS_PER_HOUR)

/** Запас зерна на складе: с избытком на весь парк любого теста. */
const GRAIN_STOCK: Tons = ZIL_TONS * 10

/** Единственное ребро мира. Фаза его не читает, но состояние должно быть целым. */
const TEST_EDGE: Edge = {
  id: edgeId('moscow-tula'),
  from: MOSCOW,
  to: TULA,
  km: 185,
  class: 'федеральная',
  route: 'М-2 Крым',
  quality: 0.87,
}

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

function makeIndustry(
  id: IndustryId,
  type: IndustryType,
  city: CityId,
  stock: Industry['stock'] = {},
): Industry {
  return { id, type, cityId: city, stock, utilization: 1, idleTicks: 0 }
}

/**
 * Постройка компании в городе.
 *
 * Число постов можно задать явно, и это не подмена данных: проверяется ПРАВИЛО
 * раздачи постов, а не прайс из BUILDING_SPEC. Тесту про три поста нужно ровно
 * три, а такой постройки в справочнике нет и заводить её ради теста нельзя.
 */
function makeBuilding(
  id: string,
  type: BuildingType,
  city: CityId,
  owner: CompanyId,
  posts: number = BUILDING_SPEC[type].posts,
): Building {
  return {
    id: buildingId(id),
    type,
    ownerId: owner,
    cityId: city,
    posts,
    storage: BUILDING_SPEC[type].storage,
    stock: {},
  }
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
    serviceTicksLeft: 0,
    queuedTicks: 0,
    classId: 'zil-130',
    // Тент возит зерно — иначе машина у элеватора грузить нечего и очереди не
    // возникает вовсе. Тесты про несовместимый кузов ставят прицеп явно.
    trailer: 'тент',
    // Водитель, износ и поломка фазу обслуживания не касаются: под погрузкой
    // машина стоит, а не едет. Поля заполнены «здоровыми» значениями.
    driverId: null,
    wear: 0,
    kmSinceService: 0,
    brokenDown: false,
    cruiseKmh: 70,
    fuelPer100Km: 30,
    odometer: 0,
    capacity: ZIL_TONS,
    cargo: null,
    loadedKm: 0,
    emptyKm: 0,
    ...patch,
  }
}

function makeCompany(
  id: CompanyId,
  buildings: Building[],
  lines: Line[],
): Company {
  return {
    id,
    name: id,
    money: 100_000,
    controller: 'человек',
    lines: Object.fromEntries(lines.map((l) => [l.id, l])) as Record<
      LineId,
      Line
    >,
    drivers: {},
    buildings: Object.fromEntries(buildings.map((b) => [b.id, b])) as Record<
      string,
      Building
    >,
    dailyRevenue: 0,
    dailyCosts: 0,
    bankrupt: false,
    daysInDebt: 0,
  }
}

type WorldOptions = {
  grain?: Tons
  buildings?: Building[]
  rivalBuildings?: Building[]
  lines?: Line[]
}

function makeState(vehicles: Vehicle[], options: WorldOptions = {}): GameState {
  const {
    grain = GRAIN_STOCK,
    buildings = [],
    rivalBuildings = [],
    lines = [],
  } = options

  const cities: Record<CityId, City> = {}
  for (const id of [MOSCOW, TULA, KALUGA]) cities[id] = makeCity(id)

  return {
    rngState: 1,
    tick: 0,
    startYear: 1994,
    world: {
      cities,
      edges: { [TEST_EDGE.id]: TEST_EDGE } as Record<EdgeId, Edge>,
      industries: {
        [ELEVATOR]: makeIndustry(ELEVATOR, 'элеватор', TULA, { зерно: grain }),
      } as Record<IndustryId, Industry>,
    },
    companies: {
      [PLAYER]: makeCompany(PLAYER, buildings, lines),
      [RIVAL]: makeCompany(RIVAL, rivalBuildings, []),
    },
    playerId: PLAYER,
    vehicles: Object.fromEntries(vehicles.map((v) => [v.id, v])) as Record<
      VehicleId,
      Vehicle
    >,
  }
}

/** Заморозка на всю глубину: любая попытка мутации входа станет исключением. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

// ─── Имитация тика ─────────────────────────────────────────────────────────

/**
 * Та часть фазы прибытия, ради которой обслуживание и существует.
 *
 * Настоящий runArrivals сюда не зовётся нарочно — по тому же правилу, по
 * которому тест погрузки не зовёт настоящий диспетчер: тест одной фазы не
 * должен падать из-за правки в соседнем модуле. Воспроизведено ровно одно
 * правило контракта, и именно его loading.ts обязан выполнять:
 *
 *   тонны перекладываются только у машины, которая ОТСТОЯЛА своё
 *   (serviceTicksLeft === 0) и при этом НЕ СТОИТ В ОЧЕРЕДИ (queuedTicks === 0).
 *
 * Одного первого условия мало: у ждущей поста машины счётчик обслуживания тоже
 * нулевой, и с проверкой только по нему очередь не значила бы ничего.
 */
function loadServed(state: GameState): GameState {
  const vehicles: Record<VehicleId, Vehicle> = { ...state.vehicles }
  const industries: Record<IndustryId, Industry> = { ...state.world.industries }
  let changed = false

  for (const id of Object.keys(vehicles) as VehicleId[]) {
    const vehicle = vehicles[id]
    if (vehicle.position.kind !== 'узел') continue
    if (vehicle.serviceTicksLeft !== 0 || vehicle.queuedTicks !== 0) continue
    if (vehicle.cargo !== null) continue

    const nodeId = vehicle.position.nodeId

    for (const key of Object.keys(industries) as IndustryId[]) {
      const industry = industries[key]
      if (industry.cityId !== nodeId) continue

      const cargo = RECIPE_BY_INDUSTRY[industry.type].output
      const available = industry.stock[cargo] ?? 0
      const tons = Math.min(vehicle.capacity, available)
      if (tons <= 0) continue

      industries[key] = {
        ...industry,
        stock: { ...industry.stock, [cargo]: available - tons },
      }
      vehicles[id] = {
        ...vehicle,
        cargo: { type: cargo, tons, originId: nodeId },
      }
      changed = true
      break
    }
  }

  return changed
    ? { ...state, world: { ...state.world, industries }, vehicles }
    : state
}

/** Один тик: обслуживание, затем погрузка отстоявших. Порядок — как в tick.ts. */
function step(state: GameState): GameState {
  return loadServed(runService(state))
}

function run(state: GameState, ticks: number): GameState {
  let next = state
  for (let i = 0; i < ticks; i++) next = step(next)
  return next
}

/**
 * На каком тике каждая машина оказалась гружёной.
 *
 * Это и есть измеритель пропускной способности узла: очередь не видна в
 * счётчиках напрямую, а вот «когда машина наконец уехала гружёной» — ровно то
 * число, ради которого весь срез и сделан.
 */
function loadedAt(state: GameState, limit: number): Map<VehicleId, number> {
  const at = new Map<VehicleId, number>()
  let next = state

  for (let tick = 1; tick <= limit; tick++) {
    next = step(next)
    for (const id of Object.keys(next.vehicles) as VehicleId[]) {
      if (!at.has(id) && next.vehicles[id].cargo !== null) at.set(id, tick)
    }
  }

  return at
}

const truck = (state: GameState, id: VehicleId) => state.vehicles[id]

// ─── Посты ─────────────────────────────────────────────────────────────────

describe('постов в узле', () => {
  it('без построек узел даёт ровно базовый пост', () => {
    // Один пост — это принципиально: вторая машина на заводе обязана вставать в
    // очередь СРАЗУ, пока сеть ещё маленькая и понятная.
    const state = makeState([makeVehicle(V1, TULA)])

    expect(postsAt(state, TULA, PLAYER)).toBe(BASE_POSTS)
  })

  it('терминал компании добавляет свои посты', () => {
    const state = makeState([makeVehicle(V1, TULA)], {
      buildings: [makeBuilding('term-tula', 'терминал', TULA, PLAYER)],
    })

    expect(postsAt(state, TULA, PLAYER)).toBe(
      BASE_POSTS + BUILDING_SPEC.терминал.posts,
    )
  })

  it('постройка в другом городе постов здесь не добавляет', () => {
    const state = makeState([makeVehicle(V1, TULA)], {
      buildings: [makeBuilding('term-moscow', 'терминал', MOSCOW, PLAYER)],
    })

    expect(postsAt(state, TULA, PLAYER)).toBe(BASE_POSTS)
    expect(postsAt(state, MOSCOW, PLAYER)).toBe(
      BASE_POSTS + BUILDING_SPEC.терминал.posts,
    )
  })

  it('терминал конкурента игроку постов не даёт', () => {
    // Иначе строительство перестало бы быть решением: достаточно дождаться,
    // пока узел застроит кто-нибудь другой.
    const state = makeState([makeVehicle(V1, TULA)], {
      rivalBuildings: [makeBuilding('term-rival', 'терминал', TULA, RIVAL)],
    })

    expect(postsAt(state, TULA, PLAYER)).toBe(BASE_POSTS)
    expect(postsAt(state, TULA, RIVAL)).toBe(
      BASE_POSTS + BUILDING_SPEC.терминал.posts,
    )
  })

  it('компания без реестра построек живёт с базовым постом', () => {
    // Сейв прошлой версии про постройки не знал вовсе. Фаза не должна падать.
    const state = makeState([makeVehicle(V1, TULA)])
    const legacy: GameState = {
      ...state,
      companies: {
        ...state.companies,
        [PLAYER]: {
          ...state.companies[PLAYER],
          buildings: undefined as unknown as Company['buildings'],
        },
      },
    }

    expect(postsAt(legacy, TULA, PLAYER)).toBe(BASE_POSTS)
  })
})

// ─── Время под погрузкой ───────────────────────────────────────────────────

describe('время под погрузкой', () => {
  it('пост перекладывает TONS_PER_POST_HOUR тонн за час', () => {
    expect(serviceTicksFor(TONS_PER_POST_HOUR)).toBe(TICKS_PER_HOUR)
  })

  it('время пропорционально тоннажу', () => {
    // Тяжёлая техника не бесплатно лучше: везёт втрое больше — грузится втрое
    // дольше. Проверяется на кратных партиях, где округление ничего не решает.
    for (const times of [1, 2, 3, 4]) {
      expect(serviceTicksFor(TONS_PER_POST_HOUR * times)).toBe(
        TICKS_PER_HOUR * times,
      )
    }

    const single = serviceTicksFor(TONS_PER_POST_HOUR)
    expect(serviceTicksFor(TONS_PER_POST_HOUR * 3)).toBe(single * 3)
  })

  it('неполный тик округляется вверх, а не отбрасывается', () => {
    // Округление вниз вернуло бы мгновенную погрузку мелких партий, а вместе с
    // ней и способ обойти пропускную способность узла целиком.
    const perTick = TONS_PER_POST_HOUR / TICKS_PER_HOUR

    expect(serviceTicksFor(TONS_PER_POST_HOUR + perTick / 2)).toBe(
      TICKS_PER_HOUR + 1,
    )
    expect(serviceTicksFor(perTick / 100)).toBe(1)
  })

  it('нулевой и битый тоннаж не занимает ни одного тика', () => {
    expect(serviceTicksFor(0)).toBe(0)
    expect(serviceTicksFor(-1)).toBe(0)
    expect(serviceTicksFor(Number.NaN)).toBe(0)
  })
})

// ─── Пропускная способность узла ───────────────────────────────────────────

describe('очередь у одного поста', () => {
  it('две машины на одном посту обслуживаются вдвое дольше одной', () => {
    // ГЛАВНОЕ ЧИСЛЕННОЕ ТРЕБОВАНИЕ СРЕЗА. Пока погрузка была мгновенной, десятая
    // машина на линии стоила столько же, сколько первая. Здесь узел впервые
    // отвечает «нет»: вторая машина ждёт, пока первая освободит рампу.
    const alone = loadedAt(makeState([makeVehicle(V1, TULA)]), LOAD_TICKS * 4)
    expect(alone.get(V1)).toBe(LOAD_TICKS)

    const pair = loadedAt(
      makeState([makeVehicle(V1, TULA), makeVehicle(V2, TULA)]),
      LOAD_TICKS * 4,
    )

    expect(pair.get(V1)).toBe(LOAD_TICKS)
    expect(pair.get(V2)).toBe(LOAD_TICKS * 2)
  })

  it('вторая машина копит очередь, пока первая стоит под погрузкой', () => {
    const state = makeState([makeVehicle(V1, TULA), makeVehicle(V2, TULA)])
    const after = run(state, LOAD_TICKS)

    // Первая отстояла своё и уже гружена — счётчики чистые.
    expect(truck(after, V1).serviceTicksLeft).toBe(0)
    expect(truck(after, V1).queuedTicks).toBe(0)
    expect(truck(after, V1).cargo).not.toBeNull()

    // Вторая всё это время стояла в очереди и не погрузила ни тонны.
    expect(truck(after, V2).cargo).toBeNull()
    expect(truck(after, V2).serviceTicksLeft).toBe(0)
    expect(truck(after, V2).queuedTicks).toBe(LOAD_TICKS)
  })

  it('получив пост, машина обнуляет счётчик ожидания', () => {
    const state = makeState([makeVehicle(V1, TULA), makeVehicle(V2, TULA)])
    // Ещё один тик после освобождения поста — очередь достаётся второй машине.
    const after = run(state, LOAD_TICKS + 1)

    expect(truck(after, V2).queuedTicks).toBe(0)
    expect(truck(after, V2).serviceTicksLeft).toBe(LOAD_TICKS - 1)
  })

  it('три машины на трёх постах обслуживаются без очереди', () => {
    // Три поста: базовый плюс постройка ровно на недостающие. Число построенных
    // постов выведено из BASE_POSTS, а не вписано, — иначе правка данных
    // роняла бы тест, в котором не поменялось ни одного правила.
    const fleet = [
      makeVehicle(V1, TULA),
      makeVehicle(V2, TULA),
      makeVehicle(V3, TULA),
    ]
    const state = makeState(fleet, {
      buildings: [
        makeBuilding(
          'yard-tula',
          'терминал',
          TULA,
          PLAYER,
          Math.max(0, fleet.length - BASE_POSTS),
        ),
      ],
    })

    expect(postsAt(state, TULA, PLAYER)).toBeGreaterThanOrEqual(fleet.length)

    const loaded = loadedAt(state, LOAD_TICKS * 4)
    for (const id of [V1, V2, V3]) expect(loaded.get(id)).toBe(LOAD_TICKS)

    // Ни один тик ожидания ни у кого: очереди не было вовсе.
    const after = run(state, LOAD_TICKS)
    for (const id of [V1, V2, V3]) expect(truck(after, id).queuedTicks).toBe(0)
  })

  it('терминал снимает очередь', () => {
    // Тот же парк, что и в тесте про вдвое дольше, но с терминалом. Это и есть
    // ответ игрока на узкое место: не третья машина, а постройка.
    const fleet = [makeVehicle(V1, TULA), makeVehicle(V2, TULA)]
    const state = makeState(fleet, {
      buildings: [makeBuilding('term-tula', 'терминал', TULA, PLAYER)],
    })

    const loaded = loadedAt(state, LOAD_TICKS * 4)
    expect(loaded.get(V1)).toBe(LOAD_TICKS)
    expect(loaded.get(V2)).toBe(LOAD_TICKS)

    const after = run(state, LOAD_TICKS)
    expect(truck(after, V2).queuedTicks).toBe(0)
  })

  it('остановка с выгрузкой и погрузкой держит пост вдвое дольше', () => {
    // Тонны идут через одну рампу: сначала отдать привезённое, потом взять
    // обратное. Именно поэтому узловые города дорожают первыми — кольцо с двумя
    // гружёными плечами перекладывает на каждой остановке и туда, и обратно.
    const stops: Stop[] = [
      { nodeId: TULA, unload: ['мука'], load: ['зерно'] },
      { nodeId: MOSCOW, unload: ['зерно'], load: ['мука'] },
    ]
    const state = makeState(
      [
        makeVehicle(V1, TULA, {
          lineId: HUB,
          stopIndex: 0,
          cargo: { type: 'мука', tons: ZIL_TONS, originId: MOSCOW },
        }),
      ],
      { lines: [{ id: HUB, name: 'кольцо', stops, assignedVehicles: [V1] }] },
    )

    const after = runService(state)

    // Ожидание считается той же функцией, а не удвоением LOAD_TICKS:
    // округление вверх не дистрибутивно, и при ставке 10 т/час шесть тонн
    // занимают 3 тика, а двенадцать — 5, а не 6.
    expect(truck(after, V1).serviceTicksLeft).toBe(
      serviceTicksFor(ZIL_TONS * 2) - 1,
    )
  })
})

// ─── Порядок ───────────────────────────────────────────────────────────────

describe('порядок обслуживания детерминирован', () => {
  it('пост достаётся тому, кто дольше ждёт', () => {
    // V2 стоит в парке второй, но ждёт дольше — значит заходит на рампу первой.
    // Иначе долго ждущая машина могла бы голодать сколько угодно.
    const state = makeState([
      makeVehicle(V1, TULA),
      makeVehicle(V2, TULA, { queuedTicks: 3 }),
    ])

    const after = runService(state)

    expect(truck(after, V2).serviceTicksLeft).toBe(LOAD_TICKS - 1)
    expect(truck(after, V2).queuedTicks).toBe(0)
    expect(truck(after, V1).serviceTicksLeft).toBe(0)
    expect(truck(after, V1).queuedTicks).toBe(1)
  })

  it('при равном ожидании первым обслуживается тот, кто раньше в парке', () => {
    const state = makeState([makeVehicle(V1, TULA), makeVehicle(V2, TULA)])
    const after = runService(state)

    expect(truck(after, V1).serviceTicksLeft).toBe(LOAD_TICKS - 1)
    expect(truck(after, V2).queuedTicks).toBe(1)
  })

  it('повторный прогон того же состояния даёт тот же результат', () => {
    // Детерминизм тика не должен зависеть ни от чего, кроме состояния.
    const state = makeState([
      makeVehicle(V1, TULA),
      makeVehicle(V2, TULA),
      makeVehicle(V3, TULA),
    ])

    const first = JSON.stringify(run(state, LOAD_TICKS * 3))
    const second = JSON.stringify(run(state, LOAD_TICKS * 3))

    expect(second).toBe(first)
  })
})

// ─── Кому пост не нужен ────────────────────────────────────────────────────

describe('машина без работы в узле', () => {
  it('поста не занимает и очередь не копит', () => {
    // Цистерна зерно не возит: машине у элеватора делать нечего. Стоянка — не
    // простой в очереди, и показывать её игроку как узкое место нельзя.
    const state = makeState([
      makeVehicle(V1, TULA, { trailer: 'цистерна' }),
      makeVehicle(V2, TULA),
    ])

    const after = runService(state)

    expect(truck(after, V1).serviceTicksLeft).toBe(0)
    expect(truck(after, V1).queuedTicks).toBe(0)
    // Единственный пост достался той машине, которой он нужен, хотя в парке
    // она вторая.
    expect(truck(after, V2).serviceTicksLeft).toBe(LOAD_TICKS - 1)
  })

  it('машина, уже гружённая здесь же, поста не занимает', () => {
    // Взять обратно свой же груз нельзя, отдать его в городе погрузки — тоже.
    const state = makeState([
      makeVehicle(V1, TULA, {
        cargo: { type: 'зерно', tons: ZIL_TONS, originId: TULA },
      }),
      makeVehicle(V2, TULA),
    ])

    const after = runService(state)

    expect(truck(after, V1).serviceTicksLeft).toBe(0)
    expect(truck(after, V1).queuedTicks).toBe(0)
    expect(truck(after, V2).serviceTicksLeft).toBe(LOAD_TICKS - 1)
  })

  it('машина на линии, стоящая не на своей остановке, поста не занимает', () => {
    // Линия сказала «здесь работы нет», и подменять её решение автоматикой
    // значит стирать разницу между спроектированной сетью и «вози что дают».
    const stops: Stop[] = [
      { nodeId: MOSCOW, unload: [], load: ['зерно'] },
      { nodeId: KALUGA, unload: ['зерно'], load: [] },
    ]
    const state = makeState([makeVehicle(V1, TULA, { lineId: AWAY })], {
      lines: [{ id: AWAY, name: 'мимо Тулы', stops, assignedVehicles: [V1] }],
    })

    const after = runService(state)

    expect(truck(after, V1).serviceTicksLeft).toBe(0)
    expect(truck(after, V1).queuedTicks).toBe(0)
  })

  it('пустой склад не создаёт ни погрузки, ни очереди', () => {
    const state = makeState([makeVehicle(V1, TULA), makeVehicle(V2, TULA)], {
      grain: 0,
    })

    const after = run(state, LOAD_TICKS * 2)

    for (const id of [V1, V2]) {
      expect(truck(after, id).cargo).toBeNull()
      expect(truck(after, id).serviceTicksLeft).toBe(0)
      expect(truck(after, id).queuedTicks).toBe(0)
    }
  })

  it('машина в пути обслуживания не проходит, а счётчики обнуляются', () => {
    // Ненулевой счётчик у едущей машины — след битого сейва. Оставить его
    // нельзя: пока он больше нуля, диспетчеризация машину не трогает.
    const state = makeState([
      makeVehicle(V1, TULA, {
        position: {
          kind: 'ребро',
          edgeId: TEST_EDGE.id,
          fromId: MOSCOW,
          progress: 0.5,
        },
        serviceTicksLeft: 5,
        queuedTicks: 7,
      }),
    ])

    const after = runService(state)

    expect(truck(after, V1).serviceTicksLeft).toBe(0)
    expect(truck(after, V1).queuedTicks).toBe(0)
  })
})

// ─── Чистота ───────────────────────────────────────────────────────────────

describe('чистота фазы', () => {
  it('не мутирует вход ни на одном уровне вложенности', () => {
    const state = makeState(
      [
        makeVehicle(V1, TULA),
        makeVehicle(V2, TULA),
        makeVehicle(V3, TULA, { queuedTicks: 2 }),
      ],
      { buildings: [makeBuilding('term-tula', 'терминал', TULA, PLAYER)] },
    )

    deepFreeze(state)
    const snapshot = JSON.stringify(state)

    const after = runService(state)

    expect(JSON.stringify(state)).toBe(snapshot)
    expect(after).not.toBe(state)
  })

  it('возвращает то же состояние по ссылке, когда ничего не изменилось', () => {
    // Ни лишних копий, ни лишних перерисовок интерфейса: у машин без работы
    // счётчики и так нулевые.
    const state = makeState([makeVehicle(V1, TULA), makeVehicle(V2, MOSCOW)], {
      grain: 0,
    })

    expect(runService(state)).toBe(state)
  })

  it('нетронутые машины остаются прежними объектами', () => {
    const state = makeState([makeVehicle(V1, TULA), makeVehicle(V2, MOSCOW)])
    const after = runService(state)

    // V1 встала под погрузку — она новая. V2 стоит в чужом городе без работы,
    // и пересоздавать её незачем.
    expect(truck(after, V1)).not.toBe(truck(state, V1))
    expect(truck(after, V2)).toBe(truck(state, V2))
  })
})
