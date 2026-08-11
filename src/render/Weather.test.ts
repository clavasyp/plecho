/**
 * Модель погоды и её стилевой замок.
 *
 * Юнит-тестом здесь проверяется ровно то, что является чистой функцией: связь
 * сезона с осадками, непрерывность фазы и яркость цветов. Всё, что «видно на
 * экране» — смонтирован ли слой, погашен ли он в ясный день, — проверяется
 * сквозным тестом tests/e2e/weather.spec.ts, потому что юнит-тест не отличает
 * посчитанный слой от нарисованного (в проекте это уже дважды стоило среза).
 */

import { describe, expect, test } from 'vitest'
import * as THREE from 'three'
import {
  FLAKE_MAX_ALPHA,
  VEIL_MAX_ALPHA,
  WEATHER_COLOR,
  WEATHER_MIN,
  sampleWeather,
} from './Weather'
import type { WeatherPhase } from './Weather'
import { palette, postFx } from './palette'
import { dateFromTick } from '../sim/time'
import { TICKS_PER_DAY } from '../sim/types'

const YEAR = 1994

function at(day: number, hour = 0): WeatherPhase {
  return sampleWeather(day * TICKS_PER_DAY + hour * 4, YEAR)
}

/** Яркость по Rec.709 — та же свёртка, по которой блум решает, что светится. */
function luminance(color: THREE.Color): number {
  return 0.2125 * color.r + 0.7154 * color.g + 0.0721 * color.b
}

describe('погода и время года', () => {
  test('зимой сыпет снегом, летом — только дождём', () => {
    for (let day = 0; day < 365; day++) {
      const { season } = dateFromTick(day * TICKS_PER_DAY, YEAR)
      const phase = at(day)

      if (season === 'зима') {
        expect(phase.rain, `день ${day}`).toBeLessThan(0.2)
      }
      if (season === 'лето') {
        expect(phase.rain, `день ${day}`).toBeGreaterThan(0.9)
        // Не строгий ноль: у самой границы сезона свежий ливень ещё добавляет
        // покрову доли процента через (1 - rain). Важно, что до порога
        // видимости это не доходит и на экране летом снега нет.
        expect(phase.cover, `день ${day}`).toBeLessThan(WEATHER_MIN.cover)
      }
    }
  })

  test('снежный покров лежит зимой и сходит к маю', () => {
    // Середина февраля — сплошное поле, середина июня — голая земля.
    expect(at(45).cover).toBeGreaterThan(0.9)
    expect(at(165).cover).toBeLessThan(WEATHER_MIN.cover)
  })

  test('дымка — осенняя, в середине лета её нет вовсе', () => {
    let autumn = 0
    let july = 0
    for (let day = 0; day < 365; day++) {
      const { month } = dateFromTick(day * TICKS_PER_DAY, YEAR)
      if (month === 10) autumn = Math.max(autumn, at(day).haze)
      if (month === 7) july = Math.max(july, at(day).haze)
    }
    expect(autumn).toBeGreaterThan(0.4)
    // В июле дымка бывает только от ливня и всё равно остаётся вдвое слабее.
    expect(july).toBeLessThan(autumn / 2)
  })

  test('первый кадр партии — снегопад: это кадр по умолчанию', () => {
    const start = sampleWeather(0, YEAR)
    expect(start.intensity).toBeGreaterThan(0.5)
    expect(start.rain).toBe(0)
    expect(start.cover).toBeGreaterThan(0.9)
  })
})

describe('погода меняется день ото дня', () => {
  test('в году есть и ясные дни, и дни с осадками', () => {
    let clear = 0
    let wet = 0
    for (let day = 0; day < 365; day++) {
      if (at(day).intensity === 0) clear++
      else wet++
    }
    // Ровный сезонный фон без суточного броска дал бы «мокрыми» все 365 дней, и
    // ветка «эффект выключен» никогда бы не выполнялась на живой карте.
    expect(clear).toBeGreaterThan(100)
    expect(wet).toBeGreaterThan(100)
  })

  test('бывают сутки, когда погоды нет совсем', () => {
    let silent = 0
    for (let day = 0; day < 365; day++) {
      const phase = at(day)
      if (
        phase.intensity <= WEATHER_MIN.intensity &&
        phase.cover <= WEATHER_MIN.cover &&
        phase.haze <= WEATHER_MIN.haze
      ) {
        silent++
      }
    }
    expect(silent).toBeGreaterThan(20)
  })

  test('фаза непрерывна: за тик ничего не прыгает', () => {
    let jump = 0
    let previous = sampleWeather(0, YEAR)
    for (let tick = 1; tick < TICKS_PER_DAY * 400; tick += 1) {
      const phase = sampleWeather(tick, YEAR)
      jump = Math.max(
        jump,
        Math.abs(phase.intensity - previous.intensity),
        Math.abs(phase.rain - previous.rain),
        Math.abs(phase.cover - previous.cover),
        Math.abs(phase.haze - previous.haze),
      )
      previous = phase
    }
    // Пятнадцать игровых минут не могут превратить ясный день в буран: иначе
    // снег включался бы на экране скачком. Порог с запасом ниже той ступеньки,
    // которую даёт переход суток без сглаживания (около 0.1).
    expect(jump).toBeLessThan(0.05)
  })

  test('год замыкается: 31 декабря похоже на 1 января', () => {
    const last = at(364)
    const first = at(365)
    expect(Math.abs(last.cover - first.cover)).toBeLessThan(0.1)
    expect(Math.abs(last.rain - first.rain)).toBeLessThan(0.1)
  })

  test('за десять лет календарь погоды не уезжает от календаря игры', () => {
    // Собственного представления о високосных годах у модели нет — она мотает
    // год тем же daysInYear, что и симуляция. Проверяется это единственным
    // честным способом: сверкой с календарём игры на каждом первом февраля и
    // первом августа десятилетней партии. Уехал бы год хоть на сутки в 1996-м —
    // к 2004-му расхождение накопилось бы в неделю и его было бы видно.
    let winters = 0
    let summers = 0

    for (let day = 0; day < 365 * 10; day++) {
      const tick = day * TICKS_PER_DAY
      const { month, day: dayOfMonth } = dateFromTick(tick, YEAR)
      if (dayOfMonth !== 1) continue

      if (month === 2) {
        expect(sampleWeather(tick, YEAR).cover, `1.2.${YEAR + winters}`)
          .toBeGreaterThan(0.9)
        winters++
      }
      if (month === 8) {
        expect(sampleWeather(tick, YEAR).cover, `1.8.${YEAR + summers}`)
          .toBeLessThan(WEATHER_MIN.cover)
        summers++
      }
    }

    expect(winters).toBe(10)
    expect(summers).toBe(10)
  })

  test('все величины остаются в 0..1 на десятилетнем прогоне', () => {
    for (let tick = 0; tick < TICKS_PER_DAY * 3650; tick += 37) {
      const phase = sampleWeather(tick, YEAR)
      for (const value of [phase.intensity, phase.rain, phase.cover, phase.haze]) {
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(1)
      }
    }
  })

  test('результат пишется в переданный объект, а не создаётся заново', () => {
    // Функция вызывается каждый кадр, и это единственная защита от аллокации в
    // цикле кадра, которую можно проверить тестом.
    const out: WeatherPhase = { intensity: -1, rain: -1, cover: -1, haze: -1 }
    const result = sampleWeather(TICKS_PER_DAY * 200, YEAR, out)
    expect(result).toBe(out)
    expect(out.intensity).not.toBe(-1)
  })
})

describe('стилевой замок: погода не светится', () => {
  const terrain = new THREE.Color(palette.terrain)

  /** Яркость слоя поверх подложки — ровно то, что увидит блум. */
  function composited(color: THREE.Color, alpha: number, under: number): number {
    return luminance(color) * alpha + under * (1 - alpha)
  }

  test('исходная palette.text сама по себе выше порога блума', () => {
    // Проверка не на погоду, а на смысл множителей: без них снег зацвёл бы.
    expect(luminance(new THREE.Color(palette.text))).toBeGreaterThan(
      postFx.bloomThreshold,
    )
  })

  test('дымка остаётся ниже порога блума', () => {
    // Освещённость в шейдере зажата единицей сверху, поэтому худший случай для
    // любого слоя погоды — это его собственный цвет на полной непрозрачности.
    expect(
      composited(WEATHER_COLOR.mist, VEIL_MAX_ALPHA, luminance(terrain)),
    ).toBeLessThan(postFx.bloomThreshold)
  })

  test('снежное поле остаётся ниже порога блума', () => {
    const white = composited(
      WEATHER_COLOR.snow,
      VEIL_MAX_ALPHA,
      luminance(terrain),
    )
    expect(white).toBeLessThan(postFx.bloomThreshold)
    // Запас не «чуть-чуть»: поле занимает весь экран, и подъезжать к порогу
    // вплотную нельзя — тональная компрессия и зерно ещё подвинут яркость.
    expect(white).toBeLessThan(postFx.bloomThreshold * 0.6)
  })

  test('осадки поверх снежного поля тоже ниже порога', () => {
    const white = composited(
      WEATHER_COLOR.snow,
      VEIL_MAX_ALPHA,
      luminance(terrain),
    )
    for (const color of [WEATHER_COLOR.snow, WEATHER_COLOR.rain]) {
      expect(composited(color, FLAKE_MAX_ALPHA, white)).toBeLessThan(
        postFx.bloomThreshold,
      )
    }
  })

  test('погода холоднее и темнее акцента', () => {
    const accent = new THREE.Color(palette.accent)
    for (const color of Object.values(WEATHER_COLOR)) {
      // Ни один погодный цвет не имеет права быть тёплым: единственный тёплый
      // цвет в игре — оранжевый акцент.
      expect(color.b).toBeGreaterThan(color.r)
      expect(color.r).toBeLessThan(accent.r)
    }
  })
})
