import { describe, expect, it } from 'vitest'

import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../sim/types'
import { atmosphereInto, createAtmosphere } from './sky'
import {
  BEAM_FAR_HALF_KM,
  BEAM_LENGTH_KM,
  BEAM_MIN_NIGHT,
  BEAM_NEAR_HALF_KM,
  BEAM_PEAK,
  CAB_GLOW_DAY,
  CAB_GLOW_NIGHT,
  beamStrength,
  beamsBurn,
  cabGlow,
  nightFrom,
} from './vehicleLights'

/**
 * Фары.
 *
 * ЧТО ЗДЕСЬ ПО-НАСТОЯЩЕМУ ОХРАНЯЕТСЯ: фары и небо смотрят на ОДНО солнце.
 * Половина проверок ниже прогоняет темноту не через выдуманные числа, а через
 * настоящую атмосферу сцены (`atmosphereInto` из sky.ts) — ту же функцию, из
 * которой Scene берёт свет, туман и цвет неба. Заведи фары собственную кривую
 * суток, и эти проверки останутся зелёными ровно до первого расхождения на
 * пятнадцать минут, которое никто не заметит; а так они ломаются в тот же день,
 * когда меняется астрономия сцены, — и это правильно, потому что решение о
 * длине ночи в проекте должно приниматься один раз.
 */

const START_YEAR = 1994

/** Темнота сцены на этот тик — тем же путём, каким её видит рендер. */
const nightAt = (tick: number): number =>
  nightFrom(atmosphereInto(createAtmosphere(), tick, START_YEAR).daylight)

const atHour = (hour: number): number => hour * TICKS_PER_HOUR
const atDay = (day: number): number => day * TICKS_PER_DAY

describe('перевод дневного света в темноту', () => {
  it('день — ноль, ночь — единица', () => {
    expect(nightFrom(1)).toBe(0)
    expect(nightFrom(0)).toBe(1)
    expect(nightFrom(0.25)).toBeCloseTo(0.75)
  })

  it('мусор и выход за края не ломают свет', () => {
    expect(nightFrom(-3)).toBe(1)
    expect(nightFrom(7)).toBe(0)
    expect(nightFrom(Number.NaN)).toBe(0)
  })
})

describe('темнота по солнцу сцены', () => {
  it('ПЕРВЫЙ КАДР ПАРТИИ — НОЧНОЙ, и рендер обязан знать это сам', () => {
    // Партия начинается 1 января в 00:00 (sim/state.ts): тик 0 — это полночь,
    // и никакой подсказки снаружи для этого не нужно.
    expect(nightAt(0)).toBe(1)
  })

  it('полдень января — день', () => {
    expect(nightAt(atHour(12))).toBe(0)
  })

  it('ЗИМНЕЕ УТРО ЕЩЁ ТЁМНОЕ, А ЛЕТНЕЕ УЖЕ СВЕТЛОЕ', () => {
    /*
     * Ради этого сезон вообще попал в свет. Семь утра в январе — фуре нужны
     * фары; семь утра в начале июля — уже нет. Разница приходит из наклона
     * солнечной дуги в sky.ts, а не из отдельного правила для зимы: здесь
     * проверяется, что она ДОХОДИТ до фар.
     */
    expect(nightAt(atHour(7)), 'семь утра в январе').toBe(1)
    expect(nightAt(atDay(182) + atHour(7)), 'семь утра в июле').toBe(0)
  })

  it('зимой темноты за сутки заметно больше, чем летом', () => {
    const dark = (fromDay: number): number => {
      let hours = 0
      for (let step = 0; step < 24 * 4; step++) {
        if (nightAt(atDay(fromDay) + step * (TICKS_PER_DAY / (24 * 4))) > 0.5) {
          hours += 0.25
        }
      }
      return hours
    }

    const winter = dark(0)
    const summer = dark(172)
    expect(winter, 'зимние сутки').toBeGreaterThan(summer + 3)
  })

  it('темнота повторяется из года в год: склейка Нового года не даёт скачка', () => {
    const before = nightAt(atDay(364) + atHour(23))
    const after = nightAt(atDay(365) + atHour(0))
    expect(Math.abs(after - before), 'скачок на границе года').toBeLessThan(0.1)
  })

  it('темнота всегда остаётся в 0..1 на протяжении года', () => {
    for (let day = 0; day < 365; day += 7) {
      for (let hour = 0; hour < 24; hour += 2) {
        const value = nightAt(atDay(day) + atHour(hour))
        expect(value, `день ${day}, час ${hour}`).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('когда фары горят', () => {
  it('днём не горят никогда', () => {
    expect(beamsBurn(0, true, false)).toBe(false)
  })

  it('ночью на перегоне — горят', () => {
    expect(beamsBurn(1, true, false)).toBe(true)
  })

  it('стоящая в городе машина фарами не светит', () => {
    expect(beamsBurn(1, false, false)).toBe(false)
  })

  it('СЛОМАННАЯ И БРОШЕННАЯ ОСТАЮТСЯ ТЁМНЫМИ даже посреди ночной трассы', () => {
    // Тот же признак, что гасит кабину (isStalled в VehicleMesh): погасшая
    // машина обязана быть погасшей целиком, иначе фары соврут про то, что она
    // едет.
    expect(beamsBurn(1, true, true)).toBe(false)
  })

  it('в первые минуты сумерек луч не рисуется вовсе', () => {
    expect(beamsBurn(BEAM_MIN_NIGHT / 2, true, false)).toBe(false)
    expect(beamsBurn(BEAM_MIN_NIGHT, true, false)).toBe(true)
  })

  it('ФАРЫ ВКЛЮЧАЮТСЯ В СУМЕРКАХ, а не когда стало темно', () => {
    /*
     * Проверка на настоящем закате: на исходе зимнего дня темнота обязана
     * перевалить порог заметно раньше, чем солнце уйдёт под горизонт. Правила
     * «включить фары за час до заката» нигде не написано — оно получается из
     * формы дневного света в sky.ts, и здесь проверяется, что получается.
     */
      const sky = atmosphereInto(createAtmosphere(), atHour(15.5), START_YEAR)
    expect(sky.sun, 'солнце ещё над горизонтом').toBeGreaterThan(0)
    expect(beamsBurn(nightFrom(sky.daylight), true, false), 'фары уже горят').toBe(
      true,
    )
  })
})

describe('яркость', () => {
  it('луч разгорается вместе с ночью и не перебивает кабину', () => {
    expect(beamStrength(0)).toBe(0)
    expect(beamStrength(1)).toBe(BEAM_PEAK)
    expect(beamStrength(0.5)).toBeCloseTo(BEAM_PEAK / 2)
    // Кабина остаётся ярчайшим телом сцены: её свечение больше единицы, лучу
    // единица недоступна по построению.
    expect(BEAM_PEAK).toBeLessThan(CAB_GLOW_DAY)
  })

  it('кабина ночью разгорается, днём остаётся прежней', () => {
    expect(cabGlow(0)).toBe(CAB_GLOW_DAY)
    expect(cabGlow(1)).toBe(CAB_GLOW_NIGHT)
    expect(CAB_GLOW_NIGHT).toBeGreaterThan(CAB_GLOW_DAY)
  })

  it('мусор на входе не гасит и не пережигает свет', () => {
    expect(beamStrength(-1)).toBe(0)
    expect(beamStrength(10)).toBe(BEAM_PEAK)
    expect(cabGlow(-1)).toBe(CAB_GLOW_DAY)
    expect(cabGlow(10)).toBe(CAB_GLOW_NIGHT)
  })
})

describe('форма луча', () => {
  it('луч расширяется вперёд и соразмерен машине, а не плечу', () => {
    expect(BEAM_FAR_HALF_KM).toBeGreaterThan(BEAM_NEAR_HALF_KM)
    // Самое короткое плечо карты — 110 км (Тула — Калуга). Луч обязан остаться
    // принадлежностью машины, а не самостоятельным телом на дороге.
    expect(BEAM_LENGTH_KM).toBeLessThan(110 / 5)
  })

  it('луч выходит за федеральное полотно: свет не считается с границей асфальта', () => {
    expect(BEAM_FAR_HALF_KM).toBeGreaterThan(3.4 / 2)
  })
})
