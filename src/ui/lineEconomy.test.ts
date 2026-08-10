/**
 * Проверка метрик линии.
 *
 * ЧИСЛА ВЫВОДЯТСЯ ИЗ КОНСТАНТ И ИЗ САМИХ ДАННЫХ, а не вписываются посчитанными.
 * Длина плеча спрашивается у графа, выручка — у deliveryRevenue, расходы — у
 * distanceCost: перебалансировка ставок или правка километража в data/roads.ts
 * не должна ронять ни одну проверку, потому что ни одно правило от них не
 * зависит. Проверяются именно правила: что порожнее плечо не приносит ничего,
 * что обратная загрузка добавляет ровно выручку своего плеча, что кольцо
 * проходится дважды и груз с последней остановки доезжает до первой.
 */

import { describe, expect, it } from 'vitest'
import { STARTER_CLASS } from '../sim/state'

/** Тариф стартового класса: тесты писались под ЗИЛ, и он им и остаётся. */
const TARIFF = STARTER_CLASS.tariffPerTonKm
const HANDLING = STARTER_CLASS.handlingPerTon

import { EDGES_BY_ID } from '../data/roads'
import { DRIVER_WAGE_PER_DAY } from '../data/operating'
import { distanceCost } from '../sim/economy/operating'
import { deliveryRevenue } from '../sim/economy/finance'
import { MIN_LINE_STOPS } from '../sim/logistics/line'
import {
  HOME_CITY,
  STARTER_CAPACITY_TONS,
  STARTER_CRUISE_KMH,
  createZil,
} from '../sim/state'
import {
  cityId,
  companyId,
  lineId,
  vehicleId,
  type CargoType,
  type CityId,
  type Line,
  type Stop,
  type Vehicle,
  type VehicleId,
} from '../sim/types'
import { buildGraph } from '../sim/world/graph'
import { shortestKm } from '../sim/world/pathfind'
import { emptyShare, fleetByLine, planLoop, ringOrder } from './lineEconomy'

const graph = buildGraph(EDGES_BY_ID)

const MOSCOW = cityId('moscow')
const TULA = cityId('tula')
const KALUGA = cityId('kaluga')
/** Города вне графа: до него нет и не может быть пути. */
const NOWHERE = cityId('nowhere')

const PLAYER = companyId('player')
const RIVAL = companyId('rival')
const LINE = lineId('line-1')
const OTHER_LINE = lineId('line-2')

/** Опорная машина теста — тот же ЗИЛ, по которому считает и сам модуль. */
const ZIL = createZil(vehicleId('zil-test'), PLAYER, HOME_CITY)

function stop(
  nodeId: CityId,
  unload: CargoType[] = [],
  load: CargoType[] = [],
): Stop {
  return { nodeId, unload, load }
}

function line(stops: Stop[]): Line {
  return { id: LINE, name: 'проверка', stops, assignedVehicles: [] }
}

/** Расходы круга той же длины — по формулам симуляции, а не по числу. */
function loopCosts(ringKm: number): number {
  return (
    distanceCost(ZIL, ringKm) +
    (DRIVER_WAGE_PER_DAY * (ringKm / STARTER_CRUISE_KMH)) / 24
  )
}

const MOSCOW_TULA_KM = shortestKm(graph, MOSCOW, TULA)

describe('ringOrder', () => {
  it('обходит остановки по порядку и замыкает кольцо', () => {
    const order = ringOrder(graph, line([stop(MOSCOW), stop(TULA), stop(KALUGA)]))
    // Нулевая остановка не повторяется в конце: кольцо замыкает последний
    // элемент на первый, и лишний повтор дал бы плечо нулевой длины.
    expect(order).toEqual([0, 1, 2])
  })

  it('пропускает недостижимую остановку', () => {
    const order = ringOrder(
      graph,
      line([stop(MOSCOW), stop(NOWHERE), stop(TULA)]),
    )
    expect(order).toEqual([0, 2])
  })

  it('не считает кольцом линию короче минимальной', () => {
    const stops = Array.from({ length: MIN_LINE_STOPS - 1 }, () => stop(MOSCOW))
    expect(ringOrder(graph, line(stops))).toEqual([])
  })
})

describe('planLoop', () => {
  it('недостроенная линия не оценивается', () => {
    const plan = planLoop(graph, line([stop(MOSCOW)]))
    expect(plan.broken).toBe(true)
    expect(plan.emptyShare).toBeNull()
  })

  it('линия без единого достижимого плеча не оценивается', () => {
    const plan = planLoop(graph, line([stop(NOWHERE), stop(MOSCOW)]))
    expect(plan.broken).toBe(true)
  })

  it('кольцо с порожним возвратом: половина пути не оплачена', () => {
    const plan = planLoop(
      graph,
      line([
        stop(MOSCOW, [], ['мука']),
        stop(TULA, ['мука'], []),
      ]),
    )

    expect(plan.broken).toBe(false)
    // Туда и обратно по одному и тому же плечу.
    expect(plan.ringKm).toBeCloseTo(MOSCOW_TULA_KM * 2, 6)
    expect(plan.emptyKm).toBeCloseTo(MOSCOW_TULA_KM, 6)
    expect(plan.emptyShare).toBeCloseTo(0.5, 6)

    // Выручка ровно за одно гружёное плечо при полном кузове.
    expect(plan.revenue).toBeCloseTo(
      deliveryRevenue('мука', STARTER_CAPACITY_TONS, MOSCOW_TULA_KM, TARIFF, HANDLING),
      6,
    )
    expect(plan.costs).toBeCloseTo(loopCosts(MOSCOW_TULA_KM * 2), 6)
    expect(plan.profit).toBeCloseTo(plan.revenue - plan.costs, 6)
  })

  it('обратная загрузка добавляет ровно выручку своего плеча', () => {
    const oneWay = planLoop(
      graph,
      line([stop(MOSCOW, [], ['мука']), stop(TULA, ['мука'], [])]),
    )
    const bothWays = planLoop(
      graph,
      line([
        stop(MOSCOW, ['зерно'], ['мука']),
        stop(TULA, ['мука'], ['зерно']),
      ]),
    )

    // Километры и расходы те же: жжёт топливо порожняя машина ровно столько же.
    expect(bothWays.ringKm).toBeCloseTo(oneWay.ringKm, 6)
    expect(bothWays.costs).toBeCloseTo(oneWay.costs, 6)

    expect(bothWays.emptyKm).toBeCloseTo(0, 6)
    expect(bothWays.emptyShare).toBeCloseTo(0, 6)

    expect(bothWays.profit - oneWay.profit).toBeCloseTo(
      deliveryRevenue('зерно', STARTER_CAPACITY_TONS, MOSCOW_TULA_KM, TARIFF, HANDLING),
      6,
    )
  })

  it('кольцо, которое ничего не везёт, убыточно ровно на свои расходы', () => {
    const plan = planLoop(graph, line([stop(MOSCOW), stop(TULA)]))

    expect(plan.revenue).toBe(0)
    expect(plan.emptyShare).toBeCloseTo(1, 6)
    expect(plan.profit).toBeCloseTo(-plan.costs, 6)
    expect(plan.profit).toBeLessThan(0)
  })

  it('груз с последней остановки доезжает до первой', () => {
    // Единственная погрузка — на ПОСЛЕДНЕЙ остановке кольца, выгрузка — на
    // нулевой. Один проход по кольцу не увидел бы этой перевозки вовсе: он
    // начинается с пустым кузовом и заканчивается, не доехав до выгрузки.
    const plan = planLoop(
      graph,
      line([stop(MOSCOW, ['зерно'], []), stop(TULA, [], ['зерно'])]),
    )

    expect(plan.revenue).toBeCloseTo(
      deliveryRevenue('зерно', STARTER_CAPACITY_TONS, MOSCOW_TULA_KM, TARIFF, HANDLING),
      6,
    )
    expect(plan.emptyKm).toBeCloseTo(MOSCOW_TULA_KM, 6)
  })

  it('сдать груз там, где его взяли, нельзя', () => {
    // Погрузка и выгрузка одного и того же на одной остановке. Перевозки нет —
    // значит нет и денег: тот же запрет, что в фазе прибытия.
    const plan = planLoop(
      graph,
      line([stop(MOSCOW, ['мука'], ['мука']), stop(TULA)]),
    )

    expect(plan.revenue).toBe(0)
  })
})

describe('fleetByLine', () => {
  function truck(
    id: string,
    owner = PLAYER,
    assigned: Line['id'] | null = LINE,
    loadedKm = 0,
    emptyKm = 0,
  ): Vehicle {
    return {
      ...createZil(vehicleId(id), owner, HOME_CITY),
      lineId: assigned,
      loadedKm,
      emptyKm,
      odometer: loadedKm + emptyKm,
    }
  }

  function fleet(...trucks: Vehicle[]): Record<VehicleId, Vehicle> {
    return Object.fromEntries(trucks.map((v) => [v.id, v])) as Record<
      VehicleId,
      Vehicle
    >
  }

  it('складывает счётчики машин линии', () => {
    const byLine = fleetByLine(
      fleet(truck('zil-1', PLAYER, LINE, 300, 100), truck('zil-2', PLAYER, LINE, 100, 0)),
      PLAYER,
    )

    expect(byLine[LINE].count).toBe(2)
    expect(byLine[LINE].loadedKm).toBe(400)
    expect(byLine[LINE].emptyKm).toBe(100)
    // Складываются километры, а не усредняются проценты машин.
    expect(byLine[LINE].emptyShare).toBeCloseTo(100 / 500, 12)
  })

  it('не смешивает линии и не считает чужие машины', () => {
    const byLine = fleetByLine(
      fleet(
        truck('zil-1', PLAYER, LINE, 100, 0),
        truck('zil-2', PLAYER, OTHER_LINE, 200, 200),
        truck('zil-3', RIVAL, LINE, 900, 900),
        truck('zil-4', PLAYER, null, 500, 500),
      ),
      PLAYER,
    )

    expect(byLine[LINE].count).toBe(1)
    expect(byLine[OTHER_LINE].count).toBe(1)
    expect(byLine[LINE].loadedKm).toBe(100)
    expect(byLine[OTHER_LINE].emptyShare).toBeCloseTo(0.5, 12)
  })

  it('линия без пробега не отчитывается нулём', () => {
    const byLine = fleetByLine(fleet(truck('zil-1')), PLAYER)
    // Ноль процентов порожнего пробега — это поздравление с идеальной работой,
    // и выдавать его машине, не проехавшей ни километра, нельзя.
    expect(byLine[LINE].emptyShare).toBeNull()
  })
})

describe('emptyShare', () => {
  it('без пробега ответа нет', () => {
    expect(emptyShare(0, 0)).toBeNull()
    expect(emptyShare(Number.NaN, 10)).toBeNull()
  })

  it('считает долю от всего пробега', () => {
    expect(emptyShare(300, 100)).toBeCloseTo(0.25, 12)
  })
})
