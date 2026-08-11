/**
 * Проверка света суток, сезонов и эпох.
 *
 * Смысл этих тестов не «цвет равен #2b3745», а свойства, нарушение которых
 * видно на экране: ночь темнее дня, полночь не мигает, Новый год не щёлкает
 * палитрой, зима светлее лета, вечер теплее утра. Числа подобраны как ПОРОГИ, а
 * не как эталоны: перекрасить закат можно, а сделать закат холоднее рассвета —
 * нельзя.
 */

import { describe, expect, it } from 'vitest'
import { season } from '../sim/time'
import { TICKS_PER_DAY } from '../sim/types'
import type { Season } from '../sim/types'
import { era } from './palette'
import {
  atmosphereInto,
  createAtmosphere,
  saturationAt,
  seasonIndexAt,
  seasonWeightAt,
  sunAt,
  yearAt,
  yearPhaseAt,
} from './sky'
import type { Atmosphere, Rgb } from './sky'

const START = 1994

/** Тик заданного часа заданных суток от начала партии. */
function at(day: number, hour: number): number {
  return day * TICKS_PER_DAY + (hour / 24) * TICKS_PER_DAY
}

/** Номер дня года (0 — 1 января) для середины месяца невисокосного года. */
function midMonthDay(month: number): number {
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  let day = 0
  for (let m = 1; m < month; m++) day += lengths[m - 1]
  return day + 14
}

/** Воспринимаемая яркость. Взвешивание по вкладу каналов, а не среднее. */
function luma(color: Rgb): number {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b
}

/** Насколько цвет тёплый: положительное — красный перевешивает синий. */
function warmth(color: Rgb): number {
  return color.r - color.b
}

function sky(tick: number, startYear = START): Atmosphere {
  return atmosphereInto(createAtmosphere(), tick, startYear)
}

/** Самая большая разница по всем цветовым каналам двух состояний. */
function colorGap(a: Atmosphere, b: Atmosphere): number {
  let gap = 0
  const pairs: [Rgb, Rgb][] = [
    [a.air, b.air],
    [a.key, b.key],
    [a.fill, b.fill],
    [a.ambient, b.ambient],
    [a.ground, b.ground],
  ]
  for (const [x, y] of pairs) {
    gap = Math.max(gap, Math.abs(x.r - y.r), Math.abs(x.g - y.g), Math.abs(x.b - y.b))
  }
  return gap
}

describe('календарь картинки', () => {
  it('год отматывается вместе с високосными', () => {
    expect(yearAt(0, START)).toBe(1994)
    expect(yearAt(at(364, 12), START)).toBe(1994)
    expect(yearAt(at(365, 12), START)).toBe(1995)
    // 1996 високосный: 366 дней, значит 1997 начнётся на день позже.
    expect(yearAt(at(365 * 3 + 365, 12), START)).toBe(1997)
  })

  it('доля года непрерывна и укладывается в [0, 1)', () => {
    for (let day = 0; day < 800; day += 7) {
      const phase = yearPhaseAt(at(day, 6), START)
      expect(phase).toBeGreaterThanOrEqual(0)
      expect(phase).toBeLessThan(1)
    }
  })

  it('битый тик не вешает цикл и считается началом партии', () => {
    expect(yearAt(-100, START)).toBe(1994)
    expect(yearPhaseAt(Number.NaN, START)).toBe(0)
    expect(sunAt(-5, START)).toBeCloseTo(sunAt(0, START), 10)
  })
})

describe('смесь сезонов', () => {
  const names: Season[] = ['зима', 'весна', 'лето', 'осень']

  it('доли всегда дают в сумме единицу', () => {
    for (let step = 0; step < 400; step++) {
      const phase = step / 400
      const sum = names.reduce((acc, name) => acc + seasonWeightAt(phase, name), 0)
      expect(sum).toBeCloseTo(1, 10)
    }
  })

  it('в середине каждого месяца преобладает сезон из sim/time', () => {
    for (let month = 1; month <= 12; month++) {
      const phase = (midMonthDay(month) + 0.5) / 365
      let best: Season = 'зима'
      for (const name of names) {
        if (seasonWeightAt(phase, name) > seasonWeightAt(phase, best)) best = name
      }
      expect(best, `месяц ${month}`).toBe(season(month))
    }
  })

  it('переход между сезонами плавный, без ступенек', () => {
    let previous = seasonWeightAt(0, 'зима')
    for (let step = 1; step <= 2000; step++) {
      const weight = seasonWeightAt(step / 2000, 'зима')
      expect(Math.abs(weight - previous)).toBeLessThan(0.02)
      previous = weight
    }
    // И замыкается на самой себе через Новый год.
    expect(Math.abs(seasonWeightAt(0.9999, 'зима') - seasonWeightAt(0, 'зима')))
      .toBeLessThan(0.01)
  })

  it('индекс сезона накрывает весь круг года', () => {
    expect(seasonIndexAt(0.04)).toBe(0)
    expect(seasonIndexAt(0.3)).toBe(1)
    expect(seasonIndexAt(0.6)).toBe(2)
    expect(seasonIndexAt(0.8)).toBe(3)
    // До середины зимы мы ещё на отрезке, начавшемся прошлой осенью.
    expect(seasonIndexAt(0.001)).toBe(3)
  })
})

describe('сутки', () => {
  it('в полдень светло, солнце высоко, ключ сильный', () => {
    const noon = sky(at(180, 12))

    expect(noon.daylight).toBeGreaterThan(0.95)
    expect(noon.sun).toBeGreaterThan(0.9)
    expect(noon.keyIntensity).toBeGreaterThan(2)
    // Солнце в зените — направление почти вертикальное.
    expect(noon.keyDirection.y).toBeGreaterThan(0.9)
  })

  it('в полночь темно и холодно, но не черно', () => {
    const night = sky(at(180, 0))

    expect(night.daylight).toBeLessThan(0.02)
    expect(night.keyIntensity).toBeLessThan(0.25)
    expect(night.keyIntensity).toBeGreaterThan(0)
    expect(night.ambientIntensity).toBeGreaterThan(0.2)
    // Ночной ключ холодный: синего больше красного.
    expect(warmth(night.key)).toBeLessThan(0)
  })

  it('ночью воздух темнее дневного, а день светлее ночи заметно', () => {
    const night = sky(at(180, 0))
    const noon = sky(at(180, 12))

    expect(luma(noon.air)).toBeGreaterThan(luma(night.air) * 2)
    expect(luma(noon.air)).toBeGreaterThan(0.1)
  })

  it('солнце ходит с востока на запад', () => {
    const morning = sky(at(180, 7))
    const evening = sky(at(180, 19))

    expect(morning.keyDirection.x).toBeGreaterThan(0.3)
    expect(evening.keyDirection.x).toBeLessThan(-0.3)
    // Ниже, чем в полдень, — отсюда длинные тени.
    expect(morning.keyDirection.y).toBeLessThan(sky(at(180, 12)).keyDirection.y)
  })

  it('закат теплее рассвета, оба теплее полудня', () => {
    const dawn = sky(at(180, 4.5))
    const dusk = sky(at(180, 19.5))
    const noon = sky(at(180, 12))

    expect(dawn.twilight).toBeGreaterThan(0.3)
    expect(dusk.twilight).toBeGreaterThan(0.3)
    expect(warmth(dusk.key)).toBeGreaterThan(warmth(dawn.key))
    expect(warmth(dawn.key)).toBeGreaterThan(warmth(noon.key))
  })

  it('направление на источник — единичный вектор и всегда над землёй', () => {
    for (let step = 0; step < 96; step++) {
      const atm = sky(at(200, (step / 96) * 24))
      const d = atm.keyDirection
      expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 10)
      expect(d.y, `тик ${step}`).toBeGreaterThan(0.1)

      const f = atm.fillDirection
      expect(Math.hypot(f.x, f.y, f.z)).toBeCloseTo(1, 10)
      expect(f.y).toBeGreaterThan(0)
      // Заливка зеркалит ключ по горизонтали.
      expect(Math.sign(f.x || 1)).toBe(-Math.sign(d.x || -1))
    }
  })

  it('туман ночью подтягивается ближе', () => {
    expect(sky(at(180, 0)).fogFar).toBeLessThan(sky(at(180, 12)).fogFar)
  })
})

describe('непрерывность', () => {
  it('на границе суток цвет не прыгает', () => {
    const before = sky(96 * 200 - 0.001)
    const after = sky(96 * 200)
    expect(colorGap(before, after)).toBeLessThan(0.002)
    expect(Math.abs(before.keyIntensity - after.keyIntensity)).toBeLessThan(0.01)
  })

  it('на границе года цвет и насыщенность не прыгают', () => {
    // 31 декабря 1994, 23:59 и 1 января 1995, 00:00.
    const before = sky(at(365, 0) - 0.001)
    const after = sky(at(365, 0))

    expect(colorGap(before, after)).toBeLessThan(0.002)
    expect(Math.abs(before.saturation - after.saturation)).toBeLessThan(0.001)
    expect(Math.abs(before.sun - after.sun)).toBeLessThan(0.001)
  })

  it('за целые сутки нет ни одного рывка', () => {
    /*
     * Проверяется не только скорость изменения, но и её РОВНОСТЬ.
     *
     * Одной ограниченной скорости мало: рассвет и так самое быстрое место суток
     * (сутки проходят за двадцать реальных секунд), и порог, который его
     * пропускает, пропустит и небольшую ступеньку. Разрыв виден по второй
     * разности — шаг, который заметно больше соседних, и есть тот самый рывок.
     *
     * Шаг — четверть тика: рендер интерполирует внутри тика, и гладкость нужна
     * именно на дробных значениях, а не только на целых.
     */
    const step = 0.25
    const gaps: number[] = []
    const jumps: number[] = []
    let previous = sky(at(120, 0))

    for (let tick = at(120, 0) + step; tick <= at(121, 0); tick += step) {
      const current = sky(tick)
      const gap = colorGap(previous, current)
      // Потолок скорости широкий намеренно: игровые сутки проходят за двадцать
      // реальных секунд (REAL_MS_PER_GAME_DAY в app/loop.ts), значит рассвет и
      // закат обязаны укладываться примерно в секунду, и цвет на них МЕНЯЕТСЯ
      // быстро. Плавность доказывает не этот порог, а вторая разность ниже.
      expect(gap, `тик ${tick}`).toBeLessThan(0.03)
      gaps.push(gap)
      jumps.push(Math.abs(current.keyIntensity - previous.keyIntensity))
      previous = current
    }

    // Порог второй разности на порядок ниже порога первой: скорость меняется
    // не более чем на десятую от собственного максимума за шаг. Ступенька
    // такого не переживёт — у неё первая и вторая разности одного размера.
    for (let i = 1; i < gaps.length; i++) {
      expect(Math.abs(gaps[i] - gaps[i - 1]), `цвет, шаг ${i}`).toBeLessThan(0.003)
      expect(Math.abs(jumps[i] - jumps[i - 1]), `сила, шаг ${i}`).toBeLessThan(0.015)
    }
  })

  it('за целый год нет ни одного рывка по земле и насыщенности', () => {
    let previous = sky(at(0, 12))
    for (let day = 1; day <= 730; day++) {
      const current = sky(at(day, 12))
      expect(colorGap(previous, current), `день ${day}`).toBeLessThan(0.02)
      expect(Math.abs(current.saturation - previous.saturation)).toBeLessThan(0.005)
      previous = current
    }
  })
})

describe('сезоны на карте', () => {
  const january = sky(at(midMonthDay(1), 12))
  const july = sky(at(midMonthDay(7), 12))
  const october = sky(at(midMonthDay(10), 12))

  it('зимой земля белеет', () => {
    expect(january.winter).toBeGreaterThan(0.9)
    expect(luma(january.ground)).toBeGreaterThan(luma(july.ground) * 2)
  })

  it('зимой воздух светлее — снег подсвечивает дымку', () => {
    expect(luma(january.air)).toBeGreaterThan(luma(july.air))
  })

  it('осенью тусклее всего', () => {
    const spread = (color: Rgb) =>
      Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b)
    expect(spread(october.ground)).toBeLessThan(spread(july.ground))
    expect(luma(october.ground)).toBeLessThan(luma(july.ground))
  })

  it('летом земля суше — уходит в тёплую сторону, но не в акцент', () => {
    expect(warmth(july.ground)).toBeGreaterThan(warmth(january.ground))
    // Насыщенность земли обязана оставаться низкой: единственный насыщенный
    // тёплый цвет в кадре — акцент.
    expect(Math.abs(warmth(july.ground))).toBeLessThan(0.08)
  })

  it('зимой день длиннее не становится, а вот солнце ниже — да', () => {
    const winterNoon = sky(at(midMonthDay(1), 12))
    const summerNoon = sky(at(midMonthDay(7), 12))
    expect(winterNoon.sun).toBeLessThan(summerNoon.sun)
    expect(winterNoon.keyDirection.y).toBeLessThan(summerNoon.keyDirection.y)
  })

  it('летний день длиннее зимнего', () => {
    const daylightHours = (dayOfYear: number) => {
      let hours = 0
      for (let step = 0; step < 96; step++) {
        if (sunAt(at(dayOfYear, (step / 96) * 24), START) > 0) hours += 0.25
      }
      return hours
    }
    expect(daylightHours(midMonthDay(6))).toBeGreaterThan(13)
    expect(daylightHours(midMonthDay(12))).toBeLessThan(11)
  })
})

describe('эпоха', () => {
  it('от девяностых к двадцатым насыщенность растёт монотонно', () => {
    let previous = saturationAt(0, START)
    expect(previous).toBeCloseTo(era.saturationFrom, 6)

    for (let day = 30; day < 365 * 40; day += 30) {
      const value = saturationAt(at(day, 12), START)
      expect(value).toBeGreaterThanOrEqual(previous - 1e-9)
      previous = value
    }
    expect(previous).toBeCloseTo(era.saturationTo, 6)
  })

  it('за пределами эпохи упирается в края, а не улетает', () => {
    expect(saturationAt(at(365 * 50, 12), START)).toBeCloseTo(era.saturationTo, 6)
    expect(saturationAt(0, 1980)).toBeCloseTo(era.saturationFrom, 6)
    expect(saturationAt(0, 2100)).toBeCloseTo(era.saturationTo, 6)
  })

  it('девяностые выцветшие, а двадцатые не кислотные', () => {
    expect(era.saturationFrom).toBeLessThan(0)
    expect(era.saturationFrom).toBeGreaterThan(-0.5)
    expect(era.saturationTo).toBeGreaterThan(0)
    expect(era.saturationTo).toBeLessThan(0.35)
  })
})

describe('дисциплина буфера', () => {
  it('расчёт чистый: тот же тик даёт тот же результат', () => {
    const first = sky(at(77, 9.5))
    const second = sky(at(77, 9.5))
    expect(second).toEqual(first)
  })

  it('повторный расчёт в тот же буфер не оставляет следов прошлого', () => {
    const buffer = createAtmosphere()
    atmosphereInto(buffer, at(180, 12), START)
    atmosphereInto(buffer, at(180, 0), START)
    expect(buffer).toEqual(sky(at(180, 0)))
  })

  it('возвращает тот же объект, а не новый', () => {
    const buffer = createAtmosphere()
    expect(atmosphereInto(buffer, 42, START)).toBe(buffer)
  })
})
