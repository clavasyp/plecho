import { describe, expect, it } from 'vitest'
import { EDGES } from '../../data/roads'
import {
  FUEL_PRICE_PER_LITER,
  HANDLING_PER_TON,
  MAINTENANCE_PER_KM,
  TARIFF_PER_TON_KM,
} from '../../data/operating'
import { CARGO_PREMIUM } from '../../data/recipes'
import type { CargoType } from '../types'
import { deliveryRevenue } from './finance'

/**
 * Тариф считается за тонно-километр плюс погрузка, всё с надбавкой за груз:
 *
 *     руб = тонны × (погрузка + тариф × км) × надбавка
 *
 * Ожидания выводятся из констант, а не вписаны числами: перебалансировка
 * тарифа не должна ронять проверки, в которых не меняется ни одно правило.
 */

/** Реальные плечи из графа дорог. */
const MOSCOW_TULA_KM = 185
const MOSCOW_SMOLENSK_KM = 395

/** Расход стартового ЗИЛа, литров на 100 км. */
const ZIL_FUEL_PER_100KM = 30
/** Грузоподъёмность стартового ЗИЛа, тонн. */
const ZIL_TONS = 6

/** Переменные расходы на километр: топливо плюс обслуживание. */
const COST_PER_KM =
  (ZIL_FUEL_PER_100KM / 100) * FUEL_PRICE_PER_LITER + MAINTENANCE_PER_KM

const ALL_CARGO = Object.keys(CARGO_PREMIUM) as CargoType[]

describe('deliveryRevenue: устройство тарифа', () => {
  it('складывается из погрузки и тонно-километров', () => {
    const revenue = deliveryRevenue('зерно', ZIL_TONS, MOSCOW_TULA_KM)
    const expected =
      ZIL_TONS *
      (HANDLING_PER_TON + TARIFF_PER_TON_KM * MOSCOW_TULA_KM) *
      CARGO_PREMIUM['зерно']

    expect(revenue).toBeCloseTo(expected, 9)
  })

  it('растёт линейно с тоннажем', () => {
    const one = deliveryRevenue('мука', 1, MOSCOW_TULA_KM)
    const six = deliveryRevenue('мука', 6, MOSCOW_TULA_KM)
    expect(six).toBeCloseTo(one * 6, 9)
  })

  it('растёт с расстоянием, но не пропорционально ему', () => {
    const near = deliveryRevenue('мука', ZIL_TONS, MOSCOW_TULA_KM)
    const far = deliveryRevenue('мука', ZIL_TONS, MOSCOW_SMOLENSK_KM)

    expect(far).toBeGreaterThan(near)
    // Постоянная часть за погрузку не зависит от плеча, поэтому выручка растёт
    // медленнее расстояния: вдвое дальше — меньше чем вдвое дороже.
    expect(far / near).toBeLessThan(MOSCOW_SMOLENSK_KM / MOSCOW_TULA_KM)
  })

  it('надбавка за груз умеренная, а не кратная', () => {
    // Здесь была главная ошибка баланса: ставки от 800 до 2000 перебивали
    // штраф за порожний пробег, и метрика переставала предсказывать прибыль.
    const values = Object.values(CARGO_PREMIUM)
    expect(Math.max(...values) / Math.min(...values)).toBeLessThan(1.5)
  })

  it('битые данные дают ноль, а не NaN', () => {
    expect(deliveryRevenue('зерно', Number.NaN, 100)).toBe(0)
    expect(deliveryRevenue('зерно', 6, Number.NaN)).toBe(0)
    expect(deliveryRevenue('зерно', 0, 100)).toBe(0)
    expect(deliveryRevenue('зерно', 6, 0)).toBe(0)
    expect(deliveryRevenue('зерно', -6, 100)).toBe(0)
    expect(deliveryRevenue('несуществующий' as CargoType, 6, 100)).toBe(0)
  })
})

/**
 * ГЛАВНЫЙ ИНВАРИАНТ ИГРЫ.
 *
 * Кольцо с одним гружёным плечом обязано быть убыточным, с двумя гружёными —
 * прибыльным. На этом стоит весь замысел: «порожний пробег превращает
 * прибыльный рейс в убыточный».
 *
 * Это не проверка формулы, а проверка смысла. Прошлая версия тарифа его не
 * выполняла, и обнаружилось это только численным прогоном ревизии: кольцо с
 * 0.24% порожнего пробега давало −18 666 руб в сутки, а с 68.89% — плюс.
 * Тестов, которые бы это поймали, не было ни одного.
 *
 * Проверяется на КАЖДОМ грузе и КАЖДОМ реальном ребре карты, а не на одном
 * разобранном примере: ровно так предыдущая ошибка и проскочила.
 */
describe('инвариант баланса: порожнее плечо съедает прибыль', () => {
  const legs = EDGES.map((edge) => edge.km)

  it.each(ALL_CARGO)('%s: кольцо с одним гружёным плечом убыточно', (cargo) => {
    for (const km of legs) {
      const revenue = deliveryRevenue(cargo, ZIL_TONS, km)
      const ringCost = 2 * km * COST_PER_KM
      expect(revenue, `${cargo}, плечо ${km} км`).toBeLessThan(ringCost)
    }
  })

  it.each(ALL_CARGO)('%s: кольцо с двумя гружёными плечами прибыльно', (cargo) => {
    for (const km of legs) {
      const revenue = 2 * deliveryRevenue(cargo, ZIL_TONS, km)
      const ringCost = 2 * km * COST_PER_KM
      expect(revenue, `${cargo}, плечо ${km} км`).toBeGreaterThan(ringCost)
    }
  })

  it('условие держится структурно, а не по совпадению чисел', () => {
    // На длинных плечах постоянная часть исчезает, и оба неравенства сводятся
    // к одному, не зависящему ни от расстояния, ни от груза:
    //     расход/км  <  тонны × тариф × надбавка  <  2 × расход/км
    // Разбор — в шапке src/data/operating.ts.
    for (const premium of Object.values(CARGO_PREMIUM)) {
      const perKm = ZIL_TONS * TARIFF_PER_TON_KM * premium
      expect(perKm).toBeGreaterThan(COST_PER_KM)
      expect(perKm).toBeLessThan(2 * COST_PER_KM)
    }
  })

  it('на карте нет плеча короче порога, где инвариант ломается', () => {
    // Ниже порога постоянная часть за погрузку перевешивает, и кольцо с
    // порожним возвратом снова становится выгодным.
    // Связывает МАКСИМАЛЬНАЯ надбавка: чем дороже груз, тем выше порог.
    const worstPremium = Math.max(...Object.values(CARGO_PREMIUM))
    const threshold =
      (ZIL_TONS * HANDLING_PER_TON * worstPremium) /
      (2 * COST_PER_KM - ZIL_TONS * TARIFF_PER_TON_KM * worstPremium)

    const shortest = Math.min(...EDGES.map((edge) => edge.km))
    expect(shortest, `порог ${threshold.toFixed(1)} км`).toBeGreaterThan(threshold)
  })
})
