import { describe, expect, it } from 'vitest'
import {
  dateFromTick,
  dayProgress,
  daysInMonth,
  formatDate,
  formatTime,
  isLeapYear,
  season,
} from './time'
import { TICKS_PER_DAY, TICKS_PER_HOUR } from './types'

/** Тик начала суток номер N (нумерация с нуля: день 0 — 1 января). */
const dayStart = (dayIndex: number) => dayIndex * TICKS_PER_DAY

describe('dateFromTick', () => {
  it('тик 0 — 1 января стартового года, полночь', () => {
    for (const year of [1994, 2000, 2024]) {
      expect(dateFromTick(0, year)).toEqual({
        year,
        month: 1,
        day: 1,
        hour: 0,
        minute: 0,
        season: 'зима',
      })
    }
  })

  it('четыре тика — час, девяносто шесть — сутки', () => {
    expect(TICKS_PER_HOUR).toBe(4)
    expect(TICKS_PER_DAY).toBe(96)

    const hour = dateFromTick(TICKS_PER_HOUR, 1994)
    expect(hour).toMatchObject({ day: 1, hour: 1, minute: 0 })

    const day = dateFromTick(TICKS_PER_DAY, 1994)
    expect(day).toMatchObject({ month: 1, day: 2, hour: 0, minute: 0 })
  })

  it('внутри суток тик даёт ровно пятнадцать минут', () => {
    const times = Array.from({ length: TICKS_PER_DAY }, (_, tick) => {
      const date = dateFromTick(tick, 1994)
      return `${date.hour}:${date.minute}`
    })
    expect(new Set(times).size).toBe(TICKS_PER_DAY)
    expect(times[1]).toBe('0:15')
    expect(times[TICKS_PER_DAY - 1]).toBe('23:45')
  })

  // 31 день января + 27 дней февраля = день с индексом 58, то есть 28 февраля.
  const FEB_28 = dayStart(58)

  it('високосный год: 28 февраля 2024 → 29 февраля', () => {
    expect(dateFromTick(FEB_28, 2024)).toMatchObject({ month: 2, day: 28 })
    expect(dateFromTick(FEB_28 + TICKS_PER_DAY, 2024)).toMatchObject({
      month: 2,
      day: 29,
    })
    expect(dateFromTick(FEB_28 + 2 * TICKS_PER_DAY, 2024)).toMatchObject({
      month: 3,
      day: 1,
    })
  })

  it('невисокосный год: 28 февраля 1994 → 1 марта', () => {
    expect(dateFromTick(FEB_28, 1994)).toMatchObject({ month: 2, day: 28 })
    expect(dateFromTick(FEB_28 + TICKS_PER_DAY, 1994)).toMatchObject({
      month: 3,
      day: 1,
    })
  })

  it('переход через границу года', () => {
    // В 1994-м 365 дней, значит 31 декабря — день с индексом 364.
    const dec31 = dayStart(364)
    expect(dateFromTick(dec31, 1994)).toMatchObject({
      year: 1994,
      month: 12,
      day: 31,
    })
    expect(dateFromTick(dec31 + TICKS_PER_DAY - 1, 1994)).toMatchObject({
      year: 1994,
      month: 12,
      day: 31,
      hour: 23,
      minute: 45,
    })
    expect(dateFromTick(dec31 + TICKS_PER_DAY, 1994)).toMatchObject({
      year: 1995,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
    })
  })

  it('високосный год добавляет ровно одни сутки к длине года', () => {
    // Старт 1 января 2024 (високосный): 1 января 2025 наступит через 366 дней.
    expect(dateFromTick(dayStart(365), 2024)).toMatchObject({
      year: 2024,
      month: 12,
      day: 31,
    })
    expect(dateFromTick(dayStart(366), 2024)).toMatchObject({
      year: 2025,
      month: 1,
      day: 1,
    })
  })

  /**
   * Независимая линейка: сорок лет посуточно против Date в UTC.
   *
   * Date в самой симуляции запрещён из-за часового пояса, но в тесте UTC-ветка
   * безопасна и полезна — это второй, написанный не нами календарь. Если наша
   * арифметика однажды разъедется с григорианской хоть на сутки, здесь это
   * видно сразу, а не через високосный февраль 2028 года в чьей-то партии.
   */
  it('совпадает с григорианским календарём на сорока годах партии', () => {
    const days = 40 * 365 + 10
    for (let dayIndex = 0; dayIndex < days; dayIndex++) {
      const actual = dateFromTick(dayStart(dayIndex), 1994)
      const expected = new Date(Date.UTC(1994, 0, 1 + dayIndex))
      expect([actual.year, actual.month, actual.day]).toEqual([
        expected.getUTCFullYear(),
        expected.getUTCMonth() + 1,
        expected.getUTCDate(),
      ])
    }
  })

  it('дробный тик округляется вниз, отрицательный — ошибка', () => {
    expect(dateFromTick(4.9, 1994)).toMatchObject({ hour: 1, minute: 0 })
    expect(() => dateFromTick(-1, 1994)).toThrow()
    expect(() => dateFromTick(Number.NaN, 1994)).toThrow()
  })
})

describe('високосность', () => {
  it('правило кратности 4, 100 и 400', () => {
    expect(isLeapYear(1994)).toBe(false)
    expect(isLeapYear(1996)).toBe(true)
    expect(isLeapYear(2000)).toBe(true)
    expect(isLeapYear(2024)).toBe(true)
    expect(isLeapYear(2100)).toBe(false)
  })

  it('февраль удлиняется только в високосный год', () => {
    expect(daysInMonth(1994, 2)).toBe(28)
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2100, 2)).toBe(28)
    expect(daysInMonth(1994, 1)).toBe(31)
    expect(daysInMonth(1994, 4)).toBe(30)
  })
})

describe('season', () => {
  it('зима — декабрь-февраль, дальше по три месяца', () => {
    const byMonth = Array.from({ length: 12 }, (_, i) => season(i + 1))
    expect(byMonth).toEqual([
      'зима',
      'зима',
      'весна',
      'весна',
      'весна',
      'лето',
      'лето',
      'лето',
      'осень',
      'осень',
      'осень',
      'зима',
    ])
  })

  it('месяц вне диапазона — ошибка, а не молчаливая осень', () => {
    expect(() => season(0)).toThrow()
    expect(() => season(13)).toThrow()
  })

  it('сезон в дате согласован с её месяцем', () => {
    // Пятое число каждого месяца 1994 года: идём по календарю накопительно,
    // чтобы проверка не повторяла арифметику самой dateFromTick.
    let dayIndex = 4
    for (let month = 1; month <= 12; month++) {
      const date = dateFromTick(dayStart(dayIndex), 1994)
      expect(date).toMatchObject({ month, day: 5 })
      expect(date.season).toBe(season(month))
      dayIndex += daysInMonth(1994, month)
    }
  })
})

describe('dayProgress', () => {
  it('полночь — 0, полдень — половина, к концу суток стремится к единице', () => {
    expect(dayProgress(0)).toBe(0)
    expect(dayProgress(TICKS_PER_DAY / 2)).toBe(0.5)
    expect(dayProgress(TICKS_PER_DAY - 1)).toBeCloseTo(1 - 1 / TICKS_PER_DAY)
  })

  it('единицы не достигает и повторяется каждые сутки', () => {
    for (let tick = 0; tick < 3 * TICKS_PER_DAY; tick++) {
      const p = dayProgress(tick)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThan(1)
      expect(p).toBeCloseTo(dayProgress(tick + TICKS_PER_DAY))
    }
  })

  it('принимает дробный тик — свет движется плавно между тиками', () => {
    expect(dayProgress(0.5)).toBeCloseTo(0.5 / TICKS_PER_DAY)
    expect(dayProgress(TICKS_PER_DAY + 0.5)).toBeCloseTo(0.5 / TICKS_PER_DAY)
  })
})

describe('форматирование', () => {
  it('дата в русском формате с месяцем в родительном падеже', () => {
    expect(formatDate(dateFromTick(0, 1994))).toBe('1 января 1994')
    expect(formatDate(dateFromTick(dayStart(58), 2024))).toBe('28 февраля 2024')
    expect(formatDate(dateFromTick(dayStart(364), 1994))).toBe('31 декабря 1994')
  })

  it('время — 24 часа, постоянная ширина строки', () => {
    expect(formatTime(dateFromTick(0, 1994))).toBe('00:00')
    expect(formatTime(dateFromTick(TICKS_PER_HOUR * 8 + 1, 1994))).toBe('08:15')
    expect(formatTime(dateFromTick(TICKS_PER_DAY - 1, 1994))).toBe('23:45')
    for (let tick = 0; tick < TICKS_PER_DAY; tick++) {
      expect(formatTime(dateFromTick(tick, 1994))).toHaveLength(5)
    }
  })
})
