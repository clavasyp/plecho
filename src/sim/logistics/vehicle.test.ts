import { describe, expect, it } from 'vitest'
import { CITIES_BY_ID } from '../../data/cities'
import { EDGES } from '../../data/roads'
import { cityId, companyId, edgeId, vehicleId } from '../types'
import type {
  City,
  CityId,
  Edge,
  EdgeId,
  GameState,
  RoadClass,
  Vehicle,
} from '../types'
import { advanceVehicle, setRoute, speedKmh } from './vehicle'

/**
 * Числа в этих тестах подобраны так, чтобы ответ считался в уме и проверялся
 * на бумаге. Там, где проверяется формула, стоят синтетические рёбра с круглой
 * длиной и качеством 1.0; там, где проверяется работа на настоящем мире, —
 * реальный граф из data/roads.ts со всеми его некруглыми километрами.
 */

const MOSCOW = cityId('moscow')
const TULA = cityId('tula')
const KALUGA = cityId('kaluga')
const OREL = cityId('orel')
const YAROSLAVL = cityId('yaroslavl')

const PLAYER = companyId('player')
const V1 = vehicleId('v1')

/** Длительность обычного тика в часах — 15 минут. */
const TICK_HOURS = 0.25

function makeEdge(
  from: CityId,
  to: CityId,
  km: number,
  roadClass: RoadClass = 'федеральная',
  quality = 1,
): Edge {
  return {
    id: edgeId(`${from}-${to}`),
    from,
    to,
    km,
    class: roadClass,
    route: 'тестовая',
    quality,
  }
}

function makeVehicle(at: CityId, route: CityId[], cruiseKmh = 90): Vehicle {
  return {
    id: V1,
    ownerId: PLAYER,
    position: { kind: 'узел', nodeId: at },
    route,
    // Без линии: движение одинаково для машины на линии и вне её, а маршрут
    // здесь выдаётся руками. Диспетчеризация проверяется в logistics/line.
    lineId: null,
    stopIndex: 0,
    blockedTicks: 0,
    cruiseKmh,
    // Расход у стартового ЗИЛа. Движение денег не считает, но нулевой расход
    // в фикстуре — плохой образец: с него его копируют в новые тесты.
    fuelPer100Km: 30,
    odometer: 0,
    // Груза в тестах движения нет: они про километры и время, а не про тонны.
    // Грузоподъёмность взята у ЗИЛ-130 — стартовой машины партии.
    capacity: 6,
    cargo: null,
    loadedKm: 0,
    emptyKm: 0,
  }
}

function makeState(edges: readonly Edge[], vehicle: Vehicle): GameState {
  return {
    rngState: 1,
    tick: 0,
    startYear: 1994,
    world: {
      // Города из данных статические, а City в состоянии — живой: у него есть
      // склад и счётчик снабжения. Достраиваем их пустыми: движению они не
      // нужны, но без них фикстура не собирается.
      cities: Object.fromEntries(
        Object.values(CITIES_BY_ID).map((city) => [
          city.id,
          { ...city, stock: {}, suppliedDays: 0 },
        ]),
      ) as Record<CityId, City>,
      edges: Object.fromEntries(edges.map((e) => [e.id, e])) as Record<
        EdgeId,
        Edge
      >,
      // Предприятия в тестах движения не участвуют.
      industries: {},
    },
    companies: {
      // Поля среза 3 (линии, суточный итог, банкротство) достраиваются
      // пустыми: движению они не нужны, но без них фикстура не собирается.
      [PLAYER]: {
        id: PLAYER,
        name: 'Игрок',
        money: 0,
        controller: 'человек',
        lines: {},
        dailyRevenue: 0,
        dailyCosts: 0,
        bankrupt: false,
        daysInDebt: 0,
      },
    },
    playerId: PLAYER,
    vehicles: { [vehicle.id]: vehicle },
  }
}

/** Прогнать машину несколько обычных тиков подряд. */
function run(vehicle: Vehicle, state: GameState, ticks: number): Vehicle {
  let current = vehicle
  for (let i = 0; i < ticks; i++) {
    current = advanceVehicle(current, state, TICK_HOURS)
  }
  return current
}

describe('speedKmh', () => {
  it('ограничена потолком класса дороги', () => {
    const vehicle = makeVehicle(MOSCOW, [], 120)
    // Потолок региональной — 70, крейсерские 120 не помогают.
    expect(speedKmh(vehicle, makeEdge(MOSCOW, TULA, 100, 'региональная'))).toBe(
      70,
    )
    expect(speedKmh(vehicle, makeEdge(MOSCOW, TULA, 100, 'местная'))).toBe(50)
  })

  it('не ускоряет тихоходную машину на хорошей дороге', () => {
    const slow = makeVehicle(MOSCOW, [], 60)
    expect(speedKmh(slow, makeEdge(MOSCOW, TULA, 100, 'федеральная'))).toBe(60)
  })

  it('умножается на качество покрытия', () => {
    const vehicle = makeVehicle(MOSCOW, [], 90)
    const edge = makeEdge(MOSCOW, TULA, 185, 'федеральная', 0.87)
    // min(90, 90) × 0.87
    expect(speedKmh(vehicle, edge)).toBeCloseTo(78.3, 6)
  })

  it('на нулевом качестве даёт ноль, а не отрицательную скорость', () => {
    const vehicle = makeVehicle(MOSCOW, [], 90)
    expect(speedKmh(vehicle, makeEdge(MOSCOW, TULA, 100, 'местная', 0))).toBe(0)
    expect(speedKmh(vehicle, makeEdge(MOSCOW, TULA, 100, 'местная', -1))).toBe(
      0,
    )
  })
})

describe('advanceVehicle: стоянка', () => {
  it('машина без маршрута стоит на месте', () => {
    const vehicle = makeVehicle(MOSCOW, [])
    const state = makeState([makeEdge(MOSCOW, TULA, 100)], vehicle)

    const after = run(vehicle, state, 100)

    // Ссылка та же — фаза движения ничего не пересобрала.
    expect(after).toBe(vehicle)
    expect(after.position).toEqual({ kind: 'узел', nodeId: MOSCOW })
    expect(after.odometer).toBe(0)
  })

  it('машина стоит, если прямой дороги до следующего города нет', () => {
    // Тула — Ярославль в графе не связаны: маршрут невалиден, и подбирать
    // объезд здесь никто не должен.
    const vehicle = makeVehicle(TULA, [YAROSLAVL])
    const state = makeState(EDGES, vehicle)

    const after = run(vehicle, state, 100)

    expect(after.position).toEqual({ kind: 'узел', nodeId: TULA })
    expect(after.odometer).toBe(0)
  })
})

describe('advanceVehicle: одно ребро', () => {
  it('проходит ребро ровно за расчётное число тиков', () => {
    // 120 км при скорости 60 км/ч — два часа, то есть ровно восемь тиков.
    const vehicle = makeVehicle(MOSCOW, [TULA], 60)
    const state = makeState([makeEdge(MOSCOW, TULA, 120)], vehicle)

    const atSeven = run(vehicle, state, 7)
    expect(atSeven.position.kind).toBe('ребро')
    // 7 × 15 км из 120 — семь восьмых пути.
    if (atSeven.position.kind === 'ребро') {
      expect(atSeven.position.progress).toBeCloseTo(0.875, 9)
      expect(atSeven.position.fromId).toBe(MOSCOW)
    }
    expect(atSeven.odometer).toBeCloseTo(105, 9)

    const atEight = advanceVehicle(atSeven, state, TICK_HOURS)
    expect(atEight.position).toEqual({ kind: 'узел', nodeId: TULA })
    expect(atEight.route).toEqual([])
    expect(atEight.odometer).toBeCloseTo(120, 9)
  })

  it('проходит настоящее плечо Москва — Тула за расчётное число тиков', () => {
    // М-2 «Крым»: 185 км, качество 0.87, тягач с крейсерскими 90.
    // Скорость 78.3 км/ч, время 2.3627 ч — это 9.45 тика, значит машина
    // приезжает на десятом и девятый ещё едет.
    const vehicle = makeVehicle(MOSCOW, [TULA], 90)
    const state = makeState(EDGES, vehicle)

    expect(run(vehicle, state, 9).position.kind).toBe('ребро')

    const arrived = run(vehicle, state, 10)
    expect(arrived.position).toEqual({ kind: 'узел', nodeId: TULA })
    expect(arrived.route).toEqual([])
  })

  it('едет по ребру в обратную сторону — рёбра ненаправленные', () => {
    // В графе ребро записано как moscow → tula, машина идёт из Тулы.
    const vehicle = makeVehicle(TULA, [MOSCOW], 90)
    const state = makeState(EDGES, vehicle)

    const moving = advanceVehicle(vehicle, state, TICK_HOURS)
    expect(moving.position.kind).toBe('ребро')
    if (moving.position.kind === 'ребро') {
      expect(moving.position.fromId).toBe(TULA)
    }

    const arrived = run(vehicle, state, 10)
    expect(arrived.position).toEqual({ kind: 'узел', nodeId: MOSCOW })
  })

  it('снимает город отправления, если маршрут начинается с него', () => {
    // Поиск пути возвращает путь вместе с началом — машина не должна на этом
    // спотыкаться.
    const vehicle = makeVehicle(MOSCOW, [MOSCOW, TULA], 60)
    const state = makeState([makeEdge(MOSCOW, TULA, 120)], vehicle)

    const arrived = run(vehicle, state, 8)
    expect(arrived.position).toEqual({ kind: 'узел', nodeId: TULA })
    expect(arrived.route).toEqual([])
    expect(arrived.odometer).toBeCloseTo(120, 9)
  })
})

describe('advanceVehicle: несколько рёбер за тик', () => {
  // Три коротких плеча по 50 км, скорость 50 км/ч: каждое проходится за час.
  const shortChain = [
    makeEdge(MOSCOW, TULA, 50),
    makeEdge(TULA, KALUGA, 50),
    makeEdge(KALUGA, OREL, 50),
  ]

  it('проходит несколько рёбер за один длинный тик и не теряет остаток', () => {
    const vehicle = makeVehicle(MOSCOW, [TULA, KALUGA, OREL], 50)
    const state = makeState(shortChain, vehicle)

    // 2.4 часа при 50 км/ч — это 120 км: два плеча целиком и 20 км третьего.
    const after = advanceVehicle(vehicle, state, 2.4)

    expect(after.position.kind).toBe('ребро')
    if (after.position.kind === 'ребро') {
      expect(after.position.edgeId).toBe(edgeId('kaluga-orel'))
      expect(after.position.fromId).toBe(KALUGA)
      expect(after.position.progress).toBeCloseTo(0.4, 9)
    }
    expect(after.route).toEqual([OREL])

    // Главное число теста: наивная реализация «один узел за вызов» дала бы
    // ровно 50 км и оставила машину в Туле, потеряв 1.4 часа.
    expect(after.odometer).toBeCloseTo(120, 9)
  })

  it('длинный шаг совпадает с суммой коротких — время не пропадает', () => {
    const vehicle = makeVehicle(MOSCOW, [TULA, KALUGA, OREL], 50)
    const state = makeState(shortChain, vehicle)

    const oneStep = advanceVehicle(vehicle, state, 2.4)

    let bySteps = vehicle
    for (let i = 0; i < 24; i++) {
      bySteps = advanceVehicle(bySteps, state, 0.1)
    }

    expect(bySteps.odometer).toBeCloseTo(oneStep.odometer, 9)
    expect(bySteps.route).toEqual(oneStep.route)
    expect(bySteps.position.kind).toBe(oneStep.position.kind)
    if (
      bySteps.position.kind === 'ребро' &&
      oneStep.position.kind === 'ребро'
    ) {
      expect(bySteps.position.edgeId).toBe(oneStep.position.edgeId)
      expect(bySteps.position.progress).toBeCloseTo(
        oneStep.position.progress,
        9,
      )
    }
  })

  it('останавливается в конечном городе с пустым маршрутом', () => {
    const vehicle = makeVehicle(MOSCOW, [TULA, KALUGA, OREL], 50)
    const state = makeState(shortChain, vehicle)

    // Времени с запасом: пути на три часа, даём сутки.
    const after = advanceVehicle(vehicle, state, 24)

    expect(after.position).toEqual({ kind: 'узел', nodeId: OREL })
    expect(after.route).toEqual([])
    expect(after.odometer).toBeCloseTo(150, 9)

    // Лишнее время не копится и не выплёскивается в следующий вызов.
    expect(advanceVehicle(after, state, 24)).toBe(after)
  })
})

describe('advanceVehicle: пробег', () => {
  it('растёт ровно на пройденное расстояние с точностью до километра', () => {
    const vehicle = makeVehicle(MOSCOW, [TULA], 90)
    const state = makeState(EDGES, vehicle)

    // Четыре тика — час пути при 78.3 км/ч.
    const after = run(vehicle, state, 4)
    expect(Math.abs(after.odometer - 78.3)).toBeLessThan(1)
  })

  it('на маршруте из нескольких плеч равен сумме их длин', () => {
    // Москва — Тула (185) плюс Тула — Калуга (110) = 295 км по графу.
    const vehicle = makeVehicle(MOSCOW, [TULA, KALUGA], 90)
    const state = makeState(EDGES, vehicle)

    const after = run(vehicle, state, 400)

    expect(after.position).toEqual({ kind: 'узел', nodeId: KALUGA })
    expect(after.route).toEqual([])
    expect(Math.abs(after.odometer - 295)).toBeLessThan(1)
  })

  it('пробег не сбрасывается при назначении нового маршрута', () => {
    const vehicle = makeVehicle(MOSCOW, [TULA], 90)
    const state = makeState(EDGES, vehicle)

    const arrived = run(vehicle, state, 10)
    const next = run(setRoute(arrived, [MOSCOW]), state, 10)

    expect(Math.abs(next.odometer - 370)).toBeLessThan(1)
  })
})

describe('setRoute', () => {
  it('не меняет исходную машину и копирует массив', () => {
    const vehicle = makeVehicle(MOSCOW, [])
    const route = [TULA, KALUGA]

    const assigned = setRoute(vehicle, route)

    expect(vehicle.route).toEqual([])
    expect(assigned.route).toEqual([TULA, KALUGA])

    // Внешний массив больше не связан с состоянием игры.
    route.push(OREL)
    expect(assigned.route).toEqual([TULA, KALUGA])
  })

  it('не сбивает машину, стоящую посреди ребра', () => {
    const vehicle = makeVehicle(MOSCOW, [TULA], 60)
    const state = makeState([makeEdge(MOSCOW, TULA, 120)], vehicle)

    const midway = run(vehicle, state, 4)
    const reassigned = setRoute(midway, [TULA, KALUGA])

    expect(reassigned.position).toEqual(midway.position)
  })
})
