import { describe, expect, it } from 'vitest'
import {
  BANKRUPTCY_GRACE_DAYS,
  DRIVER_WAGE_PER_DAY,
  FUEL_PRICE_PER_LITER,
  MAINTENANCE_PER_KM,
} from '../../data/operating'
import { advanceVehicle, setRoute, speedKmh } from '../logistics/vehicle'
import {
  STARTER_CAPACITY_TONS,
  STARTER_CRUISE_KMH,
  STARTER_FUEL_PER_100KM,
} from '../state'
import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../types'
import { cityId, companyId, edgeId, vehicleId } from '../types'
import type {
  City,
  CityId,
  Company,
  CompanyId,
  Edge,
  EdgeId,
  GameState,
  IndustryId,
  Industry,
  Vehicle,
  VehicleId,
} from '../types'
import { deliveryRevenue } from './finance'
import {
  DAY_WINDOW_DECAY,
  WAGE_PER_TICK,
  creditRevenue,
  distanceCost,
  fuelCost,
  maintenanceCost,
  runOperatingCosts,
  tickKm,
} from './operating'

/**
 * Мир здесь синтетический, но плечо настоящее: Орёл — Тула, 183 км по М-2
 * «Крым», качество 0.78 — ровно та строка из src/data/roads.ts, на которой
 * посчитана сходимость в конце src/data/operating.ts. Тест про смысл игры
 * обязан считать по тому же плечу, что и документ, иначе сверять нечего.
 *
 * ЧИСЛА ВЫВОДЯТСЯ ИЗ КОНСТАНТ. Ни одно ожидание не вписано посчитанным: цена
 * километра спрашивается у fuelCost/maintenanceCost, скорость — у speedKmh,
 * выручка — у deliveryRevenue, машина собирается из STARTER_* (sim/state.ts).
 * Перебалансировка данных обязана менять поведение игры, но не ронять тесты, в
 * которых не поменялось ни одного ПРАВИЛА.
 */

const OREL = cityId('orel')
const TULA = cityId('tula')

const PLAYER: CompanyId = companyId('player')
const RIVAL: CompanyId = companyId('rival')
const V1: VehicleId = vehicleId('v1')

/** Реальное плечо Орёл — Тула по М-2. */
const LEG_KM = 183
const LEG_QUALITY = 0.78

const M2: EdgeId = edgeId('orel-tula')
/** Та же дорога вдвое хуже — для проверки пропорциональности пробегу. */
const M2_ROUGH: EdgeId = edgeId('orel-tula-rough')

const EDGES: Edge[] = [
  {
    id: M2,
    from: OREL,
    to: TULA,
    km: LEG_KM,
    class: 'федеральная',
    route: 'М-2 Крым',
    quality: LEG_QUALITY,
  },
  {
    id: M2_ROUGH,
    from: OREL,
    to: TULA,
    km: LEG_KM,
    class: 'федеральная',
    route: 'М-2 Крым (разбитая)',
    quality: LEG_QUALITY / 2,
  },
]

/**
 * Длительность тика в часах. Выводится так же, как в самой фазе, и по той же
 * причине: это перевод единиц из контракта, а не игровое правило.
 */
const HOURS_PER_TICK = 1 / TICKS_PER_HOUR

/**
 * Денег заведомо больше, чем тратится за прогон: банкротство посреди теста про
 * топливо мешало бы. Но и не «сто миллионов»: расход считается вычитанием
 * остатков, а вычитание 14 рублей из огромного числа теряет значащие цифры
 * раньше, чем тест успевает что-нибудь проверить.
 */
const RICH = 1_000_000

function makeCity(id: CityId): City {
  return {
    id,
    name: id,
    coord: { lat: 54, lon: 36 },
    population: 300_000,
    profile: 'промышленный',
    stock: {},
    suppliedDays: 0,
  }
}

/** Стартовый ЗИЛ — та самая машина, на которой посчитан документ. */
function makeZil(at: CityId, patch: Partial<Vehicle> = {}): Vehicle {
  return {
    id: V1,
    ownerId: PLAYER,
    position: { kind: 'узел', nodeId: at },
    route: [],
    lineId: null,
    stopIndex: 0,
    blockedTicks: 0,
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

function makeCompany(id: CompanyId, patch: Partial<Company> = {}): Company {
  return {
    id,
    name: id,
    money: RICH,
    controller: 'человек',
    lines: {},
    dailyRevenue: 0,
    dailyCosts: 0,
    bankrupt: false,
    daysInDebt: 0,
    ...patch,
  }
}

function makeState(vehicles: Vehicle[], companies: Company[]): GameState {
  return {
    rngState: 1,
    tick: 0,
    startYear: 1994,
    world: {
      cities: Object.fromEntries([OREL, TULA].map((id) => [id, makeCity(id)])) as Record<
        CityId,
        City
      >,
      edges: Object.fromEntries(EDGES.map((e) => [e.id, e])) as Record<EdgeId, Edge>,
      industries: {} as Record<IndustryId, Industry>,
    },
    companies: Object.fromEntries(companies.map((c) => [c.id, c])) as Record<
      CompanyId,
      Company
    >,
    playerId: PLAYER,
    vehicles: Object.fromEntries(vehicles.map((v) => [v.id, v])) as Record<
      VehicleId,
      Vehicle
    >,
  }
}

/** Скорость ЗИЛа на плече — по единственной формуле скорости в проекте. */
const LEG_SPEED_KMH = speedKmh(makeZil(OREL), EDGES[0])
/** Сколько машина проходит за один тик на этом плече. */
const KM_PER_TICK = LEG_SPEED_KMH * HOURS_PER_TICK

function player(state: GameState): Company {
  return state.companies[PLAYER]
}

function truck(state: GameState): Vehicle {
  return state.vehicles[V1]
}

function spent(before: GameState, after: GameState): number {
  return player(before).money - player(after).money
}

/** Фаза движения из tick.ts, воспроизведённая ровно настолько, сколько нужно. */
function moveVehicles(state: GameState): GameState {
  const vehicles: Record<VehicleId, Vehicle> = { ...state.vehicles }
  for (const id of Object.keys(vehicles) as VehicleId[]) {
    vehicles[id] = advanceVehicle(vehicles[id], state, HOURS_PER_TICK)
  }
  return { ...state, vehicles }
}

function withVehicle(state: GameState, next: Vehicle): GameState {
  return { ...state, vehicles: { ...state.vehicles, [next.id]: next } }
}

/**
 * Проехать плечо до города `to` и вернуть состояние с числом потраченных тиков.
 *
 * Воспроизводит порядок фаз тика в той части, которая касается денег:
 * диспетчеризация выдаёт маршрут СТОЯЩЕЙ машине (фаза 3), потом движение
 * (фаза 4), потом расходы (фаза 7). Именно этот порядок и создаёт задачу с
 * хвостом плеча: машина приезжает в узел посреди тика и остаток тика стоит.
 */
function driveLeg(state: GameState, to: CityId): { state: GameState; ticks: number } {
  let next = withVehicle(state, setRoute(truck(state), [to]))
  let ticks = 0

  while (ticks < 1000) {
    next = moveVehicles(next)
    next = runOperatingCosts(next)
    ticks++

    const position = truck(next).position
    if (position.kind === 'узел' && position.nodeId === to) break
  }

  return { state: next, ticks }
}

describe('пробег тика', () => {
  it('машина на ребре платит за километры этого тика, а не за одометр', () => {
    // Одометр намеренно огромный: если фаза начнёт считать по нему, счёт
    // отличится на два порядка и тест это увидит.
    const zil = makeZil(OREL, {
      position: { kind: 'ребро', edgeId: M2, fromId: OREL, progress: 0.5 },
      route: [TULA],
      odometer: 100_000,
      emptyKm: 100_000,
    })
    const before = makeState([zil], [makeCompany(PLAYER)])

    expect(tickKm(zil, before)).toBeCloseTo(KM_PER_TICK, 9)

    const after = runOperatingCosts(before)
    expect(spent(before, after)).toBeCloseTo(
      distanceCost(zil, KM_PER_TICK) + WAGE_PER_TICK,
      9,
    )
  })

  it('топливо и обслуживание пропорциональны пробегу тика', () => {
    const onGood = makeZil(OREL, {
      position: { kind: 'ребро', edgeId: M2, fromId: OREL, progress: 0.5 },
      route: [TULA],
    })
    const onRough = makeZil(OREL, {
      position: { kind: 'ребро', edgeId: M2_ROUGH, fromId: OREL, progress: 0.5 },
      route: [TULA],
    })

    const good = makeState([onGood], [makeCompany(PLAYER)])
    const rough = makeState([onRough], [makeCompany(PLAYER)])

    // Дорога вдвое хуже — скорость вдвое ниже, пробег тика вдвое меньше.
    expect(tickKm(onRough, rough)).toBeCloseTo(tickKm(onGood, good) / 2, 9)

    const goodDistance = spent(good, runOperatingCosts(good)) - WAGE_PER_TICK
    const roughDistance = spent(rough, runOperatingCosts(rough)) - WAGE_PER_TICK

    expect(roughDistance).toBeCloseTo(goodDistance / 2, 9)
    // И обе статьи считаются по одному пробегу.
    expect(goodDistance).toBeCloseTo(
      fuelCost(onGood, KM_PER_TICK) + maintenanceCost(KM_PER_TICK),
      9,
    )
  })

  it('за плечо платится ровно его длина: хвост не теряется', () => {
    const zil = makeZil(OREL)
    const before = makeState([zil], [makeCompany(PLAYER)])

    const { state: after, ticks } = driveLeg(before, TULA)

    expect(truck(after).odometer).toBeCloseTo(LEG_KM, 9)

    const distance = spent(before, after) - ticks * WAGE_PER_TICK
    expect(distance).toBeCloseTo(distanceCost(zil, LEG_KM), 6)
  })

  it('плечо занимает не целое число тиков — иначе хвост нечего было бы досчитывать', () => {
    // Проверка предпосылки предыдущего теста: если плечо вдруг уложится в целое
    // число тиков, тест про хвост станет зелёным, ничего не проверяя.
    expect(LEG_KM % KM_PER_TICK).toBeGreaterThan(0)
  })
})

describe('зарплата', () => {
  it('идёт и у стоящей машины', () => {
    const before = makeState([makeZil(OREL)], [makeCompany(PLAYER)])
    const after = runOperatingCosts(before)

    expect(tickKm(truck(before), before)).toBe(0)
    expect(spent(before, after)).toBeCloseTo(WAGE_PER_TICK, 9)
  })

  it('за сутки простоя набегает ровно суточная ставка', () => {
    let state = makeState([makeZil(OREL)], [makeCompany(PLAYER)])
    const before = state

    for (let i = 0; i < TICKS_PER_DAY; i++) state = runOperatingCosts(state)

    // Точность до копеек, а не до девятого знака: сумма набирается 96
    // вычитаниями из шестизначного остатка, и последние разряды съедает сам
    // формат числа, а не правило.
    expect(spent(before, state)).toBeCloseTo(DRIVER_WAGE_PER_DAY, 6)
  })
})

describe('суточный итог', () => {
  it('считается за сутки, а не накопительно', () => {
    let state = makeState([makeZil(OREL)], [makeCompany(PLAYER)])
    const before = state

    // Двадцать суток, а не двое: окно экспоненциальное и к установившемуся
    // значению подходит асимптотически — остаток разбега равен (1−d) в степени
    // числа тиков. За двадцать суток от него не остаётся ничего заметного.
    const days = 20
    for (let i = 0; i < days * TICKS_PER_DAY; i++) state = runOperatingCosts(state)

    // Потрачено за двадцать суток — ровно вдвадцатеро больше суточного.
    expect(spent(before, state)).toBeCloseTo(days * DRIVER_WAGE_PER_DAY, 6)
    // А показывается по-прежнему СУТОЧНЫЙ итог: окно сошлось к суточной ставке.
    expect(player(state).dailyCosts).toBeCloseTo(DRIVER_WAGE_PER_DAY, 1)
    // Накопительный итог был бы в двадцать раз больше — вот этого и не должно
    // быть видно в панели.
    expect(player(state).dailyCosts).toBeLessThan(2 * DRIVER_WAGE_PER_DAY)
  })

  it('выручка, начисленная через creditRevenue, сходится к суточной', () => {
    // Ровно то, что делает фаза прибытия: каждый тик приходит одна и та же
    // сумма. Через несколько суток окно обязано показать суточный итог, а не
    // сумму с начала прогона.
    const perTick = 500
    let state = makeState([], [makeCompany(PLAYER, { money: 0 })])

    for (let i = 0; i < 20 * TICKS_PER_DAY; i++) {
      state = {
        ...state,
        companies: {
          ...state.companies,
          [PLAYER]: creditRevenue(state.companies[PLAYER], perTick),
        },
      }
      state = runOperatingCosts(state)
    }

    expect(player(state).dailyRevenue).toBeCloseTo(perTick * TICKS_PER_DAY, 1)
    // Деньги при этом накопились за все двадцать суток — окно их не «съедает».
    expect(player(state).money).toBeCloseTo(perTick * 20 * TICKS_PER_DAY, 6)
  })

  it('старая выручка уходит из окна, когда перестала поступать', () => {
    const earned = 100_000
    const state = makeState(
      [],
      [makeCompany(PLAYER, { dailyRevenue: earned })],
    )

    let next = state
    for (let i = 0; i < TICKS_PER_DAY; i++) next = runOperatingCosts(next)

    // Ровно (1−d)^96 от прежнего — окно длиной в сутки, а не срез в полночь:
    // забывает плавно и не зависит от того, когда игрок открыл панель.
    expect(player(next).dailyRevenue).toBeCloseTo(
      earned * (1 - DAY_WINDOW_DECAY) ** TICKS_PER_DAY,
      6,
    )
    expect(player(next).dailyRevenue).toBeLessThan(earned / 2)
  })
})

describe('банкротство', () => {
  /** Компания без парка: деньги не меняются, растёт только счётчик долга. */
  function indebted(money: number): GameState {
    return makeState([], [makeCompany(PLAYER, { money })])
  }

  function run(state: GameState, ticks: number): GameState {
    let next = state
    for (let i = 0; i < ticks; i++) next = runOperatingCosts(next)
    return next
  }

  it('наступает только после отсрочки', () => {
    const grace = BANKRUPTCY_GRACE_DAYS * TICKS_PER_DAY

    const almost = run(indebted(-1), grace - 1)
    expect(almost.companies[PLAYER].bankrupt).toBe(false)
    expect(almost.companies[PLAYER].daysInDebt).toBeCloseTo(
      BANKRUPTCY_GRACE_DAYS - 1 / TICKS_PER_DAY,
      6,
    )

    const over = run(almost, 1)
    expect(over.companies[PLAYER].bankrupt).toBe(true)
  })

  it('не наступает, если компания вышла в плюс', () => {
    const grace = BANKRUPTCY_GRACE_DAYS * TICKS_PER_DAY

    const deep = run(indebted(-1), grace - 1)
    expect(deep.companies[PLAYER].daysInDebt).toBeGreaterThan(0)

    // Пришла выручка — счёт долга обнуляется тем же тиком.
    const rescued = run(
      {
        ...deep,
        companies: {
          ...deep.companies,
          [PLAYER]: { ...deep.companies[PLAYER], money: 1 },
        },
      },
      1,
    )
    expect(rescued.companies[PLAYER].daysInDebt).toBe(0)
    expect(rescued.companies[PLAYER].bankrupt).toBe(false)

    // И отсрочка отсчитывается заново, а не продолжается с прежнего места.
    const again = run(
      {
        ...rescued,
        companies: {
          ...rescued.companies,
          [PLAYER]: { ...rescued.companies[PLAYER], money: -1 },
        },
      },
      grace - 1,
    )
    expect(again.companies[PLAYER].bankrupt).toBe(false)
  })

  it('ноль на счету — ещё не долг', () => {
    const after = run(indebted(0), TICKS_PER_DAY)
    expect(after.companies[PLAYER].daysInDebt).toBe(0)
  })

  it('обанкротившейся компании ничего не начисляется', () => {
    const zil = makeZil(OREL, {
      position: { kind: 'ребро', edgeId: M2, fromId: OREL, progress: 0.5 },
      route: [TULA],
    })
    const before = makeState(
      [zil],
      [
        makeCompany(PLAYER, {
          money: -5000,
          bankrupt: true,
          daysInDebt: BANKRUPTCY_GRACE_DAYS,
          dailyRevenue: 1234,
          dailyCosts: 5678,
        }),
      ],
    )

    const after = runOperatingCosts(before)

    expect(player(after).money).toBe(player(before).money)
    // Потоков у банкрота нет — показывать вчерашние значит врать.
    expect(player(after).dailyRevenue).toBe(0)
    expect(player(after).dailyCosts).toBe(0)

    // И дальше состояние вообще перестаёт меняться.
    expect(runOperatingCosts(after)).toBe(after)
  })

  it('банкротство одной компании не задевает соседнюю', () => {
    const mine = makeZil(OREL)
    const theirs = makeZil(OREL, { id: vehicleId('v2'), ownerId: RIVAL })

    const before = makeState(
      [mine, theirs],
      [
        makeCompany(PLAYER, { money: -1, bankrupt: true }),
        makeCompany(RIVAL, { money: 10_000 }),
      ],
    )
    const after = runOperatingCosts(before)

    expect(after.companies[PLAYER].money).toBe(-1)
    expect(after.companies[RIVAL].money).toBeCloseTo(10_000 - WAGE_PER_TICK, 9)
  })
})

describe('смысл игры в деньгах', () => {
  /**
   * Кольцо Орёл → Тула → Орёл целиком, тик за тиком, через настоящую фазу
   * расходов. Возвращает всё, из чего складывается его итог.
   *
   * Это главный тест среза, и проверяет он не формулу, а замысел: порожний
   * пробег обязан превращать прибыльный рейс в убыточный. Сходимость посчитана
   * в конце src/data/operating.ts на этом же плече.
   */
  function ring(
    patch: Partial<Vehicle> = {},
  ): { costs: number; ticks: number; km: number; legRevenue: number } {
    const zil = makeZil(OREL, patch)
    const before = makeState([zil], [makeCompany(PLAYER)])

    const there = driveLeg(before, TULA)
    const back = driveLeg(there.state, OREL)

    return {
      costs: spent(before, back.state),
      ticks: there.ticks + back.ticks,
      km: truck(back.state).odometer,
      // Ставка за зерно на этом плече — столько приносит ГРУЖЁНОЕ плечо.
      legRevenue: deliveryRevenue('зерно', STARTER_CAPACITY_TONS, LEG_KM),
    }
  }

  it('кольцо с одним гружёным плечом убыточно', () => {
    const { costs, legRevenue, km } = ring()

    expect(km).toBeCloseTo(2 * LEG_KM, 6)
    expect(legRevenue - costs).toBeLessThan(0)
  })

  it('то же кольцо с двумя гружёными плечами прибыльно', () => {
    const { costs, legRevenue } = ring()

    expect(2 * legRevenue - costs).toBeGreaterThan(0)
  })

  it('расходы кольца не зависят от того, есть ли в кузове груз', () => {
    const empty = ring()
    const loaded = ring({
      cargo: { type: 'зерно', tons: STARTER_CAPACITY_TONS, originId: OREL },
    })

    // Вот на чём держится весь урок: порожнее плечо жжёт ровно столько же
    // топлива, сколько гружёное, — значит разница между двумя кольцами это
    // чистая недополученная выручка, а не «сэкономили на пустом рейсе».
    expect(loaded.costs).toBeCloseTo(empty.costs, 9)
    expect(loaded.km).toBeCloseTo(empty.km, 9)
  })

  it('счёт кольца складывается из километров и смены, и больше ни из чего', () => {
    const { costs, ticks, km } = ring()
    const zil = makeZil(OREL)

    expect(costs).toBeCloseTo(distanceCost(zil, km) + ticks * WAGE_PER_TICK, 6)
  })

  it('цена километра совпадает с расчётом в data/operating.ts', () => {
    const zil = makeZil(OREL)
    const perKm =
      (STARTER_FUEL_PER_100KM / 100) * FUEL_PRICE_PER_LITER + MAINTENANCE_PER_KM

    expect(distanceCost(zil, LEG_KM)).toBeCloseTo(LEG_KM * perKm, 9)
  })
})

describe('чистота', () => {
  it('фаза не меняет входное состояние', () => {
    const zil = makeZil(OREL, {
      position: { kind: 'ребро', edgeId: M2, fromId: OREL, progress: 0.5 },
      route: [TULA],
    })
    const before = makeState(
      [zil],
      [makeCompany(PLAYER, { money: 1000, dailyRevenue: 500, dailyCosts: 300 })],
    )
    const snapshot = JSON.stringify(before)

    const after = runOperatingCosts(before)

    expect(JSON.stringify(before)).toBe(snapshot)
    expect(after).not.toBe(before)
    expect(after.companies[PLAYER]).not.toBe(before.companies[PLAYER])
    // Мир и парк фазе расходов не принадлежат — она их не подменяет.
    expect(after.world).toBe(before.world)
    expect(after.vehicles).toBe(before.vehicles)
  })

  it('битые числа дают ноль, а не NaN в балансе', () => {
    const broken = makeZil(OREL, {
      position: { kind: 'ребро', edgeId: M2, fromId: OREL, progress: 0.5 },
      route: [TULA],
      fuelPer100Km: Number.NaN,
    })
    const before = makeState([broken], [makeCompany(PLAYER, { money: 1000 })])
    const after = runOperatingCosts(before)

    expect(Number.isFinite(player(after).money)).toBe(true)
    // Топливо не начислилось, но обслуживание и зарплата — да.
    expect(spent(before, after)).toBeCloseTo(
      maintenanceCost(KM_PER_TICK) + WAGE_PER_TICK,
      9,
    )
  })
})
