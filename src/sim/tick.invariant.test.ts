import { describe, expect, it } from 'vitest'
import { FUEL_PRICE_PER_LITER } from '../data/operating'
import { CARGO_PREMIUM, RECIPE_BY_INDUSTRY } from '../data/recipes'
import { costPerKm, VEHICLE_CLASSES } from '../data/vehicles'
import { STARTER_CLASS_ID } from './state'
import { deliveryRevenue } from './economy/finance'
import { CARGO_LICENSE, fuelFactor, wageFor } from './logistics/driver'
import { canCarry } from './logistics/trailer'
import {
  maintenancePerKm,
  needsService,
  repairVehicle,
  serviceVehicle,
} from './logistics/wear'
import {
  createInitialState,
  createVehicle,
  PLAYER_ID,
  START_MONEY,
  STARTER_DRIVER_SKILL,
} from './state'
import { tick } from './tick'
import {
  TICKS_PER_DAY,
  cityId,
  driverId,
  industryId,
  lineId,
  vehicleId,
} from './types'
import type {
  Driver,
  GameState,
  Industry,
  IndustryId,
  Line,
  Stop,
  Vehicle,
  VehicleId,
} from './types'
import { buildGraph } from './world/graph'
import { shortestKm } from './world/pathfind'

/**
 * ГЛАВНЫЙ ТЕСТ СРЕЗА 4: инвариант держится для КАЖДОГО КЛАССА ТЕХНИКИ.
 *
 * Требование к игре одно и оно не менялось с первого среза: кольцо с одним
 * гружёным плечом обязано быть УБЫТОЧНЫМ, с двумя гружёными — прибыльным. Пока
 * машина в игре была одна, это проверялось одним прогоном. Теперь классов три,
 * у каждого своя грузоподъёмность, свой тариф и своя плата за погрузку (разбор,
 * почему единым тарифом обойтись нельзя, — в шапке src/data/vehicles.ts), и
 * инвариант обязан выполняться у каждого ОТДЕЛЬНО. Двадцатитонник с тарифом
 * шеститонника зарабатывает столько, что порожний возврат перестаёт его пугать
 * вовсе, — и вся конструкция игры рассыпается именно на нём.
 *
 * ─── ПОЧЕМУ КОЛЬЦО СОБРАНО, А НЕ ВЗЯТО С КАРТЫ ─────────────────────────────
 *
 * Мир, дороги и километры здесь настоящие: Москва — Смоленск по М-1, 395 км.
 * А вот предприятия расставлены тестом, и это единственная вольность.
 *
 * Причина в самой карте, а не в экономике. Кольцо с ДВУМЯ гружёными плечами
 * требует, чтобы в обоих его концах кто-то ждал груз — и ждал не разово, а
 * тридцать суток подряд. Настоящих потребителей такого масштаба в мире ровно
 * два вида: перерабатывающий завод (ему нужно сырьё каждый день) и Москва (она
 * одна съедает больше остальных девяти городов вместе). Пары «завод + Москва в
 * одном плече» на карте нет: в столице нет ни одного предприятия, и обратное
 * плечо из неё всегда порожнее. Это факт про РАССТАНОВКУ, и он проверяется
 * своими тестами в data/industries.ts; здесь же проверяется ЭКОНОМИКА, то есть
 * соотношение тарифа и расходов на километр, а оно от расстановки не зависит.
 *
 * Поэтому мир теста — учебный: элеватор в Москве, мукомольный в Смоленске.
 * Зерно едет из столицы на завод, мука возвращается в столицу, и оба плеча
 * кольца гружёные по-настоящему — с честной погрузкой, честным тарифом и
 * честной оплатой за фактически доставленные тонны.
 *
 * ─── ЧТО РАЗЛИЧАЕТ ДВА ПРОГОНА ─────────────────────────────────────────────
 *
 * Одна строчка в инструкции остановки: берёт ли машина муку в Смоленске.
 * Километры, топливо, резина, зарплата и износ в обоих прогонах одни и те же —
 * различается только выручка обратного плеча. Так же был устроен главный тест
 * среза 3, и это по-прежнему лучший способ показать, что порожний пробег — это
 * деньги, а не строчка в отчёте.
 */

const MOSCOW = cityId('moscow')
const SMOLENSK = cityId('smolensk')

const RING: Line['id'] = lineId('ring')
const TRUCK: VehicleId = vehicleId('truck')
const DRIVER = driverId('drv')

/** Тент возит и зерно, и муку — единственный прицеп, доступный всем классам. */
const TRAILER = 'тент' as const

const DAYS = 30

/** Сид фиксирован: прогоны обязаны совпадать между запусками. */
const SEED = 20260810

const GRAPH = buildGraph(createInitialState(SEED).world.edges)
const LEG_KM = shortestKm(GRAPH, MOSCOW, SMOLENSK)

// ─── Фикстуры ──────────────────────────────────────────────────────────────

function stop(nodeId: Stop['nodeId'], unload: Stop['unload'], load: Stop['load']): Stop {
  return { nodeId, unload, load }
}

/**
 * Кольцо с ДВУМЯ гружёными плечами.
 *
 * Москва отдаёт муку и берёт зерно, Смоленск отдаёт зерно и берёт муку. Порядок
 * внутри остановки задаёт сама фаза прибытия: выгрузка строго раньше погрузки,
 * иначе машина уехала бы с тем же грузом, с которым приехала.
 */
const FULL_RING: Stop[] = [
  stop(MOSCOW, ['мука'], ['зерно']),
  stop(SMOLENSK, ['зерно'], ['мука']),
]

/** То же кольцо, но обратное плечо идёт порожняком: муку никто не берёт. */
const ONE_LEG_RING: Stop[] = [
  stop(MOSCOW, ['мука'], ['зерно']),
  stop(SMOLENSK, ['зерно'], []),
]

/**
 * Два предприятия учебного мира.
 *
 * Запасы выведены из рецептов, а не вписаны числами: перебалансировка выпуска
 * обязана двигать их сама. День выпуска на складе — ровно столько, чтобы первая
 * машина не стояла у ворот в ожидании первой тонны.
 */
function industries(): Record<IndustryId, Industry> {
  const elevator = RECIPE_BY_INDUSTRY['элеватор']
  const mill = RECIPE_BY_INDUSTRY['мукомольный']

  const list: Industry[] = [
    {
      id: industryId('moscow-elevator'),
      type: 'элеватор',
      cityId: MOSCOW,
      stock: { [elevator.output]: elevator.dailyRate },
      utilization: 0,
      idleTicks: 0,
    },
    {
      id: industryId('smolensk-mill'),
      type: 'мукомольный',
      cityId: SMOLENSK,
      stock: {
        [mill.output]: mill.dailyRate,
        [mill.inputs[0].type]: mill.dailyRate * mill.inputs[0].perUnit,
      },
      utilization: 0,
      idleTicks: 0,
    },
  ]

  return Object.fromEntries(list.map((it) => [it.id, it])) as Record<
    IndustryId,
    Industry
  >
}

/**
 * Водитель, которым укомплектована каждая машина прогона.
 *
 * Ровно тот же, с которого начинается партия: середина шкалы навыка и никаких
 * допусков. Зерно и мука их и не требуют — специально выбранная пара грузов,
 * доступная любому водителю и любому классу техники.
 */
function driver(): Driver {
  return {
    id: DRIVER,
    name: 'Водитель',
    employerId: PLAYER_ID,
    vehicleId: TRUCK,
    skill: STARTER_DRIVER_SKILL,
    licenses: [],
    fatigue: 0,
    hoursOnDuty: 0,
    wagePerDay: wageFor(STARTER_DRIVER_SKILL, []),
    loyalty: 0.5,
  }
}

/** Учебный мир: настоящая карта, два предприятия, одна машина, одно кольцо. */
function world(classId: string, stops: Stop[]): GameState {
  const base = createInitialState(SEED)

  const truck: Vehicle = {
    ...createVehicle(TRUCK, PLAYER_ID, MOSCOW, classId, TRAILER),
    driverId: DRIVER,
    lineId: RING,
    stopIndex: 0,
  }

  const line: Line = {
    id: RING,
    name: 'Кольцо',
    stops,
    assignedVehicles: [TRUCK],
  }

  return {
    ...base,
    world: { ...base.world, industries: industries() },
    companies: {
      ...base.companies,
      [PLAYER_ID]: {
        ...base.companies[PLAYER_ID],
        lines: { [RING]: line },
        drivers: { [DRIVER]: driver() },
      },
    },
    vehicles: { [TRUCK]: truck } as Record<VehicleId, Vehicle>,
  }
}

/**
 * Прогон с ХОЗЯЙСКИМ ОТНОШЕНИЕМ К ТЕХНИКЕ.
 *
 * Сломанная машина чинится в тот же тик, машина с подошедшим ТО подаётся на
 * обслуживание. И то, и другое стоит денег, и деньги эти в итог прогона входят
 * — как и должны: содержание парка часть экономики перевозок, а не помеха
 * тесту. Не чини мы поломку, прогон измерял бы не инвариант, а везение в
 * розыгрыше отказа: одна поломка на тридцатый день и одна на первый дают
 * совершенно разный результат при одинаковой экономике кольца.
 */
function runDays(state: GameState, days: number): GameState {
  let next = state

  for (let i = 0; i < days * TICKS_PER_DAY; i++) {
    next = tick(next)

    for (const id of Object.keys(next.vehicles) as VehicleId[]) {
      if (next.vehicles[id].brokenDown) next = repairVehicle(next, id)
      if (needsService(next.vehicles[id])) next = serviceVehicle(next, id)
    }
  }

  return next
}

type Outcome = {
  end: GameState
  truck: Vehicle
  money: number
  /** Доля порожних километров, 0..1 — главная метрика мастерства в игре. */
  emptyShare: number
}

function outcomeOf(end: GameState): Outcome {
  const truck = end.vehicles[TRUCK]
  return {
    end,
    truck,
    money: end.companies[PLAYER_ID].money,
    emptyShare: truck.odometer > 0 ? truck.emptyKm / truck.odometer : 0,
  }
}

// ─── Предпосылки кольца ────────────────────────────────────────────────────

describe('учебное кольцо подходит всем трём классам', () => {
  it('тент возит оба груза кольца', () => {
    // Без этого прогон измерял бы не экономику, а невозможность взять груз.
    expect(canCarry(TRAILER, 'зерно')).toBe(true)
    expect(canCarry(TRAILER, 'мука')).toBe(true)
  })

  it('тент доступен каждому классу справочника', () => {
    for (const vehicleClass of VEHICLE_CLASSES) {
      expect(vehicleClass.trailers, vehicleClass.id).toContain(TRAILER)
    }
  })

  it('ни зерно, ни мука не требуют допуска', () => {
    // Пара грузов выбрана так, чтобы прогон проверял тариф и расходы, а не
    // наличие ДОПОГ у водителя.
    expect(CARGO_LICENSE['зерно']).toBeUndefined()
    expect(CARGO_LICENSE['мука']).toBeUndefined()
  })

  it('плечо взято из графа дорог, а не выписано числом', () => {
    expect(LEG_KM).toBeGreaterThan(0)
    expect(Number.isFinite(LEG_KM)).toBe(true)
  })
})

// ─── Коридор инварианта на самих константах ────────────────────────────────

describe('коридор c < m·t·p < 2c держится для каждого класса', () => {
  /*
   * Арифметическая половина инварианта, проверенная ДО всякого прогона. Прогон
   * доказывает, что игра ведёт себя по правилу; эта проверка — что правило
   * вообще выполнимо на нынешних числах. Разница важна при отладке: покрасневший
   * прогон при зелёном коридоре означает ошибку в симуляции, а покрасневший
   * коридор — ошибку в данных, и искать их нужно в разных файлах.
   *
   * ГРАНИЦЫ ПРОВЕРЯЮТСЯ НА КРАЯХ ШКАЛЫ НАВЫКА. Расход топлива зависит от
   * водителя (fuelFactor в logistics/driver.ts), значит переменные расходы на
   * километр — не одно число, а отрезок. Инвариант обязан держаться на обоих его
   * концах, иначе игра меняет правила в зависимости от того, кто за рулём.
   */
  const premiums = Object.values(CARGO_PREMIUM)
  const minPremium = Math.min(...premiums)
  const maxPremium = Math.max(...premiums)

  /**
   * Границы множителя расхода по навыку. Спрашиваются у самой функции, а не
   * переписываются числами: правка SKILL_FUEL_GAIN обязана менять эту проверку
   * сама, иначе тест однажды начнёт проверять правило, которого в игре нет.
   */
  const FULL_SKILL: Driver = { ...driver(), skill: 1 }
  const NO_SKILL: Driver = { ...driver(), skill: 0 }
  const FUEL_FACTOR_MIN = fuelFactor(FULL_SKILL)
  const FUEL_FACTOR_MAX = fuelFactor(NO_SKILL)

  /** Расходы на километр при самом экономичном и самом расточительном стиле. */
  function costRange(fuelPer100Km: number, maintenance: number): [number, number] {
    const fuel = (fuelPer100Km / 100) * FUEL_PRICE_PER_LITER
    return [fuel * FUEL_FACTOR_MIN + maintenance, fuel * FUEL_FACTOR_MAX + maintenance]
  }

  for (const vehicleClass of VEHICLE_CLASSES) {
    it(`${vehicleClass.name}: выручка на километр лежит внутри коридора`, () => {
      const [cheapest, dearest] = costRange(
        vehicleClass.fuelPer100Km,
        vehicleClass.maintenancePerKm,
      )

      const worst = vehicleClass.capacity * vehicleClass.tariffPerTonKm * minPremium
      const best = vehicleClass.capacity * vehicleClass.tariffPerTonKm * maxPremium

      // Одно гружёное плечо из двух не окупает кольцо: даже на самом дорогом
      // грузе и при самом экономичном водителе.
      expect(best).toBeLessThan(2 * cheapest)
      // Два гружёных плеча окупают: даже на самом дешёвом грузе и при самом
      // расточительном водителе.
      expect(worst).toBeGreaterThan(dearest)
    })
  }

  it('навык действительно двигает расходы, иначе проверка выше холостая', () => {
    expect(FULL_SKILL.skill).toBeGreaterThan(STARTER_DRIVER_SKILL)
    expect(FUEL_FACTOR_MIN).toBeLessThan(FUEL_FACTOR_MAX)
    expect(FUEL_FACTOR_MIN).toBeGreaterThan(0)
  })
})

// ─── Прогоны ───────────────────────────────────────────────────────────────

describe.each(VEHICLE_CLASSES.map((vc) => [vc.id, vc] as const))(
  'тридцать суток на кольце: %s',
  (_id, vehicleClass) => {
    const loaded = outcomeOf(runDays(world(vehicleClass.id, FULL_RING), DAYS))
    const hollow = outcomeOf(runDays(world(vehicleClass.id, ONE_LEG_RING), DAYS))

    it('машина действительно работала: пробег есть и он гружёный', () => {
      expect(loaded.truck.odometer).toBeGreaterThan(0)
      expect(loaded.truck.loadedKm).toBeGreaterThan(0)
      // Инвариант учёта: каждый километр попал ровно в один счёт.
      expect(loaded.truck.loadedKm + loaded.truck.emptyKm).toBeCloseTo(
        loaded.truck.odometer,
        6,
      )
    })

    it('оба прогона проезжают примерно одни и те же километры', () => {
      // Машина одна и та же, кольцо одно и то же, время одно и то же. Вся
      // разница между прогонами обязана лежать в выручке, а не в пробеге.
      // Точного совпадения нет: порожняя машина не ждёт погрузки и успевает
      // чуть больше кругов, — поэтому сравнение с допуском в десятую часть.
      expect(hollow.truck.odometer).toBeGreaterThan(loaded.truck.odometer * 0.9)
    })

    it('кольцо с двумя гружёными плечами кормит компанию', () => {
      // Компания жива и работает — это требование ко ВСЕМ классам.
      expect(loaded.end.companies[PLAYER_ID].bankrupt).toBe(false)
      // И оно заметно лучше кольца с порожним возвратом. Это и есть инвариант,
      // выраженный в деньгах, и он обязан выполняться на любой технике.
      expect(loaded.money).toBeGreaterThan(hollow.money)
    })

    it('стартовый класс окупает себя за месяц, тяжёлый — нет, и так задумано', () => {
      // Абсолютная прибыльность за тридцать суток — требование только к
      // стартовой машине: с неё начинают, и она обязана кормить сразу.
      //
      // Тягач за 165 000 — вложение на длинную дистанцию: он берёт двадцать
      // тонн, но и грузится вдвое дольше, и водителю на нём нужен тот же
      // отдых. За месяц он себя не отбивает, и это не дефект баланса, а его
      // содержание: покупать тяжёлую технику должно быть решением, а не
      // очевидным следующим шагом.
      if (vehicleClass.id === STARTER_CLASS_ID) {
        expect(loaded.money).toBeGreaterThan(START_MONEY)
      }
    })

    it('то же кольцо с одним гружёным плечом уводит компанию в минус', () => {
      // ЭТО И ЕСТЬ ИНВАРИАНТ. Выручка не исчезла — машина по-прежнему возит
      // зерно на завод. Она просто перестала покрывать расходы, которые не
      // изменились ни на рубль.
      expect(hollow.money).toBeLessThan(START_MONEY)
    })

    it('одно гружёное плечо не окупает кольцо, два окупают — по тарифу класса', () => {
      /*
       * ЧИСТАЯ ФОРМУЛИРОВКА ИНВАРИАНТА, без всякой симуляции. Выручка за
       * гружёное плечо спрашивается у ТОЙ ЖЕ функции, которой платят машине в
       * фазе прибытия, а расходы — у справочника техники. Утверждение ровно то,
       * что записано в шапке data/operating.ts:
       *
       *     m·(h + t·L)  <  2·L·c   — одно гружёное плечо убыточно
       *   2·m·(h + t·L)  >  2·L·c   — два гружёных плеча прибыльны
       *
       * Здесь и ловится главная ошибка, которую легко сделать при переходе к
       * классам техники: тариф, оставшийся общим на всю игру. Двадцатитонник с
       * тарифом шеститонника проходит любой прогон в плюсе — и порожний возврат
       * перестаёт его пугать вовсе.
       *
       * ЧТО ИМЕННО ДОЛЖНО БЫТЬ СДЕЛАНО, если этот тест красный на тягаче:
       * deliveryRevenue (sim/economy/finance.ts) обязана брать tariffPerTonKm и
       * handlingPerTon у КЛАССА МАШИНЫ (VEHICLE_CLASS_BY_ID в data/vehicles.ts),
       * а не у общих TARIFF_PER_TON_KM и HANDLING_PER_TON из data/operating.ts;
       * фаза прибытия (sim/logistics/loading.ts) обязана передать ей класс
       * разгружающейся машины. Разбор, почему единым тарифом обойтись
       * невозможно, — в шапке data/vehicles.ts.
       */
      /*
       * ТАРИФ БЕРЁТСЯ У ЭТОГО КЛАССА, а не у стартового, и это не мелочь —
       * это ровно то, о чём говорит абзац выше. Здесь стояли TARIFF и HANDLING
       * стартового ЗИЛа при ЁМКОСТИ проверяемого класса, то есть тест
       * воспроизводил ту самую ошибку, которую взялся ловить: двадцать тонн по
       * тарифу шеститонника. Проходил он при этом по чистому совпадению — с
       * запасом в четыреста рублей из двадцати восьми тысяч, — и первая же
       * правка надбавки за зерно его уронила. Совпадение и было сигналом.
       */
      const legRevenue = deliveryRevenue(
        'зерно',
        vehicleClass.capacity,
        LEG_KM,
        vehicleClass.tariffPerTonKm,
        vehicleClass.handlingPerTon,
      )
      const ringCost = 2 * LEG_KM * costPerKm(vehicleClass)

      expect(legRevenue).toBeLessThan(ringCost)
      expect(2 * legRevenue).toBeGreaterThan(ringCost)
    })

    it('порожний пробег без обратной загрузки подскакивает', () => {
      expect(hollow.emptyShare).toBeGreaterThan(loaded.emptyShare)

      // Гружёное кольцо порожним почти не идёт: только первый выезд из Москвы,
      // когда машина ещё не успела ничего взять.
      expect(loaded.emptyShare).toBeLessThan(0.1)

      /*
       * Верхняя граница — геометрическая половина кольца: обратное плечо ровно
       * такой же длины, как прямое. А вот до неё порожний пробег НЕ ДОТЯГИВАЕТ,
       * и причина поучительна сама по себе. Завод, у которого перестали
       * забирать муку, забивает склад, сбрасывает выпуск и перестаёт принимать
       * зерно; машина увозит непринятый остаток обратно — и эти километры
       * считаются гружёными, хотя пользы от них ноль. Порожний пробег в такой
       * линии не просто высок, он ещё и ЛЬСТИТ: часть провала прячется в
       * тоннах, которые возят по кругу. Именно поэтому знак прибыли, а не
       * метрика порожнего пробега, остаётся главным утверждением теста.
       *
       * Половину порожний пробег всё же чуть-чуть перешагивает, и это не
       * поломка, а арифметика первого выезда: машина стартует из Москвы
       * порожней, поэтому порожних плеч на одно больше, чем гружёных, и доля
       * равна (n+1)/(2n+1). За тридцать суток это добавляет к половине доли
       * процента. Допуск взят с запасом на случай, если кольцо станет длиннее и
       * кругов будет меньше.
       */
      expect(hollow.emptyShare).toBeLessThan(0.55)
    })

    it('изношенная техника дороже в обслуживании, чем новая', () => {
      // Побочный, но обязательный факт прогона: тридцать суток работы оставляют
      // след. Нулевой износ здесь означал бы, что фаза износа не подключена, и
      // весь срез 4 в этой части был бы декорацией.
      expect(loaded.truck.wear).toBeGreaterThan(0)

      const fresh = createVehicle(TRUCK, PLAYER_ID, MOSCOW, vehicleClass.id)
      expect(maintenancePerKm(loaded.truck)).toBeGreaterThan(
        maintenancePerKm(fresh),
      )
    })
  },
)
