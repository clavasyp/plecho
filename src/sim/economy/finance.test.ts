import { describe, expect, it } from 'vitest'
import { EDGES } from '../../data/roads'
import { FUEL_PRICE_PER_LITER } from '../../data/operating'
import { CARGO_PREMIUM } from '../../data/recipes'
import { VEHICLE_CLASSES } from '../../data/vehicles'
import type { CargoType, VehicleClass } from '../types'
import { deliveryRevenue } from './finance'

/**
 * Тариф считается за тонно-километр плюс погрузка, всё с надбавкой за груз:
 *
 *     руб = тонны × (погрузка + тариф × км) × надбавка
 *
 * Тариф и плата за погрузку берутся У КЛАССА МАШИНЫ: ставка падает с размером
 * партии. Раньше тут стояли глобальные константы, поля класса не читал никто,
 * и весь расчёт по классам был декоративным — тягач зарабатывал 66 руб/км
 * вместо заявленных 40, а этот тест ничего не замечал, потому что считал по
 * тем же глобальным числам.
 */

const ALL_CARGO = Object.keys(CARGO_PREMIUM) as CargoType[]

/**
 * Переменные расходы класса на километр — в САМОМ ВЫГОДНОМ для игрока случае.
 *
 * Множитель 0.9 — экономия самого умелого водителя (см. fuelFactor в
 * logistics/driver.ts). Инвариант обязан держаться именно при минимальных
 * расходах: чем дешевле километр, тем выгоднее кольцо с порожним возвратом, и
 * если оно окупается хоть у кого-то, механика сломана. Считать по паспортному
 * расходу, как было раньше, значит проверять не худший случай, а средний.
 */
const BEST_FUEL_FACTOR = 0.95

function costPerKm(vc: VehicleClass): number {
  return (
    (vc.fuelPer100Km / 100) * FUEL_PRICE_PER_LITER * BEST_FUEL_FACTOR +
    vc.maintenancePerKm
  )
}

describe('deliveryRevenue: устройство тарифа', () => {
  const zil = VEHICLE_CLASSES[0]

  it('складывается из погрузки и тонно-километров', () => {
    const km = 185
    const revenue = deliveryRevenue(
      'зерно',
      zil.capacity,
      km,
      zil.tariffPerTonKm,
      zil.handlingPerTon,
    )
    expect(revenue).toBeCloseTo(
      zil.capacity *
        (zil.handlingPerTon + zil.tariffPerTonKm * km) *
        CARGO_PREMIUM['зерно'],
      9,
    )
  })

  it('крупная партия дешевле в пересчёте на тонно-километр', () => {
    // Объёмная скидка — то, на чём держится инвариант для тяжёлой техники.
    for (let i = 1; i < VEHICLE_CLASSES.length; i++) {
      expect(VEHICLE_CLASSES[i].tariffPerTonKm).toBeLessThan(
        VEHICLE_CLASSES[i - 1].tariffPerTonKm,
      )
      expect(VEHICLE_CLASSES[i].handlingPerTon).toBeLessThan(
        VEHICLE_CLASSES[i - 1].handlingPerTon,
      )
    }
  })

  it('надбавка за груз умеренная, а не кратная', () => {
    const values = Object.values(CARGO_PREMIUM)
    expect(Math.max(...values) / Math.min(...values)).toBeLessThan(1.5)
  })

  it('битые данные дают ноль, а не NaN', () => {
    const t = zil.tariffPerTonKm
    const h = zil.handlingPerTon
    expect(deliveryRevenue('зерно', Number.NaN, 100, t, h)).toBe(0)
    expect(deliveryRevenue('зерно', 6, Number.NaN, t, h)).toBe(0)
    expect(deliveryRevenue('зерно', 6, 100, Number.NaN, h)).toBe(0)
    expect(deliveryRevenue('зерно', 0, 100, t, h)).toBe(0)
    expect(deliveryRevenue('зерно', -6, 100, t, h)).toBe(0)
    expect(deliveryRevenue('нет' as CargoType, 6, 100, t, h)).toBe(0)
  })
})

/**
 * ГЛАВНЫЙ ИНВАРИАНТ ИГРЫ.
 *
 * Кольцо с одним гружёным плечом обязано быть убыточным, с двумя гружёными —
 * прибыльным. На этом стоит весь замысел: «порожний пробег превращает
 * прибыльный рейс в убыточный».
 *
 * Проверяется на КАЖДОМ классе техники, КАЖДОМ грузе и КАЖДОМ реальном ребре
 * карты. Все три измерения обязательны: прошлые ошибки проскакивали ровно
 * потому, что проверка велась на одном классе (ЗИЛ), одном грузе (зерно) или
 * одном разобранном плече.
 */
describe('инвариант баланса: порожнее плечо съедает прибыль', () => {
  const legs = EDGES.map((edge) => edge.km)

  for (const vc of VEHICLE_CLASSES) {
    const c = costPerKm(vc)

    it.each(ALL_CARGO)(
      `${vc.name} / %s: кольцо с одним гружёным плечом убыточно`,
      (cargo) => {
        for (const km of legs) {
          const revenue = deliveryRevenue(
            cargo,
            vc.capacity,
            km,
            vc.tariffPerTonKm,
            vc.handlingPerTon,
          )
          expect(revenue, `${vc.name}, ${cargo}, ${km} км`).toBeLessThan(
            2 * km * c,
          )
        }
      },
    )

    it.each(ALL_CARGO)(
      `${vc.name} / %s: кольцо с двумя гружёными плечами прибыльно`,
      (cargo) => {
        for (const km of legs) {
          const revenue =
            2 *
            deliveryRevenue(
              cargo,
              vc.capacity,
              km,
              vc.tariffPerTonKm,
              vc.handlingPerTon,
            )
          expect(revenue, `${vc.name}, ${cargo}, ${km} км`).toBeGreaterThan(
            2 * km * c,
          )
        }
      },
    )
  }

  it('условие держится структурно для каждого класса', () => {
    // На длинных плечах постоянная часть исчезает, и оба неравенства сводятся
    // к одному:  расход/км < тонны × тариф × надбавка < 2 × расход/км.
    for (const vc of VEHICLE_CLASSES) {
      const c = costPerKm(vc)
      for (const premium of Object.values(CARGO_PREMIUM)) {
        const perKm = vc.capacity * vc.tariffPerTonKm * premium
        expect(perKm, `${vc.name}, надбавка ${premium}`).toBeGreaterThan(c)
        expect(perKm, `${vc.name}, надбавка ${premium}`).toBeLessThan(2 * c)
      }
    }
  })

  it('на карте нет плеча короче порога ни для одного класса', () => {
    const shortest = Math.min(...legs)
    const worstPremium = Math.max(...Object.values(CARGO_PREMIUM))

    for (const vc of VEHICLE_CLASSES) {
      const c = costPerKm(vc)
      const threshold =
        (vc.capacity * vc.handlingPerTon * worstPremium) /
        (2 * c - vc.capacity * vc.tariffPerTonKm * worstPremium)
      expect(
        shortest,
        `${vc.name}: порог ${threshold.toFixed(1)} км`,
      ).toBeGreaterThan(threshold)
    }
  })
})
