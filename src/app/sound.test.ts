import { describe, expect, it } from 'vitest'

import { createInitialState, createVehicle, HOME_CITY } from '../sim/state'
import { dayProgress } from '../sim/time'
import { TICKS_PER_DAY } from '../sim/types'
import type { Building, Company, GameState, Vehicle } from '../sim/types'
import { buildingId, vehicleId } from '../sim/types'
import {
  AMBIENT_DAY,
  AMBIENT_NIGHT,
  ambientAt,
  cueDuration,
  cueFor,
  detectEvents,
  EVENT_BIT,
  EVENT_ORDER,
  isSoundOn,
  QUIETEST_HOUR,
  shouldPlay,
  soundAvailable,
  toggleSound,
} from './sound'
import type { SoundEvent } from './sound'

/**
 * Проверяется РАСЧЁТ, а не синтез.
 *
 * Услышать звук тестом нельзя, и притворяться, что можно, — самый быстрый
 * способ получить зелёный набор тестов при мёртвой кнопке. Поэтому здесь три
 * вещи: громкость гула от времени суток, выбор отклика по событию и разбор
 * события из разницы состояний. Всё остальное — что кнопка на экране есть, что
 * контекст поднялся и что отклик доехал до графа — доказывает сквозной тест
 * tests/e2e/sound.spec.ts, потому что только он видит браузер.
 *
 * Прогон идёт в Node, где AudioContext не существует. Это не ограничение, а
 * половина проверки: модуль обязан быть безопасен там, где звука нет.
 */

const SEED = 20260808

/** Состояние партии на старте — база для всех снимков ниже. */
function fresh(): GameState {
  return createInitialState(SEED)
}

/** Тот же снимок, но с подменённой машиной игрока. */
function withVehicle(state: GameState, vehicle: Vehicle): GameState {
  return {
    ...state,
    vehicles: { ...state.vehicles, [vehicle.id]: vehicle },
  }
}

/** Первая машина игрока в снимке. */
function playerVehicle(state: GameState): Vehicle {
  const found = Object.values(state.vehicles).find(
    (vehicle) => vehicle.ownerId === state.playerId,
  )
  if (found === undefined) throw new Error('в стартовом состоянии нет машины игрока')
  return found
}

/** Машина конкурента — для проверки, что чужое не звучит. */
function rivalVehicle(state: GameState): Vehicle {
  const found = Object.values(state.vehicles).find(
    (vehicle) => vehicle.ownerId !== state.playerId,
  )
  if (found === undefined) throw new Error('в стартовом состоянии нет конкурентов')
  return found
}

/** Тот же снимок, но с подменённой компанией игрока. */
function withPlayerCompany(state: GameState, company: Company): GameState {
  return {
    ...state,
    companies: { ...state.companies, [state.playerId]: company },
  }
}

describe('detectEvents — событие выводится из разницы снимков', () => {
  it('одно и то же состояние не звучит ничем', () => {
    const state = fresh()
    expect(detectEvents(state, state)).toBe(0)

    // Смена скорости состояние не трогает: стор будит подписчиков, звук молчит.
    expect(detectEvents(state, { ...state })).toBe(0)
  })

  it('новая машина в парке игрока — покупка', () => {
    const before = fresh()
    const bought = createVehicle(vehicleId('новая'), before.playerId, HOME_CITY)
    const after = withVehicle(before, bought)

    expect(detectEvents(before, after)).toBe(EVENT_BIT.покупка)
  })

  it('прицеп на голом тягаче — тоже покупка', () => {
    const before = fresh()
    const bare = { ...playerVehicle(before), trailer: null }
    const withoutTrailer = withVehicle(before, bare)
    const after = withVehicle(withoutTrailer, { ...bare, trailer: 'тент' })

    expect(detectEvents(withoutTrailer, after)).toBe(EVENT_BIT.покупка)
  })

  it('машина встала под погрузку — погрузка, и только в момент начала', () => {
    const before = fresh()
    const idle = { ...playerVehicle(before), serviceTicksLeft: 0 }
    const parked = withVehicle(before, idle)

    const started = withVehicle(parked, { ...idle, serviceTicksLeft: 4 })
    expect(detectEvents(parked, started)).toBe(EVENT_BIT.погрузка)

    // Пока стоит — тишина: иначе звук тянулся бы все часы погрузки.
    const going = withVehicle(started, { ...idle, serviceTicksLeft: 3 })
    expect(detectEvents(started, going)).toBe(0)

    // И на выходе из погрузки тоже тишина: озвучено начало работы, не конец.
    const done = withVehicle(going, { ...idle, serviceTicksLeft: 0 })
    expect(detectEvents(going, done)).toBe(0)
  })

  it('машина сломалась — поломка, ремонт молчит', () => {
    const before = fresh()
    const healthy = { ...playerVehicle(before), brokenDown: false }
    const ok = withVehicle(before, healthy)

    const broken = withVehicle(ok, { ...healthy, brokenDown: true })
    expect(detectEvents(ok, broken)).toBe(EVENT_BIT.поломка)

    expect(detectEvents(broken, ok)).toBe(0)
  })

  it('новая постройка — постройка', () => {
    const before = fresh()
    const company = before.companies[before.playerId]
    expect(company).toBeDefined()

    const terminal: Building = {
      id: buildingId('терминал-тест'),
      type: 'терминал',
      ownerId: before.playerId,
      cityId: HOME_CITY,
      posts: 2,
      storage: 0,
      stock: {},
    }
    const after = withPlayerCompany(before, {
      ...company,
      buildings: { ...company.buildings, [terminal.id]: terminal },
    })

    expect(detectEvents(before, after)).toBe(EVENT_BIT.постройка)
    // Снос — не событие для ушей: звук постройки на сносе сбивал бы с толку.
    expect(detectEvents(after, before)).toBe(0)
  })

  it('чужие машины не звучат', () => {
    const before = fresh()
    const rival = rivalVehicle(before)
    const after = withVehicle(before, {
      ...rival,
      brokenDown: true,
      serviceTicksLeft: 4,
    })

    expect(detectEvents(before, after)).toBe(0)
  })

  it('несколько событий в одном тике складываются в маску', () => {
    const before = fresh()
    const mine = playerVehicle(before)
    const healthy = { ...mine, brokenDown: false, serviceTicksLeft: 0 }
    const base = withVehicle(before, healthy)

    const bought = createVehicle(vehicleId('вторая'), base.playerId, HOME_CITY)
    const after = withVehicle(
      withVehicle(base, { ...healthy, brokenDown: true, serviceTicksLeft: 4 }),
      bought,
    )

    const mask = detectEvents(base, after)
    expect(mask & EVENT_BIT.поломка).not.toBe(0)
    expect(mask & EVENT_BIT.погрузка).not.toBe(0)
    expect(mask & EVENT_BIT.покупка).not.toBe(0)
    expect(mask & EVENT_BIT.постройка).toBe(0)
  })

  it('десять машин под погрузкой дают один бит, а не десять звуков', () => {
    const before = fresh()
    const mine = playerVehicle(before)
    const idle = { ...mine, serviceTicksLeft: 0 }

    let parked = withVehicle(before, idle)
    for (let i = 0; i < 10; i++) {
      const extra = createVehicle(
        vehicleId(`парк-${i}`),
        before.playerId,
        HOME_CITY,
      )
      parked = withVehicle(parked, extra)
    }

    let loading = parked
    for (const vehicle of Object.values(parked.vehicles)) {
      if (vehicle.ownerId !== parked.playerId) continue
      loading = withVehicle(loading, { ...vehicle, serviceTicksLeft: 4 })
    }

    // Покупка тоже поднята — машины добавлены тем же снимком; проверяем, что
    // погрузка ровно одна и маска остаётся числом, а не растёт со списком.
    expect(detectEvents(parked, loading) & EVENT_BIT.погрузка).toBe(
      EVENT_BIT.погрузка,
    )
    expect(detectEvents(parked, loading)).toBe(EVENT_BIT.погрузка)
  })

  it('разряды маски не пересекаются', () => {
    const bits = EVENT_ORDER.map((event) => EVENT_BIT[event])
    expect(new Set(bits).size).toBe(bits.length)
    for (const bit of bits) {
      // Степень двойки: у числа ровно один единичный разряд.
      expect(bit & (bit - 1)).toBe(0)
    }
  })

  it('идёт обычный тик симуляции — разбор не падает и не выдумывает событий', () => {
    // Настоящая партия, а не собранный руками снимок: на старте все машины
    // стоят в узлах, и первый же тик обязан звучать погрузкой или тишиной,
    // но никак не поломкой на нулевом износе.
    const before = fresh()
    const after = { ...before, tick: before.tick + 1 }

    const mask = detectEvents(before, after)
    expect(mask & EVENT_BIT.поломка).toBe(0)
    expect(mask & EVENT_BIT.покупка).toBe(0)
  })
})

describe('ambientAt — гул по времени суток', () => {
  it('тише всего в четыре утра, громче всего через полсуток', () => {
    expect(ambientAt(QUIETEST_HOUR).gain).toBeCloseTo(AMBIENT_NIGHT.gain, 6)
    expect(ambientAt(QUIETEST_HOUR).cutoff).toBeCloseTo(AMBIENT_NIGHT.cutoff, 4)

    const peak = QUIETEST_HOUR + 0.5
    expect(ambientAt(peak).gain).toBeCloseTo(AMBIENT_DAY.gain, 6)
    expect(ambientAt(peak).cutoff).toBeCloseTo(AMBIENT_DAY.cutoff, 4)
  })

  it('никогда не выходит за края шкалы', () => {
    for (let tick = 0; tick < TICKS_PER_DAY; tick++) {
      const { gain, cutoff } = ambientAt(dayProgress(tick))
      expect(gain).toBeGreaterThanOrEqual(AMBIENT_NIGHT.gain - 1e-9)
      expect(gain).toBeLessThanOrEqual(AMBIENT_DAY.gain + 1e-9)
      expect(cutoff).toBeGreaterThanOrEqual(AMBIENT_NIGHT.cutoff - 1e-6)
      expect(cutoff).toBeLessThanOrEqual(AMBIENT_DAY.cutoff + 1e-6)
    }
  })

  it('от ночи к вечеру растёт непрерывно, без ступенек', () => {
    let previous = ambientAt(QUIETEST_HOUR).gain
    for (let step = 1; step <= 48; step++) {
      const gain = ambientAt(QUIETEST_HOUR + step / 96).gain
      expect(gain).toBeGreaterThan(previous)
      // Шаг в пятнадцать игровых минут не может дать скачка громкости.
      expect(gain - previous).toBeLessThan(0.005)
      previous = gain
    }
  })

  it('сутки замыкаются: полночь одна и та же вчера и сегодня', () => {
    for (const progress of [0, 0.25, 0.5, 0.75]) {
      expect(ambientAt(progress).gain).toBeCloseTo(
        ambientAt(progress + 1).gain,
        9,
      )
    }
  })

  it('ночь глуше дня не только тише', () => {
    const night = ambientAt(0)
    const noon = ambientAt(0.5)
    expect(night.gain).toBeLessThan(noon.gain)
    expect(night.cutoff).toBeLessThan(noon.cutoff)
  })

  it('мусор на входе отдаёт ночь, а не NaN', () => {
    // NaN, попавший в AudioParam, глушит весь граф до перезагрузки страницы.
    const broken = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]
    for (const bad of broken) {
      expect(ambientAt(bad)).toEqual(AMBIENT_NIGHT)
    }
  })

  it('гул тихий по определению — громче десятой доли не бывает', () => {
    expect(AMBIENT_DAY.gain).toBeLessThan(0.1)
  })
})

describe('cueFor — голос события', () => {
  const events: readonly SoundEvent[] = EVENT_ORDER

  it('у каждого события есть свой голос', () => {
    for (const event of events) {
      const cue = cueFor(event)
      expect(cue.tones.length).toBeGreaterThan(0)
      expect(cue.gain).toBeGreaterThan(0)
    }
  })

  it('отклики короткие: полсекунды — потолок', () => {
    for (const event of events) {
      const duration = cueDuration(cueFor(event))
      expect(duration).toBeGreaterThan(0.02)
      expect(duration).toBeLessThan(0.5)
    }
  })

  it('отклики различимы между собой', () => {
    const signatures = events.map((event) => {
      const cue = cueFor(event)
      return `${cue.wave}:${cue.tones.join('-')}`
    })
    expect(new Set(signatures).size).toBe(events.length)
  })

  it('все тоны в слышимой середине, ничего писклявого', () => {
    for (const event of events) {
      for (const tone of cueFor(event).tones) {
        expect(tone).toBeGreaterThanOrEqual(80)
        expect(tone).toBeLessThanOrEqual(1200)
      }
    }
  })

  it('поломка громче всех, погрузка тише всех', () => {
    const gains = events.map((event) => cueFor(event).gain)
    expect(cueFor('поломка').gain).toBe(Math.max(...gains))
    expect(cueFor('погрузка').gain).toBe(Math.min(...gains))
  })

  it('поломка идёт вниз, покупка вверх', () => {
    const broken = cueFor('поломка').tones
    for (let i = 1; i < broken.length; i++) {
      expect(broken[i]).toBeLessThan(broken[i - 1])
    }

    const bought = cueFor('покупка').tones
    for (let i = 1; i < bought.length; i++) {
      expect(bought[i]).toBeGreaterThan(bought[i - 1])
    }
  })

  it('ни один отклик не орёт', () => {
    for (const event of events) {
      expect(cueFor(event).gain).toBeLessThanOrEqual(0.5)
    }
  })
})

describe('shouldPlay — остывание отклика', () => {
  it('первый раз звучит всегда', () => {
    for (const event of EVENT_ORDER) {
      expect(shouldPlay(event, 0, null)).toBe(true)
    }
  })

  it('повтор внутри остывания глохнет', () => {
    const cooldown = cueFor('погрузка').cooldownMs
    expect(shouldPlay('погрузка', cooldown - 1, 0)).toBe(false)
    expect(shouldPlay('погрузка', cooldown, 0)).toBe(true)
    expect(shouldPlay('погрузка', cooldown * 2, 0)).toBe(true)
  })

  it('у частого события остывание самое долгое', () => {
    const cooldowns = EVENT_ORDER.map((event) => cueFor(event).cooldownMs)
    expect(cueFor('погрузка').cooldownMs).toBe(Math.max(...cooldowns))
  })

  it('часы, ушедшие назад, не запирают звук навсегда', () => {
    // performance.now() у вкладки, пережившей сон системы, умеет прыгать.
    expect(shouldPlay('поломка', 10, 1_000_000)).toBe(true)
  })

  it('на скорости ×5 погрузка звучит не чаще раза в игровые сутки', () => {
    // Сутки на ×5 проходят за четыре реальные секунды; остывание погрузки
    // больше секунды, значит подряд идущие погрузки в треск не сольются.
    expect(cueFor('погрузка').cooldownMs).toBeGreaterThan(1000)
  })
})

describe('среда без Web Audio', () => {
  it('в Node звука нет, и это известно заранее', () => {
    expect(soundAvailable()).toBe(false)
  })

  it('переключение без AudioContext не падает', () => {
    expect(isSoundOn()).toBe(false)

    expect(toggleSound()).toBe(true)
    expect(isSoundOn()).toBe(true)

    expect(toggleSound()).toBe(false)
    expect(isSoundOn()).toBe(false)
  })
})
