import { describe, expect, it } from 'vitest'
import { deliveryRevenue } from '../economy/finance'
import { CONSUMPTION_PER_1K } from '../../data/recipes'
import { cityId, companyId, edgeId, industryId, vehicleId } from '../types'
import type {
  CargoType,
  City,
  CityId,
  CompanyId,
  GameState,
  Industry,
  IndustryId,
  IndustryType,
  Edge,
  EdgeId,
  Tons,
  Vehicle,
  VehicleId,
} from '../types'
import { stockCapacity } from '../economy/production'
import { CITY_STOCK_DAYS, cityCapacity, runArrivals } from './loading'

/**
 * Мир в этих тестах синтетический и намеренно крошечный: один-два города,
 * одно-два предприятия. Настоящие данные из src/data сюда не тянутся — состав
 * предприятий пишет другой модуль, и тест погрузки не должен падать оттого, что
 * элеватор переехал в соседний город.
 *
 * Население городов круглое, чтобы вместимость склада считалась в уме:
 * 100 000 жителей × 0.06 т муки на тысячу × 5 суток = 30 тонн муки.
 *
 * Расстояния — настоящие: 185 км это Москва — Тула по М-2 «Крым».
 */

const MOSCOW = cityId('moscow')
const TULA = cityId('tula')
const KALUGA = cityId('kaluga')

const PLAYER: CompanyId = companyId('player')
const V1: VehicleId = vehicleId('v1')
const V2: VehicleId = vehicleId('v2')

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
    cruiseKmh: 70,
    odometer: 0,
    capacity: ZIL_TONS,
    cargo: null,
    loadedKm: 0,
    emptyKm: 0,
    ...patch,
  }
}

function makeState(
  cities: City[],
  industries: Industry[],
  vehicles: Vehicle[],
  money = 0,
): GameState {
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
    companies: {
      [PLAYER]: { id: PLAYER, name: 'Игрок', money, controller: 'человек' },
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

/** Имитация фазы движения: одометр растёт, счётчики пробега не трогаются. */
/**
 * Имитация фазы движения.
 *
 * Разносит километры по счетам ровно так же, как это делает advanceVehicle:
 * гружёная машина копит loadedKm, порожняя — emptyKm. Прежде счета закрывала
 * фаза прибытия, и здесь достаточно было двигать одометр; теперь это работа
 * движения, и подменять её хелпером, который так не делает, значит проверять
 * несуществующее поведение.
 */
function drive(vehicle: Vehicle, km: number, to: CityId): Vehicle {
  const carrying = vehicle.cargo !== null
  return {
    ...vehicle,
    odometer: vehicle.odometer + km,
    loadedKm: vehicle.loadedKm + (carrying ? km : 0),
    emptyKm: vehicle.emptyKm + (carrying ? 0 : km),
    position: { kind: 'узел', nodeId: to },
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

    // Выход: 40 т/сут × 3 суток. Вход: 40 × 1.25 × 3.
    expect(stockCapacity(mill, 'мука')).toBeCloseTo(120, 9)
    expect(stockCapacity(mill, 'зерно')).toBeCloseTo(150, 9)
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
    // 6 т зерна на 185 км: 6 × 900 × (0.4 + 0.6 × 185/200).
    expect(money(after)).toBeCloseTo(5157, 6)
    expect(money(after)).toBeCloseTo(deliveryRevenue('зерно', ZIL_TONS, LEG_KM), 9)
  })

  it('город принимает потребительский товар', () => {
    const state = makeState(
      [makeCity(MOSCOW, 500_000)],
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
    expect(money(after)).toBeCloseTo(9168, 6)
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
    expect(after).toBe(state)
    expect(truck(after).cargo).toMatchObject({ type: 'зерно', tons: ZIL_TONS })
    expect(money(after)).toBe(0)
    // Километры плеча не разнесены: за них ещё не заплачено.
    expect(truck(after).loadedKm).toBe(0)
  })

  it('сырьё имеет приоритет: полный склад пропускается ради соседнего предприятия', () => {
    // Первый мукомольный задохнулся зерном, второй голодает. Машина обязана
    // найти второго, а не встать в очередь к первому.
    const state = makeState(
      [makeCity(TULA, 100_000)],
      [
        makeIndustry('mill-full', 'мукомольный', TULA, { 'зерно': 150 }),
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

    expect(plant(after, 'mill-full').stock['зерно']).toBe(150)
    expect(plant(after, 'mill-hungry').stock['зерно']).toBeCloseTo(ZIL_TONS, 9)
  })

  it('в переполненный склад ложится сколько влезет, остаток едет дальше', () => {
    // Вместимость под зерно 150 т, лежит 147 — влезут только три тонны.
    const state = makeState(
      [makeCity(TULA, 100_000)],
      [makeIndustry('mill', 'мукомольный', TULA, { 'зерно': 147 })],
      [
        makeVehicle(V1, TULA, {
          cargo: { type: 'зерно', tons: ZIL_TONS, originId: MOSCOW },
          odometer: LEG_KM,
        }),
      ],
    )

    const after = runArrivals(state)

    expect(plant(after, 'mill').stock['зерно']).toBeCloseTo(150, 9)
    expect(truck(after).cargo).toMatchObject({ type: 'зерно', tons: 3 })
    // Платят ровно за доставленное, а не за то, что было в кузове.
    expect(money(after)).toBeCloseTo(deliveryRevenue('зерно', 3, LEG_KM), 9)
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
    expect(plant(after, 'elevator').stock['зерно']).toBeCloseTo(94, 9)
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
    expect(plant(after, 'elevator').stock['зерно']).toBeCloseTo(174, 9)
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
    expect(plant(after, 'mill').stock['мука']).toBeCloseTo(44, 9)
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
      [makeCity(MOSCOW, 500_000)],
      [],
      [
        makeVehicle(V1, MOSCOW, {
          cargo: { type: 'мука', tons: ZIL_TONS, originId: TULA },
          odometer: LEG_KM,
        }),
      ],
    )
    const looping = makeState(
      [makeCity(MOSCOW, 500_000)],
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
      [makeCity(TULA, 100_000), makeCity(MOSCOW, 500_000)],
      [makeIndustry('mill', 'мукомольный', TULA, { 'мука': 100 })],
      [makeVehicle(V1, TULA)],
    )

    const loaded = runArrivals(state)
    expect(truck(loaded).cargo).toMatchObject({ type: 'мука', tons: ZIL_TONS })

    // Едем в Москву гружёными.
    const enRoute: GameState = {
      ...loaded,
      vehicles: { [V1]: drive(truck(loaded), LEG_KM, MOSCOW) },
    }
    const delivered = runArrivals(enRoute)
    expect(truck(delivered).cargo).toBeNull()

    // Возвращаемся порожняком.
    const back: GameState = {
      ...delivered,
      vehicles: { [V1]: drive(truck(delivered), LEG_KM, TULA) },
    }
    const home = runArrivals(back)

    const v = truck(home)
    expect(v.loadedKm).toBeCloseTo(LEG_KM, 9)
    expect(v.emptyKm).toBeCloseTo(LEG_KM, 9)
    expect(v.loadedKm + v.emptyKm).toBeCloseTo(v.odometer, 9)
    // Половина пути вхолостую — ровно то, что игрок обязан научиться убирать.
    expect(v.emptyKm / v.odometer).toBeCloseTo(0.5, 9)
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
            edgeId: 'moscow-tula' as never,
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
    const state = makeState(
      [makeCity(TULA, 100_000)],
      [makeIndustry('elevator', 'элеватор', TULA, { 'зерно': 8 })],
      [makeVehicle(V1, TULA), makeVehicle(V2, TULA)],
    )

    const after = runArrivals(state)

    expect(truck(after, V1).cargo).toMatchObject({ type: 'зерно', tons: 6 })
    expect(truck(after, V2).cargo).toMatchObject({ type: 'зерно', tons: 2 })
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
      [makeCity(TULA, 100_000), makeCity(MOSCOW, 500_000)],
      [
        makeIndustry('mill', 'мукомольный', TULA, { 'мука': 50 }),
        makeIndustry('elevator', 'элеватор', TULA, { 'зерно': 20 }),
      ],
      [
        makeVehicle(V1, TULA, {
          cargo: { type: 'зерно', tons: ZIL_TONS, originId: MOSCOW },
          odometer: LEG_KM,
        }),
        makeVehicle(V2, MOSCOW, {
          cargo: { type: 'мука', tons: ZIL_TONS, originId: TULA },
          odometer: LEG_KM,
        }),
      ],
      1000,
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
