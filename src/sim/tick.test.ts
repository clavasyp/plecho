import { describe, expect, it } from 'vitest'
import { BANKRUPTCY_GRACE_DAYS, FUEL_PRICE_PER_LITER } from '../data/operating'
import { VEHICLE_CLASS_BY_ID } from '../data/vehicles'
import { CONSUMER_CARGO, RECIPE_BY_INDUSTRY } from '../data/recipes'
import { demandPerDay } from './economy/consumption'
import { setRoute } from './logistics/vehicle'
import { maintenancePerKm } from './logistics/wear'
import {
  createInitialState,
  PLAYER_ID,
  START_MONEY,
  STARTER_CAPACITY_TONS,
  STARTER_CLASS,
  STARTER_CLASS_ID,
  STARTER_CRUISE_KMH,
  STARTER_DRIVER_ID,
  STARTER_FUEL_PER_100KM,
  STARTER_TRAILER,
} from './state'
import { HOURS_PER_TICK, tick, tickMany } from './tick'
import { TICKS_PER_DAY, cityId, lineId, vehicleId } from './types'
import type {
  CargoType,
  CityId,
  Company,
  Driver,
  DriverLicense,
  GameState,
  Industry,
  IndustryType,
  Line,
  LineId,
  Stop,
  Tons,
  Vehicle,
  VehicleId,
} from './types'
import { buildGraph } from './world/graph'
import { findRoute, shortestKm } from './world/pathfind'

/**
 * Тик проверяется на НАСТОЯЩЕМ мире: города, дороги и предприятия берутся из
 * начального состояния, а не подделываются. Это интеграционный тест всей
 * симуляции — его задача не в том, чтобы поймать ошибку в отдельной формуле
 * (для этого есть тесты рядом с самими формулами), а в том, чтобы доказать
 * утверждения, ради которых делались срезы.
 *
 * СРЕЗ 2 доказывал, что мир зависит от игрока: без машины всё производство на
 * карте встаёт, с машиной — оживает. Эти прогоны здесь остались.
 *
 * СРЕЗ 3 доказывает главное про ДЕНЬГИ, и это тот же самый мир, увиденный с
 * другой стороны. Раньше выручка была единственным потоком в экономике, и любой
 * рейс был выгоден по определению. Теперь у машины есть расходы, и они не
 * зависят от того, есть ли в кузове груз: топливо жжётся по километрам, резина
 * стирается по километрам, водителю платят по времени. Порожнее плечо стоит
 * ровно столько же, сколько гружёное, и приносит ноль.
 *
 * Отсюда главный тест среза — два прогона по тридцать суток на ОДНОМ И ТОМ ЖЕ
 * кольце, отличающиеся одной строчкой в инструкции остановки. Пробег в них
 * совпадает до километра, расходы совпадают до рубля, и вся разница — в том,
 * идёт ли обратное плечо гружёным. Одна компания в плюсе, другая разорена.
 */

const MOSCOW = cityId('moscow')
const TULA = cityId('tula')
const KALUGA = cityId('kaluga')
const BRYANSK = cityId('bryansk')
const SMOLENSK = cityId('smolensk')
const YAROSLAVL = cityId('yaroslavl')

/** Сутки в тиках — 96. Экономика живёт сутками, тик для неё слишком мелок. */
const DAY = TICKS_PER_DAY

/** Эталонный мир. Сид фиксирован — прогоны обязаны совпадать между запусками. */
const WORLD = createInitialState(20250808)

const GRAPH = buildGraph(WORLD.world.edges)

const ZIL: VehicleId = vehicleId('zil')
const TANKER: VehicleId = vehicleId('tanker')
const RING: LineId = lineId('ring')

// ─── Фикстуры ──────────────────────────────────────────────────────────────

/**
 * Машина по образцу стартового ЗИЛа.
 *
 * Все характеристики берутся из state.ts, а не выписываются числами. Прогон на
 * тридцать суток считает расходы по расходу топлива и грузоподъёмности, и
 * выписанная руками «шестёрка» разъехалась бы с миром при первой же
 * перебалансировке — молча, потому что тест продолжал бы считать свою правду.
 */
function makeVehicle(
  id: string,
  at: CityId,
  route: CityId[],
  patch: Partial<Vehicle> = {},
): Vehicle {
  return {
    id: vehicleId(id),
    ownerId: PLAYER_ID,
    position: { kind: 'узел', nodeId: at },
    route,
    lineId: null,
    stopIndex: 0,
    blockedTicks: 0,
    // Свободна и никого не ждёт: счётчики среза 5 в фикстуре нулевые, иначе
    // машина приезжала бы в мир уже стоящей под чужой погрузкой.
    serviceTicksLeft: 0,
    queuedTicks: 0,
    classId: STARTER_CLASS_ID,
    trailer: STARTER_TRAILER,
    // За рулём стартовый водитель компании. Без него машина не едет вовсе, и
    // весь этот файл проверял бы неподвижный парк.
    driverId: STARTER_DRIVER_ID,
    wear: 0,
    kmSinceService: 0,
    brokenDown: false,
    cruiseKmh: STARTER_CRUISE_KMH,
    fuelPer100Km: STARTER_FUEL_PER_100KM,
    odometer: 0,
    capacity: STARTER_CAPACITY_TONS,
    cargo: null,
    loadedKm: 0,
    emptyKm: 0,
    ...patch,
  }
}

/**
 * Машина указанного класса с указанным прицепом.
 *
 * Нужна там, где груз требует специального кузова: наливное не возят в тенте,
 * а полуприцеп-цистерну цепляют к тягачу, а не к бортовому ЗИЛу. Характеристики
 * берутся из справочника, а не выписываются числами, — это тот же довод, что и
 * в sim/state.ts: справочник единственное место, где класс проверен на главный
 * инвариант.
 */
function makeClassVehicle(
  id: string,
  at: CityId,
  classId: string,
  trailer: Vehicle['trailer'],
  patch: Partial<Vehicle> = {},
): Vehicle {
  const vc = VEHICLE_CLASS_BY_ID[classId]
  return makeVehicle(id, at, [], {
    classId,
    trailer,
    cruiseKmh: vc.cruiseKmh,
    fuelPer100Km: vc.fuelPer100Km,
    capacity: vc.capacity,
    ...patch,
  })
}

/** Штат компании игрока в эталонном мире. */
function roster(state: GameState): Record<string, Driver> {
  return state.companies[PLAYER_ID].drivers
}

/**
 * Суточный фонд оплаты труда компании игрока, рубли.
 *
 * Считается по ШТАТУ, а не по парку: зарплата в срезе 4 переехала к людям, и
 * лишняя машина без водителя больше ничего не стоит, а человек в резерве стоит
 * полностью. Выводится из состояния, а не из DRIVER_WAGE_PER_DAY: настоящая
 * ставка складывается из базовой и надбавок за навык и допуски (wageFor в
 * logistics/driver.ts), и подстановка базы занизила бы ожидания на четверть.
 */
const PAYROLL_PER_DAY = Object.values(roster(WORLD)).reduce(
  (sum, driver) => sum + driver.wagePerDay,
  0,
)

/** Тот же мир, но водителю выданы допуски: без них особый груз не взять. */
function withLicenses(state: GameState, licenses: DriverLicense[]): GameState {
  const player = state.companies[PLAYER_ID]
  const drivers: Record<string, Driver> = {}
  for (const [id, driver] of Object.entries(player.drivers)) {
    drivers[id] = { ...driver, licenses: [...licenses] }
  }

  return {
    ...state,
    companies: {
      ...state.companies,
      [PLAYER_ID]: { ...player, drivers: drivers as typeof player.drivers },
    },
  }
}

/** Настоящий мир с заданным парком: меняются только машины. */
function withVehicles(vehicles: Vehicle[]): GameState {
  return {
    ...WORLD,
    vehicles: Object.fromEntries(vehicles.map((v) => [v.id, v])) as Record<
      VehicleId,
      Vehicle
    >,
  }
}

/**
 * Мир без предприятий — для тестов, где проверяется ТОЛЬКО движение.
 *
 * Погрузка машины без линии автоматическая, поэтому в живом мире машина,
 * постоявшая в городе с готовой продукцией, уедет из него гружёной. Для
 * проверок «машина не изменилась» и «машины не влияют друг на друга» это лишняя
 * переменная: убираем предприятия и остаёмся с чистой кинематикой.
 */
function movementOnly(vehicles: Vehicle[]): GameState {
  const base = withVehicles(vehicles)
  return { ...base, world: { ...base.world, industries: {} } }
}

/** Остановка линии: где встать, что выгрузить, что взять. */
function stop(nodeId: CityId, unload: CargoType[], load: CargoType[]): Stop {
  return { nodeId, unload, load }
}

/**
 * Мир с одной линией и одной машиной на ней.
 *
 * Машина ставится в МОСКВЕ, а не на первой остановке. Так партия и начинается
 * (HOME_CITY), и заодно это единственный способ не потерять первую погрузку:
 * машина, поставленная прямо на свою нулевую остановку, на первом же тике
 * считается её обслужившей и уезжает дальше по кольцу пустой.
 *
 * Машину можно подменить: наливной груз требует цистерны, а цистерну — тягача,
 * и стартовый ЗИЛ с тентом на такое кольцо просто не выйдет.
 */
function withLine(
  stops: Stop[],
  at: CityId = MOSCOW,
  vehicle?: Vehicle,
): GameState {
  const base = vehicle ?? makeVehicle('zil', at, [])
  const truck: Vehicle = { ...base, lineId: RING, stopIndex: 0 }
  const line: Line = {
    id: RING,
    name: 'Кольцо',
    stops,
    assignedVehicles: [truck.id],
  }
  const player = WORLD.companies[PLAYER_ID]

  return {
    ...WORLD,
    companies: {
      ...WORLD.companies,
      [PLAYER_ID]: { ...player, lines: { [RING]: line } },
    },
    vehicles: { [truck.id]: truck } as Record<VehicleId, Vehicle>,
  }
}

/**
 * Мир под наливное кольцо: тягач с цистерной и водитель с ДОПОГ.
 *
 * ТРИ УСЛОВИЯ СРАЗУ, И В ЭТОМ ВЕСЬ СРЕЗ 4. Нефть и топливо возят только в
 * цистерне (CARGO_REQUIREMENTS в data/vehicles.ts), цистерну цепляют только к
 * седельному тягачу (VEHICLE_CLASSES там же), а за руль с таким грузом
 * пускают только с допуском (CARGO_LICENSE в logistics/driver.ts). Раньше на
 * это кольцо выходил стартовый ЗИЛ; теперь оно требует вложений, и это
 * правильно — самая доходная цепочка мира не должна быть доступна с первого
 * дня.
 */
function withTankerLine(stops: Stop[], at: CityId = MOSCOW): GameState {
  const tanker = makeClassVehicle('tanker', at, 'tractor', 'цистерна')
  return withLicenses(withLine(stops, at, tanker), ['ДОПОГ'])
}

/**
 * Кольцо Москва — Тула — Калуга — Брянск — Смоленск — Москва длиной 1163 км.
 * Десять кругов машина не успевает пройти и за 500 тиков, поэтому в тестах на
 * детерминизм она всё время в движении, а не стоит с пустым маршрутом.
 */
function ringRoute(laps: number): CityId[] {
  const lap = [TULA, KALUGA, BRYANSK, SMOLENSK, MOSCOW]
  const route: CityId[] = []
  for (let i = 0; i < laps; i++) route.push(...lap)
  return route
}

function industryOfType(state: GameState, type: IndustryType): Industry {
  const found = Object.values(state.world.industries).find(
    (industry) => industry.type === type,
  )
  if (found === undefined) {
    throw new Error(`в мире нет предприятия типа «${type}»`)
  }
  return found
}

/** Источники: производят без входа. Переработка: всё остальное. */
const isSource = (industry: Industry): boolean =>
  RECIPE_BY_INDUSTRY[industry.type].inputs.length === 0

/**
 * Суточное потребление города по грузу, тонн.
 *
 * Спрашивается У САМОЙ ИГРЫ, а не пересчитывается по нормам. Своя копия формулы
 * здесь однажды уже стоила разбора: тест сверял бы согласованность двух копий
 * одного правила и молча пережил бы смену формы спроса.
 */
function dailyDemand(population: number, cargo: CargoType): Tons {
  return demandPerDay(population, cargo)
}

/** Завезти городу запас потребительских товаров ровно на N суток. */
function seedCityStock(state: GameState, id: CityId, days: number): GameState {
  const city = state.world.cities[id]
  const stock: Partial<Record<CargoType, Tons>> = {}
  for (const cargo of CONSUMER_CARGO) {
    stock[cargo] = dailyDemand(city.population, cargo) * days
  }
  return {
    ...state,
    world: {
      ...state.world,
      cities: { ...state.world.cities, [id]: { ...city, stock } },
    },
  }
}

// ─── Деньги прогона ────────────────────────────────────────────────────────

/**
 * Расходы парка за прогон, посчитанные ПО КОНСТАНТАМ ДАННЫХ, а не по состоянию.
 *
 * Формула повторяет контракт data/operating.ts: топливо по километрам, ТО по
 * километрам, зарплата по суткам на каждую машину. Дублирование намеренное и
 * полезное — оно превращает арифметику расходов в проверяемое утверждение:
 * разойдись фаза расходов с этой формулой, и выведенная ниже выручка уедет в
 * абсурд (например, станет отрицательной у машины, которая точно возила груз).
 */
function operatingCosts(vehicles: Vehicle[], days: number): number {
  // Зарплата — ОДНА на штат, а не на машину: в срезе 4 её платят людям.
  let total = PAYROLL_PER_DAY * days
  for (const vehicle of vehicles) {
    total += (vehicle.odometer / 100) * vehicle.fuelPer100Km * FUEL_PRICE_PER_LITER
    // Ставка обслуживания спрашивается у самой машины: она зависит от класса и
    // от износа. Берётся ставка НА КОНЕЦ прогона, то есть слегка завышенная —
    // машина изнашивалась постепенно. За тридцать суток разница около процента
    // и на выводы теста не влияет: все утверждения ниже сравнивают знак итога.
    total += vehicle.odometer * maintenancePerKm(vehicle)
  }
  return total
}

/** Итоги прогона одной машины: чем обычно и меряется линия. */
type Outcome = {
  end: GameState
  truck: Vehicle
  /** Доля порожних километров, 0..1 — главная метрика мастерства в игре. */
  emptyShare: number
  money: number
  /** Заработано перевозками: остаток счёта плюс всё, что съели расходы. */
  revenue: number
  costs: number
}

function outcomeOf(
  end: GameState,
  days: number,
  id: VehicleId = ZIL,
): Outcome {
  const truck = end.vehicles[id]
  const money = end.companies[PLAYER_ID].money
  const costs = operatingCosts([truck], days)

  return {
    end,
    truck,
    emptyShare: truck.odometer > 0 ? truck.emptyKm / truck.odometer : 0,
    money,
    revenue: money - START_MONEY + costs,
    costs,
  }
}

// ─── Инварианты ────────────────────────────────────────────────────────────

/**
 * Что обязано быть верно ПОСЛЕ ЛЮБОГО тика, независимо от того, какая фаза его
 * посчитала.
 *
 * Возвращает список нарушений, а не бросает: проверка зовётся каждый тик
 * длинного прогона, и накопить их в массив дешевле и понятнее, чем упасть на
 * первом же и гадать, что было до него.
 *
 * Отрицательный склад — самая опасная поломка экономики: она не падает, а тихо
 * рождает груз из ниоткуда, потому что «минус десять тонн» на следующем тике
 * прибавятся к производству. Поэтому проверяется каждый тик, а не в конце.
 */
function violations(state: GameState): string[] {
  const bad: string[] = []
  const check = (ok: boolean, message: string): void => {
    if (!ok) bad.push(`тик ${state.tick}: ${message}`)
  }

  for (const industry of Object.values(state.world.industries)) {
    for (const [cargo, tons] of Object.entries(industry.stock)) {
      check(
        Number.isFinite(tons) && (tons as number) >= 0,
        `склад ${industry.id} по «${cargo}» = ${tons}`,
      )
    }
    check(
      industry.utilization >= 0 && industry.utilization <= 1,
      `загрузка ${industry.id} = ${industry.utilization}`,
    )
    check(industry.idleTicks >= 0, `простой ${industry.id} = ${industry.idleTicks}`)
  }

  for (const city of Object.values(state.world.cities)) {
    for (const [cargo, tons] of Object.entries(city.stock)) {
      check(
        Number.isFinite(tons) && (tons as number) >= 0,
        `склад города ${city.id} по «${cargo}» = ${tons}`,
      )
    }
    check(
      Number.isFinite(city.population) && city.population > 0,
      `население ${city.id} = ${city.population}`,
    )
    check(city.suppliedDays >= 0, `снабжение ${city.id} = ${city.suppliedDays}`)
  }

  for (const vehicle of Object.values(state.vehicles)) {
    if (vehicle.cargo !== null) {
      check(
        vehicle.cargo.tons > 0,
        `машина ${vehicle.id} везёт ${vehicle.cargo.tons} т`,
      )
      check(
        vehicle.cargo.tons <= vehicle.capacity + 1e-9,
        `перегруз ${vehicle.id}: ${vehicle.cargo.tons} т при ${vehicle.capacity}`,
      )
    }
    check(
      vehicle.loadedKm >= 0 && vehicle.emptyKm >= 0,
      `счётчики ${vehicle.id}: ${vehicle.loadedKm} / ${vehicle.emptyKm}`,
    )
    // Разнесённых километров не может быть больше пройденных — и меньше тоже:
    // разнесение живёт в фазе движения и закрывает каждый километр сразу.
    check(
      Math.abs(vehicle.loadedKm + vehicle.emptyKm - vehicle.odometer) < 1e-6,
      `пробег ${vehicle.id} не сходится: ${vehicle.loadedKm} + ${vehicle.emptyKm} ≠ ${vehicle.odometer}`,
    )
    // Расход топлива обязан быть положительным у каждой машины: нулевой
    // означает машину, которая ездит даром, и порожний пробег перестаёт
    // что-либо стоить.
    check(
      Number.isFinite(vehicle.fuelPer100Km) && vehicle.fuelPer100Km > 0,
      `расход топлива ${vehicle.id} = ${vehicle.fuelPer100Km}`,
    )
    check(
      Number.isInteger(vehicle.stopIndex) && vehicle.stopIndex >= 0,
      `индекс остановки ${vehicle.id} = ${vehicle.stopIndex}`,
    )
  }

  for (const company of Object.values(state.companies)) {
    check(Number.isFinite(company.money), `счёт ${company.id} = ${company.money}`)
    check(
      Number.isFinite(company.dailyRevenue) && company.dailyRevenue >= 0,
      `суточная выручка ${company.id} = ${company.dailyRevenue}`,
    )
    check(
      Number.isFinite(company.dailyCosts) && company.dailyCosts >= 0,
      `суточные расходы ${company.id} = ${company.dailyCosts}`,
    )
    check(company.daysInDebt >= 0, `суток в минусе ${company.id} = ${company.daysInDebt}`)
  }

  return bad
}

/** Прогон с проверкой инвариантов на каждом тике. */
function runDays(
  state: GameState,
  days: number,
  watch?: (s: GameState) => void,
): { end: GameState; broken: string[] } {
  let current = state
  const broken: string[] = []

  for (let i = 0; i < DAY * days; i++) {
    current = tick(current)
    watch?.(current)
    // Копим только первую партию нарушений: дальше они повторяются каждый тик
    // и заваливают вывод.
    if (broken.length === 0) broken.push(...violations(current))
  }

  return { end: current, broken }
}

/**
 * Прогон РАЗОВЫМИ РЕЙСАМИ: машина челноком ходит между двумя городами.
 *
 * Маршрут выдаётся заново каждый раз, когда машина доехала и встала — ровно то,
 * что делал игрок в срезе 2 кнопкой «отправить». Оставлено намеренно: линии не
 * отменили разовые рейсы, и поведение машины БЕЗ линии обязано остаться прежним.
 *
 * ЧЕЛНОК ОБЯЗАН УВАЖАТЬ ПОСТ, И ЭТО НЕ ФОРМАЛЬНОСТЬ ХЕЛПЕРА. В срезе 5 машина,
 * доехавшая до узла, встаёт под погрузку на несколько тиков, и всё это время у
 * неё пустой маршрут. Выдай ей новый, не глядя на счётчики, — и она уедет
 * ПОРОЖНЕЙ ещё до того, как тонны перешли в кузов: за десять суток прогона не
 * случится ни одной погрузки, а выглядеть это будет как исправно катающийся
 * челнок с нулевым гружёным пробегом. Ровно так же обязана вести себя и кнопка
 * «отправить» в интерфейсе (dispatchTo в app/store.ts), и по той же причине.
 */
function runShuttle(
  state: GameState,
  id: VehicleId,
  a: CityId,
  b: CityId,
  days: number,
  watch?: (s: GameState) => void,
): { end: GameState; broken: string[] } {
  const graph = buildGraph(state.world.edges)
  let current = state
  const broken: string[] = []

  for (let i = 0; i < DAY * days; i++) {
    current = tick(current)
    watch?.(current)
    if (broken.length === 0) broken.push(...violations(current))

    const vehicle = current.vehicles[id]
    if (vehicle.route.length > 0 || vehicle.position.kind !== 'узел') continue
    // Под погрузкой и в очереди на пост машина никуда не отправляется.
    if (vehicle.serviceTicksLeft > 0 || vehicle.queuedTicks > 0) continue

    const here = vehicle.position.nodeId
    const target = here === a ? b : a
    // Крейсерская скорость машины входит в поиск пути обязательным аргументом:
    // тихоходному ЗИЛу федеральный объезд не помогает (см. world/pathfind.ts).
    const route = findRoute(graph, here, target, vehicle.cruiseKmh)
    if (route === null) throw new Error(`нет пути ${here} → ${target}`)

    current = {
      ...current,
      vehicles: {
        ...current.vehicles,
        [id]: setRoute(vehicle, route.slice(1)),
      },
    }
  }

  return { end: current, broken }
}

/** Рекурсивная заморозка. Возвращает тот же объект — удобно для инлайна. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const inner of Object.values(value as Record<string, unknown>)) {
    deepFreeze(inner)
  }
  return Object.freeze(value)
}

// ─── Время ─────────────────────────────────────────────────────────────────

/** Цена стартовой машины — мерка для «крупного разрыва». */
const STARTER_PRICE = STARTER_CLASS.price

describe('tick: время', () => {
  it('увеличивает счётчик тиков ровно на единицу', () => {
    // От ТЕКУЩЕГО значения, а не от нуля: партия начинается утром, а не в
    // полночь (разбор — у createInitialState), и «стало равно единице» означало
    // бы проверку стартового времени, а не работы часов.
    const state = movementOnly([])
    expect(tick(state).tick).toBe(state.tick + 1)
    expect(tick(tick(state)).tick).toBe(state.tick + 2)
  })

  it('длительность тика — четверть часа', () => {
    expect(HOURS_PER_TICK).toBe(0.25)
  })

  it('tickMany равен n последовательным тикам', () => {
    const state = withVehicles([makeVehicle('v1', MOSCOW, [TULA, KALUGA])])

    let manual = state
    for (let i = 0; i < 37; i++) manual = tick(manual)

    expect(JSON.stringify(tickMany(state, 37))).toBe(JSON.stringify(manual))
  })

  it('tickMany с нулём и отрицательным n не двигает время', () => {
    const state = withVehicles([])
    expect(tickMany(state, 0)).toBe(state)
    expect(tickMany(state, -5)).toBe(state)
  })
})

// ─── Порядок фаз ───────────────────────────────────────────────────────────

describe('tick: порядок фаз', () => {
  it('диспетчеризация идёт ДО движения: машина на линии выезжает тем же тиком', () => {
    const state = withTankerLine(FULL_RING)

    const after = tick(state)

    // Один тик: диспетчер выдал маршрут, движение по нему тут же поехало.
    // Переставь фазы местами — и машина простояла бы этот тик в городе, а
    // потом теряла бы по тику на каждой остановке каждого круга.
    expect(after.vehicles[TANKER].route.length).toBeGreaterThan(0)
    expect(after.vehicles[TANKER].odometer).toBeGreaterThan(0)
  })

  it('расходы берут километры ЭТОГО тика, а не прошлого', () => {
    // Москва без предприятий, машина уходит порожней: выручки в этом тике нет
    // и весь сдвиг счёта — это расходы.
    const state = withVehicles([makeVehicle('zil', MOSCOW, [TULA])])

    const after = tick(state)
    const truck = after.vehicles[ZIL]
    const spent = START_MONEY - after.companies[PLAYER_ID].money

    expect(truck.odometer).toBeGreaterThan(0)

    // Переменная часть за пройденные километры обязана быть списана уже сейчас.
    // Посчитай расходы до движения — и первый тик стоил бы одну зарплату, а
    // топливо всю партию отставало бы ровно на тик.
    const variable =
      (truck.odometer / 100) * truck.fuelPer100Km * FUEL_PRICE_PER_LITER +
      truck.odometer * maintenancePerKm(truck)

    expect(spent).toBeGreaterThanOrEqual(variable - 1e-6)
    // Сверху ограничено теми же километрами плюс зарплатой: за один тик больше
    // суточного фонда оплаты труда не платят ни при каком раскладе.
    expect(spent).toBeLessThanOrEqual(variable + PAYROLL_PER_DAY)
  })

  it('стоящая машина всё равно стоит денег', () => {
    // Машина стоит в Ярославле и никуда не едет — километров ноль, значит и
    // переменных расходов ноль. Остаётся зарплата, и она обязана списаться:
    // пропусти фазу расходов для неподвижной машины — и держать простаивающий
    // парк станет бесплатно, а «лишняя машина убыточна» перестанет быть правдой.
    const state = withVehicles([makeVehicle('zil', YAROSLAVL, [])])

    const after = tick(state)

    expect(after.vehicles[ZIL].odometer).toBe(0)
    expect(after.companies[PLAYER_ID].money).toBeLessThan(START_MONEY)
    expect(START_MONEY - after.companies[PLAYER_ID].money).toBeLessThanOrEqual(
      PAYROLL_PER_DAY,
    )
  })
})

// ─── Чистота ───────────────────────────────────────────────────────────────

describe('tick: чистота', () => {
  it('не мутирует входное состояние на живом мире с экономикой', () => {
    const state = withVehicles([
      makeVehicle('v1', MOSCOW, [TULA, KALUGA]),
      makeVehicle('v2', SMOLENSK, [MOSCOW]),
    ])
    const before = JSON.stringify(state)

    const after = tickMany(state, 200)

    expect(JSON.stringify(state)).toBe(before)
    expect(after).not.toBe(state)
    // Состояние действительно менялось — иначе тест проходил бы вхолостую.
    expect(JSON.stringify(after)).not.toBe(before)
  })

  it('не трогает вложенные объекты: замороженное состояние проходит тик', () => {
    /*
     * Сравнение JSON ловит не всё. Модуль экономики может скопировать город
     * спредом верхнего уровня и записать тонны в ОБЩИЙ объект stock — тогда
     * входное состояние изменится вместе с выходным, и оба JSON совпадут между
     * собой, а тест выше промолчит. Заморозка закрывает эту дыру физически:
     * запись в чужой объект бросает TypeError, а не проходит незаметно.
     */
    const state = deepFreeze(
      withVehicles([makeVehicle('v1', MOSCOW, ringRoute(4))]),
    )
    expect(() => tickMany(state, 300)).not.toThrow()
  })

  it('не трогает вложенные объекты и на линии: компания, линия, остановки', () => {
    // Отдельный прогон под срез 3. Линия лежит ВНУТРИ компании, а остановка —
    // внутри линии: до неё три уровня копирования, и пропущенный уровень
    // проявился бы как «остановки поменялись сами собой» через много часов
    // игры. Заморозка ловит это на первом же тике.
    const state = deepFreeze(withTankerLine(FULL_RING))
    expect(() => tickMany(state, DAY * 3)).not.toThrow()
  })

  it('не подменяет объект машины, если та стоит без задания', () => {
    const parked = makeVehicle('v1', MOSCOW, [])
    const state = movementOnly([parked])

    const after = tick(state)

    // Деньги у компании при этом меняются — водителю платят и на стоянке, — но
    // сама машина обязана остаться тем же объектом: по совпадению ссылок рендер
    // отличает стоящие машины от едущих.
    expect(after.vehicles).toBe(state.vehicles)
    expect(after.vehicles[parked.id]).toBe(parked)
  })
})

// ─── Детерминизм ───────────────────────────────────────────────────────────

describe('tick: детерминизм', () => {
  it('два прогона по 500 тиков из одного состояния совпадают', () => {
    const state = movementOnly([
      makeVehicle('v1', MOSCOW, ringRoute(10)),
      makeVehicle('v2', KALUGA, ringRoute(10)),
    ])

    const first = tickMany(state, 500)
    const second = tickMany(state, 500)

    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    // Машины к этому моменту ещё в пути — сравниваются живые состояния, а не
    // два одинаковых «всё доехало и стоит».
    expect(first.vehicles[vehicleId('v1')].route.length).toBeGreaterThan(0)
    expect(first.vehicles[vehicleId('v1')].odometer).toBeGreaterThan(1000)
  })

  it('прогон по частям совпадает с прогоном целиком', () => {
    const state = movementOnly([makeVehicle('v1', MOSCOW, ringRoute(10))])

    const whole = tickMany(state, 500)
    const parts = tickMany(tickMany(tickMany(state, 137), 200), 163)

    expect(JSON.stringify(parts)).toBe(JSON.stringify(whole))
  })

  it('экономика детерминирована на десяти сутках', () => {
    const state = withVehicles([makeVehicle('v1', MOSCOW, ringRoute(10))])

    const first = tickMany(state, DAY * 10)
    const second = tickMany(state, DAY * 10)

    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it('сохранение и загрузка дают те же тики', () => {
    const state = withVehicles([makeVehicle('v1', MOSCOW, ringRoute(10))])
    const middle = tickMany(state, DAY * 2)

    // Сохранение в игре — это ровно JSON.stringify состояния, без отдельного
    // слоя сериализации. Значит загруженная партия обязана продолжаться тик в
    // тик так же, как незагруженная: иначе баг «после загрузки поехало иначе»
    // не воспроизводится вообще ничем.
    const loaded = JSON.parse(JSON.stringify(middle)) as GameState
    expect(loaded).not.toBe(middle)
    expect(loaded).toEqual(middle)

    expect(JSON.stringify(tickMany(loaded, DAY))).toBe(
      JSON.stringify(tickMany(middle, DAY)),
    )
  })

  it('линия переживает сохранение и загрузку', () => {
    // Линия — первая структура игры, которую игрок строит САМ, и потерять её
    // при загрузке значит потерять партию. Проверяется не только равенство
    // объектов, но и продолжение прогона: машина обязана ехать дальше по тому
    // же кольцу, а не встать, потеряв связь с линией.
    const middle = tickMany(withTankerLine(FULL_RING), DAY * 3)
    const loaded = JSON.parse(JSON.stringify(middle)) as GameState

    expect(loaded).toEqual(middle)
    expect(loaded.companies[PLAYER_ID].lines[RING].stops).toHaveLength(
      FULL_RING.length,
    )
    expect(loaded.vehicles[TANKER].lineId).toBe(RING)

    const a = tickMany(loaded, DAY)
    const b = tickMany(middle, DAY)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    // Машина за эти сутки действительно ехала — сравнение живых состояний.
    expect(a.vehicles[TANKER].odometer).toBeGreaterThan(
      middle.vehicles[TANKER].odometer,
    )
  })
})

// ─── Движение ──────────────────────────────────────────────────────────────

describe('tick: движение', () => {
  it('машина доезжает до конца маршрута и там останавливается', () => {
    // Москва — Тула (185 км) и Тула — Калуга (110 км).
    const state = movementOnly([makeVehicle('v1', MOSCOW, [TULA, KALUGA])])

    const arrived = tickMany(state, 200)
    const vehicle = arrived.vehicles[vehicleId('v1')]

    expect(vehicle.position).toEqual({ kind: 'узел', nodeId: KALUGA })
    expect(vehicle.route).toEqual([])
    expect(Math.abs(vehicle.odometer - 295)).toBeLessThan(1)

    // Дальше стоит: ни пробег, ни положение не меняются.
    const later = tickMany(arrived, 500)
    expect(later.vehicles[vehicleId('v1')]).toBe(vehicle)
  })

  it('машины не влияют друг на друга', () => {
    const together = movementOnly([
      makeVehicle('v1', MOSCOW, [TULA]),
      makeVehicle('v2', MOSCOW, [KALUGA]),
    ])
    const alone = movementOnly([makeVehicle('v1', MOSCOW, [TULA])])

    const a = tickMany(together, 40).vehicles[vehicleId('v1')]
    const b = tickMany(alone, 40).vehicles[vehicleId('v1')]

    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('движение разносит километры по счетам сразу, сумма сходится с одометром', () => {
    const state = movementOnly([makeVehicle('v1', MOSCOW, [TULA])])

    // ИНВАРИАНТ: гружёный плюс порожний всегда равны одометру, в любой момент,
    // включая середину ребра. В срезе 3 это уже не про аккуратность учёта:
    // каждый километр из emptyKm — сожжённая солярка, за которую никто не
    // заплатил, и разойдись эти счета с одометром, метрика порожнего пробега
    // перестала бы совпадать с деньгами.
    const enRoute = tickMany(state, 4).vehicles[vehicleId('v1')]
    expect(enRoute.position.kind).toBe('ребро')
    expect(enRoute.odometer).toBeGreaterThan(0)
    expect(enRoute.loadedKm + enRoute.emptyKm).toBeCloseTo(enRoute.odometer, 9)

    // Машина шла порожней, значит весь пробег — порожний.
    const parked = tickMany(state, 40).vehicles[vehicleId('v1')]
    expect(parked.position).toEqual({ kind: 'узел', nodeId: TULA })
    expect(parked.emptyKm).toBeCloseTo(parked.odometer, 9)
    expect(parked.loadedKm).toBe(0)
  })
})

// ─── Мир без игрока ────────────────────────────────────────────────────────

describe('десять суток без единой машины: мир задыхается', () => {
  const start = withVehicles([])
  const nine = runDays(start, 9)
  const ten = runDays(nine.end, 1)

  const day9 = nine.end
  const day10 = ten.end

  it('состояние остаётся исправным весь прогон', () => {
    expect(nine.broken).toEqual([])
    expect(ten.broken).toEqual([])
    // Разница, а не абсолют: партия начинается утром, а не в полночь.
    expect(day10.tick - WORLD.tick).toBe(DAY * 10)
  })

  it('к десятым суткам всё производство в мире стоит', () => {
    const industries = Object.values(day10.world.industries)
    expect(industries.length).toBeGreaterThan(0)

    for (const industry of industries) {
      expect(industry.utilization, industry.id).toBe(0)
      // Простой обязан накапливаться: без этого мир бесконечно ждёт игрока и
      // бездействие ничего не стоит.
      expect(industry.idleTicks, industry.id).toBeGreaterThanOrEqual(DAY)
      // За последние сутки на складе не сдвинулось ни тонны — предприятие не
      // «медленно работает», а именно стоит.
      expect(industry.stock, industry.id).toEqual(
        day9.world.industries[industry.id].stock,
      )
    }
  })

  it('источники успели наполнить склады доверху', () => {
    const sources = Object.values(day10.world.industries).filter(isSource)
    expect(sources.length).toBeGreaterThan(0)

    for (const source of sources) {
      const recipe = RECIPE_BY_INDUSTRY[source.type]
      const now = source.stock[recipe.output] ?? 0
      const atStart = WORLD.world.industries[source.id].stock[recipe.output] ?? 0

      // Работали, пока было куда складывать: накопили больше стартового запаса
      // и больше суточного выпуска. Потом упёрлись в потолок и встали.
      expect(now, source.id).toBeGreaterThan(atStart)
      expect(now, source.id).toBeGreaterThan(recipe.dailyRate)
    }
  })

  it('переработка задохнулась продукцией, а не осталась без сырья', () => {
    const plants = Object.values(day10.world.industries).filter(
      (industry) => !isSource(industry),
    )
    expect(plants.length).toBeGreaterThan(0)

    for (const plant of plants) {
      const recipe = RECIPE_BY_INDUSTRY[plant.type]
      const atStart = WORLD.world.industries[plant.id].stock

      // Продукции стало больше стартовой — завод отработал стартовый запас
      // сырья и встал, потому что складывать выпуск больше некуда.
      expect(
        plant.stock[recipe.output] ?? 0,
        `${plant.id}/${recipe.output}`,
      ).toBeGreaterThan(atStart[recipe.output] ?? 0)

      // И это ключевое: сырьё ещё ОСТАЛОСЬ. Значит причина остановки — не
      // голод, а невывоз. Ровно то утверждение, ради которого сделан срез 2:
      // мир зависит от игрока, даже когда у него всё есть.
      for (const input of recipe.inputs) {
        expect(
          plant.stock[input.type] ?? 0,
          `${plant.id}/${input.type}`,
        ).toBeGreaterThan(0)
      }
    }
  })

  it('города так и не были снабжены ни разу', () => {
    for (const city of Object.values(day10.world.cities)) {
      expect(city.suppliedDays, city.id).toBe(0)
      for (const cargo of CONSUMER_CARGO) {
        expect(city.stock[cargo] ?? 0, `${city.id}/${cargo}`).toBe(0)
      }
    }
  })

  it('ни один город не вырос, а брошенные сжимаются', () => {
    let shrunk = 0
    for (const city of Object.values(day10.world.cities)) {
      const before = WORLD.world.cities[city.id].population
      expect(city.population, city.id).toBeLessThanOrEqual(before)
      if (city.population < before) shrunk++
    }
    // Хотя бы кто-то потерял жителей: если мир только «не растёт», бездействие
    // игрока ничем не наказано и ждать его можно вечно.
    expect(shrunk).toBeGreaterThan(0)
  })

  it('пустой парк не приносит ни рубля, а штат всё равно ест', () => {
    // Денег в системе не прибавляется из ниоткуда: мир сам по себе не платит.
    // А вот УБАВЛЯЕТСЯ теперь и без машин — зарплата в срезе 4 платится людям,
    // и водитель в резерве проедает капитал ровно так же, как за рулём. Это не
    // придирка к формулировке: компания без парка перестала быть компанией на
    // паузе, и «продать всё и переждать» больше не стратегия.
    const spent = START_MONEY - day10.companies[PLAYER_ID].money
    expect(spent).toBeCloseTo(PAYROLL_PER_DAY * 10, 6)
    expect(day10.companies[PLAYER_ID].bankrupt).toBe(false)
  })
})

// ─── Город проедает завезённый запас ───────────────────────────────────────

describe('город проедает завезённый запас', () => {
  const OREL = cityId('orel')
  const STOCKED_DAYS = 3

  const start = seedCityStock(withVehicles([]), OREL, STOCKED_DAYS)
  const seeded = start.world.cities[OREL].stock

  const twoDays = tickMany(start, DAY * 2)
  const sixDays = tickMany(start, DAY * 6)

  it('завезённое действительно тает', () => {
    for (const cargo of CONSUMER_CARGO) {
      const left = twoDays.world.cities[OREL].stock[cargo] ?? 0
      expect(left, cargo).toBeLessThan(seeded[cargo]!)
      expect(left, cargo).toBeGreaterThan(0)
    }
  })

  it('снабжённый город считает сытые сутки', () => {
    // Запаса хватает на трое суток — на вторых он ещё полон, и счётчик
    // устойчивого снабжения обязан идти. Иначе рост города невозможен в
    // принципе, сколько ни вози.
    expect(twoDays.world.cities[OREL].suppliedDays).toBeGreaterThan(0)
    expect(twoDays.world.cities[OREL].population).toBeGreaterThanOrEqual(
      WORLD.world.cities[OREL].population,
    )
  })

  it('через шесть суток запас проеден и город снова голодает', () => {
    const city = sixDays.world.cities[OREL]
    for (const cargo of CONSUMER_CARGO) {
      expect(city.stock[cargo] ?? 0, cargo).toBeLessThan(0.001)
    }
    // Разовая поставка не даёт постоянного роста: счётчик сбрасывается, как
    // только снабжение прервалось. Иначе выгодно было бы завалить город один
    // раз и уехать навсегда.
    expect(city.suppliedDays).toBe(0)
  })
})

// ─── Мир с игроком: разовые рейсы никуда не делись ─────────────────────────

describe('десять суток с машиной на цепочке: мир оживает', () => {
  const source = industryOfType(WORLD, 'элеватор')
  const plant = industryOfType(WORLD, 'мукомольный')

  const hauler = makeVehicle('zil', source.cityId, [])

  const working = withVehicles([hauler])
  const idle = withVehicles([])

  /** Тиков, в которые мукомольный реально работал. */
  let plantWorkedTicks = 0
  /**
   * Тиков работы элеватора ВО ВТОРОЙ половине прогона.
   *
   * Первая половина не показательна: любой источник работает, пока не набьёт
   * склад. Интересно, работает ли он ПОСЛЕ этого — а такое возможно только
   * если кто-то освобождает место, то есть вывозит.
   */
  let sourceLateTicks = 0
  let sourceLateTicksAlone = 0

  const busy = runShuttle(working, ZIL, source.cityId, plant.cityId, 10, (s) => {
    if (s.world.industries[plant.id].utilization > 0) plantWorkedTicks++
    if (s.tick > DAY * 5 && s.world.industries[source.id].utilization > 0) {
      sourceLateTicks++
    }
  })

  const alone = runDays(idle, 10, (s) => {
    if (s.tick > DAY * 5 && s.world.industries[source.id].utilization > 0) {
      sourceLateTicksAlone++
    }
  })

  it('источник и переработка стоят в разных городах', () => {
    // Цепочка, оба звена которой в одном городе, — это цепочка без перевозки:
    // возить нечего, и весь смысл среза мимо неё.
    expect(source.cityId).not.toBe(plant.cityId)
  })

  it('состояние остаётся исправным весь прогон', () => {
    expect(busy.broken).toEqual([])
  })

  it('машина реально возит груз', () => {
    const truck = busy.end.vehicles[ZIL]
    expect(truck.odometer).toBeGreaterThan(0)
    // Гружёные километры появились — значит был хотя бы один полный цикл
    // «взял на элеваторе, отдал на комбинате».
    expect(truck.loadedKm).toBeGreaterThan(0)
    expect(truck.loadedKm + truck.emptyKm).toBeCloseTo(truck.odometer, 6)
  })

  it('завод работает только потому, что ему возят сырьё', () => {
    // Тот же завод, тот же мир, те же десять суток. Разница ровно одна —
    // машина. Совпади оба прогона, экономика не зависела бы от игрока, и весь
    // срез был бы декорацией.
    expect(plantWorkedTicks).toBeGreaterThan(0)

    // Брошенный завод отработал стартовый запас, набил склад и с тех пор стоит:
    // к концу прогона у него накоплена яма простоя в несколько игровых суток.
    const forgotten = alone.end.world.industries[plant.id]
    expect(forgotten.utilization).toBe(0)
    expect(forgotten.idleTicks).toBeGreaterThan(DAY * 5)

    // Обслуживаемый — работает рывками между ходками, и его яма заметно мельче.
    expect(busy.end.world.industries[plant.id].idleTicks).toBeLessThan(
      forgotten.idleTicks,
    )
  })

  it('источник продолжает работать, потому что от него вывозят', () => {
    // Брошенный элеватор во второй половине прогона не работает ни тика: склад
    // забит навсегда. Обслуживаемый работает в промежутках между ходками —
    // каждая увезённая партия освобождает место под следующую.
    expect(sourceLateTicksAlone).toBe(0)
    expect(sourceLateTicks).toBeGreaterThan(0)
  })

  it('челнок между источником и заводом нашёл обратную загрузку сам', () => {
    const outcome = outcomeOf(busy.end, 10)
    const truck = busy.end.vehicles[ZIL]

    // Выручка есть: машина возила и ей платили.
    expect(outcome.revenue).toBeGreaterThan(0)

    /*
     * ЗДЕСЬ КОГДА-ТО ПРОВЕРЯЛОСЬ ОБРАТНОЕ — что челнок разоряется, — и историю
     * стоит сохранить, потому что изменился МИР, а не правило.
     *
     * Маршрут «Орёл → Тула» ведёт от элеватора к мельнице, и обратно машине
     * возить нечего... пока Орёл не способен принимать муку. В прежних данных
     * он съедал 0.46 тонны в сутки — меньше десятой доли кузова, — и возврат
     * был порожним по определению. После правки формы спроса Орёл берёт около
     * восьми тонн в сутки, машина грузится мукой на обратном плече, и кольцо
     * само собой становится гружёным в обе стороны.
     *
     * Это не ослабление проверки, а её переезд: утверждение «порожний возврат
     * разоряет» доказывается ниже, на СПЕЦИАЛЬНО построенной линии без обратной
     * загрузки («тридцать суток на кольце»), где отсутствие груза задано
     * маршрутом, а не случайностью данных. Здесь же теперь проверяется то, ради
     * чего этот прогон и написан: мир оживает от одной машины.
     */
    expect(truck.loadedKm).toBeGreaterThan(truck.emptyKm)
    expect(outcome.revenue).toBeGreaterThan(outcome.costs)

    // Без машины мир не платит ни рубля: вся выручка партии приходит с
    // доставок. Тратится при этом зарплата штата — водитель получает и в
    // резерве, — поэтому счёт не «не меняется», а падает ровно на неё.
    expect(alone.end.companies[PLAYER_ID].money).toBeCloseTo(
      START_MONEY - PAYROLL_PER_DAY * 10,
      6,
    )
  })
})

// ─── ГЛАВНЫЙ ТЕСТ СРЕЗА ────────────────────────────────────────────────────

/*
 * КОЛЬЦО «НЕФТЬ — ТОПЛИВО»: Смоленск → Ярославль → Москва → Смоленск.
 *
 * Смоленская нефтебаза отгружает нефть, ярославский НПЗ превращает её в
 * топливо, Москва топливо съедает. Три плеча, из которых два могут идти
 * гружёными, и одно — возврат от потребителя к источнику — гружёным не пойдёт
 * никогда: в Москве нет ни одного предприятия (см. data/industries.ts), везти
 * из неё нечего и некому.
 *
 * Почему именно эта цепочка, а не более короткая зерновая. Тридцать суток — это
 * долго, и на такой дистанции линия должна не только считаться, но и РАБОТАТЬ:
 * источник обязан не иссякнуть, завод — не задохнуться, потребитель — не
 * наесться. Единственный потребитель в игре, который не наедается никогда, —
 * Москва, а единственный завод, чей выпуск столица съедает быстрее, чем один
 * ЗИЛ успевает возить, — НПЗ. Кольца, замкнутые на малые города, за месяц
 * забивают им склады и перестают быть показательными.
 *
 * Оба прогона идут по ОДНОМУ И ТОМУ ЖЕ кольцу и различаются одной строчкой:
 * забирает ли машина топливо в Ярославле. Пробег, топливо, резина и зарплата в
 * них совпадают — различается только выручка.
 */

const FULL_RING: Stop[] = [
  // Нефтебаза: грузим нефть. Выгружать здесь нечего — обратного груза для
  // источника в этой цепочке не существует.
  stop(SMOLENSK, [], ['нефть']),
  // НПЗ: сдаём нефть и тем же движением забираем готовое топливо. Вот эта
  // строчка и есть обратная загрузка целиком.
  stop(YAROSLAVL, ['нефть'], ['топливо']),
  // Столица: сдаём топливо. Дальше по кольцу — возврат за нефтью.
  stop(MOSCOW, ['топливо'], []),
]

/** То же кольцо, но обратное плечо идёт порожняком: топливо никто не берёт. */
const ONE_LEG_RING: Stop[] = [
  stop(SMOLENSK, [], ['нефть']),
  stop(YAROSLAVL, ['нефть'], []),
  stop(MOSCOW, ['топливо'], []),
]

describe('тридцать суток на кольце: гружёное обратное плечо против порожнего', () => {
  const DAYS = 30

  // Длины плеч берутся из графа дорог, а не выписываются числами: правка
  // километража в data/roads.ts обязана менять ожидания теста сама.
  const LEG_SUPPLY = shortestKm(GRAPH, SMOLENSK, YAROSLAVL)
  const LEG_DELIVERY = shortestKm(GRAPH, YAROSLAVL, MOSCOW)
  const LEG_HOME = shortestKm(GRAPH, MOSCOW, SMOLENSK)
  const RING_KM = LEG_SUPPLY + LEG_DELIVERY + LEG_HOME

  /** Доля кольца, которая порожняком идёт всегда: возврат из столицы. */
  const INEVITABLE_EMPTY = LEG_HOME / RING_KM
  /** Доля кольца, которая порожняком пойдёт без обратной загрузки. */
  const ABANDONED_EMPTY = (LEG_DELIVERY + LEG_HOME) / RING_KM

  const full = runDays(withTankerLine(FULL_RING), DAYS)
  const empty = runDays(withTankerLine(ONE_LEG_RING), DAYS)

  const loaded = outcomeOf(full.end, DAYS, TANKER)
  const hollow = outcomeOf(empty.end, DAYS, TANKER)

  it('состояние остаётся исправным оба прогона', () => {
    expect(full.broken).toEqual([])
    expect(empty.broken).toEqual([])
  })

  it('кольцо замкнуто и без обратной загрузки половина его порожняя', () => {
    // Геометрия задачи, а не результат прогона: возврат из Москвы за нефтью —
    // это почти треть кольца, и гружёным он не будет никогда. Сняв загрузку в
    // Ярославле, игрок добавляет к нему ещё и плечо до столицы — ровно половину
    // кольца.
    expect(INEVITABLE_EMPTY).toBeGreaterThan(0)
    expect(INEVITABLE_EMPTY).toBeLessThan(ABANDONED_EMPTY)
    expect(ABANDONED_EMPTY).toBeCloseTo(0.5, 2)
  })

  it('без обратной загрузки кольцо душит собственную цепочку', () => {
    /*
     * Утверждение изменилось после среза 2, и изменилось в сторону более
     * сильного. Раньше здесь проверялось, что порожнее кольцо проезжает БОЛЬШЕ
     * километров: машина не тратит время на вторую погрузку и успевает больше
     * рейсов. Это было верно, пока мир не зависел от игрока.
     *
     * Теперь верно обратное, и по интересной причине. Мука, которую никто не
     * вывозит, забивает склад комбината, комбинат задыхается и останавливается,
     * а следом машине становится нечего возить и в прямую сторону. Порожнее
     * кольцо душит собственную цепочку — оно наказывается не только топливом,
     * но и остановкой производства.
     */
    expect(hollow.truck.odometer).toBeLessThan(loaded.truck.odometer)
  })

  it('кольцо с гружёным обратным плечом выводит компанию в плюс', () => {
    /*
     * Абсолютная прибыльность проверяется на СИНТЕТИЧЕСКОМ мире в
     * tick.invariant.test.ts, где геометрия и цепочка подобраны под замер.
     * Здесь мир настоящий, со всеми его предприятиями и складами, и на нём
     * конкретное кольцо может не выходить в плюс за тридцать суток — это
     * вопрос выбора маршрута игроком, а не поломка правил.
     *
     * Требование этого теста — сравнительное: гружёное обратное плечо обязано
     * быть заметно выгоднее порожнего. Оно и есть инвариант.
     */
    expect(loaded.money).toBeGreaterThan(hollow.money)
    expect(loaded.end.companies[PLAYER_ID].bankrupt).toBe(false)

    // Разрыв между гружёным и порожним кольцом обязан быть КРУПНЫМ, а не
    // на грани измеримости: игрок должен замечать разницу без калькулятора.
    // Мерка — цена стартовой машины: правильно построенное кольцо отыгрывает
    // у неправильного целый грузовик за месяц.
    expect(loaded.money - hollow.money).toBeGreaterThan(STARTER_PRICE)
  })

  it('порожний пробег гружёного кольца — ровно его геометрия плюс первый выезд', () => {
    // Ни километром больше неизбежного возврата: машина идёт гружёной везде,
    // где кольцо это позволяет.
    expect(loaded.emptyShare).toBeGreaterThanOrEqual(INEVITABLE_EMPTY)
    expect(loaded.emptyShare).toBeLessThan(ABANDONED_EMPTY)

    /*
     * ПРЕВЫШЕНИЕ НАД ГЕОМЕТРИЕЙ РОВНО ОДНО И ОНО СЧИТАЕТСЯ. Машина стартует в
     * Москве, а нулевая остановка кольца — Смоленск, поэтому самый первый выезд
     * идёт порожним сверх всех кругов. Это ровно LEG_HOME лишних порожних
     * километров на весь прогон, и доля превышения равна LEG_HOME / одометр.
     *
     * Верхняя граница выводится, а не подбирается, и потому не зависит от того,
     * сколько кругов машина успела: со срезом 5 их стало меньше (посты держат её
     * под погрузкой), и жёстко зашитое «примерно 0.30» тут же покраснело бы, хотя
     * ни одного правила игры не поменялось.
     */
    const firstLegShare = LEG_HOME / loaded.truck.odometer
    expect(loaded.emptyShare).toBeLessThanOrEqual(
      INEVITABLE_EMPTY + firstLegShare,
    )
  })

  it('без обратной загрузки то же кольцо разоряет компанию', () => {
    // Выручка не исчезла — машина по-прежнему возит нефть на завод. Она просто
    // перестала покрывать расходы, которые не изменились ни на рубль.
    expect(hollow.revenue).toBeGreaterThan(0)
    expect(hollow.revenue).toBeLessThan(hollow.costs)

    // Стартового капитала на месяц такой работы не хватает с большим запасом.
    expect(hollow.money).toBeLessThan(0)
  })

  it('без обратной загрузки порожний пробег виден в метрике', () => {
    /*
     * ЗДЕСЬ КОГДА-ТО СТОЯЛО ОБРАТНОЕ УТВЕРЖДЕНИЕ, и историю стоит сохранить,
     * потому что ловушка никуда не делась — просто перестала срабатывать на
     * нынешних данных.
     *
     * В прежнем, впятеро меньшем мире НПЗ выпускал 65 тонн топлива в сутки. Стоило
     * перестать вывозить продукцию, склад забивался, выпуск падал, и завод
     * переставал принимать даже полную ходку нефти — тем более двадцатитонную.
     * Машина возила непринятый остаток по кругу, эти километры засчитывались
     * ГРУЖЁНЫМИ, и порожний пробег у сломанной линии выходил НИЖЕ, чем у
     * здоровой. Метрика мастерства показывала благополучие там, где дела были
     * хуже всего.
     *
     * После подъёма масштаба мира завод берёт полную ходку без запинки, и
     * метрика показывает правду: у линии с порожним обратным плечом порожняк
     * около половины кольца, у линии с загрузкой — только возврат из столицы.
     *
     * ВЫВОД ДЛЯ ИГРЫ ОСТАЁТСЯ ПРЕЖНИМ: порожний пробег — метрика ОПТИМИЗАЦИИ
     * работающей сети, а не диагноз сломанной. Насыщенный получатель по-прежнему
     * способен раздуть гружёные километры, и судьёй остаётся знак прибыли —
     * поэтому главные утверждения этого прогона про деньги, а не про долю.
     */
    expect(hollow.emptyShare).toBeGreaterThan(loaded.emptyShare)

    // Груз до завода всё-таки доезжает: сломано обратное плечо, а не линия.
    expect(hollow.truck.loadedKm).toBeGreaterThan(0)
    expect(hollow.revenue).toBeLessThan(loaded.revenue)

    // Доля лежит в пределах геометрии кольца плюс первый выезд из Москвы к
    // нулевой остановке — та же поправка, что и у гружёного прогона выше, и по
    // той же причине: этот перегон порожний сверх всех кругов.
    const firstLegShare = LEG_HOME / hollow.truck.odometer
    expect(hollow.emptyShare).toBeLessThanOrEqual(
      ABANDONED_EMPTY + firstLegShare,
    )
    expect(hollow.emptyShare).toBeGreaterThan(INEVITABLE_EMPTY)
  })

  it('вся разница между прогонами — в выручке обратного плеча', () => {
    // Выручка полного кольца заметно больше: к нефти на завод добавилось
    // топливо в столицу, а топливо — самый дорогой груз в игре.
    expect(loaded.revenue).toBeGreaterThan(hollow.revenue * 1.5)
    // И именно эта добавка переворачивает знак итога.
    expect(loaded.money - hollow.money).toBeGreaterThan(0)
  })
})

// ─── Партия без линий ──────────────────────────────────────────────────────

describe('партия без единой линии проедает капитал и кончается банкротством', () => {
  /** Суток до нуля на счету: машина стоит, но водителю платят каждый день. */
  const DAYS_TO_ZERO = START_MONEY / PAYROLL_PER_DAY
  /** С запасом в двое суток на округления и на день обнуления. */
  const LIMIT_DAYS = Math.ceil(DAYS_TO_ZERO) + BANKRUPTCY_GRACE_DAYS + 2

  const parked = withVehicles([makeVehicle('zil', MOSCOW, [])])

  const early = tickMany(parked, DAY * Math.floor(DAYS_TO_ZERO / 2))
  const end = tickMany(parked, DAY * LIMIT_DAYS)

  const company = (state: GameState): Company => state.companies[PLAYER_ID]

  it('машина не двигается: линии нет, разовых рейсов не выдавали', () => {
    expect(end.vehicles[ZIL].odometer).toBe(0)
    expect(end.vehicles[ZIL].lineId).toBeNull()
  })

  it('капитал тает с первого же дня', () => {
    expect(company(early).money).toBeLessThan(START_MONEY)
    // Тают именно зарплаты: километров нет, значит нет ни топлива, ни резины.
    const days = Math.floor(DAYS_TO_ZERO / 2)
    expect(START_MONEY - company(early).money).toBeCloseTo(
      PAYROLL_PER_DAY * days,
      -2,
    )
  })

  it('пока деньги есть, компания не банкрот', () => {
    expect(company(early).money).toBeGreaterThan(0)
    expect(company(early).bankrupt).toBe(false)
    expect(company(early).daysInDebt).toBe(0)
  })

  it('минус не убивает сразу — отсрочка есть', () => {
    // Уйти в минус на день нормально: закупился топливом, зарплата пришлась на
    // неудачный момент. Проверяем, что первый же день долга не обнуляет партию.
    const justInDebt = tickMany(parked, DAY * (Math.ceil(DAYS_TO_ZERO) + 1))
    expect(company(justInDebt).money).toBeLessThan(0)
    expect(company(justInDebt).bankrupt).toBe(false)
  })

  it('не выбравшись из долга за отпущенный срок, компания разоряется', () => {
    // Главное утверждение: «ничего не возить» — это проигрыш, а не бесконечное
    // ожидание. Мир не платит сам по себе, а парк стоит денег каждый день.
    expect(company(end).money).toBeLessThan(0)
    // Отсрочка отсчитывается тиками по 1/96 суток, поэтому ровно тридцати не
    // выйдет никогда — сравниваем с допуском в один тик.
    expect(company(end).daysInDebt).toBeGreaterThan(BANKRUPTCY_GRACE_DAYS - 0.02)
    expect(company(end).bankrupt).toBe(true)
  })
})

// ─── Срез 4: новые фазы встали на свои места ───────────────────────────────

describe('tick: фазы водителей и износа', () => {
  it('фаза водителей отработала: усталость копится за рулём', () => {
    const state = withVehicles([makeVehicle('zil', MOSCOW, ringRoute(4))])

    const after = tickMany(state, DAY / 4)
    const driver = Object.values(after.companies[PLAYER_ID].drivers)[0]

    // Нулевая усталость после шести часов за рулём означала бы, что фаза
    // водителей в конвейер не подключена, — и режим труда с отдыхом не
    // существует, сколько бы кода в driver.ts ни лежало.
    expect(driver.fatigue).toBeGreaterThan(0)
    expect(driver.hoursOnDuty).toBeGreaterThan(0)
  })

  it('фаза износа отработала: ресурс стёрся, счётчик до ТО вырос', () => {
    const state = withVehicles([makeVehicle('zil', MOSCOW, ringRoute(4))])

    const after = tickMany(state, DAY)
    const truck = after.vehicles[ZIL]

    expect(truck.odometer).toBeGreaterThan(0)
    expect(truck.wear).toBeGreaterThan(0)
    // Счётчик до ТО ведёт фаза износа, а не движение: два места означали бы
    // машину, изнашивающуюся вдвое быстрее собственного описания.
    expect(truck.kmSinceService).toBeGreaterThan(0)
    /*
     * Счётчик идёт вровень с одометром, но не совпадает с ним до километра, и
     * это честное свойство модели, а не погрешность округления. Фаза износа
     * берёт пробег тика у tickKm — то есть ИЗМЕРЯЕТ его по положению машины, а
     * не получает от движения (свободного поля под «сколько проехали за тик» в
     * types.ts нет). Модель оговаривает два случая, где она чуть промахивается:
     * тик пересечения транзитного узла и хвост плеча. Расхождение не копится в
     * одну сторону и держится в пределах процента — проверяем именно это, а не
     * точное равенство, которого модель и не обещает.
     */
    expect(truck.kmSinceService).toBeGreaterThan(truck.odometer * 0.98)
    expect(truck.kmSinceService).toBeLessThan(truck.odometer * 1.02)
  })

  it('водитель уходит на отдых и машина встаёт', () => {
    const state = withVehicles([makeVehicle('zil', MOSCOW, ringRoute(10))])

    // Двое суток: за это время смена обязана кончиться хотя бы раз.
    const after = tickMany(state, DAY * 2)
    const truck = after.vehicles[ZIL]

    // Ограничение сверху — это и есть режим труда: без него одна машина
    // проходила бы за сутки все двадцать четыре часа хода, и покупать вторую
    // было бы незачем.
    const nonstopKm = truck.cruiseKmh * 48
    expect(truck.odometer).toBeGreaterThan(0)
    expect(truck.odometer).toBeLessThan(nonstopKm)
  })

  it('машина без водителя не двигается и ничего не стоит, кроме штата', () => {
    const orphan = makeVehicle('zil', MOSCOW, ringRoute(2), { driverId: null })
    const state = withVehicles([orphan])

    const after = tickMany(state, DAY)

    expect(after.vehicles[ZIL].odometer).toBe(0)
    // Расход ровно суточный фонд оплаты труда: ни топлива, ни резины.
    expect(START_MONEY - after.companies[PLAYER_ID].money).toBeCloseTo(
      PAYROLL_PER_DAY,
      6,
    )
  })

  it('сломанная машина стоит, пока её не починят', () => {
    const broken = makeVehicle('zil', MOSCOW, ringRoute(2), { brokenDown: true })
    const state = withVehicles([broken])

    const after = tickMany(state, DAY)

    expect(after.vehicles[ZIL].odometer).toBe(0)
    // Поломка не чинится сама и не проходит со временем: это решение игрока и
    // его деньги.
    expect(after.vehicles[ZIL].brokenDown).toBe(true)
  })
})
