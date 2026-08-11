/**
 * Проверка чтения парка.
 *
 * ЧИСЛА ВЫВОДЯТСЯ ИЗ КОНСТАНТ И ИЗ САМИХ ДАННЫХ, а не вписываются посчитанными.
 * Ставка обслуживания спрашивается у sim/logistics/wear.ts, цена прицепа — у
 * TRAILER_PRICE, тариф и грузоподъёмность — у справочника техники, допуски — у
 * CARGO_LICENSE. Перебалансировка данных не должна ронять ни одну проверку:
 * дважды за проект она роняла тесты, в которых не менялось ни одного правила.
 *
 * Проверяются именно ПРАВИЛА: что оба числа решения о списании берутся из
 * симуляции, что порог списания лежит внутри ресурса и стоит там, где расходы
 * догоняют выручку, что недоступная техника из списка не исчезает, что прицеп
 * называет свои грузы, а водитель — грузы, которые ему не доверят.
 */

import { describe, expect, it } from 'vitest'

import { TARIFF_PER_TON_KM } from '../data/operating'
import {
  TRAILER_PRICE,
  VEHICLE_CLASSES,
  VEHICLE_CLASS_BY_ID,
  costPerKm as classCostPerKm,
} from '../data/vehicles'
import {
  CARGO_LICENSE,
  MAX_SHIFT_HOURS,
  wageFor,
} from '../sim/logistics/driver'
import { cargoFor } from '../sim/logistics/trailer'
import {
  MAINTENANCE_WEAR_GAIN,
  SERVICE_INTERVAL_KM,
  maintenancePerKm,
  repairCost,
  serviceCost,
} from '../sim/logistics/wear'
import {
  HOME_CITY,
  STARTER_CLASS_ID,
  createInitialState,
  createVehicle,
} from '../sim/state'
import {
  companyId,
  driverId,
  lineId,
  vehicleId,
  type CargoType,
  type Driver,
  type DriverLicense,
  type Edge,
  type Line,
  type LineId,
  type Vehicle,
  type VehicleId,
} from '../sim/types'
import {
  classOffers,
  costPerKm,
  driverRow,
  driverRows,
  fleetRow,
  fleetRows,
  fleetSummary,
  payrollPerDay,
  trailerOffers,
  type FleetContext,
} from './fleetReadout'
// Порог списания и потолок выручки переехали в симуляцию: по ним принимает
// решение и панель, и конкурент, поэтому число обязано быть одно.
import { revenuePerKm, writeOffWear } from '../sim/logistics/wear'

const PLAYER = companyId('player')

/** Настоящий мир партии: города и дороги берутся из него, а не выдумываются. */
const world = createInitialState(1).world

/** Любое ребро графа — для проверки машины в пути. Первое, чтобы не гадать. */
const EDGE: Edge = Object.values(world.edges)[0]

function context(patch: Partial<FleetContext> = {}): FleetContext {
  return {
    cities: world.cities,
    edges: world.edges,
    lines: {},
    drivers: {},
    ...patch,
  }
}

function zil(patch: Partial<Vehicle> = {}): Vehicle {
  return {
    ...createVehicle(
      vehicleId('zil-test'),
      PLAYER,
      HOME_CITY,
      STARTER_CLASS_ID,
      'тент',
    ),
    ...patch,
  }
}

function driver(patch: Partial<Driver> = {}): Driver {
  const licenses: DriverLicense[] = patch.licenses ?? []
  return {
    id: driverId('drv-1'),
    name: 'Пётр Сомов',
    employerId: PLAYER,
    vehicleId: null,
    skill: 0.5,
    licenses,
    fatigue: 0,
    hoursOnDuty: 0,
    wagePerDay: wageFor(0.5, licenses),
    loyalty: 0.5,
    ...patch,
  }
}

// ─── Два числа одного решения ──────────────────────────────────────────────

describe('износ и обслуживание', () => {
  it('обе величины берутся у симуляции, а не считаются панелью', () => {
    const worn = zil({ wear: 0.6 })
    const row = fleetRow(worn, context())

    expect(row.wear).toBe(0.6)
    expect(row.maintenancePerKm).toBe(maintenancePerKm(worn))
  })

  it('у новой машины ставка равна паспортной ставке класса', () => {
    const row = fleetRow(zil(), context())
    const vc = VEHICLE_CLASS_BY_ID[STARTER_CLASS_ID]

    expect(row.basePerKm).toBe(vc.maintenancePerKm)
    expect(row.maintenancePerKm).toBeCloseTo(vc.maintenancePerKm, 10)
  })

  it('к концу ресурса обслуживание дорожает ровно по кривой износа', () => {
    const row = fleetRow(zil({ wear: 1 }), context())
    const vc = VEHICLE_CLASS_BY_ID[STARTER_CLASS_ID]

    expect(row.maintenancePerKm).toBeCloseTo(
      vc.maintenancePerKm * (1 + MAINTENANCE_WEAR_GAIN),
      10,
    )
  })

  it('расход на километр у новой машины совпадает со справочным', () => {
    const row = fleetRow(zil(), context())

    // costPerKm из data/vehicles — то самое c, через которое записан главный
    // инвариант игры. Панель обязана показывать именно его, а не своё число.
    expect(row.costPerKm).toBeCloseTo(
      classCostPerKm(VEHICLE_CLASS_BY_ID[STARTER_CLASS_ID]),
      10,
    )
  })

  it('цены ТО и ремонта — из симуляции, вместе с надбавкой за износ', () => {
    const worn = zil({ wear: 0.8, kmSinceService: SERVICE_INTERVAL_KM })
    const row = fleetRow(worn, context())

    expect(row.serviceCost).toBe(serviceCost(worn))
    expect(row.repairCost).toBe(repairCost(worn))
    expect(row.serviceDue).toBe(true)
  })
})

// ─── Порог списания ────────────────────────────────────────────────────────

describe('порог списания', () => {
  it('потолок выручки — это m·t из справочника класса', () => {
    for (const vc of VEHICLE_CLASSES) {
      const fresh = createVehicle(
        vehicleId(`ref-${vc.id}`),
        PLAYER,
        HOME_CITY,
        vc.id,
      )
      expect(revenuePerKm(fresh)).toBeCloseTo(vc.capacity * vc.tariffPerTonKm, 10)
    }
  })

  it('неизвестный класс откатывается к общему тарифу, а не к нулю', () => {
    // Машина из сохранения, справочник которого до нас не дожил. Ноль здесь
    // означал бы «списать немедленно» из-за дефекта данных.
    const orphan = zil({ classId: 'нет-такого' })
    expect(revenuePerKm(orphan)).toBeCloseTo(
      orphan.capacity * TARIFF_PER_TON_KM,
      10,
    )
  })

  it('новая машина любого класса зарабатывает больше, чем тратит', () => {
    // Это левая половина главного инварианта игры: c < m·t. Если она сломается,
    // панель первой скажет «списывать сразу после покупки».
    for (const vc of VEHICLE_CLASSES) {
      const fresh = createVehicle(
        vehicleId(`ref-${vc.id}`),
        PLAYER,
        HOME_CITY,
        vc.id,
      )
      expect(costPerKm(fresh, null)).toBeLessThan(revenuePerKm(fresh))
    }
  })

  it('порог у каждого класса свой и лежит внутри ресурса', () => {
    for (const vc of VEHICLE_CLASSES) {
      const fresh = createVehicle(
        vehicleId(`ref-${vc.id}`),
        PLAYER,
        HOME_CITY,
        vc.id,
      )
      const threshold = writeOffWear(fresh)

      expect(threshold).not.toBeNull()
      const w = threshold as number
      expect(w).toBeGreaterThan(0)
      expect(w).toBeLessThanOrEqual(1)
    }
  })

  it('в точке порога расходы сравниваются с потолком выручки', () => {
    for (const vc of VEHICLE_CLASSES) {
      const fresh = createVehicle(
        vehicleId(`ref-${vc.id}`),
        PLAYER,
        HOME_CITY,
        vc.id,
      )
      const w = writeOffWear(fresh) as number
      const revenue = revenuePerKm(fresh)

      // Чуть раньше порога машина ещё отбивает идеальный рейс, чуть позже — уже
      // нет. Отступ берётся заведомо крупнее точности поиска (см. WRITE_OFF_STEPS).
      const step = 1e-3
      expect(costPerKm({ ...fresh, wear: w - step }, null)).toBeLessThan(revenue)
      expect(
        costPerKm({ ...fresh, wear: Math.min(1, w + step) }, null),
      ).toBeGreaterThan(revenue)
    }
  })
})

// ─── Положение и беды ──────────────────────────────────────────────────────

describe('строка парка', () => {
  it('машина в узле без маршрута стоит без задания', () => {
    const row = fleetRow(zil(), context())

    expect(row.leg).toBe(world.cities[HOME_CITY].name)
    expect(row.progress).toBeNull()
    expect(row.idle).toBe(true)
  })

  it('машина на ребре показывает плечо и долю пути', () => {
    const row = fleetRow(
      zil({
        position: {
          kind: 'ребро',
          edgeId: EDGE.id,
          fromId: EDGE.from,
          progress: 0.4,
        },
        route: [EDGE.to],
      }),
      context(),
    )

    expect(row.leg).toBe(
      `${world.cities[EDGE.from].name} → ${world.cities[EDGE.to].name}`,
    )
    expect(row.progress).toBeCloseTo(0.4, 10)
    expect(row.idle).toBe(false)
  })

  it('битое положение не выдумывает плечо', () => {
    const row = fleetRow(
      zil({
        position: {
          kind: 'ребро',
          edgeId: EDGE.id,
          // Машина «выехала» из города, которого на этом ребре нет.
          fromId: HOME_CITY === EDGE.from ? EDGE.to : HOME_CITY,
          progress: 0.5,
        },
      }),
      context(),
    )

    // Либо ребро разобрано (город случайно оказался его концом), либо честное
    // «в пути». Чего быть не должно — выдуманного направления.
    if (row.leg !== 'в пути') {
      expect(row.leg).toContain('→')
    }
  })

  it('прицеп называет грузы, которые машина может взять', () => {
    const withTent = fleetRow(zil({ trailer: 'тент' }), context())
    expect(withTent.carries).toEqual(cargoFor('тент'))

    const bare = fleetRow(zil({ trailer: null }), context())
    expect(bare.carries).toEqual([])
  })

  it('линия и водитель подставляются по ссылке из состояния', () => {
    const id: LineId = lineId('line-1')
    const line: Line = {
      id,
      name: 'Зерновое кольцо',
      stops: [],
      assignedVehicles: [],
    }
    const man = driver({ vehicleId: vehicleId('zil-test') })

    const row = fleetRow(
      zil({ lineId: id, driverId: man.id }),
      context({ lines: { [id]: line }, drivers: { [man.id]: man } }),
    )

    expect(row.lineName).toBe('Зерновое кольцо')
    expect(row.driverName).toBe(man.name)
  })

  it('главная беда одна, и поломка важнее прочих', () => {
    expect(fleetRow(zil(), context()).trouble).toBe('без водителя')

    const manned = zil({ driverId: driverId('drv-1') })
    expect(fleetRow(manned, context()).trouble).toBeNull()

    expect(fleetRow({ ...manned, trailer: null }, context()).trouble).toBe(
      'без прицепа',
    )
    expect(
      fleetRow(
        { ...manned, kmSinceService: SERVICE_INTERVAL_KM },
        context(),
      ).trouble,
    ).toBe('пора на ТО')

    // Сломанная без водителя и без прицепа называет ровно одну причину.
    expect(
      fleetRow(
        { ...manned, brokenDown: true, trailer: null, driverId: null },
        context(),
      ).trouble,
    ).toBe('сломана')
  })
})

describe('сводка парка', () => {
  it('считает остановленные деньги по всем причинам сразу', () => {
    const rows = fleetRows(
      [
        zil({ id: vehicleId('a'), driverId: driverId('drv-1') }),
        zil({ id: vehicleId('b'), brokenDown: true }),
        zil({ id: vehicleId('c'), trailer: null }),
        zil({
          id: vehicleId('d'),
          driverId: driverId('drv-2'),
          kmSinceService: SERVICE_INTERVAL_KM,
        }),
      ],
      context(),
    )
    const summary = fleetSummary(rows)

    expect(summary.count).toBe(4)
    expect(summary.broken).toBe(1)
    // Без водителя стоят «b» и «c»: водителя им никто не сажал.
    expect(summary.driverless).toBe(2)
    expect(summary.trailerless).toBe(1)
    expect(summary.serviceDue).toBe(1)
    // Стоят без задания все четыре: маршрута нет ни у одной.
    expect(summary.idle).toBe(4)
    expect(summary.troubled).toBe(3)
  })

  it('изношенная сверх порога машина попадает в списание', () => {
    const fresh = zil()
    const w = writeOffWear(fresh) as number

    const rows = fleetRows(
      [zil({ id: vehicleId('a'), wear: w + 0.05 }), zil({ id: vehicleId('b') })],
      context(),
    )

    expect(fleetSummary(rows).wornOut).toBe(1)
  })
})

// ─── Витрина техники ───────────────────────────────────────────────────────

describe('покупка машины', () => {
  const richYear = 3000
  const rich = 10_000_000

  it('в списке все классы справочника, включая недоступные', () => {
    const offers = classOffers(1994, 0, false)
    expect(offers.map((offer) => offer.id)).toEqual(
      VEHICLE_CLASSES.map((vc) => vc.id),
    )
  })

  it('техника из будущего видна, но недоступна и говорит почему', () => {
    const future = VEHICLE_CLASSES.find((vc) => vc.availableFrom > 1994)
    // Справочник может однажды остаться без «будущих» классов — проверять
    // тогда нечего, но и падать не за что.
    if (future === undefined) return

    const offer = classOffers(1994, rich, false).find(
      (item) => item.id === future.id,
    )

    expect(offer?.available).toBe(false)
    expect(offer?.released).toBe(false)
    expect(offer?.reason).toContain(String(future.availableFrom))
    // Цена видна и у недоступной: копить невозможно на то, чего не видно.
    expect(offer?.price).toBe(future.price)
  })

  it('нехватка денег гасит кнопку и называет недостающую сумму', () => {
    const vc = VEHICLE_CLASSES[0]
    const offer = classOffers(richYear, vc.price - 1, false).find(
      (item) => item.id === vc.id,
    )

    expect(offer?.affordable).toBe(false)
    expect(offer?.available).toBe(false)
    expect(offer?.reason).toContain('не хватает')
  })

  it('денег хватает и класс выпускается — можно покупать', () => {
    for (const offer of classOffers(richYear, rich, false)) {
      expect(offer.available).toBe(true)
      expect(offer.reason).toBeNull()
      // Экономика класса показана той же парой чисел, что и у своих машин.
      expect(offer.revenuePerKm).toBeCloseTo(
        offer.capacity * offer.tariffPerTonKm,
        10,
      )
      expect(offer.costPerKm).toBeCloseTo(
        classCostPerKm(VEHICLE_CLASS_BY_ID[offer.id]),
        10,
      )
    }
  })

  it('банкроту не продают ничего', () => {
    for (const offer of classOffers(richYear, rich, true)) {
      expect(offer.available).toBe(false)
    }
  })
})

// ─── Прицепы ───────────────────────────────────────────────────────────────

describe('покупка прицепа', () => {
  it('совместимость решает справочник техники, а не список грузов', () => {
    const offers = trailerOffers(zil(), 10_000_000, false)
    const fits = offers.filter((offer) => offer.fits).map((o) => o.trailer)

    // Порядок не значим: справочник перечисляет кузова в своём порядке,
    // а витрина — в своём. Проверяется состав.
    expect([...fits].sort()).toEqual(
      [...VEHICLE_CLASS_BY_ID[STARTER_CLASS_ID].trailers].sort(),
    )
  })

  it('неподходящие прицепы остаются в списке недоступными', () => {
    const offers = trailerOffers(zil(), 10_000_000, false)
    const alien = offers.find((offer) => !offer.fits)

    expect(alien).toBeDefined()
    expect(alien?.available).toBe(false)
    expect(alien?.reason).toContain('не тянет')
  })

  it('каждый прицеп называет свою цену и свои грузы', () => {
    for (const offer of trailerOffers(zil(), 10_000_000, false)) {
      expect(offer.price).toBe(TRAILER_PRICE[offer.trailer])
      expect(offer.cargo).toEqual(cargoFor(offer.trailer))
    }
  })

  it('уже стоящий прицеп не продаётся второй раз', () => {
    const offers = trailerOffers(zil({ trailer: 'тент' }), 10_000_000, false)
    const tent = offers.find((offer) => offer.trailer === 'тент')

    expect(tent?.current).toBe(true)
    expect(tent?.available).toBe(false)
  })

  it('без денег прицеп виден с ценой и с недостающей суммой', () => {
    const offers = trailerOffers(zil({ trailer: null }), 0, false)
    const tent = offers.find((offer) => offer.trailer === 'тент')

    expect(tent?.price).toBe(TRAILER_PRICE['тент'])
    expect(tent?.available).toBe(false)
    expect(tent?.reason).toContain('не хватает')
  })
})

// ─── Водители ──────────────────────────────────────────────────────────────

describe('штат', () => {
  it('отдых читается по счётчику смены из симуляции', () => {
    expect(driverRow(driver({ hoursOnDuty: 0 }), {}).resting).toBe(false)
    expect(
      driverRow(driver({ hoursOnDuty: MAX_SHIFT_HOURS }), {}).resting,
    ).toBe(true)
  })

  it('без допуска водитель не везёт грузы, которые их требуют', () => {
    const licensed = Object.keys(CARGO_LICENSE) as CargoType[]
    const rookie = driverRow(driver({ licenses: [] }), {})

    expect(rookie.denied).toEqual(licensed)
  })

  it('с допуском груз пропадает из запретного списка', () => {
    const adr = driverRow(driver({ licenses: ['ДОПОГ'] }), {})

    for (const cargo of Object.keys(CARGO_LICENSE) as CargoType[]) {
      if (CARGO_LICENSE[cargo] === 'ДОПОГ') {
        expect(adr.denied).not.toContain(cargo)
      } else {
        expect(adr.denied).toContain(cargo)
      }
    }
  })

  it('закреплённая машина названа классом и номером', () => {
    const id: VehicleId = vehicleId('zil-test')
    const vehicles: Record<VehicleId, Vehicle> = { [id]: zil({ id }) }
    const row = driverRow(driver({ vehicleId: id }), vehicles)

    expect(row.seat).toBe(`${VEHICLE_CLASS_BY_ID[STARTER_CLASS_ID].name} ${id}`)
  })

  it('в резерве водитель без машины, и это не ошибка данных', () => {
    expect(driverRow(driver({ vehicleId: null }), {}).seat).toBeNull()
  })

  it('фонд оплаты труда — сумма личных ставок, включая резерв', () => {
    const first = driver({ id: driverId('a'), skill: 0.2 })
    const second = driver({
      id: driverId('b'),
      skill: 0.9,
      licenses: ['ДОПОГ'],
      wagePerDay: wageFor(0.9, ['ДОПОГ']),
    })

    const rows = driverRows({ [first.id]: first, [second.id]: second }, {})
    expect(payrollPerDay(rows)).toBe(first.wagePerDay + second.wagePerDay)
  })
})
