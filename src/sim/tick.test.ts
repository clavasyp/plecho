import { describe, expect, it } from 'vitest'
import { CITIES_BY_ID } from '../data/cities'
import { EDGES_BY_ID } from '../data/roads'
import { HOURS_PER_TICK, tick, tickMany } from './tick'
import { cityId, companyId, vehicleId } from './types'
import type { CityId, GameState, Vehicle, VehicleId } from './types'

/**
 * Тик проверяется на настоящем мире: города и дороги берутся из data/, а не
 * подделываются. Заглушечные фазы ничего не делают, поэтому пока весь наблюдаемый
 * эффект тика — это часы и движение, и именно они здесь и проверяются.
 */

const MOSCOW = cityId('moscow')
const TULA = cityId('tula')
const KALUGA = cityId('kaluga')
const BRYANSK = cityId('bryansk')
const SMOLENSK = cityId('smolensk')

const PLAYER = companyId('player')

function makeVehicle(id: string, at: CityId, route: CityId[]): Vehicle {
  return {
    id: vehicleId(id),
    ownerId: PLAYER,
    position: { kind: 'узел', nodeId: at },
    route,
    cruiseKmh: 90,
    odometer: 0,
  }
}

function makeState(vehicles: Vehicle[]): GameState {
  return {
    rngState: 20250808,
    tick: 0,
    startYear: 1994,
    world: { cities: CITIES_BY_ID, edges: EDGES_BY_ID },
    companies: {
      [PLAYER]: { id: PLAYER, name: 'Игрок', money: 1_000_000, controller: 'человек' },
    },
    playerId: PLAYER,
    vehicles: Object.fromEntries(vehicles.map((v) => [v.id, v])) as Record<
      VehicleId,
      Vehicle
    >,
  }
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

describe('tick: время', () => {
  it('увеличивает счётчик тиков ровно на единицу', () => {
    const state = makeState([])
    expect(tick(state).tick).toBe(1)
    expect(tick(tick(state)).tick).toBe(2)
  })

  it('длительность тика — четверть часа', () => {
    expect(HOURS_PER_TICK).toBe(0.25)
  })

  it('tickMany равен n последовательным тикам', () => {
    const state = makeState([makeVehicle('v1', MOSCOW, [TULA, KALUGA])])

    let manual = state
    for (let i = 0; i < 37; i++) manual = tick(manual)

    expect(JSON.stringify(tickMany(state, 37))).toBe(JSON.stringify(manual))
  })

  it('tickMany с нулём и отрицательным n не двигает время', () => {
    const state = makeState([])
    expect(tickMany(state, 0)).toBe(state)
    expect(tickMany(state, -5)).toBe(state)
  })
})

describe('tick: чистота', () => {
  it('не мутирует входное состояние', () => {
    const state = makeState([
      makeVehicle('v1', MOSCOW, [TULA, KALUGA]),
      makeVehicle('v2', SMOLENSK, [MOSCOW]),
    ])
    const before = JSON.stringify(state)

    const after = tickMany(state, 100)

    expect(JSON.stringify(state)).toBe(before)
    expect(after).not.toBe(state)
    // Состояние действительно менялось — иначе тест проходил бы вхолостую.
    expect(JSON.stringify(after)).not.toBe(before)
  })

  it('не подменяет объект машины, если та стоит без задания', () => {
    const parked = makeVehicle('v1', MOSCOW, [])
    const state = makeState([parked])

    const after = tick(state)

    expect(after.vehicles).toBe(state.vehicles)
    expect(after.vehicles[parked.id]).toBe(parked)
  })
})

describe('tick: детерминизм', () => {
  it('два прогона по 500 тиков из одного состояния совпадают', () => {
    const state = makeState([
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
    const state = makeState([makeVehicle('v1', MOSCOW, ringRoute(10))])

    const whole = tickMany(state, 500)
    const parts = tickMany(tickMany(tickMany(state, 137), 200), 163)

    expect(JSON.stringify(parts)).toBe(JSON.stringify(whole))
  })
})

describe('tick: движение', () => {
  it('машина доезжает до конца маршрута и там останавливается', () => {
    // Москва — Тула (185 км) и Тула — Калуга (110 км).
    const state = makeState([makeVehicle('v1', MOSCOW, [TULA, KALUGA])])

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
    const together = makeState([
      makeVehicle('v1', MOSCOW, [TULA]),
      makeVehicle('v2', MOSCOW, [KALUGA]),
    ])
    const alone = makeState([makeVehicle('v1', MOSCOW, [TULA])])

    const a = tickMany(together, 40).vehicles[vehicleId('v1')]
    const b = tickMany(alone, 40).vehicles[vehicleId('v1')]

    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})
