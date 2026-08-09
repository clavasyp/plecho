import { describe, expect, it } from 'vitest'
import { CARGO_RATE } from '../../data/recipes'
import {
  DELIVERY_FIXED_SHARE,
  DELIVERY_REFERENCE_KM,
  deliveryRevenue,
} from './finance'

/**
 * Числа здесь считаются на бумаге по формуле из шапки finance.ts:
 *
 *     руб = тонны × ставка × (0.4 + 0.6 × км / 200)
 *
 * Там, где проверяется смысл, а не арифметика, стоят расстояния из настоящего
 * графа дорог: 185 км — Москва — Тула по М-2, 395 — Москва — Смоленск по М-1.
 */

const MOSCOW_TULA_KM = 185
const MOSCOW_SMOLENSK_KM = 395

describe('deliveryRevenue: смысл ставки', () => {
  it('на опорном плече равна ставке за тонну без поправок', () => {
    // Главное свойство формулы: CARGO_RATE читается буквально ровно на 200 км.
    for (const cargo of Object.keys(CARGO_RATE) as (keyof typeof CARGO_RATE)[]) {
      expect(deliveryRevenue(cargo, 1, DELIVERY_REFERENCE_KM)).toBeCloseTo(
        CARGO_RATE[cargo],
        9,
      )
    }
  })

  it('дорогой груз оплачивается лучше дешёвого на том же плече', () => {
    const flour = deliveryRevenue('мука', 6, MOSCOW_TULA_KM)
    const grain = deliveryRevenue('зерно', 6, MOSCOW_TULA_KM)

    // 1600 против 900 — отношение выручки в точности отношение ставок.
    expect(flour / grain).toBeCloseTo(1600 / 900, 9)
  })
})

describe('deliveryRevenue: тоннаж', () => {
  it('растёт с тоннажем', () => {
    const one = deliveryRevenue('мука', 1, MOSCOW_TULA_KM)
    const six = deliveryRevenue('мука', 6, MOSCOW_TULA_KM)

    expect(six).toBeGreaterThan(one)
  })

  it('строго пропорциональна тоннажу — скидок за объём нет', () => {
    // Скидка за объём была бы отдельным решением про экономику, а не побочным
    // эффектом формулы. Пока её нет, это должно быть видно тестом.
    const six = deliveryRevenue('мука', 6, MOSCOW_TULA_KM)
    const twelve = deliveryRevenue('мука', 12, MOSCOW_TULA_KM)

    expect(twelve).toBeCloseTo(six * 2, 9)
  })

  it('нулевой и отрицательный тоннаж денег не приносит', () => {
    expect(deliveryRevenue('мука', 0, MOSCOW_TULA_KM)).toBe(0)
    expect(deliveryRevenue('мука', -6, MOSCOW_TULA_KM)).toBe(0)
  })
})

describe('deliveryRevenue: расстояние', () => {
  it('растёт с расстоянием', () => {
    const near = deliveryRevenue('мука', 6, MOSCOW_TULA_KM)
    const far = deliveryRevenue('мука', 6, MOSCOW_SMOLENSK_KM)

    expect(far).toBeGreaterThan(near)
  })

  it('монотонна по расстоянию на всём графе', () => {
    // Все длины рёбер из data/roads.ts по возрастанию: выручка не должна нигде
    // проседать, иначе где-то в мире нашёлся бы рейс, который выгодно укоротить.
    const distances = [110, 131, 175, 183, 185, 190, 200, 210, 226, 230, 247,
      265, 328, 395, 410]

    for (let i = 1; i < distances.length; i++) {
      expect(deliveryRevenue('мука', 6, distances[i])).toBeGreaterThan(
        deliveryRevenue('мука', 6, distances[i - 1]),
      )
    }
  })

  it('короткое плечо всё равно оплачивается — постоянная часть тарифа', () => {
    // Плечо в четверть опорного приносит заметно больше четверти денег: за
    // подачу и погрузку платят одинаково на любом расстоянии.
    const quarter = deliveryRevenue('мука', 6, DELIVERY_REFERENCE_KM / 4)
    const full = deliveryRevenue('мука', 6, DELIVERY_REFERENCE_KM)

    expect(quarter / full).toBeCloseTo(DELIVERY_FIXED_SHARE + 0.6 * 0.25, 9)
    expect(quarter / full).toBeGreaterThan(0.25)
  })

  it('вдвое дальше — меньше чем вдвое дороже', () => {
    // Обратная сторона постоянной части: тариф деградирует по расстоянию, как
    // в жизни. Если бы удвоение расстояния удваивало выручку, короткие плечи
    // ничем не отличались бы от длинных.
    const near = deliveryRevenue('мука', 6, 100)
    const far = deliveryRevenue('мука', 6, 200)

    expect(far).toBeLessThan(near * 2)
    expect(far).toBeGreaterThan(near)
  })

  it('нулевое плечо не оплачивается', () => {
    // Иначе город, где рядом стоят производитель и потребитель, превращается в
    // печатный станок: тонны ездят между складами, не сходя с места.
    expect(deliveryRevenue('мука', 6, 0)).toBe(0)
    expect(deliveryRevenue('мука', 6, -185)).toBe(0)
  })
})

describe('deliveryRevenue: реальные рейсы', () => {
  it('Москва — Тула, шесть тонн муки: 9168 рублей', () => {
    // 6 × 1600 × (0.4 + 0.6 × 185/200). Якорь баланса: если число поедет,
    // поедет и весь расчёт окупаемости из шапки finance.ts.
    expect(deliveryRevenue('мука', 6, MOSCOW_TULA_KM)).toBeCloseTo(9168, 6)
  })

  it('Тула — Калуга, шесть тонн зерна: 3942 рубля', () => {
    // Самый бедный рейс из проверенных: дешёвое сырьё по короткой региональной
    // трассе. Он обязан оставаться прибыльным, но на грани.
    expect(deliveryRevenue('зерно', 6, 110)).toBeCloseTo(3942, 6)
  })

  it('Москва — Смоленск, шесть тонн муки: 15 216 рублей', () => {
    expect(deliveryRevenue('мука', 6, MOSCOW_SMOLENSK_KM)).toBeCloseTo(15216, 6)
  })

  it('дальнее плечо проигрывает ближнему в рублях на километр круга', () => {
    // Не дефект, а сердце игры: порожний возврат съедает выигрыш дальнего
    // рейса, и лечится это обратной загрузкой, а не выбором плеча подлиннее.
    const nearPerKm = deliveryRevenue('мука', 6, MOSCOW_TULA_KM) / (2 * 185)
    const farPerKm = deliveryRevenue('мука', 6, MOSCOW_SMOLENSK_KM) / (2 * 395)

    expect(nearPerKm).toBeGreaterThan(farPerKm)
  })
})

describe('deliveryRevenue: битые входы', () => {
  it('NaN и бесконечности дают ноль, а не заражают баланс', () => {
    // NaN в деньгах компании неизлечим: все сравнения с ним ложны, и
    // банкротство не наступает никогда.
    expect(deliveryRevenue('мука', Number.NaN, 185)).toBe(0)
    expect(deliveryRevenue('мука', 6, Number.NaN)).toBe(0)
    expect(deliveryRevenue('мука', Number.POSITIVE_INFINITY, 185)).toBe(0)
    expect(deliveryRevenue('мука', 6, Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('неизвестный груз денег не приносит', () => {
    // Груз, которого нет в CARGO_RATE, — это опечатка в данных, а не бесплатная
    // перевозка по нулевой ставке.
    const unknown = 'щебень' as Parameters<typeof deliveryRevenue>[0]
    expect(deliveryRevenue(unknown, 6, 185)).toBe(0)
  })
})
