import { describe, expect, it } from 'vitest'
import { FUEL_PRICE_PER_LITER } from '../../data/operating'
import { CARGO_PREMIUM } from '../../data/recipes'
import {
  TRAILERS_FOR_CARGO,
  VEHICLE_CLASSES,
  VEHICLE_CLASS_BY_ID,
  costPerKm,
} from '../../data/vehicles'
import { tickKm } from '../economy/operating'
import { Rng } from '../rng'
import { TICKS_PER_HOUR } from '../types'
import { cityId, companyId, driverId, edgeId, vehicleId } from '../types'
import type {
  CargoType,
  City,
  CityId,
  Company,
  CompanyId,
  Driver,
  DriverId,
  Edge,
  EdgeId,
  GameState,
  Industry,
  IndustryId,
  Vehicle,
  VehicleClass,
  VehicleId,
  VehiclePosition,
} from '../types'
import { MAX_SHIFT_HOURS, breakdownFactor } from './driver'
import { speedKmh } from './vehicle'
import {
  BREAKDOWN_MTBF_KM,
  IDLE_EXPOSURE_KM,
  MAINTENANCE_WEAR_GAIN,
  NEGLECT_WEAR_GAIN,
  REPAIR_COST_KM,
  ROADSIDE_REPAIR_MULTIPLIER,
  SERVICE_COST_KM,
  SERVICE_INTERVAL_KM,
  WEAR_LIFE_KM,
  breakdownChance,
  maintenanceMultiplier,
  maintenancePerKm,
  needsService,
  repairCost,
  repairVehicle,
  roadWearFactor,
  runWear,
  serviceCost,
  serviceNeglect,
  serviceVehicle,
  wearPerKm,
} from './wear'

/**
 * Мир синтетический, плечо настоящее: Орёл — Тула, 183 км по М-2 «Крым»,
 * качество 0.78 — та же строка из src/data/roads.ts, на которой посчитана
 * сходимость в src/data/operating.ts и написан тест фазы расходов. Рядом лежит
 * та же дорога вдвое хуже: качество — единственное, чем эти два ребра
 * отличаются, поэтому всё, что между ними разошлось, разошлось из-за него.
 *
 * ЧИСЛА ВЫВОДЯТСЯ ИЗ КОНСТАНТ. Ни одно ожидание не вписано посчитанным:
 * пробег тика спрашивается у tickKm, доля ресурса — у wearPerKm, цены — у
 * serviceCost/repairCost, характеристики техники — у справочника классов.
 * Перебалансировка данных обязана менять поведение игры, но не ронять тесты, в
 * которых не поменялось ни одного ПРАВИЛА.
 */

const OREL = cityId('orel')
const TULA = cityId('tula')

const PLAYER: CompanyId = companyId('player')
const V1: VehicleId = vehicleId('v1')
const V2: VehicleId = vehicleId('v2')
const D1: DriverId = driverId('d1')

const LEG_KM = 183
const LEG_QUALITY = 0.78
const ROUGH_QUALITY = LEG_QUALITY / 2

const M2: EdgeId = edgeId('orel-tula')
const M2_ROUGH: EdgeId = edgeId('orel-tula-rough')

const EDGES: Edge[] = [
  {
    id: M2,
    from: OREL,
    to: TULA,
    km: LEG_KM,
    class: 'федеральная',
    route: 'М-2 Крым',
    quality: LEG_QUALITY,
  },
  {
    id: M2_ROUGH,
    from: OREL,
    to: TULA,
    km: LEG_KM,
    class: 'федеральная',
    route: 'М-2 Крым (разбитая)',
    quality: ROUGH_QUALITY,
  },
]

/** Длительность тика в часах — перевод единиц из контракта, а не правило. */
const HOURS_PER_TICK = 1 / TICKS_PER_HOUR

const ZIL: VehicleClass = VEHICLE_CLASS_BY_ID['zil-130']

/** Денег заведомо больше, чем тратится за прогон, но не «сто миллионов». */
const RICH = 1_000_000

function makeCity(id: CityId): City {
  return {
    id,
    name: id,
    coord: { lat: 54, lon: 36 },
    population: 300_000,
    profile: 'промышленный',
    stock: {},
    suppliedDays: 0,
  }
}

function makeDriver(patch: Partial<Driver> = {}): Driver {
  return {
    id: D1,
    name: 'Иванов',
    employerId: PLAYER,
    vehicleId: V1,
    // Середина шкалы: ни мастер, ни новичок. Все выводы про навык в тестах
    // делаются сравнением, а не от абсолютного значения.
    skill: 0.5,
    licenses: [],
    fatigue: 0,
    hoursOnDuty: 0,
    wagePerDay: 700,
    loyalty: 0.5,
    ...patch,
  }
}

/** Машина класса из справочника — характеристики берутся у него, не руками. */
function makeVehicle(
  vc: VehicleClass,
  patch: Partial<Vehicle> = {},
): Vehicle {
  return {
    id: V1,
    ownerId: PLAYER,
    position: { kind: 'узел', nodeId: OREL },
    route: [],
    lineId: null,
    stopIndex: 0,
    blockedTicks: 0,
    // Счётчики обслуживания: машина свободна, поста под ней нет и в очереди
    // она не стоит. Оба поля обязательны с среза 5 (Vehicle в sim/types.ts).
    serviceTicksLeft: 0,
    queuedTicks: 0,
    classId: vc.id,
    trailer: null,
    driverId: D1,
    wear: 0,
    kmSinceService: 0,
    brokenDown: false,
    cruiseKmh: vc.cruiseKmh,
    fuelPer100Km: vc.fuelPer100Km,
    odometer: 0,
    capacity: vc.capacity,
    cargo: null,
    loadedKm: 0,
    emptyKm: 0,
    ...patch,
  }
}

/** Положение на ребре: доля пройденного пути от Орла. */
function at(edge: EdgeId, progress: number): VehiclePosition {
  return { kind: 'ребро', edgeId: edge, fromId: OREL, progress }
}

/** Машина посреди указанного ребра — то положение, в котором она едет. */
function onRoad(edge: EdgeId, patch: Partial<Vehicle> = {}): Vehicle {
  return makeVehicle(ZIL, { position: at(edge, 0.5), route: [TULA], ...patch })
}

function makeCompany(patch: Partial<Company> = {}): Company {
  return {
    id: PLAYER,
    name: PLAYER,
    money: RICH,
    controller: 'человек',
    lines: {},
    drivers: { [D1]: makeDriver() },
    // Ни одной постройки: поле обязательно с среза 5 (Company в sim/types.ts).
    buildings: {},
    dailyRevenue: 0,
    dailyCosts: 0,
    bankrupt: false,
    daysInDebt: 0,
    ...patch,
  }
}

function makeState(vehicles: Vehicle[], company: Company = makeCompany()): GameState {
  return {
    rngState: 1,
    tick: 0,
    startYear: 1994,
    world: {
      cities: Object.fromEntries(
        [OREL, TULA].map((id) => [id, makeCity(id)]),
      ) as Record<CityId, City>,
      edges: Object.fromEntries(EDGES.map((e) => [e.id, e])) as Record<EdgeId, Edge>,
      industries: {} as Record<IndustryId, Industry>,
    },
    companies: { [PLAYER]: company } as Record<CompanyId, Company>,
    playerId: PLAYER,
    vehicles: Object.fromEntries(vehicles.map((v) => [v.id, v])) as Record<
      VehicleId,
      Vehicle
    >,
  }
}

function truck(state: GameState, id: VehicleId = V1): Vehicle {
  return state.vehicles[id]
}

function money(state: GameState): number {
  return state.companies[PLAYER].money
}

/** Пробег ЗИЛа за тик на хорошем плече — по единственной модели пробега. */
const KM_PER_TICK = tickKm(onRoad(M2), makeState([onRoad(M2)]))

describe('износ от пробега', () => {
  it('за тик стирается ровно пробег тика, умноженный на долю ресурса', () => {
    const before = makeState([onRoad(M2)])
    const after = runWear(before)

    // Предпосылка: машина действительно ехала, и ехала по модели скорости.
    expect(KM_PER_TICK).toBeCloseTo(speedKmh(onRoad(M2), EDGES[0]) * HOURS_PER_TICK, 9)

    expect(truck(after).wear).toBeCloseTo(
      KM_PER_TICK * wearPerKm(LEG_QUALITY, 0),
      12,
    )
    // Счётчик до ТО идёт теми же километрами: ТО привязано к пробегу, а не ко
    // времени, иначе стоящая машина требовала бы обслуживания.
    expect(truck(after).kmSinceService).toBeCloseTo(KM_PER_TICK, 9)
  })

  it('растёт пропорционально пробегу', () => {
    const steps = 3
    let state = makeState([onRoad(M2, { position: at(M2, 0) })])

    const first = runWear(state)
    const perTickWear = truck(first).wear

    state = first
    for (let i = 1; i < steps; i++) {
      // Между износами машина продвигается по ребру. Двигаем её здесь руками, а
      // не фазой движения: тест про износ не должен зависеть от того, чинят ли
      // прямо сейчас соседний файл.
      state = {
        ...state,
        vehicles: {
          ...state.vehicles,
          [V1]: { ...truck(state), position: at(M2, (i * KM_PER_TICK) / LEG_KM) },
        },
      }
      state = runWear(state)
    }

    // Скорость на ребре не зависит от пройденной доли, поэтому каждый тик даёт
    // одинаковый вклад: втрое больше километров — втрое больше износа.
    expect(truck(state).wear).toBeCloseTo(steps * perTickWear, 12)
    expect(truck(state).kmSinceService).toBeCloseTo(steps * KM_PER_TICK, 6)
  })

  it('на плохой дороге тот же километр стирает больше ресурса', () => {
    const good = makeState([onRoad(M2)])
    const rough = makeState([onRoad(M2_ROUGH)])

    const goodKm = tickKm(truck(good), good)
    const roughKm = tickKm(truck(rough), rough)

    const goodWear = runWear(good).vehicles[V1].wear
    const roughWear = runWear(rough).vehicles[V1].wear

    // Сравнение именно НА КИЛОМЕТР. За тик разбитая дорога стирает меньше — по
    // ней и проехать успеваешь меньше (скорость падает пропорционально
    // качеству), и без этой поправки тест доказывал бы обратное тому, что нужно.
    expect(roughKm).toBeLessThan(goodKm)
    expect(roughWear / roughKm).toBeGreaterThan(goodWear / goodKm)

    expect(roughWear / roughKm).toBeCloseTo(wearPerKm(ROUGH_QUALITY, 0), 12)
    expect(goodWear / goodKm).toBeCloseTo(wearPerKm(LEG_QUALITY, 0), 12)

    // И ровно во столько раз, во сколько сказано про качество покрытия.
    expect((roughWear / roughKm) / (goodWear / goodKm)).toBeCloseTo(
      roadWearFactor(ROUGH_QUALITY) / roadWearFactor(LEG_QUALITY),
      9,
    )
  })

  it('идеальная дорога тратит ресурс ровно по паспорту', () => {
    // Проверка масштаба: по идеальному покрытию машина проходит ровно ресурс.
    expect(wearPerKm(1, 0) * WEAR_LIFE_KM).toBeCloseTo(1, 12)
  })

  it('стоящая машина ресурс не тратит', () => {
    const parked = makeState([makeVehicle(ZIL)])
    const after = runWear(parked)

    expect(truck(after).wear).toBe(0)
    expect(truck(after).kmSinceService).toBe(0)
  })

  it('машина без водителя не едет и не изнашивается', () => {
    const abandoned = makeState([onRoad(M2, { driverId: null })])
    const after = runWear(abandoned)

    expect(truck(after).wear).toBe(0)
    expect(truck(after).kmSinceService).toBe(0)
  })

  it('машина отдыхающего водителя тоже стоит', () => {
    // Разрешение на выезд спрашивается у фазы водителей целиком, а не
    // пересобирается здесь по полям. Появится там четвёртая причина стоять —
    // износ узнает о ней сам.
    const resting = makeCompany({
      drivers: { [D1]: makeDriver({ hoursOnDuty: MAX_SHIFT_HOURS }) },
    })
    const after = runWear(makeState([onRoad(M2)], resting))

    expect(truck(after).wear).toBe(0)
    expect(truck(after).kmSinceService).toBe(0)
  })
})

describe('стоимость обслуживания', () => {
  it('растёт с износом и только вверх', () => {
    expect(maintenanceMultiplier(0)).toBe(1)
    expect(maintenanceMultiplier(1)).toBeCloseTo(1 + MAINTENANCE_WEAR_GAIN, 12)

    let previous = maintenanceMultiplier(0)
    for (let w = 0.05; w <= 1.0001; w += 0.05) {
      const current = maintenanceMultiplier(w)
      expect(current).toBeGreaterThan(previous)
      previous = current
    }
  })

  it('ставка новой машины совпадает со справочником, изношенной — втрое выше', () => {
    for (const vc of VEHICLE_CLASSES) {
      expect(maintenancePerKm(makeVehicle(vc))).toBeCloseTo(vc.maintenancePerKm, 9)
      expect(maintenancePerKm(makeVehicle(vc, { wear: 1 }))).toBeCloseTo(
        vc.maintenancePerKm * (1 + MAINTENANCE_WEAR_GAIN),
        9,
      )
    }
  })

  it('неизвестный класс не даёт бесплатную машину', () => {
    // Дефект данных обязан быть дорогим, а не выгодным: нулевая ставка сделала
    // бы машину из битого сейва лучшей в парке.
    expect(maintenancePerKm(makeVehicle(ZIL, { classId: 'нет-такого' }))).toBeGreaterThan(0)
  })
})

/**
 * Грузы, которые класс физически может взять: прицеп должен подходить и грузу,
 * и тягачу. Ровно та проверка, из-за которой обратная загрузка в этом срезе
 * стала труднее.
 */
function cargoFor(vc: VehicleClass): CargoType[] {
  return (Object.keys(CARGO_PREMIUM) as CargoType[]).filter((cargo) =>
    (TRAILERS_FOR_CARGO[cargo] ?? []).some((t) =>
      (vc.trailers as string[]).includes(t),
    ),
  )
}

/** Переменные расходы класса при таком износе, рубли за километр. */
function costPerKmAt(vc: VehicleClass, wear: number): number {
  return (
    (vc.fuelPer100Km / 100) * FUEL_PRICE_PER_LITER +
    vc.maintenancePerKm * maintenanceMultiplier(wear)
  )
}

/**
 * Износ, при котором машина перестаёт отбивать даже идеальное кольцо.
 *
 * Условие ровно то же, из которого выведен главный инвариант игры: пока
 * m·t·p > c, кольцо с двумя гружёными плечами прибыльно. Решаем относительно
 * износа — получаем точку, в которой машину пора списывать.
 */
function writeOffWear(vc: VehicleClass, cargo: CargoType): number {
  const revenuePerKm = vc.capacity * vc.tariffPerTonKm * CARGO_PREMIUM[cargo]
  const gap = revenuePerKm - costPerKmAt(vc, 0)
  return Math.sqrt(gap / (MAINTENANCE_WEAR_GAIN * vc.maintenancePerKm))
}

describe('решение о списании', () => {
  it('точка списания у каждого класса и груза своя', () => {
    const thresholds: number[] = []

    for (const vc of VEHICLE_CLASSES) {
      const cargo = cargoFor(vc)
      expect(cargo.length).toBeGreaterThan(0)

      const own = cargo.map((c) => writeOffWear(vc, c))
      for (const w of own) {
        // Внутри жизни машины, а не за её пределами: списание должно наступать
        // до того, как ресурс кончится сам, и после того, как машина поработала.
        expect(w).toBeGreaterThan(0)
        expect(w).toBeLessThan(1)
      }

      // Один и тот же грузовик на разных грузах списывается в разные моменты —
      // значит порог зависит не только от техники, но и от того, что возить.
      expect(Math.max(...own) - Math.min(...own)).toBeGreaterThan(0.05)
      thresholds.push(...own)
    }

    // И по парку в целом единого числа «списывай на N процентах» не существует:
    // разброс больше четверти жизни машины. Любой одинаковый для всех порог
    // настолько же и ошибается.
    expect(Math.max(...thresholds) - Math.min(...thresholds)).toBeGreaterThan(0.2)
  })

  it('износ не может сделать кольцо с одним гружёным плечом прибыльным', () => {
    // ГЛАВНЫЙ ИНВАРИАНТ ИГРЫ. Он записан как c < m·t·p < 2c; износ двигает
    // только c и только вверх, поэтому правая половина может стать лишь
    // надёжнее. Тест ловит обратное: множитель, опустившийся ниже единицы,
    // мгновенно сделал бы порожний возврат выгодным.
    for (const vc of VEHICLE_CLASSES) {
      // Новая машина обязана удовлетворять инварианту с обеих сторон — это
      // проверка предпосылки, посчитанная той же формулой, что в справочнике.
      expect(costPerKmAt(vc, 0)).toBeCloseTo(costPerKm(vc), 9)

      for (const cargo of cargoFor(vc)) {
        const revenuePerKm = vc.capacity * vc.tariffPerTonKm * CARGO_PREMIUM[cargo]
        expect(revenuePerKm).toBeGreaterThan(costPerKmAt(vc, 0))

        for (let w = 0; w <= 1.0001; w += 0.1) {
          expect(revenuePerKm).toBeLessThan(2 * costPerKmAt(vc, w))
        }
      }
    }
  })
})

describe('ТО', () => {
  it('обнуляет счётчик и списывает деньги', () => {
    const due = makeVehicle(ZIL, { kmSinceService: SERVICE_INTERVAL_KM })
    const before = makeState([due])

    expect(needsService(due)).toBe(true)

    const after = serviceVehicle(before, V1)

    expect(truck(after).kmSinceService).toBe(0)
    expect(needsService(truck(after))).toBe(false)
    expect(money(before) - money(after)).toBeCloseTo(
      SERVICE_COST_KM * ZIL.maintenancePerKm,
      9,
    )
    // Разовый счёт обязан попасть и в суточный итог — иначе панель показывает
    // парк дешевле, чем он есть.
    expect(after.companies[PLAYER].dailyCosts).toBeCloseTo(serviceCost(due), 9)
  })

  it('дорожает вместе с износом', () => {
    const worn = makeVehicle(ZIL, { wear: 1, kmSinceService: SERVICE_INTERVAL_KM })
    expect(serviceCost(worn)).toBeCloseTo(
      SERVICE_COST_KM * ZIL.maintenancePerKm * (1 + MAINTENANCE_WEAR_GAIN),
      9,
    )
  })

  it('не возвращает ресурс: это регламент, а не капремонт', () => {
    const half = makeVehicle(ZIL, { wear: 0.5, kmSinceService: SERVICE_INTERVAL_KM })
    const after = serviceVehicle(makeState([half]), V1)

    expect(truck(after).wear).toBe(0.5)
  })

  it('повторное ТО на нулевом счётчике не стоит ничего', () => {
    const fresh = makeState([makeVehicle(ZIL)])
    expect(serviceVehicle(fresh, V1)).toBe(fresh)
  })
})

describe('пропущенное ТО', () => {
  it('до норматива не наказывает вовсе', () => {
    expect(serviceNeglect(0)).toBe(0)
    expect(serviceNeglect(SERVICE_INTERVAL_KM)).toBe(0)
    expect(wearPerKm(1, SERVICE_INTERVAL_KM)).toBeCloseTo(wearPerKm(1, 0), 12)
  })

  it('нарастает плавно, а не скачком на пороге', () => {
    // Опоздание на километр не имеет права удвоить износ: скачок на пороге
    // игрок воспринял бы как несправедливость, и был бы прав.
    const justOver = wearPerKm(1, SERVICE_INTERVAL_KM + 1)
    expect(justOver).toBeGreaterThan(wearPerKm(1, SERVICE_INTERVAL_KM))
    expect(justOver).toBeLessThan(wearPerKm(1, SERVICE_INTERVAL_KM) * 1.001)
  })

  it('ускоряет износ, и не больше чем на свой множитель', () => {
    const overdue = 2 * SERVICE_INTERVAL_KM
    expect(serviceNeglect(overdue)).toBe(1)

    expect(wearPerKm(1, overdue)).toBeCloseTo(
      wearPerKm(1, 0) * (1 + NEGLECT_WEAR_GAIN),
      12,
    )
    // Запущенность ограничена сверху: забыть на полгода не хуже, чем на месяц.
    expect(wearPerKm(1, 10 * SERVICE_INTERVAL_KM)).toBeCloseTo(
      wearPerKm(1, overdue),
      12,
    )
  })

  it('видна в самой фазе, а не только в формуле', () => {
    const kept = onRoad(M2, { kmSinceService: SERVICE_INTERVAL_KM })
    const neglected = onRoad(M2, {
      id: V2,
      kmSinceService: 2 * SERVICE_INTERVAL_KM,
    })
    const state = makeState([kept, neglected])
    const after = runWear(state)

    expect(truck(after, V2).wear).toBeCloseTo(
      truck(after, V1).wear * (1 + NEGLECT_WEAR_GAIN),
      12,
    )
  })

  it('повышает и риск поломки', () => {
    const kept = makeVehicle(ZIL, { kmSinceService: SERVICE_INTERVAL_KM })
    const neglected = makeVehicle(ZIL, { kmSinceService: 2 * SERVICE_INTERVAL_KM })

    expect(breakdownChance(neglected, makeDriver(), 100)).toBeGreaterThan(
      breakdownChance(kept, makeDriver(), 100),
    )
  })
})

describe('вероятность поломки', () => {
  const driver = makeDriver()

  it('растёт с износом', () => {
    let previous = breakdownChance(makeVehicle(ZIL, { wear: 0 }), driver, 100)
    for (let w = 0.1; w <= 1.0001; w += 0.1) {
      const current = breakdownChance(makeVehicle(ZIL, { wear: w }), driver, 100)
      expect(current).toBeGreaterThan(previous)
      previous = current
    }
  })

  it('падает с навыком водителя и растёт с усталостью', () => {
    const vehicle = makeVehicle(ZIL, { wear: 0.5 })

    const novice = breakdownChance(vehicle, makeDriver({ skill: 0 }), 100)
    const master = breakdownChance(vehicle, makeDriver({ skill: 1 }), 100)
    expect(master).toBeLessThan(novice)

    const rested = breakdownChance(vehicle, makeDriver({ fatigue: 0 }), 100)
    const tired = breakdownChance(vehicle, makeDriver({ fatigue: 1 }), 100)
    expect(tired).toBeGreaterThan(rested)

    // И ровно во столько раз, во сколько сказано в фазе водителей: вклад
    // человека здесь не переписан, а взят множителем.
    const hazard = (p: number) => -Math.log(1 - p)
    expect(hazard(master) / hazard(novice)).toBeCloseTo(
      breakdownFactor(makeDriver({ skill: 1 })) /
        breakdownFactor(makeDriver({ skill: 0 })),
      9,
    )
  })

  it('растёт с пробегом и никогда не выходит за единицу', () => {
    const doomed = makeVehicle(ZIL, {
      wear: 1,
      kmSinceService: 10 * SERVICE_INTERVAL_KM,
    })
    const reckless = makeDriver({ skill: 0, fatigue: 1 })

    expect(breakdownChance(doomed, reckless, 10)).toBeLessThan(
      breakdownChance(doomed, reckless, 100),
    )
    /*
     * Пробег, на котором ЛИНЕЙНАЯ модель дала бы заведомо больше единицы:
     * пять тысяч километров при частоте отказов убитой машины — это шесть
     * «ожидаемых поломок». Линейная вероятность там давно перестала бы
     * различать «плохо» и «совсем плохо» — ровно в том углу, где это важнее
     * всего. Экспоненциальная остаётся строго внутри шкалы.
     */
    const beyondLinear = 5_000
    const chance = breakdownChance(doomed, reckless, beyondLinear)
    // Накопленная частота отказов восстанавливается из вероятности обратно и
    // здесь заведомо больше единицы — то есть линейная модель уже сломалась.
    expect(-Math.log(1 - chance)).toBeGreaterThan(1)

    expect(breakdownChance(doomed, reckless, beyondLinear)).toBeLessThan(1)
    expect(breakdownChance(doomed, reckless, beyondLinear)).toBeGreaterThan(0.9)
    // И за единицу не выходит ни при каком пробеге вообще.
    expect(breakdownChance(doomed, reckless, 1_000_000)).toBeLessThanOrEqual(1)
  })

  it('новая машина у опытного водителя ломается редко', () => {
    // Масштаб механики: за средний пробег между поломками новая машина у
    // среднего водителя ломается примерно один раз. Тест не про точное число, а
    // про то, что поломка осталась событием, а не фоном.
    const fresh = makeVehicle(ZIL)
    const chance = breakdownChance(fresh, driver, BREAKDOWN_MTBF_KM)

    expect(chance).toBeGreaterThan(0.2)
    expect(chance).toBeLessThan(0.8)
  })

  it('нулевой пробег не ломает ничего', () => {
    expect(breakdownChance(makeVehicle(ZIL, { wear: 1 }), driver, 0)).toBe(0)
  })
})

describe('поломка', () => {
  /** Заведомо аварийная машина: убитая, с просроченным ТО, за рулём уставший. */
  function doomedState(seed: number): GameState {
    return {
      ...makeState(
        [onRoad(M2, { wear: 1, kmSinceService: 10 * SERVICE_INTERVAL_KM })],
        makeCompany({ drivers: { [D1]: makeDriver({ skill: 0, fatigue: 1 }) } }),
      ),
      rngState: seed,
    }
  }

  /**
   * Прогон без фазы движения: машина остаётся на ребре и каждый тик рискует
   * одинаково. Движение здесь только увело бы её в город и смазало картину.
   */
  function firstBreakdown(state: GameState, ticks: number): number {
    let next = state
    for (let i = 0; i < ticks; i++) {
      next = runWear(next)
      if (truck(next).brokenDown) return i
    }
    return -1
  }

  it('детерминирована при фиксированном сиде', () => {
    const seed = 12345
    const a = firstBreakdown(doomedState(seed), 500)
    const b = firstBreakdown(doomedState(seed), 500)

    expect(a).toBeGreaterThanOrEqual(0)
    expect(b).toBe(a)

    // И не только момент поломки: состояние после прогона совпадает целиком.
    let one = doomedState(seed)
    let two = doomedState(seed)
    for (let i = 0; i < 50; i++) {
      one = runWear(one)
      two = runWear(two)
    }
    expect(JSON.stringify(one)).toBe(JSON.stringify(two))
  })

  it('другой сид даёт другую партию', () => {
    // Иначе «детерминированно» означало бы «одинаково всегда», то есть
    // случайности нет вовсе.
    expect(firstBreakdown(doomedState(777), 500)).not.toBe(
      firstBreakdown(doomedState(31337), 500),
    )
  })

  it('генератор дёргается ровно по разу на машину', () => {
    // Число обращений зависит только от размера парка — не от того, кто в пути
    // и насколько он рискует. Иначе перебалансировка порогов сдвигала бы всю
    // последовательность и старые сохранения переставали бы воспроизводиться.
    const state = makeState([onRoad(M2), makeVehicle(ZIL, { id: V2 })])

    const rng = Rng.from(state.rngState)
    rng.float()
    rng.float()

    expect(runWear(state).rngState).toBe(rng.seed)
  })

  it('сломанная машина стоит: ресурс не тратится и счётчик ТО не растёт', () => {
    const broken = onRoad(M2, {
      brokenDown: true,
      wear: 0.4,
      kmSinceService: 1234,
    })
    const after = runWear(makeState([broken]))

    expect(truck(after).wear).toBe(0.4)
    expect(truck(after).kmSinceService).toBe(1234)
    expect(truck(after).brokenDown).toBe(true)
  })

  it('стоящая с водителем машина рискует, брошенная — нет', () => {
    const parked = makeVehicle(ZIL, { wear: 1 })
    const abandoned = makeVehicle(ZIL, { wear: 1, driverId: null })

    expect(breakdownChance(parked, makeDriver(), IDLE_EXPOSURE_KM)).toBeGreaterThan(0)
    expect(breakdownChance(abandoned, null, 0)).toBe(0)

    // И риск простоя заметно ниже рабочего: машина в гараже — не машина в рейсе.
    expect(breakdownChance(parked, makeDriver(), IDLE_EXPOSURE_KM)).toBeLessThan(
      breakdownChance(parked, makeDriver(), KM_PER_TICK) / 2,
    )
  })
})

describe('ремонт', () => {
  it('снимает поломку за деньги', () => {
    const broken = makeVehicle(ZIL, { brokenDown: true })
    const before = makeState([broken])
    const after = repairVehicle(before, V1)

    expect(truck(after).brokenDown).toBe(false)
    expect(money(before) - money(after)).toBeCloseTo(
      REPAIR_COST_KM * ZIL.maintenancePerKm,
      9,
    )
  })

  it('поломка в пути заметно дороже поломки на стоянке', () => {
    const inYard = makeVehicle(ZIL, { brokenDown: true })
    const onLeg = onRoad(M2, { brokenDown: true })

    expect(repairCost(onLeg)).toBeCloseTo(
      repairCost(inYard) * ROADSIDE_REPAIR_MULTIPLIER,
      9,
    )
    expect(ROADSIDE_REPAIR_MULTIPLIER).toBeGreaterThan(1)

    const yardBill = money(makeState([inYard])) - money(repairVehicle(makeState([inYard]), V1))
    const legBill = money(makeState([onLeg])) - money(repairVehicle(makeState([onLeg]), V1))
    expect(legBill).toBeCloseTo(yardBill * ROADSIDE_REPAIR_MULTIPLIER, 9)
  })

  it('дорожает с износом, как и всё остальное обслуживание', () => {
    const worn = makeVehicle(ZIL, { brokenDown: true, wear: 1 })
    expect(repairCost(worn)).toBeCloseTo(
      REPAIR_COST_KM * ZIL.maintenancePerKm * (1 + MAINTENANCE_WEAR_GAIN),
      9,
    )
  })

  it('проходит даже в минус: иначе игрок запирается насмерть', () => {
    const broken = makeVehicle(ZIL, { brokenDown: true })
    const poor = makeState([broken], makeCompany({ money: 0 }))
    const after = repairVehicle(poor, V1)

    expect(truck(after).brokenDown).toBe(false)
    expect(money(after)).toBeLessThan(0)
  })

  it('исправную машину чинить не за что', () => {
    const fine = makeState([makeVehicle(ZIL)])
    expect(repairVehicle(fine, V1)).toBe(fine)
  })

  it('не возвращает ресурс и не отменяет ТО', () => {
    const broken = makeVehicle(ZIL, {
      brokenDown: true,
      wear: 0.7,
      kmSinceService: 2 * SERVICE_INTERVAL_KM,
    })
    const after = repairVehicle(makeState([broken]), V1)

    expect(truck(after).wear).toBe(0.7)
    expect(truck(after).kmSinceService).toBe(2 * SERVICE_INTERVAL_KM)
  })
})

describe('чистота', () => {
  it('фаза не меняет входное состояние', () => {
    const state = makeState([
      onRoad(M2, { wear: 0.9, kmSinceService: 3 * SERVICE_INTERVAL_KM }),
      makeVehicle(ZIL, { id: V2, wear: 0.2 }),
    ])
    const snapshot = JSON.stringify(state)

    const after = runWear(state)

    expect(JSON.stringify(state)).toBe(snapshot)
    expect(after).not.toBe(state)
    expect(after.vehicles[V1]).not.toBe(state.vehicles[V1])
    // Мир и деньги фазе износа не принадлежат — она их не подменяет.
    expect(after.world).toBe(state.world)
    expect(after.companies).toBe(state.companies)
  })

  it('команды игрока не меняют входное состояние', () => {
    const state = makeState([
      makeVehicle(ZIL, {
        brokenDown: true,
        wear: 0.5,
        kmSinceService: SERVICE_INTERVAL_KM,
      }),
    ])
    const snapshot = JSON.stringify(state)

    const serviced = serviceVehicle(state, V1)
    const repaired = repairVehicle(state, V1)

    expect(JSON.stringify(state)).toBe(snapshot)
    expect(serviced.vehicles).not.toBe(state.vehicles)
    expect(repaired.companies[PLAYER]).not.toBe(state.companies[PLAYER])
  })

  it('машина, которая никуда не делась, возвращается по ссылке', () => {
    // По совпадению ссылок рендер отличает изменившееся от нетронутого.
    const state = makeState([makeVehicle(ZIL, { driverId: null })])
    const after = runWear(state)

    expect(after.vehicles).toBe(state.vehicles)
    // А состояние генератора всё равно записано обратно.
    expect(after.rngState).not.toBe(state.rngState)
  })

  it('несуществующая машина не роняет команды', () => {
    const state = makeState([])
    expect(serviceVehicle(state, V1)).toBe(state)
    expect(repairVehicle(state, V1)).toBe(state)
    expect(runWear(state)).toBe(state)
  })

  it('битые числа дают ноль, а не NaN в износе', () => {
    const broken = onRoad(M2, {
      wear: Number.NaN,
      kmSinceService: Number.NaN,
    })
    const after = runWear(makeState([broken]))

    expect(Number.isFinite(truck(after).wear)).toBe(true)
    expect(Number.isFinite(truck(after).kmSinceService)).toBe(true)
    expect(Number.isFinite(maintenancePerKm(truck(after)))).toBe(true)
  })
})
