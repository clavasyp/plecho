import { describe, expect, it } from 'vitest'
import {
  CONSUMER_CARGO,
  CONSUMPTION_PER_1K,
  RECIPE_BY_INDUSTRY,
} from '../data/recipes'
import { setRoute } from './logistics/vehicle'
import { createInitialState, PLAYER_ID, START_MONEY } from './state'
import { HOURS_PER_TICK, tick, tickMany } from './tick'
import { TICKS_PER_DAY, cityId, vehicleId } from './types'
import type {
  CargoType,
  CityId,
  GameState,
  Industry,
  IndustryType,
  Tons,
  Vehicle,
  VehicleId,
} from './types'
import { buildGraph } from './world/graph'
import { findRoute } from './world/pathfind'

/**
 * Тик проверяется на НАСТОЯЩЕМ мире: города, дороги и предприятия берутся из
 * начального состояния, а не подделываются. Это интеграционный тест среза 2 —
 * его задача не в том, чтобы поймать ошибку в отдельной формуле (для этого
 * есть тесты рядом с самими формулами), а в том, чтобы доказать два
 * утверждения, ради которых срез и делался:
 *
 *   1. Мир БЕЗ игрока задыхается. За десять суток ВСЁ производство на карте
 *      встаёт: и источники, и переработка упираются в потолок склада, города
 *      проедают завезённое, и ни рубля ниоткуда не появляется.
 *   2. Мир С игроком оживает. Та же цепочка при работающей машине производит,
 *      а счёт компании растёт.
 *
 * Если оба прогона дают одно и то же — экономики нет, есть декорация.
 *
 * Важная деталь первого прогона, которую стоит держать в голове при чтении
 * тестов: переработка встаёт НЕ от голода. Данные дают ей запас сырья на трое
 * суток, и она успевает набить свой склад продукцией раньше, чем съест этот
 * запас. То есть завод останавливается, имея полный склад сырья, — просто
 * складывать выпуск больше некуда. Это и есть «мир зависит от игрока» в самой
 * чистой форме: не хватает не ресурсов, не хватает ВЫВОЗА.
 */

const MOSCOW = cityId('moscow')
const TULA = cityId('tula')
const KALUGA = cityId('kaluga')
const BRYANSK = cityId('bryansk')
const SMOLENSK = cityId('smolensk')

/** Сутки в тиках — 96. Экономика живёт сутками, тик для неё слишком мелок. */
const DAY = TICKS_PER_DAY

/** Крейсерская скорость стартового ЗИЛа. */
const ZIL_KMH = 70

/** Эталонный мир. Сид фиксирован — прогоны обязаны совпадать между запусками. */
const WORLD = createInitialState(20250808)

// ─── Фикстуры ──────────────────────────────────────────────────────────────

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
    cruiseKmh: 90,
    odometer: 0,
    capacity: 6,
    cargo: null,
    loadedKm: 0,
    emptyKm: 0,
    ...patch,
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
 * Погрузка автоматическая, поэтому в живом мире машина, постоявшая в городе с
 * готовой продукцией, уедет из него гружёной. Для проверок «машина не
 * изменилась» и «машины не влияют друг на друга» это лишняя переменная:
 * убираем предприятия и остаёмся с чистой кинематикой.
 */
function movementOnly(vehicles: Vehicle[]): GameState {
  const base = withVehicles(vehicles)
  return { ...base, world: { ...base.world, industries: {} } }
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

/** Суточное потребление города по грузу, тонн. */
function dailyDemand(population: number, cargo: CargoType): Tons {
  return (CONSUMPTION_PER_1K[cargo] ?? 0) * (population / 1000)
}

/** Завезти городу запас потребительских товаров ровно на N суток. */
function seedCityStock(
  state: GameState,
  id: CityId,
  days: number,
): GameState {
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
    // Разнесённых километров не может быть больше пройденных. Разность —
    // это пробег с последней погрузки, по нему фаза прибытия считает плечо
    // доставки; уйди она в минус, и рейс оплатился бы за отрицательное плечо.
    check(
      vehicle.loadedKm >= 0 && vehicle.emptyKm >= 0,
      `счётчики ${vehicle.id}: ${vehicle.loadedKm} / ${vehicle.emptyKm}`,
    )
    check(
      vehicle.loadedKm + vehicle.emptyKm <= vehicle.odometer + 1e-6,
      `разнесено больше пройденного у ${vehicle.id}: ${vehicle.loadedKm} + ${vehicle.emptyKm} > ${vehicle.odometer}`,
    )
  }

  for (const company of Object.values(state.companies)) {
    check(Number.isFinite(company.money), `счёт ${company.id} = ${company.money}`)
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
 * Прогон с ИГРОКОМ ЗА РУЛЁМ: машина челноком ходит между двумя городами.
 *
 * Маршрут выдаётся заново каждый раз, когда машина доехала и встала. Это ровно
 * то, что делает игрок в срезе 2 кнопкой «отправить», и это единственный
 * способ дать машине постоять в узле: advanceVehicle доедает остаток тика и
 * проходит промежуточные города НАСКВОЗЬ, поэтому машина с длинным
 * заготовленным маршрутом почти никогда не оказывается в узле на границе тика —
 * а погрузка бывает только на стоянке. В срезе 3 эту работу возьмут на себя
 * линии, и здесь останется назначение на линию.
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

// ─── Время ─────────────────────────────────────────────────────────────────

describe('tick: время', () => {
  it('увеличивает счётчик тиков ровно на единицу', () => {
    const state = movementOnly([])
    expect(tick(state).tick).toBe(1)
    expect(tick(tick(state)).tick).toBe(2)
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

  it('не подменяет объект машины, если та стоит без задания', () => {
    const parked = makeVehicle('v1', MOSCOW, [])
    const state = movementOnly([parked])

    const after = tick(state)

    expect(after.vehicles).toBe(state.vehicles)
    expect(after.vehicles[parked.id]).toBe(parked)
  })
})

/** Рекурсивная заморозка. Возвращает тот же объект — удобно для инлайна. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const inner of Object.values(value as Record<string, unknown>)) {
    deepFreeze(inner)
  }
  return Object.freeze(value)
}

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
    // включая середину ребра. Разнесение живёт в фазе движения, потому что
    // только там известно, гружена машина или нет.
    //
    // Раньше счета закрывались на остановках, и машина с грузом, которому нигде
    // нет получателя, не доезжала до закрытия никогда: в прогоне на 100 суток
    // так терялось 99.5% одометра, а метрика порожнего пробега — главная
    // метрика мастерства в игре — показывала неправду.
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

// ─── Главный тест среза: мир без игрока ────────────────────────────────────

describe('десять суток без единой машины: мир задыхается', () => {
  const start = withVehicles([])
  const nine = runDays(start, 9)
  const ten = runDays(nine.end, 1)

  const day9 = nine.end
  const day10 = ten.end

  it('состояние остаётся исправным весь прогон', () => {
    expect(nine.broken).toEqual([])
    expect(ten.broken).toEqual([])
    expect(day10.tick).toBe(DAY * 10)
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
      // голод, а невывоз. Ровно то утверждение, ради которого сделан срез:
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

  it('мир без перевозок не приносит ни рубля', () => {
    // Денег в системе не прибавляется из ниоткуда. Это же и означает, что
    // пересидеть партию на стартовом капитале нельзя.
    expect(day10.companies[PLAYER_ID].money).toBe(START_MONEY)
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

// ─── Главный тест среза: мир с игроком ─────────────────────────────────────

describe('десять суток с машиной на цепочке: мир оживает', () => {
  const source = industryOfType(WORLD, 'элеватор')
  const plant = industryOfType(WORLD, 'мукомольный')

  const ZIL = vehicleId('zil')
  const hauler = makeVehicle('zil', source.cityId, [], { cruiseKmh: ZIL_KMH })

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
  /** Баланс на конец каждых суток — по нему видно, растёт он или замер. */
  const moneyByDay: number[] = []

  const busy = runShuttle(working, ZIL, source.cityId, plant.cityId, 10, (s) => {
    if (s.world.industries[plant.id].utilization > 0) plantWorkedTicks++
    if (s.tick > DAY * 5 && s.world.industries[source.id].utilization > 0) {
      sourceLateTicks++
    }
    if (s.tick % DAY === 0) moneyByDay.push(s.companies[PLAYER_ID].money)
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
    expect(truck.loadedKm + truck.emptyKm).toBeLessThanOrEqual(
      truck.odometer + 1e-6,
    )
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

  it('деньги растут и продолжают расти', () => {
    expect(moneyByDay).toHaveLength(10)
    expect(moneyByDay[4]).toBeGreaterThan(START_MONEY)
    expect(moneyByDay[9]).toBeGreaterThan(moneyByDay[4])

    // Без машины счёт не меняется вообще: мир сам по себе не платит.
    expect(alone.end.companies[PLAYER_ID].money).toBe(START_MONEY)
  })
})
