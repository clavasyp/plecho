import { describe, expect, it } from 'vitest'
import { DRIVER_WAGE_PER_DAY } from '../../data/operating'
import {
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  cityId,
  companyId,
  driverId,
  edgeId,
  vehicleId,
} from '../types'
import type {
  CargoType,
  CompanyId,
  Driver,
  DriverId,
  DriverLicense,
  Edge,
  GameState,
  Vehicle,
  VehicleId,
} from '../types'
import {
  CARGO_LICENSE,
  FATIGUE_PER_HOUR,
  FATIGUE_SPEED_PENALTY,
  HIRE_LOYALTY,
  HIRE_SKILL_MAX,
  HIRE_SKILL_MIN,
  LICENSE_WAGE_BONUS,
  LOYALTY_GAIN_PER_DAY,
  LOYALTY_LOSS_PER_DAY,
  MAX_SHIFT_HOURS,
  OVERWORK_FATIGUE,
  RECOVERY_PER_HOUR,
  REST_HOURS,
  SKILL_CAP,
  SKILL_LEARNING_KM,
  SKILL_WAGE_BONUS,
  canDepart,
  canDrive,
  grownSkill,
  hireDriver,
  isResting,
  runDrivers,
  speedFactor,
  vehicleSpeedFactor,
  wageFor,
} from './driver'

/**
 * Мир здесь синтетический и НЕПОДВИЖНЫЙ: одно ребро, одна машина, один водитель.
 * Фаза движения не вызывается вовсе — машина всё время теста стоит на ребре
 * ровно там, где её поставили. Это не упрощение ради лени: фаза водителей
 * читает положение машины и больше ничего, и подмешивать в проверку режима
 * труда ещё и километры значило бы измерять два правила одним числом.
 *
 * ВСЕ ОЖИДАЕМЫЕ ВЕЛИЧИНЫ ВЫВОДЯТСЯ ИЗ КОНСТАНТ. Ни девятки, ни одиннадцати, ни
 * тридцати шести тиков в тексте теста нет: перебалансировка режима не имеет
 * права ронять проверки, в которых не менялось ни одного правила.
 */

const MOSCOW = cityId('moscow')
const TULA = cityId('tula')

const PLAYER: CompanyId = companyId('player')
const RIVAL: CompanyId = companyId('rival')
const TRUCK: VehicleId = vehicleId('zil-1')
const DRIVER: DriverId = driverId('player-drv-1')

/** М-2 «Крым» с настоящими длиной и качеством из src/data/roads.ts. */
const M2: Edge = {
  id: edgeId('moscow-tula'),
  from: MOSCOW,
  to: TULA,
  km: 185,
  class: 'федеральная',
  route: 'М-2 Крым',
  quality: 0.87,
}

const ZIL_KMH = 70
const ZIL_TONS = 6
const ZIL_FUEL = 30

/** Длительность тика в часах. Выводится из календаря, а не вписывается. */
const HOURS_PER_TICK = 1 / TICKS_PER_HOUR

/** Тиков в полной смене и в полном отдыхе — прямо из режима. */
const SHIFT_TICKS = Math.ceil(MAX_SHIFT_HOURS / HOURS_PER_TICK)
const REST_TICKS = Math.ceil(REST_HOURS / HOURS_PER_TICK)

// ─── Сборка мира ───────────────────────────────────────────────────────────

function makeDriver(over: Partial<Driver> = {}): Driver {
  return {
    id: DRIVER,
    name: 'Пётр Савельев',
    employerId: PLAYER,
    vehicleId: TRUCK,
    skill: 0.5,
    licenses: [],
    fatigue: 0,
    hoursOnDuty: 0,
    wagePerDay: DRIVER_WAGE_PER_DAY,
    loyalty: HIRE_LOYALTY,
    ...over,
  }
}

function makeVehicle(over: Partial<Vehicle> = {}): Vehicle {
  return {
    id: TRUCK,
    ownerId: PLAYER,
    position: { kind: 'узел', nodeId: MOSCOW },
    route: [],
    lineId: null,
    stopIndex: 0,
    blockedTicks: 0,
    // Счётчики обслуживания: машина свободна, поста под ней нет и в очереди
    // она не стоит. Оба поля обязательны с среза 5 (Vehicle в sim/types.ts).
    serviceTicksLeft: 0,
    queuedTicks: 0,
    classId: 'zil-130',
    trailer: 'тент',
    driverId: DRIVER,
    wear: 0,
    kmSinceService: 0,
    brokenDown: false,
    cruiseKmh: ZIL_KMH,
    fuelPer100Km: ZIL_FUEL,
    odometer: 0,
    capacity: ZIL_TONS,
    cargo: null,
    loadedKm: 0,
    emptyKm: 0,
    ...over,
  }
}

/** Машина в рейсе — стоит на ребре, то есть последний тик она ехала. */
function onRoad(over: Partial<Vehicle> = {}): Vehicle {
  return makeVehicle({
    position: { kind: 'ребро', edgeId: M2.id, fromId: MOSCOW, progress: 0.1 },
    ...over,
  })
}

function makeState(drivers: Driver[], vehicles: Vehicle[]): GameState {
  const roster: Record<DriverId, Driver> = {}
  for (const driver of drivers) roster[driver.id] = driver

  const parked: Record<VehicleId, Vehicle> = {}
  for (const vehicle of vehicles) parked[vehicle.id] = vehicle

  return {
    rngState: 12345,
    tick: 0,
    startYear: 1994,
    // Городов и предприятий фазе водителей не нужно — она смотрит только на
    // рёбра, чтобы понять, с какой скоростью машина шла.
    world: { cities: {}, edges: { [M2.id]: M2 }, industries: {} },
    companies: {
      [PLAYER]: {
        id: PLAYER,
        name: 'ТОО «Плечо»',
        money: 30_000,
        controller: 'человек',
        lines: {},
        drivers: roster,
        // Ни одной постройки: поле обязательно с среза 5 (Company в sim/types.ts).
        buildings: {},
        dailyRevenue: 0,
        dailyCosts: 0,
        bankrupt: false,
        daysInDebt: 0,
      },
    },
    playerId: PLAYER,
    vehicles: parked,
  }
}

function driverIn(state: GameState, id: DriverId = DRIVER): Driver {
  return state.companies[PLAYER].drivers[id]
}

/** Прогнать фазу n раз подряд. */
function runTicks(state: GameState, n: number): GameState {
  let next = state
  for (let i = 0; i < n; i++) next = runDrivers(next)
  return next
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return Object.freeze(value)
}

// ─── Усталость ─────────────────────────────────────────────────────────────

describe('усталость', () => {
  it('копится за рулём', () => {
    const state = makeState([makeDriver()], [onRoad()])

    const after = runDrivers(state)

    expect(driverIn(after).fatigue).toBeCloseTo(
      FATIGUE_PER_HOUR * HOURS_PER_TICK,
      12,
    )
    expect(driverIn(after).hoursOnDuty).toBeCloseTo(HOURS_PER_TICK, 12)
  })

  it('снимается на стоянке в узле', () => {
    const start = 0.5
    const state = makeState([makeDriver({ fatigue: start })], [makeVehicle()])

    const after = runDrivers(state)

    expect(driverIn(after).fatigue).toBeCloseTo(
      start - RECOVERY_PER_HOUR * HOURS_PER_TICK,
      12,
    )
  })

  it('снимается и у сломанной машины, и у машины без водителя за рулём', () => {
    const start = 0.5
    // Сломанная стоит на ребре — но это стоянка, а не рейс.
    const broken = makeState(
      [makeDriver({ fatigue: start })],
      [onRoad({ brokenDown: true })],
    )
    // Водитель в резерве: машины за ним не закреплено вовсе.
    const idle = makeState(
      [makeDriver({ fatigue: start, vehicleId: null })],
      [onRoad({ driverId: null })],
    )

    const expected = start - RECOVERY_PER_HOUR * HOURS_PER_TICK
    expect(driverIn(runDrivers(broken)).fatigue).toBeCloseTo(expected, 12)
    expect(driverIn(runDrivers(idle)).fatigue).toBeCloseTo(expected, 12)
  })

  it('уставший едет медленнее, отдохнувший — с полной скоростью', () => {
    const fresh = makeDriver({ fatigue: 0 })
    const dead = makeDriver({ fatigue: 1 })

    expect(speedFactor(fresh)).toBe(1)
    expect(speedFactor(dead)).toBeCloseTo(1 - FATIGUE_SPEED_PENALTY, 12)
    expect(speedFactor(dead)).toBeLessThan(speedFactor(fresh))
  })

  it('не выходит за единицу даже на бесконечной смене', () => {
    const state = makeState([makeDriver()], [onRoad()])

    // Вдвое дольше смены: режим всё равно остановит, но проверяем шкалу.
    const after = runTicks(state, SHIFT_TICKS * 2)

    expect(driverIn(after).fatigue).toBeLessThanOrEqual(1)
    expect(driverIn(after).fatigue).toBeGreaterThan(0)
  })
})

// ─── Режим труда и отдыха ──────────────────────────────────────────────────

describe('режим труда и отдыха', () => {
  it('после полной смены водитель уходит на отдых', () => {
    const state = makeState([makeDriver()], [onRoad()])

    const beforeEnd = runTicks(state, SHIFT_TICKS - 1)
    expect(isResting(driverIn(beforeEnd))).toBe(false)
    expect(canDepart(beforeEnd, beforeEnd.vehicles[TRUCK])).toBe(true)

    const shift = runDrivers(beforeEnd)
    expect(driverIn(shift).hoursOnDuty).toBeCloseTo(MAX_SHIFT_HOURS, 12)
    expect(isResting(driverIn(shift))).toBe(true)
    expect(canDepart(shift, shift.vehicles[TRUCK])).toBe(false)
    expect(vehicleSpeedFactor(shift, shift.vehicles[TRUCK])).toBe(0)
  })

  it('отдохнув, возвращается в рейс и начинает смену заново', () => {
    const state = makeState([makeDriver()], [onRoad()])

    const resting = runTicks(state, SHIFT_TICKS)
    // Отдыхает прямо на обочине: смена кончилась там, где кончилась.
    const almost = runTicks(resting, REST_TICKS - 1)
    expect(isResting(driverIn(almost))).toBe(true)
    expect(driverIn(almost).fatigue).toBeGreaterThan(0)

    const back = runDrivers(almost)
    expect(driverIn(back).fatigue).toBe(0)
    expect(driverIn(back).hoursOnDuty).toBe(0)
    expect(isResting(driverIn(back))).toBe(false)
    expect(canDepart(back, back.vehicles[TRUCK])).toBe(true)

    // И снова за руль: следующий тик опять пишется в смену.
    const working = runDrivers(back)
    expect(driverIn(working).hoursOnDuty).toBeCloseTo(HOURS_PER_TICK, 12)
  })

  it('короткая стоянка списывает усталость, но не сбрасывает смену', () => {
    const state = makeState([makeDriver()], [onRoad()])

    const driving = runTicks(state, SHIFT_TICKS - 1)
    const dutyBefore = driverIn(driving).hoursOnDuty

    // Машина встала под погрузку на один тик.
    const parked = runDrivers({
      ...driving,
      vehicles: { [TRUCK]: makeVehicle() },
    })

    expect(driverIn(parked).fatigue).toBeLessThan(driverIn(driving).fatigue)
    expect(driverIn(parked).hoursOnDuty).toBe(dutyBefore)
  })

  it('ставит потолок на суточный пробег машины', () => {
    const state = makeState([makeDriver()], [onRoad()])

    // Четыре полных цикла «смена + отдых» — достаточно, чтобы доля устоялась.
    let next = state
    let atWheel = 0
    const total = (SHIFT_TICKS + REST_TICKS) * 4

    for (let i = 0; i < total; i++) {
      next = runDrivers(next)
      if (canDepart(next, next.vehicles[TRUCK])) atWheel++
    }

    // Доля времени за рулём — ровно то, что режим и обещает.
    const expected = MAX_SHIFT_HOURS / (MAX_SHIFT_HOURS + REST_HOURS)
    expect(atWheel / total).toBeCloseTo(expected, 2)
    // И это заметно меньше круглосуточной работы — ради этого всё и писалось.
    expect(atWheel / total).toBeLessThan(0.6)
  })
})

// ─── Разрешение на выезд ───────────────────────────────────────────────────

describe('разрешение на выезд', () => {
  it('машина без водителя не едет', () => {
    const state = makeState([], [makeVehicle({ driverId: null })])

    expect(canDepart(state, state.vehicles[TRUCK])).toBe(false)
    expect(vehicleSpeedFactor(state, state.vehicles[TRUCK])).toBe(0)
  })

  it('машина с водителем, которого нет в парке компании, не едет', () => {
    const state = makeState(
      [],
      [makeVehicle({ driverId: driverId('player-drv-99') })],
    )

    expect(canDepart(state, state.vehicles[TRUCK])).toBe(false)
  })

  it('сломанная машина не едет даже с отдохнувшим водителем', () => {
    const state = makeState([makeDriver()], [makeVehicle({ brokenDown: true })])

    expect(canDepart(state, state.vehicles[TRUCK])).toBe(false)
    expect(vehicleSpeedFactor(state, state.vehicles[TRUCK])).toBe(0)
  })

  it('целая машина с отдохнувшим водителем едет на полной скорости', () => {
    const state = makeState([makeDriver()], [makeVehicle()])

    expect(canDepart(state, state.vehicles[TRUCK])).toBe(true)
    expect(vehicleSpeedFactor(state, state.vehicles[TRUCK])).toBe(1)
  })
})

// ─── Допуски ───────────────────────────────────────────────────────────────

describe('допуски', () => {
  const ALL_CARGO: CargoType[] = [
    'зерно',
    'кругляк',
    'нефть',
    'мука',
    'пиломатериалы',
    'топливо',
  ]

  it('водитель без допусков не везёт топливо и нефть', () => {
    const plain = makeDriver({ licenses: [] })

    for (const cargo of ALL_CARGO) {
      const required = CARGO_LICENSE[cargo]
      expect(canDrive(plain, cargo)).toBe(required === undefined)
    }
  })

  it('ДОПОГ открывает наливное, но не длинномер', () => {
    const adr = makeDriver({ licenses: ['ДОПОГ'] })

    for (const cargo of ALL_CARGO) {
      const required = CARGO_LICENSE[cargo]
      expect(canDrive(adr, cargo)).toBe(
        required === undefined || required === 'ДОПОГ',
      )
    }
  })

  it('с обоими допусками берётся любой груз', () => {
    const licenses: DriverLicense[] = ['ДОПОГ', 'длинномер']
    const master = makeDriver({ licenses })

    for (const cargo of ALL_CARGO) {
      expect(canDrive(master, cargo)).toBe(true)
    }
  })

  it('порожний рейс не требует допусков', () => {
    expect(canDrive(makeDriver({ licenses: [] }), null)).toBe(true)
  })
})

// ─── Навык ─────────────────────────────────────────────────────────────────

describe('навык', () => {
  it('растёт с пробегом и упирается в потолок', () => {
    const novice = 0.2

    const short = grownSkill(novice, SKILL_LEARNING_KM / 100)
    expect(short).toBeGreaterThan(novice)

    // Сколько ни ехать — выше потолка не поднимается.
    let skill = novice
    for (let i = 0; i < 100; i++) skill = grownSkill(skill, SKILL_LEARNING_KM)
    expect(skill).toBeLessThanOrEqual(SKILL_CAP)
    expect(skill).toBeCloseTo(SKILL_CAP, 6)
  })

  it('чем опытнее водитель, тем меньше даёт та же тысяча километров', () => {
    const km = SKILL_LEARNING_KM / 100

    const early = grownSkill(0.2, km) - 0.2
    const late = grownSkill(0.9, km) - 0.9

    expect(early).toBeGreaterThan(late)
    expect(late).toBeGreaterThan(0)
  })

  it('нулевой и отрицательный пробег ничего не меняют', () => {
    expect(grownSkill(0.4, 0)).toBe(0.4)
    expect(grownSkill(0.4, -100)).toBe(0.4)
    expect(grownSkill(0.4, Number.NaN)).toBe(0.4)
  })

  it('растёт в рейсе и стоит на месте на стоянке', () => {
    const start = 0.3
    const road = makeState([makeDriver({ skill: start })], [onRoad()])
    const yard = makeState([makeDriver({ skill: start })], [makeVehicle()])

    expect(driverIn(runDrivers(road)).skill).toBeGreaterThan(start)
    expect(driverIn(runDrivers(yard)).skill).toBe(start)
  })

  it('вместе с навыком растёт и зарплата', () => {
    const start = 0.3
    const state = makeState(
      [makeDriver({ skill: start, wagePerDay: wageFor(start, []) })],
      [onRoad()],
    )

    // Год плотной работы — навык и цена человека заметно выше.
    const after = runTicks(state, TICKS_PER_DAY * 300)

    expect(driverIn(after).skill).toBeGreaterThan(start)
    expect(driverIn(after).wagePerDay).toBeGreaterThan(wageFor(start, []))
    expect(driverIn(after).wagePerDay).toBe(
      wageFor(driverIn(after).skill, driverIn(after).licenses),
    )
  })
})

// ─── Зарплата ──────────────────────────────────────────────────────────────

describe('зарплата', () => {
  it('нулевой навык без допусков стоит базовую ставку', () => {
    expect(wageFor(0, [])).toBe(DRIVER_WAGE_PER_DAY)
  })

  it('навык и допуски идут надбавками к базовой ставке', () => {
    expect(wageFor(1, [])).toBe(
      Math.round(DRIVER_WAGE_PER_DAY * (1 + SKILL_WAGE_BONUS)),
    )
    expect(wageFor(0, ['ДОПОГ'])).toBe(
      Math.round(DRIVER_WAGE_PER_DAY * (1 + LICENSE_WAGE_BONUS)),
    )
    expect(wageFor(0, ['ДОПОГ', 'длинномер'])).toBe(
      Math.round(DRIVER_WAGE_PER_DAY * (1 + 2 * LICENSE_WAGE_BONUS)),
    )
  })
})

// ─── Лояльность ────────────────────────────────────────────────────────────

describe('лояльность', () => {
  it('растёт за спокойные сутки работы', () => {
    const start = 0.5
    const state = makeState([makeDriver({ loyalty: start })], [makeVehicle()])

    const after = runTicks(state, TICKS_PER_DAY)

    expect(driverIn(after).loyalty).toBeCloseTo(start + LOYALTY_GAIN_PER_DAY, 6)
  })

  it('падает, когда водителя гоняют на исходе смены', () => {
    const start = 0.5
    const state = makeState(
      [makeDriver({ loyalty: start, fatigue: OVERWORK_FATIGUE })],
      [onRoad()],
    )

    const after = runDrivers(state)
    const perTick = (LOYALTY_GAIN_PER_DAY - LOYALTY_LOSS_PER_DAY) / TICKS_PER_DAY

    expect(driverIn(after).loyalty).toBeCloseTo(start + perTick, 9)
    expect(driverIn(after).loyalty).toBeLessThan(start)
  })
})

// ─── Найм ──────────────────────────────────────────────────────────────────

describe('найм', () => {
  const empty = makeState([], [])

  it('детерминирован: один сид — один и тот же водитель', () => {
    const first = hireDriver(empty, PLAYER, 777)
    const second = hireDriver(empty, PLAYER, 777)

    expect(JSON.stringify(first.companies[PLAYER].drivers)).toBe(
      JSON.stringify(second.companies[PLAYER].drivers),
    )
  })

  it('разные сиды дают разных людей', () => {
    const names = new Set<string>()
    for (let seed = 0; seed < 40; seed++) {
      const hired = hireDriver(empty, PLAYER, seed)
      for (const driver of Object.values(hired.companies[PLAYER].drivers)) {
        names.add(driver.name)
      }
    }

    expect(names.size).toBeGreaterThan(1)
  })

  it('второй нанятый не затирает первого', () => {
    const one = hireDriver(empty, PLAYER, 1)
    const two = hireDriver(one, PLAYER, 1)

    const roster = two.companies[PLAYER].drivers
    expect(Object.keys(roster)).toHaveLength(2)
    for (const [key, driver] of Object.entries(roster)) {
      expect(driver.id).toBe(key)
      expect(driver.employerId).toBe(PLAYER)
    }
  })

  it('кандидат приходит отдохнувшим, в резерве и в границах шкал', () => {
    for (let seed = 0; seed < 40; seed++) {
      const hired = hireDriver(empty, PLAYER, seed)
      const driver = Object.values(hired.companies[PLAYER].drivers)[0]

      expect(driver.fatigue).toBe(0)
      expect(driver.hoursOnDuty).toBe(0)
      expect(driver.vehicleId).toBeNull()
      expect(driver.loyalty).toBe(HIRE_LOYALTY)
      expect(driver.skill).toBeGreaterThanOrEqual(HIRE_SKILL_MIN)
      expect(driver.skill).toBeLessThan(HIRE_SKILL_MAX)
      expect(driver.name.trim()).not.toBe('')
      expect(driver.wagePerDay).toBe(wageFor(driver.skill, driver.licenses))
      expect(new Set(driver.licenses).size).toBe(driver.licenses.length)
    }
  })

  it('рынок труда даёт мастеров хуже, чем собственная работа', () => {
    // Иначе найм превратился бы в лотерею, а выращенный водитель — в обузу.
    expect(HIRE_SKILL_MAX).toBeLessThan(SKILL_CAP)
    expect(grownSkill(HIRE_SKILL_MAX, SKILL_LEARNING_KM * 2)).toBeGreaterThan(
      HIRE_SKILL_MAX,
    )
  })

  it('не трогает основной поток случайности', () => {
    // Найм — команда игрока в произвольный момент. Дёрни он общий ГПСЧ, и один
    // лишний клик сдвинул бы всю дальнейшую историю партии.
    expect(hireDriver(empty, PLAYER, 5).rngState).toBe(empty.rngState)
  })

  it('найм в несуществующую компанию не меняет состояние', () => {
    expect(hireDriver(empty, RIVAL, 1)).toBe(empty)
  })
})

// ─── Чистота фазы ──────────────────────────────────────────────────────────

describe('чистота', () => {
  it('runDrivers не мутирует вход ни на одном уровне вложенности', () => {
    const state = makeState([makeDriver({ fatigue: 0.3 })], [onRoad()])

    const snapshot = JSON.stringify(state)
    // Заморозка ловит мутацию как исключение, снимок — как расхождение.
    deepFreeze(state)

    const after = runDrivers(state)

    expect(JSON.stringify(state)).toBe(snapshot)
    expect(after).not.toBe(state)
    expect(after.companies[PLAYER].drivers).not.toBe(
      state.companies[PLAYER].drivers,
    )
    expect(driverIn(after)).not.toBe(driverIn(state))
  })

  it('hireDriver не мутирует вход', () => {
    const state = makeState([makeDriver()], [makeVehicle()])

    const snapshot = JSON.stringify(state)
    deepFreeze(state)

    const after = hireDriver(state, PLAYER, 3)

    expect(JSON.stringify(state)).toBe(snapshot)
    expect(Object.keys(after.companies[PLAYER].drivers)).toHaveLength(2)
  })

  it('фаза детерминирована', () => {
    const state = makeState([makeDriver({ fatigue: 0.4 })], [onRoad()])

    expect(JSON.stringify(runDrivers(state))).toBe(
      JSON.stringify(runDrivers(state)),
    )
  })

  it('без единого водителя возвращает то же состояние по ссылке', () => {
    const state = makeState([], [makeVehicle({ driverId: null })])

    expect(runDrivers(state)).toBe(state)
  })
})
