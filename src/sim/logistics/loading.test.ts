import { describe, expect, it } from 'vitest'
import { deliveryRevenue } from '../economy/finance'
import { CONSUMPTION_PER_1K, RECIPE_BY_INDUSTRY } from '../../data/recipes'
import { STOCK_DAYS, stockCapacity } from '../economy/production'
import {
  cityId,
  companyId,
  edgeId,
  industryId,
  lineId,
  vehicleId,
} from '../types'
import type {
  CargoType,
  City,
  CityId,
  Company,
  CompanyId,
  GameState,
  Industry,
  IndustryId,
  IndustryType,
  Edge,
  EdgeId,
  Line,
  LineId,
  Stop,
  Tons,
  Vehicle,
  VehicleId,
} from '../types'
import { CITY_STOCK_DAYS, cityCapacity, runArrivals } from './loading'

/**
 * Мир в этих тестах синтетический и намеренно крошечный: один-два города,
 * одно-два предприятия. Настоящие данные из src/data сюда не тянутся — состав
 * предприятий пишет другой модуль, и тест погрузки не должен падать оттого, что
 * элеватор переехал в соседний город.
 *
 * ЧИСЛА ВЫВОДЯТСЯ ИЗ КОНСТАНТ, а не вписываются посчитанными. Вместимости
 * спрашиваются у stockCapacity и cityCapacity, выручка — у deliveryRevenue,
 * население подбирается формулой под нужный тоннаж. Перебалансировка данных
 * (ставки, нормы потребления, суточные мощности) обязана менять поведение игры,
 * но не ронять тесты, в которых не поменялось ни одно ПРАВИЛО.
 *
 * Расстояния — настоящие: 185 км это Москва — Тула по М-2 «Крым».
 */

const MOSCOW = cityId('moscow')
const TULA = cityId('tula')
const KALUGA = cityId('kaluga')

const PLAYER: CompanyId = companyId('player')
const V1: VehicleId = vehicleId('v1')
const V2: VehicleId = vehicleId('v2')

const RING: LineId = lineId('ring')

/** Реальное плечо Москва — Тула. */
const LEG_KM = 185

/**
 * Дороги синтетического мира.
 *
 * Понадобились с тех пор, как выручка считается по ТАРИФНОМУ расстоянию —
 * кратчайшему пути от места погрузки до места выгрузки, а не по одометру.
 * Без рёбер граф пуст, кратчайшего пути нет, и любая доставка оказывается
 * бесплатной. Длины настоящие, из src/data/roads.ts.
 */
const TEST_EDGES: Edge[] = [
  {
    id: edgeId('moscow-tula'),
    from: MOSCOW,
    to: TULA,
    km: LEG_KM,
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
]

/** Грузоподъёмность ЗИЛ-130 — стартовой машины партии. */
const ZIL_TONS = 6

/**
 * Расход ЗИЛ-130, л/100 км.
 *
 * На фазу прибытия не влияет никак: топливо жжёт фаза расходов. Но поле
 * обязательное, и держать его правдоподобным дешевле, чем потом гадать, откуда
 * в отладке нули.
 */
const ZIL_FUEL_PER_100KM = 30

/**
 * Население, при котором городской склад вмещает полный кузов этого груза.
 *
 * Выводится из норм потребления, а не подбирается на глаз. Тестам про линии
 * нужен город, способный принять всю ходку целиком: прими он половину, остаток
 * остался бы в кузове, машина не смогла бы взять обратную загрузку, и тест
 * порожнего пробега показывал бы не то, что проверяет. Двойной запас — чтобы
 * умеренная правка CONSUMPTION_PER_1K не превращала тест про пробег в тест про
 * вместимость.
 */
function popForFullTruck(cargo: CargoType): number {
  const perDayPer1k = CONSUMPTION_PER_1K[cargo] ?? 0
  return Math.ceil((2 * ZIL_TONS * 1000) / (perDayPer1k * CITY_STOCK_DAYS))
}

const FLOUR_CITY_POP = popForFullTruck('мука')

function makeCity(
  id: CityId,
  population: number,
  stock: Partial<Record<CargoType, Tons>> = {},
): City {
  return {
    id,
    name: id,
    coord: { lat: 55, lon: 37 },
    population,
    profile: 'промышленный',
    stock,
    suppliedDays: 0,
  }
}

function makeIndustry(
  id: string,
  type: IndustryType,
  city: CityId,
  stock: Partial<Record<CargoType, Tons>> = {},
): Industry {
  return {
    id: industryId(id),
    type,
    cityId: city,
    stock,
    utilization: 1,
    idleTicks: 0,
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
    cruiseKmh: 70,
    fuelPer100Km: ZIL_FUEL_PER_100KM,
    odometer: 0,
    capacity: ZIL_TONS,
    cargo: null,
    loadedKm: 0,
    emptyKm: 0,
    ...patch,
  }
}

/** Остановка линии. Пустые списки — законное состояние, см. types.ts. */
function makeStop(
  nodeId: CityId,
  unload: CargoType[] = [],
  load: CargoType[] = [],
): Stop {
  return { nodeId, unload, load }
}

function makeLine(id: LineId, stops: Stop[], vehicles: VehicleId[] = []): Line {
  return { id, name: id, stops, assignedVehicles: vehicles }
}

function makeState(
  cities: City[],
  industries: Industry[],
  vehicles: Vehicle[],
  money = 0,
  lines: Line[] = [],
): GameState {
  const player: Company = {
    id: PLAYER,
    name: 'Игрок',
    money,
    controller: 'человек',
    lines: Object.fromEntries(lines.map((l) => [l.id, l])) as Record<
      LineId,
      Line
    >,
    dailyRevenue: 0,
    dailyCosts: 0,
    bankrupt: false,
    daysInDebt: 0,
  }

  return {
    rngState: 1,
    tick: 0,
    startYear: 1994,
    world: {
      cities: Object.fromEntries(cities.map((c) => [c.id, c])) as Record<
        CityId,
        City
      >,
      edges: Object.fromEntries(TEST_EDGES.map((e) => [e.id, e])) as Record<EdgeId, Edge>,
      industries: Object.fromEntries(industries.map((i) => [i.id, i])) as Record<
        IndustryId,
        Industry
      >,
    },
    companies: { [PLAYER]: player },
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

/**
 * Имитация фаз диспетчеризации и движения между остановками.
 *
 * Километры разносятся по счетам ровно так же, как это делает advanceVehicle:
 * гружёная машина копит loadedKm, порожняя — emptyKm. Прежде счета закрывала
 * фаза прибытия, и здесь достаточно было двигать одометр; теперь это работа
 * движения, и подменять её хелпером, который так не делает, значит проверять
 * несуществующее поведение.
 *
 * `stopIndex` двигается здесь же, потому что за него отвечает диспетчеризация
 * (logistics/line.ts): к моменту прибытия индекс показывает ту остановку, на
 * которой машина стоит. Настоящий advanceLineVehicles сюда не зовётся нарочно —
 * тест погрузки не должен падать из-за чужого модуля.
 */
function drive(
  vehicle: Vehicle,
  km: number,
  to: CityId,
  stopIndex: number = vehicle.stopIndex,
): Vehicle {
  const carrying = vehicle.cargo !== null
  return {
    ...vehicle,
    odometer: vehicle.odometer + km,
    loadedKm: vehicle.loadedKm + (carrying ? km : 0),
    emptyKm: vehicle.emptyKm + (carrying ? 0 : km),
    position: { kind: 'узел', nodeId: to },
    stopIndex,
  }
}

/** Состояние с одной подменённой машиной — остальное по ссылке. */
function withVehicle(state: GameState, vehicle: Vehicle): GameState {
  return {
    ...state,
    vehicles: { ...state.vehicles, [vehicle.id]: vehicle },
  }
}

const money = (state: GameState) => state.companies[PLAYER].money
const truck = (state: GameState, id: VehicleId = V1) => state.vehicles[id]
const plant = (state: GameState, id: string) =>
  state.world.industries[industryId(id)]

describe('вместимость складов', () => {
  it('погрузка использует потолок склада из производства, а не свой', () => {
    // Правило переполнения в игре одно и живёт в economy/production.ts.
    // Здесь проверяется, что погрузка сверяется именно с ним: разойдись эти
    // числа, завод душился бы на одном, а машины сыпали бы в него до другого.
    const mill = makeIndustry('mill', 'мукомольный', TULA)
    const recipe = RECIPE_BY_INDUSTRY['мукомольный']
    const grainPerTon = recipe.inputs[0].perUnit

    expect(stockCapacity(mill, 'мука')).toBeCloseTo(
      recipe.dailyRate * STOCK_DAYS,
      9,
    )
    expect(stockCapacity(mill, 'зерно')).toBeCloseTo(
      recipe.dailyRate * grainPerTon * STOCK_DAYS,
      9,
    )
    // Чужой груз на склад не ляжет ни при каких условиях.
    expect(stockCapacity(mill, 'нефть')).toBe(0)
  })

  it('склад города растёт вместе с населением', () => {
    const small = makeCity(TULA, 100_000)
    const big = makeCity(MOSCOW, 1_000_000)

    expect(cityCapacity(small, 'мука')).toBeCloseTo(
      100 * (CONSUMPTION_PER_1K['мука'] ?? 0) * CITY_STOCK_DAYS,
      9,
    )
    expect(cityCapacity(big, 'мука')).toBeCloseTo(10 * cityCapacity(small, 'мука'), 9)

    // Сырьё городу не нужно — его негде хранить и незачем.
    expect(cityCapacity(big, 'зерно')).toBe(0)
  })
})

describe('runArrivals: разгрузка', () => {
  it('гружёная машина разгружается на подходящем предприятии и получает деньги', () => {
    const state = makeState(
      [makeCity(TULA, 100_000)],
      [makeIndustry('mill', 'мукомольный', TULA)],
      [
        makeVehicle(V1, TULA, {
          cargo: { type: 'зерно', tons: ZIL_TONS, originId: MOSCOW },
          odometer: LEG_KM,
        }),
      ],
    )

    const after = runArrivals(state)

    expect(plant(after, 'mill').stock['зерно']).toBeCloseTo(ZIL_TONS, 9)
    expect(truck(after).cargo).toBeNull()
    // 6 т зерна на 185 км — около 5 157 руб при нынешних ставках.
    expect(money(after)).toBeCloseTo(deliveryRevenue('зерно', ZIL_TONS, LEG_KM), 9)
    expect(money(after)).toBeGreaterThan(0)
  })

  it('город принимает потребительский товар', () => {
    const state = makeState(
      [makeCity(MOSCOW, FLOUR_CITY_POP)],
      [],
      [
        makeVehicle(V1, MOSCOW, {
          cargo: { type: 'мука', tons: ZIL_TONS, originId: TULA },
          odometer: LEG_KM,
        }),
      ],
    )

    const after = runArrivals(state)

    expect(after.world.cities[MOSCOW].stock['мука']).toBeCloseTo(ZIL_TONS, 9)
    expect(truck(after).cargo).toBeNull()
    expect(money(after)).toBeCloseTo(deliveryRevenue('мука', ZIL_TONS, LEG_KM), 9)
  })

  it('машина с грузом, который здесь никому не нужен, стоит гружёной', () => {
    // В Калуге только НПЗ: ему нужна нефть, а зерно город не потребляет.
    const state = makeState(
      [makeCity(KALUGA, 100_000)],
      [makeIndustry('refinery', 'НПЗ', KALUGA)],
      [
        makeVehicle(V1, KALUGA, {
          cargo: { type: 'зерно', tons: ZIL_TONS, originId: MOSCOW },
          odometer: LEG_KM,
        }),
      ],
    )

    const after = runArrivals(state)

    // Ничего не произошло вообще — состояние даже не пересобиралось.
    expect(truck(after).cargo).not.toBeNull()
    expect(truck(after).cargo).toMatchObject({ type: 'зерно', tons: ZIL_TONS })
    expect(money(after)).toBe(0)
    // Километры плеча не разнесены: за них ещё не заплачено.
    expect(truck(after).loadedKm).toBe(0)
  })

  it('сырьё имеет приоритет: полный склад пропускается ради соседнего предприятия', () => {
    // Первый мукомольный задохнулся зерном, второй голодает. Машина обязана
    // найти второго, а не встать в очередь к первому.
    const grainRoom = stockCapacity(
      makeIndustry('probe', 'мукомольный', TULA),
      'зерно',
    )
    const state = makeState(
      [makeCity(TULA, 100_000)],
      [
        makeIndustry('mill-full', 'мукомольный', TULA, { 'зерно': grainRoom }),
        makeIndustry('mill-hungry', 'мукомольный', TULA),
      ],
      [
        makeVehicle(V1, TULA, {
          cargo: { type: 'зерно', tons: ZIL_TONS, originId: MOSCOW },
          odometer: LEG_KM,
        }),
      ],
    )

    const after = runArrivals(state)

    expect(plant(after, 'mill-full').stock['зерно']).toBe(grainRoom)
    expect(plant(after, 'mill-hungry').stock['зерно']).toBeCloseTo(ZIL_TONS, 9)
  })

  it('в переполненный склад ложится сколько влезет, остаток едет дальше', () => {
    // На складе не хватает места ровно на половину кузова.
    const grainRoom = stockCapacity(
      makeIndustry('probe', 'мукомольный', TULA),
      'зерно',
    )
    const fits = ZIL_TONS / 2
    const state = makeState(
      [makeCity(TULA, 100_000)],
      [makeIndustry('mill', 'мукомольный', TULA, { 'зерно': grainRoom - fits })],
      [
        makeVehicle(V1, TULA, {
          cargo: { type: 'зерно', tons: ZIL_TONS, originId: MOSCOW },
          odometer: LEG_KM,
        }),
      ],
    )

    const after = runArrivals(state)

    expect(plant(after, 'mill').stock['зерно']).toBeCloseTo(grainRoom, 9)
    expect(truck(after).cargo).toMatchObject({ type: 'зерно', tons: fits })
    // Платят ровно за доставленное, а не за то, что было в кузове.
    expect(money(after)).toBeCloseTo(deliveryRevenue('зерно', fits, LEG_KM), 9)
  })

  it('нет получателя вовсе — деньги не начисляются', () => {
    const state = makeState(
      [makeCity(TULA, 100_000)],
      [],
      [
        makeVehicle(V1, TULA, {
          cargo: { type: 'кругляк', tons: ZIL_TONS, originId: MOSCOW },
          odometer: LEG_KM,
        }),
      ],
    )

    expect(money(runArrivals(state))).toBe(0)
  })
})

describe('runArrivals: погрузка', () => {
  it('пустая машина грузится готовой продукцией предприятия', () => {
    const state = makeState(
      [makeCity(TULA, 100_000)],
      [makeIndustry('elevator', 'элеватор', TULA, { 'зерно': 100 })],
      // Порожний пробег до погрузки уже разнесён фазой движения — прибытие
      // счётчики не трогает и трогать не должно.
      [makeVehicle(V1, TULA, { odometer: LEG_KM, emptyKm: LEG_KM })],
    )

    const after = runArrivals(state)

    expect(truck(after).cargo).toMatchObject({ type: 'зерно', tons: ZIL_TONS })
    expect(plant(after, 'elevator').stock['зерно']).toBeCloseTo(100 - ZIL_TONS, 9)
    expect(truck(after).emptyKm).toBeCloseTo(LEG_KM, 9)
    expect(truck(after).loadedKm).toBe(0)
  })

  it('грузится не больше грузоподъёмности', () => {
    const state = makeState(
      [makeCity(TULA, 100_000)],
      [makeIndustry('elevator', 'элеватор', TULA, { 'зерно': 180 })],
      [makeVehicle(V1, TULA)],
    )

    const after = runArrivals(state)

    expect(truck(after).cargo?.tons).toBeCloseTo(ZIL_TONS, 9)
    expect(plant(after, 'elevator').stock['зерно']).toBeCloseTo(180 - ZIL_TONS, 9)
  })

  it('грузится не больше того, что есть на складе', () => {
    const state = makeState(
      [makeCity(TULA, 100_000)],
      [makeIndustry('elevator', 'элеватор', TULA, { 'зерно': 2 })],
      [makeVehicle(V1, TULA)],
    )

    const after = runArrivals(state)

    expect(truck(after).cargo).toMatchObject({ type: 'зерно', tons: 2 })
    expect(plant(after, 'elevator').stock['зерно']).toBeCloseTo(0, 9)
  })

  it('пустой склад машину не грузит', () => {
    const state = makeState(
      [makeCity(TULA, 100_000)],
      [makeIndustry('elevator', 'элеватор', TULA)],
      [makeVehicle(V1, TULA)],
    )

    expect(truck(runArrivals(state)).cargo).toBeNull()
  })

  it('берёт только готовую продукцию, а не сырьё со склада переработки', () => {
    // На складе мукомольного лежит зерно (сырьё) и мука (продукция). Взять
    // можно только муку — иначе машины возили бы сырьё по кругу между заводами.
    const state = makeState(
      [makeCity(TULA, 100_000)],
      [makeIndustry('mill', 'мукомольный', TULA, { 'зерно': 100, 'мука': 50 })],
      [makeVehicle(V1, TULA)],
    )

    const after = runArrivals(state)

    expect(truck(after).cargo).toMatchObject({ type: 'мука', tons: ZIL_TONS })
    expect(plant(after, 'mill').stock['зерно']).toBe(100)
  })
})

describe('runArrivals: разгрузка раньше погрузки', () => {
  it('не грузится сырьём, которое сама же привезла', () => {
    // Машина привозит зерно на мукомольный. После разгрузки на складе лежит её
    // же зерно, и наивная погрузка «бери что есть» увезла бы его обратно.
    const state = makeState(
      [makeCity(TULA, 100_000)],
      [makeIndustry('mill', 'мукомольный', TULA)],
      [
        makeVehicle(V1, TULA, {
          cargo: { type: 'зерно', tons: ZIL_TONS, originId: MOSCOW },
          odometer: LEG_KM,
        }),
      ],
    )

    const after = runArrivals(state)

    expect(plant(after, 'mill').stock['зерно']).toBeCloseTo(ZIL_TONS, 9)
    expect(truck(after).cargo).toBeNull()
  })

  it('разворачивается за один тик: отдал сырьё, взял продукцию', () => {
    const state = makeState(
      [makeCity(TULA, 100_000)],
      [makeIndustry('mill', 'мукомольный', TULA, { 'мука': 50 })],
      [
        makeVehicle(V1, TULA, {
          cargo: { type: 'зерно', tons: ZIL_TONS, originId: MOSCOW },
          odometer: LEG_KM,
        }),
      ],
    )

    const after = runArrivals(state)

    expect(plant(after, 'mill').stock['зерно']).toBeCloseTo(ZIL_TONS, 9)
    expect(plant(after, 'mill').stock['мука']).toBeCloseTo(50 - ZIL_TONS, 9)
    expect(truck(after).cargo).toMatchObject({ type: 'мука', tons: ZIL_TONS })
    // Плечо оплачено один раз — за привезённое зерно.
    expect(money(after)).toBeCloseTo(deliveryRevenue('зерно', ZIL_TONS, LEG_KM), 9)
  })

  it('гружёная машина не догружается поверх своего груза', () => {
    // Груза для неё в Калуге нет, но есть готовая продукция нефтебазы. Кузов
    // занят — значит занят.
    const state = makeState(
      [makeCity(KALUGA, 100_000)],
      [makeIndustry('depot', 'нефтебаза', KALUGA, { 'нефть': 100 })],
      [
        makeVehicle(V1, KALUGA, {
          cargo: { type: 'зерно', tons: 2, originId: MOSCOW },
          odometer: LEG_KM,
        }),
      ],
    )

    const after = runArrivals(state)

    expect(truck(after).cargo).toMatchObject({ type: 'зерно', tons: 2 })
    expect(plant(after, 'depot').stock['нефть']).toBe(100)
  })
})

describe('runArrivals: километры и метрика пробега', () => {
  it('платят по ТАРИФНОМУ расстоянию, а одометр на выручку не влияет', () => {
    // Ядро защиты экономики от накрутки. Две машины везут одинаковый груз по
    // одному плечу Тула → Москва, но вторая перед этим намотала лишнюю тысячу
    // километров кругами. Заплатить обязаны одинаково.
    const honest = makeState(
      [makeCity(MOSCOW, FLOUR_CITY_POP)],
      [],
      [
        makeVehicle(V1, MOSCOW, {
          cargo: { type: 'мука', tons: ZIL_TONS, originId: TULA },
          odometer: LEG_KM,
        }),
      ],
    )
    const looping = makeState(
      [makeCity(MOSCOW, FLOUR_CITY_POP)],
      [],
      [
        makeVehicle(V1, MOSCOW, {
          cargo: { type: 'мука', tons: ZIL_TONS, originId: TULA },
          odometer: LEG_KM + 1000,
        }),
      ],
    )

    expect(money(runArrivals(honest))).toBeCloseTo(
      deliveryRevenue('мука', ZIL_TONS, LEG_KM),
      9,
    )
    expect(money(runArrivals(looping))).toBeCloseTo(money(runArrivals(honest)), 9)
  })

  it('сдать груз в городе, где его и взяли, нельзя', () => {
    // Кольцо с возвратом домой раньше оплачивалось как настоящий рейс, а город
    // при этом снабжался даром. Теперь такой машине просто некому сдать груз.
    const state = makeState(
      [makeCity(TULA, 100_000)],
      [makeIndustry('mill', 'мукомольный', TULA)],
      [
        makeVehicle(V1, TULA, {
          cargo: { type: 'зерно', tons: ZIL_TONS, originId: TULA },
          odometer: 500,
        }),
      ],
    )

    const after = runArrivals(state)

    expect(truck(after).cargo).not.toBeNull()
    expect(money(after)).toBe(0)
    expect(plant(after, 'mill').stock['зерно'] ?? 0).toBe(0)
  })

  it('прибытие не трогает счётчики пробега — это работа движения', () => {
    const state = makeState(
      [makeCity(TULA, 100_000)],
      [],
      [makeVehicle(V1, TULA, { odometer: LEG_KM, emptyKm: LEG_KM })],
    )

    const after = runArrivals(state)

    expect(truck(after).emptyKm).toBe(LEG_KM)
    expect(truck(after).loadedKm).toBe(0)
  })

  it('за круговой рейс сумма счётчиков сходится с одометром', () => {
    // Тула → Москва гружёной, обратно порожней. Это и есть та самая метрика
    // порожнего пробега, вокруг которой строится вся оптимизация.
    const state = makeState(
      [makeCity(TULA, 100_000), makeCity(MOSCOW, FLOUR_CITY_POP)],
      [makeIndustry('mill', 'мукомольный', TULA, { 'мука': 100 })],
      [makeVehicle(V1, TULA)],
    )

    const loaded = runArrivals(state)
    expect(truck(loaded).cargo).toMatchObject({ type: 'мука', tons: ZIL_TONS })

    // Едем в Москву гружёными.
    const delivered = runArrivals(
      withVehicle(loaded, drive(truck(loaded), LEG_KM, MOSCOW)),
    )
    expect(truck(delivered).cargo).toBeNull()

    // Возвращаемся порожняком.
    const home = runArrivals(
      withVehicle(delivered, drive(truck(delivered), LEG_KM, TULA)),
    )

    const v = truck(home)
    expect(v.loadedKm).toBeCloseTo(LEG_KM, 9)
    expect(v.emptyKm).toBeCloseTo(LEG_KM, 9)
    expect(v.loadedKm + v.emptyKm).toBeCloseTo(v.odometer, 9)
    // Половина пути вхолостую — ровно то, что игрок обязан научиться убирать.
    expect(v.emptyKm / v.odometer).toBeCloseTo(0.5, 9)
  })
})

// ─── Линии ─────────────────────────────────────────────────────────────────

describe('runArrivals: машина на линии', () => {
  /**
   * Кольцо из двух остановок, на котором построена половина тестов ниже.
   *
   * Тула: элеватор отдаёт зерно, город принимает муку.
   * Москва: мукомольный принимает зерно и отдаёт муку.
   *
   * То есть гружёными могут быть ОБА плеча — и именно этого игра требует от
   * игрока. Ломая инструкцию одной остановки, тесты показывают, во что это
   * обходится в километрах.
   */
  function ringState(moscowLoad: CargoType[] = ['мука']): GameState {
    return makeState(
      [makeCity(TULA, FLOUR_CITY_POP), makeCity(MOSCOW, 100_000)],
      [
        makeIndustry('elevator', 'элеватор', TULA, { 'зерно': 100 }),
        makeIndustry('mill', 'мукомольный', MOSCOW, { 'мука': 100 }),
      ],
      [makeVehicle(V1, TULA, { lineId: RING, stopIndex: 0 })],
      0,
      [
        makeLine(
          RING,
          [
            makeStop(TULA, ['мука'], ['зерно']),
            makeStop(MOSCOW, ['зерно'], moscowLoad),
          ],
          [V1],
        ),
      ],
    )
  }

  it('выгружает ровно то, что указано в остановке', () => {
    const state = makeState(
      [makeCity(TULA, 100_000)],
      [makeIndustry('mill', 'мукомольный', TULA)],
      [
        makeVehicle(V1, TULA, {
          lineId: RING,
          stopIndex: 0,
    blockedTicks: 0,
          cargo: { type: 'зерно', tons: ZIL_TONS, originId: MOSCOW },
          odometer: LEG_KM,
        }),
      ],
      0,
      [makeLine(RING, [makeStop(TULA, ['зерно']), makeStop(MOSCOW)], [V1])],
    )

    const after = runArrivals(state)

    expect(plant(after, 'mill').stock['зерно']).toBeCloseTo(ZIL_TONS, 9)
    expect(truck(after).cargo).toBeNull()
    expect(money(after)).toBeCloseTo(deliveryRevenue('зерно', ZIL_TONS, LEG_KM), 9)
  })

  it('не выгружает того, чего в инструкции нет, даже если груз здесь ждут', () => {
    // Мукомольный в Туле голоден, и автоматика разового рейса отдала бы ему
    // зерно. Но остановка велит везти дальше — значит везём дальше. Без этого
    // сквозное плечо через город-переработчик было бы невозможно: машину
    // разбирали бы на полпути.
    const state = makeState(
      [makeCity(TULA, 100_000)],
      [makeIndustry('mill', 'мукомольный', TULA)],
      [
        makeVehicle(V1, TULA, {
          lineId: RING,
          stopIndex: 0,
    blockedTicks: 0,
          cargo: { type: 'зерно', tons: ZIL_TONS, originId: MOSCOW },
          odometer: LEG_KM,
        }),
      ],
      0,
      [makeLine(RING, [makeStop(TULA, ['мука']), makeStop(MOSCOW)], [V1])],
    )

    const after = runArrivals(state)

    // Не сделано ничего — состояние даже не пересобиралось.
    expect(truck(after).cargo).not.toBeNull()
    expect(truck(after).cargo).toMatchObject({ type: 'зерно', tons: ZIL_TONS })
    expect(plant(after, 'mill').stock['зерно'] ?? 0).toBe(0)
    expect(money(after)).toBe(0)
  })

  it('грузит по списку и соблюдает его порядок как приоритет', () => {
    // В городе есть и зерно, и мука. Элеватор стоит в данных ПЕРВЫМ, поэтому
    // автоматика взяла бы зерно всегда — и совпадение с порядком списка не
    // доказывало бы ничего. Доказывает переворот: меняем список местами и
    // получаем другой груз.
    const build = (load: CargoType[]) =>
      makeState(
        [makeCity(TULA, 100_000)],
        [
          makeIndustry('elevator', 'элеватор', TULA, { 'зерно': 100 }),
          makeIndustry('mill', 'мукомольный', TULA, { 'мука': 100 }),
        ],
        [makeVehicle(V1, TULA, { lineId: RING, stopIndex: 0 })],
        0,
        [makeLine(RING, [makeStop(TULA, [], load), makeStop(MOSCOW)], [V1])],
      )

    expect(truck(runArrivals(build(['мука', 'зерно']))).cargo).toMatchObject({
      type: 'мука',
      tons: ZIL_TONS,
    })
    expect(truck(runArrivals(build(['зерно', 'мука']))).cargo).toMatchObject({
      type: 'зерно',
      tons: ZIL_TONS,
    })
  })

  it('второй груз в списке берётся, когда первого в городе нет', () => {
    const state = makeState(
      [makeCity(TULA, 100_000)],
      [makeIndustry('elevator', 'элеватор', TULA, { 'зерно': 100 })],
      [makeVehicle(V1, TULA, { lineId: RING, stopIndex: 0 })],
      0,
      [
        makeLine(
          RING,
          [makeStop(TULA, [], ['топливо', 'зерно']), makeStop(MOSCOW)],
          [V1],
        ),
      ],
    )

    expect(truck(runArrivals(state)).cargo).toMatchObject({ type: 'зерно' })
  })

  it('велено грузить то, чего здесь нет, — уходит порожней, и это не ошибка', () => {
    // Обратная связь вместо подсказки: игрок увидит порожний пробег в отчёте и
    // поймёт, что спроектировал линию плохо. Подсунуть «хоть что-нибудь»
    // значило бы стереть разницу между продуманной сетью и случайной.
    const state = makeState(
      [makeCity(TULA, 100_000)],
      [makeIndustry('elevator', 'элеватор', TULA, { 'зерно': 100 })],
      [makeVehicle(V1, TULA, { lineId: RING, stopIndex: 0 })],
      0,
      [
        makeLine(
          RING,
          [makeStop(TULA, [], ['пиломатериалы']), makeStop(MOSCOW)],
          [V1],
        ),
      ],
    )

    const after = runArrivals(state)

    expect(after).toBe(state)
    expect(truck(after).cargo).toBeNull()
    expect(plant(after, 'elevator').stock['зерно']).toBe(100)
  })

  it('пустой список погрузки оставляет машину порожней', () => {
    const state = makeState(
      [makeCity(TULA, 100_000)],
      [makeIndustry('elevator', 'элеватор', TULA, { 'зерно': 100 })],
      [makeVehicle(V1, TULA, { lineId: RING, stopIndex: 0 })],
      0,
      [makeLine(RING, [makeStop(TULA), makeStop(MOSCOW)], [V1])],
    )

    expect(truck(runArrivals(state)).cargo).toBeNull()
  })

  it('не забирает груз с городского склада', () => {
    // Город — конечный потребитель. Разреши забрать привезённое обратно, и
    // одна и та же партия муки оплачивалась бы столько раз, сколько у игрока
    // хватит терпения возить её между городами.
    const state = makeState(
      [makeCity(TULA, FLOUR_CITY_POP, { 'мука': 50 })],
      [],
      [makeVehicle(V1, TULA, { lineId: RING, stopIndex: 0 })],
      0,
      [makeLine(RING, [makeStop(TULA, [], ['мука']), makeStop(MOSCOW)], [V1])],
    )

    const after = runArrivals(state)

    expect(truck(after).cargo).toBeNull()
    expect(after.world.cities[TULA].stock['мука']).toBe(50)
  })

  it('в городе, которого нет в кольце, машина на линии не делает ничего', () => {
    // Транзитный узел или ручной перегон. Автоматика здесь означала бы, что
    // линия перестаёт быть инструкцией, стоит машине встать не там.
    const state = makeState(
      [makeCity(TULA, 100_000)],
      [makeIndustry('elevator', 'элеватор', TULA, { 'зерно': 100 })],
      [makeVehicle(V1, TULA, { lineId: RING, stopIndex: 0 })],
      0,
      [makeLine(RING, [makeStop(MOSCOW, [], ['мука']), makeStop(KALUGA)], [V1])],
    )

    const after = runArrivals(state)

    expect(after).toBe(state)
    expect(truck(after).cargo).toBeNull()
  })

  it('инструкция читается от stopIndex, а не от начала кольца', () => {
    // Тула стоит в кольце дважды: по дороге туда там грузятся, по дороге
    // обратно — сдают. Из двух одноимённых остановок правильная всегда
    // ближайшая ВПЕРЁД по ходу линии, иначе узловая база работает только в
    // одну сторону.
    const line = makeLine(
      RING,
      [
        makeStop(TULA, [], ['зерно']),
        makeStop(MOSCOW, ['зерно'], ['мука']),
        makeStop(TULA, ['мука'], []),
      ],
      [V1],
    )
    const state = makeState(
      [makeCity(TULA, FLOUR_CITY_POP)],
      [makeIndustry('elevator', 'элеватор', TULA, { 'зерно': 100 })],
      [
        makeVehicle(V1, TULA, {
          lineId: RING,
          stopIndex: 2,
          cargo: { type: 'мука', tons: ZIL_TONS, originId: MOSCOW },
          odometer: LEG_KM,
        }),
      ],
      0,
      [line],
    )

    const after = runArrivals(state)

    // Сработала третья остановка: муку сдали, зерно не брали.
    expect(after.world.cities[TULA].stock['мука']).toBeCloseTo(ZIL_TONS, 9)
    expect(truck(after).cargo).toBeNull()
    expect(plant(after, 'elevator').stock['зерно']).toBe(100)
  })

  it('недостроенная линия из одной остановки — тоже режим разовых рейсов', () => {
    // Кольца из одной остановки не бывает (types.ts), работать по такой линии
    // нельзя. Правило одно на оба случая: нет РАБОЧЕЙ линии — работает
    // автоматика; есть — только её инструкции.
    const state = makeState(
      [makeCity(TULA, 100_000)],
      [makeIndustry('elevator', 'элеватор', TULA, { 'зерно': 100 })],
      [makeVehicle(V1, TULA, { lineId: RING, stopIndex: 0 })],
      0,
      [makeLine(RING, [makeStop(TULA, [], ['пиломатериалы'])], [V1])],
    )

    expect(truck(runArrivals(state)).cargo).toMatchObject({ type: 'зерно' })
  })

  it('потерянная линия роняет машину в режим разовых рейсов', () => {
    // Линию удалили, а машину отвязать забыли. Парализованная машина, которая
    // жжёт зарплату и молчит, — худший ответ на дыру в данных.
    const state = makeState(
      [makeCity(TULA, 100_000)],
      [makeIndustry('elevator', 'элеватор', TULA, { 'зерно': 100 })],
      [makeVehicle(V1, TULA, { lineId: lineId('удалённая'), stopIndex: 0 })],
    )

    expect(truck(runArrivals(state)).cargo).toMatchObject({ type: 'зерно' })
  })

  it('кольцо с гружёными обоими плечами не даёт порожнего пробега', () => {
    const state = ringState()
    // Город обязан принять полную ходку: прими он половину, остаток застрял бы
    // в кузове и обратной загрузки не случилось бы по чужой причине.
    expect(
      cityCapacity(state.world.cities[TULA], 'мука'),
    ).toBeGreaterThanOrEqual(ZIL_TONS)

    // Тула: берём зерно.
    const atTula = runArrivals(state)
    expect(truck(atTula).cargo).toMatchObject({ type: 'зерно', tons: ZIL_TONS })

    // Едем в Москву, сдаём зерно, берём муку.
    const atMoscow = runArrivals(
      withVehicle(atTula, drive(truck(atTula), LEG_KM, MOSCOW, 1)),
    )
    expect(truck(atMoscow).cargo).toMatchObject({ type: 'мука', tons: ZIL_TONS })

    // Возвращаемся в Тулу гружёными и сдаём муку городу.
    const home = runArrivals(
      withVehicle(atMoscow, drive(truck(atMoscow), LEG_KM, TULA, 0)),
    )

    const v = truck(home)
    expect(v.emptyKm).toBeCloseTo(0, 9)
    expect(v.loadedKm).toBeCloseTo(2 * LEG_KM, 9)
    expect(v.emptyKm / v.odometer).toBeCloseTo(0, 9)

    // Оплачены оба плеча, а не одно.
    expect(money(home)).toBeCloseTo(
      deliveryRevenue('зерно', ZIL_TONS, LEG_KM) +
        deliveryRevenue('мука', ZIL_TONS, LEG_KM),
      9,
    )
  })

  it('кольцо с одним гружёным плечом даёт половину пробега вхолостую', () => {
    // Та же линия, но в Москве нечего (или незачем) грузить. Разница между
    // этим тестом и предыдущим — ровно один пустой список в инструкции, и
    // стоит она половины всего топлива кольца.
    const state = ringState([])

    const atTula = runArrivals(state)
    const atMoscow = runArrivals(
      withVehicle(atTula, drive(truck(atTula), LEG_KM, MOSCOW, 1)),
    )
    expect(truck(atMoscow).cargo).toBeNull()

    const home = runArrivals(
      withVehicle(atMoscow, drive(truck(atMoscow), LEG_KM, TULA, 0)),
    )

    const v = truck(home)
    expect(v.loadedKm).toBeCloseTo(LEG_KM, 9)
    expect(v.emptyKm).toBeCloseTo(LEG_KM, 9)
    expect(v.emptyKm / v.odometer).toBeCloseTo(0.5, 9)

    // Оплачено одно плечо из двух.
    expect(money(home)).toBeCloseTo(
      deliveryRevenue('зерно', ZIL_TONS, LEG_KM),
      9,
    )
  })

  it('машина без линии в том же мире ведёт себя по-прежнему', () => {
    // Контрольный прогон: линия меняет поведение только той машины, которая на
    // неё назначена. Разовые рейсы остаются рабочим режимом.
    const state = ringState()
    const free = makeVehicle(V2, TULA)
    const both: GameState = {
      ...state,
      vehicles: { ...state.vehicles, [V2]: free },
    }

    const after = runArrivals(both)

    // Обе взяли зерно: линия велела, а вторая нашла сама.
    expect(truck(after, V1).cargo).toMatchObject({ type: 'зерно' })
    expect(truck(after, V2).cargo).toMatchObject({ type: 'зерно' })
  })
})

describe('runArrivals: детерминизм и чистота', () => {
  it('машина в пути не грузится и не разгружается', () => {
    const state = makeState(
      [makeCity(TULA, 100_000)],
      [makeIndustry('elevator', 'элеватор', TULA, { 'зерно': 100 })],
      [
        makeVehicle(V1, TULA, {
          position: {
            kind: 'ребро',
            edgeId: edgeId('moscow-tula'),
            fromId: MOSCOW,
            progress: 0.5,
          },
          odometer: 90,
        }),
      ],
    )

    const after = runArrivals(state)

    expect(after).toBe(state)
    expect(truck(after).cargo).toBeNull()
  })

  it('машины разбирают дефицитный склад в порядке вставки', () => {
    // На складе восемь тонн, машин две по шесть. Первой достаётся полный кузов,
    // второй — остаток. Тонны при этом не удваиваются: вторая машина видит
    // склад уже уменьшенным, а не общий снимок начала фазы.
    const stored = ZIL_TONS + 2
    const state = makeState(
      [makeCity(TULA, 100_000)],
      [makeIndustry('elevator', 'элеватор', TULA, { 'зерно': stored })],
      [makeVehicle(V1, TULA), makeVehicle(V2, TULA)],
    )

    const after = runArrivals(state)

    expect(truck(after, V1).cargo).toMatchObject({
      type: 'зерно',
      tons: ZIL_TONS,
    })
    expect(truck(after, V2).cargo).toMatchObject({
      type: 'зерно',
      tons: stored - ZIL_TONS,
    })
    expect(plant(after, 'elevator').stock['зерно']).toBeCloseTo(0, 9)
  })

  it('повторный прогон одного состояния даёт тот же результат', () => {
    const state = makeState(
      [makeCity(TULA, 100_000)],
      [makeIndustry('elevator', 'элеватор', TULA, { 'зерно': 8 })],
      [makeVehicle(V1, TULA), makeVehicle(V2, TULA)],
    )

    expect(JSON.stringify(runArrivals(state))).toBe(
      JSON.stringify(runArrivals(state)),
    )
  })

  it('не мутирует вход ни на одном уровне вложенности', () => {
    const state = makeState(
      [makeCity(TULA, 100_000), makeCity(MOSCOW, FLOUR_CITY_POP)],
      [
        makeIndustry('mill', 'мукомольный', TULA, { 'мука': 50 }),
        makeIndustry('elevator', 'элеватор', TULA, { 'зерно': 20 }),
      ],
      [
        makeVehicle(V1, TULA, {
          lineId: RING,
          stopIndex: 0,
    blockedTicks: 0,
          cargo: { type: 'зерно', tons: ZIL_TONS, originId: MOSCOW },
          odometer: LEG_KM,
        }),
        makeVehicle(V2, MOSCOW, {
          cargo: { type: 'мука', tons: ZIL_TONS, originId: TULA },
          odometer: LEG_KM,
        }),
      ],
      1000,
      [
        makeLine(
          RING,
          [makeStop(TULA, ['зерно'], ['мука']), makeStop(MOSCOW, ['мука'])],
          [V1],
        ),
      ],
    )

    const snapshot = JSON.stringify(state)
    // Заморозка ловит мутацию как исключение, снимок — как расхождение.
    deepFreeze(state)

    const after = runArrivals(state)

    expect(JSON.stringify(state)).toBe(snapshot)
    expect(after).not.toBe(state)
    expect(money(after)).toBeGreaterThan(1000)
  })
})
