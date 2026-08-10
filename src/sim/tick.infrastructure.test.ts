import { describe, expect, it } from 'vitest'
import {
  BASE_POSTS,
  BUILDING_SPEC,
  TONS_PER_POST_HOUR,
} from '../data/infrastructure'
import { CONSUMPTION_PER_1K, RECIPE_BY_INDUSTRY } from '../data/recipes'
import { VEHICLE_CLASS_BY_ID } from '../data/vehicles'
import { buildBuilding } from './economy/buildings'
import { CARGO_LICENSE, wageFor } from './logistics/driver'
import { postsAt, serviceTicksFor } from './logistics/service'
import { canCarry } from './logistics/trailer'
import { needsService, repairVehicle, serviceVehicle } from './logistics/wear'
import {
  createInitialState,
  createVehicle,
  PLAYER_ID,
  STARTER_DRIVER_SKILL,
} from './state'
import { HOURS_PER_TICK, tick } from './tick'
import {
  TICKS_PER_DAY,
  cityId,
  driverId,
  industryId,
  lineId,
  vehicleId,
} from './types'
import type {
  CargoType,
  City,
  CityId,
  Driver,
  DriverId,
  GameState,
  Industry,
  IndustryId,
  Line,
  LineId,
  Stop,
  Vehicle,
  VehicleId,
} from './types'
import { buildGraph } from './world/graph'
import { shortestKm } from './world/pathfind'
import { speedKmh } from './world/speed'

/**
 * ГЛАВНЫЙ ТЕСТ СРЕЗА 5: у СЕТИ ПОЯВИЛАСЬ ПРОПУСКНАЯ СПОСОБНОСТЬ.
 *
 * До этого среза погрузка была мгновенной, а значит бесплатной: десятая машина
 * на линии стоила ровно столько же, сколько первая, и правильным ответом на
 * любую задачу игры было «купить ещё грузовик». Здесь проверяется, что ответ
 * перестал работать: с какого-то момента добавленная машина не привозит своей
 * доли, потому что упирается в пост, — и расшивается это не покупкой машины, а
 * ТЕРМИНАЛОМ.
 *
 * ─── ГДЕ ИМЕННО ЛОМАЕТСЯ ЛИНЕЙНОСТЬ, И ПОЧЕМУ НЕ НА ВТОРОЙ МАШИНЕ ──────────
 *
 * Соблазнительно проверять это на двух машинах — «вторая на том же заводе
 * встаёт в очередь». На ОДИНОЧНОМ КОЛЬЦЕ это неверно, и разбор стоит того,
 * чтобы его записать: он объясняет, чего игра на самом деле требует от игрока.
 *
 * Пусть в кольце k обслуживаемых остановок, на каждой машина стоит S тиков, а
 * весь объезд занимает D тиков хода. Круг одной машины — k·S + D. Каждая машина
 * заходит на каждую остановку ровно раз за круг, поэтому пост в узле занят
 *
 *     N · S / (k·S + D)
 *
 * долей времени, и очередь появляется, когда эта доля переваливает за единицу:
 *
 *     N  >  k + D/S
 *
 * При k = 2 порог всегда СТРОГО больше двух, сколько бы ни длилась погрузка.
 * Две машины на кольце из двух остановок расходятся по его концам сами:
 * выдержка интервала (departureGapKm в logistics/line.ts) разводит их ровно на
 * половину кольца, то есть по разным узлам, и мешать друг другу им негде.
 *
 * Это не поблажка, а содержательное свойство модели: пропускная способность
 * узла — ПОТОЛОК, а не налог. Пока сеть под ним, она честно масштабируется
 * покупкой машин; как только упёрлась, покупка перестаёт работать вовсе. Игрок
 * обязан почувствовать стену, а не медленное удорожание каждой машины.
 *
 * Поэтому парк, на котором проверяется главное утверждение, ВЫВОДИТСЯ из
 * формулы выше, а не выбирается на глаз: правка TONS_PER_POST_HOUR или скоростей
 * подвинет порог, и тест подвинется вместе с ним.
 *
 * ─── ПОЧЕМУ КОЛЬЦО ИМЕННО ТАКОЕ ───────────────────────────────────────────
 *
 * ТЯЖЁЛАЯ МАШИНА И САМОЕ КОРОТКОЕ ПЛЕЧО КАРТЫ. Порог N > k + D/S тем ниже, чем
 * больше S относительно D, — то есть на тяжёлой технике и коротком плече.
 * Двадцать тонн грузятся втрое дольше шести (TONS_PER_POST_HOUR в
 * data/infrastructure.ts), а Тула — Калуга это 110 км, самое короткое ребро в
 * data/roads.ts. На этой паре перевалка ДОЛЬШЕ езды, и узкое место видно на
 * трёх машинах, а не на двадцати. Заодно это ровно тот урок, ради которого
 * посты и вводились: тяжёлая техника не бесплатно лучше — везёт втрое больше, но
 * и стоит под погрузкой втрое дольше.
 *
 * ГРУЗЫ ПОТРЕБИТЕЛЬСКИЕ, А НЕ СЫРЬЁ, и это принципиально для измерения. Склад
 * завода вмещает трое суток его выпуска и опустошается только собственным
 * производством; сеть, привозящая больше, забивает его за сутки, и дальше
 * добавленная машина не везёт ничего — независимо от всяких очередей. Город же
 * ест непрерывно, и его аппетит задаётся населением, то есть одним числом,
 * которое учебный мир вправе назначить сам. Мука и пиломатериалы выбраны ещё и
 * потому, что оба возит ОДИН тент: иначе кольцо потребовало бы двух разных
 * прицепов на одной машине.
 *
 * МИР УЧЕБНЫЙ, как и в tick.invariant.test.ts, и по той же причине: настоящая
 * расстановка предприятий проверяется своими тестами, а здесь проверяется
 * ПРОПУСКНАЯ СПОСОБНОСТЬ. Мир нарочно сделан заведомо щедрым — бездонные склады
 * отправителей и города-миллионники, — чтобы упереться сеть могла ТОЛЬКО в пост.
 * Что мир и правда не мешал, проверяется отдельным тестом.
 */

const NEAR = cityId('tula')
const FAR = cityId('kaluga')
const RING: LineId = lineId('ring')

/** Сид фиксирован: прогоны обязаны совпадать между запусками. */
const SEED = 20260810

/** Тридцать суток — тот же горизонт, что и у теста инварианта. */
const DAYS = 30

/**
 * Класс машины прогона — самый тяжёлый в справочнике.
 *
 * Выбирается не по имени, а по грузоподъёмности: появится в справочнике машина
 * крупнее — тест возьмёт её, потому что именно на ней пост становится узким
 * местом раньше всего.
 */
const HEAVY = Object.values(VEHICLE_CLASS_BY_ID).reduce((best, vehicleClass) =>
  vehicleClass.capacity > best.capacity ? vehicleClass : best,
)

/** Тент — единственный прицеп, который берёт оба груза кольца. */
const TRAILER = 'тент' as const

/** Что везут в одну и в другую сторону. */
const THERE: CargoType = 'пиломатериалы'
const BACK: CargoType = 'мука'

const WORLD = createInitialState(SEED)
const GRAPH = buildGraph(WORLD.world.edges)
const LEG_KM = shortestKm(GRAPH, NEAR, FAR)

/** Ребро кольца — по нему считается время хода. */
const LEG_EDGE = Object.values(WORLD.world.edges).find(
  (edge) =>
    (edge.from === NEAR && edge.to === FAR) ||
    (edge.from === FAR && edge.to === NEAR),
)!

/**
 * Тиков хода на одно плечо.
 *
 * Скорость спрашивается у той же единственной формулы, по которой едет игра
 * (world/speed.ts). Переписать её здесь значило бы завести вторую копию — ровно
 * ту ошибку, из-за которой когда-то маршрут строился по одному расписанию, а
 * проезжался по другому.
 */
const LEG_TICKS = LEG_KM / speedKmh(HEAVY.cruiseKmh, LEG_EDGE) / HOURS_PER_TICK

/**
 * Тиков под погрузкой на одной остановке кольца.
 *
 * На каждой остановке машина и сдаёт полный кузов, и берёт полный: оба потока
 * идут через один пост, поэтому тоннаж двойной.
 */
const SERVICE_TICKS = serviceTicksFor(2 * HEAVY.capacity)

/** Обслуживаемых остановок в кольце. */
const STOPS_COUNT = 2

/**
 * Наименьший парк, при котором пост становится узким местом.
 *
 * Ровно формула из шапки: N > k + D/S, где D — ход по всему кольцу.
 */
const QUEUE_FLEET =
  Math.floor(STOPS_COUNT + (STOPS_COUNT * LEG_TICKS) / SERVICE_TICKS) + 1

/** Парк на единицу меньше порога: сеть его ещё держит без очереди. */
const FREE_FLEET = QUEUE_FLEET - 1

// ─── Учебный мир ───────────────────────────────────────────────────────────

/**
 * Запас, который в учебном мире не кончается.
 *
 * Склады отправителей набиты заведомо, и это не «подгонка ради зелёного теста»,
 * а единственный способ измерить ИМЕННО пост. Погрузка берёт партию у ОДНОГО
 * предприятия (findPickup в logistics/loading.ts не собирает кузов из двух
 * складов), поэтому подсохший отправитель отдаёт неполную ходку — и добавленная
 * машина возит меньше тонн независимо от всяких очередей. Отличить одну причину
 * от другой по итогам прогона невозможно, поэтому вторая устраняется физически.
 */
const ENDLESS_TONS = 1_000_000

/**
 * Пиковый поток сети в одну сторону, тонн в сутки.
 *
 * Считается по кругу без единой минуты очереди: круг это k·(S + D) тиков, за
 * него каждая машина отдаёт один кузов. Величина нужна только затем, чтобы
 * назначить размеры городов с запасом.
 */
const PEAK_TONS_PER_DAY =
  ((QUEUE_FLEET * HEAVY.capacity) /
    (STOPS_COUNT * (LEG_TICKS + SERVICE_TICKS))) *
  TICKS_PER_DAY

/**
 * Население, при котором город съедает втрое больше груза, чем сеть способна
 * привезти.
 *
 * Мегаполис выходит неправдоподобный, и это осознанно: норма потребления в игре
 * крошечная (полтора килограмма муки на человека в сутки, CONSUMPTION_PER_1K),
 * поэтому обычный город насыщается раньше, чем упирается пост, — и прогон
 * измерял бы аппетит, а не пропускную способность. Тройной запас берётся ещё и
 * потому, что склад города вмещает ровно тридцать суток потребления
 * (CITY_STOCK_DAYS в logistics/loading.ts): маленький город не смог бы принять и
 * одной ходки тягача.
 */
function populationFor(cargo: CargoType): number {
  return Math.ceil(
    (3 * PEAK_TONS_PER_DAY * 1000) / (CONSUMPTION_PER_1K[cargo] ?? 1),
  )
}

/**
 * Два отправителя, по одному в каждом конце кольца.
 *
 * ЦБК в ближнем городе отгружает пиломатериалы, мукомольный в дальнем — муку.
 * Входного сырья им не подвозят и не нужно: склад набит заведомо, производство
 * всё равно остановлено переполнением, а тест меряет перевалку, а не цепочку.
 */
function industries(): Record<IndustryId, Industry> {
  const list: Industry[] = [
    {
      id: industryId('mill-far'),
      type: 'мукомольный',
      cityId: FAR,
      stock: { [RECIPE_BY_INDUSTRY['мукомольный'].output]: ENDLESS_TONS },
      utilization: 0,
      idleTicks: 0,
    },
    {
      id: industryId('pulp-near'),
      type: 'ЦБК',
      cityId: NEAR,
      stock: { [RECIPE_BY_INDUSTRY['ЦБК'].output]: ENDLESS_TONS },
      utilization: 0,
      idleTicks: 0,
    },
  ]

  return Object.fromEntries(list.map((it) => [it.id, it])) as Record<
    IndustryId,
    Industry
  >
}

/** Кольцо с двумя гружёными плечами: пиломатериалы туда, мука обратно. */
const STOPS: Stop[] = [
  { nodeId: NEAR, unload: [BACK], load: [THERE] },
  { nodeId: FAR, unload: [THERE], load: [BACK] },
]

/**
 * Стартовый капитал прогона.
 *
 * Заведомо больше любых расходов и любых построек: тест меряет ПРИРОСТ счёта, а
 * банкротство посреди прогона превратило бы измерение в шум.
 */
const START_CASH = 10_000_000

/** Мир с указанным парком на кольце и терминалами в указанных городах. */
function world(fleet: number, terminals: readonly CityId[] = []): GameState {
  const base = createInitialState(SEED)

  const vehicles: Record<VehicleId, Vehicle> = {}
  const drivers: Record<DriverId, Driver> = {}
  const ids: VehicleId[] = []

  for (let i = 0; i < fleet; i++) {
    const truck = vehicleId(`truck-${String.fromCharCode(97 + i)}`)
    const driver = driverId(`drv-${String.fromCharCode(97 + i)}`)
    ids.push(truck)

    vehicles[truck] = {
      ...createVehicle(truck, PLAYER_ID, NEAR, HEAVY.id, TRAILER),
      driverId: driver,
      lineId: RING,
      stopIndex: 0,
    }
    drivers[driver] = {
      id: driver,
      name: `Водитель ${i + 1}`,
      employerId: PLAYER_ID,
      vehicleId: truck,
      skill: STARTER_DRIVER_SKILL,
      licenses: [],
      fatigue: 0,
      hoursOnDuty: 0,
      wagePerDay: wageFor(STARTER_DRIVER_SKILL, []),
      loyalty: 0.5,
    }
  }

  const line: Line = {
    id: RING,
    name: 'Кольцо',
    stops: STOPS,
    assignedVehicles: ids,
  }

  const near: City = {
    ...base.world.cities[NEAR],
    population: populationFor(BACK),
  }
  const far: City = {
    ...base.world.cities[FAR],
    population: populationFor(THERE),
  }

  let state: GameState = {
    ...base,
    world: {
      ...base.world,
      cities: { ...base.world.cities, [NEAR]: near, [FAR]: far },
      industries: industries(),
    },
    companies: {
      ...base.companies,
      [PLAYER_ID]: {
        ...base.companies[PLAYER_ID],
        money: START_CASH,
        lines: { [RING]: line },
        drivers,
      },
    },
    vehicles,
  }

  for (const city of terminals) {
    state = buildBuilding(state, PLAYER_ID, city, 'терминал')
  }

  return state
}

/** Итог прогона: конечное состояние и доставленные тонны. */
type Outcome = {
  end: GameState
  /** Тонн сдано получателям за весь прогон. */
  tons: number
}

/**
 * Прогон с хозяйским отношением к технике и с подсчётом доставленного.
 *
 * ПОЧЕМУ ТОННЫ, А НЕ ГРУЖЁНЫЙ ПРОБЕГ. Гружёный километр говорит только о том,
 * что в кузове что-то было, — а машина с двумя тоннами в двадцатитонном
 * полуприцепе накручивает его ровно так же, как полная. Сеть, упёршаяся в
 * пропускную способность, начинает возить НЕПОЛНЫЕ кузова, и по километрам это
 * выглядит как рост. Считать надо то, за что платят.
 *
 * Тонны берутся разностью груза машины между тиками: уменьшился кузов — значит
 * сдали. Отдельного счётчика в GameState нет, и заводить его ради теста нельзя:
 * это была бы диагностика, уехавшая в сохранение.
 *
 * Поломка чинится в тот же тик, подошедшее ТО проводится — так же, как в
 * tick.invariant.test.ts. Иначе прогон измерял бы везение в розыгрыше отказа:
 * поломка на первый день и поломка на тридцатый дают разный результат при
 * одинаковой пропускной способности.
 */
function run(state: GameState, days: number): Outcome {
  let next = state
  let tons = 0

  for (let i = 0; i < days * TICKS_PER_DAY; i++) {
    const before = next
    next = tick(next)

    for (const id of Object.keys(next.vehicles) as VehicleId[]) {
      const was = before.vehicles[id]?.cargo
      if (was === undefined || was === null || was.tons <= 0) continue

      const now = next.vehicles[id].cargo
      // Груз исчез или сменился — сдали всё, что было. Уменьшился — сдали
      // разницу: получатель принял не весь кузов, остаток поехал дальше.
      if (now === null || now.type !== was.type) tons += was.tons
      else if (now.tons < was.tons) tons += was.tons - now.tons
    }

    for (const id of Object.keys(next.vehicles) as VehicleId[]) {
      if (next.vehicles[id].brokenDown) next = repairVehicle(next, id)
      if (needsService(next.vehicles[id])) next = serviceVehicle(next, id)
    }
  }

  return { end: next, tons }
}

const cash = (state: GameState): number => state.companies[PLAYER_ID].money

// ─── Предпосылки прогона ───────────────────────────────────────────────────

describe('кольцо выбрано так, что пост может стать узким местом', () => {
  it('плечо взято из графа дорог и оно самое короткое на карте', () => {
    const shortest = Math.min(
      ...Object.values(WORLD.world.edges).map((edge) => edge.km),
    )
    // Короткое плечо — обязательное условие: чем меньше ход, тем большую долю
    // круга занимает перевалка и тем раньше упирается сеть.
    expect(LEG_KM).toBe(shortest)
    expect(LEG_KM).toBeGreaterThan(0)
  })

  it('перевалка на остановке дольше, чем ход по плечу', () => {
    // Ровно то, что делает пост узким местом. На лёгкой машине или длинном
    // плече соотношение обратное, и очередь пришлось бы искать на десятках
    // машин — то есть проверять не то, ради чего срез делался.
    expect(TONS_PER_POST_HOUR).toBeGreaterThan(0)
    expect(SERVICE_TICKS).toBeGreaterThan(LEG_TICKS)
  })

  it('оба груза кольца возит один тент и ни один не требует допуска', () => {
    // Иначе прогон измерял бы невозможность взять груз, а не пропускную
    // способность.
    expect(canCarry(TRAILER, THERE)).toBe(true)
    expect(canCarry(TRAILER, BACK)).toBe(true)
    expect(HEAVY.trailers).toContain(TRAILER)
    expect(CARGO_LICENSE[THERE]).toBeUndefined()
    expect(CARGO_LICENSE[BACK]).toBeUndefined()
  })

  it('порог парка выведен из формулы, а не выбран на глаз', () => {
    // N > k + D/S. При двух остановках порог всегда строго больше двух, сколько
    // бы ни длилась погрузка, — разбор в шапке файла.
    expect(QUEUE_FLEET).toBeGreaterThan(STOPS_COUNT)
    expect(QUEUE_FLEET * SERVICE_TICKS).toBeGreaterThan(
      STOPS_COUNT * (SERVICE_TICKS + LEG_TICKS),
    )
    // А парк на единицу меньше порога сеть ещё держит.
    expect(FREE_FLEET * SERVICE_TICKS).toBeLessThanOrEqual(
      STOPS_COUNT * (SERVICE_TICKS + LEG_TICKS),
    )
  })

  it('в городе игрока ровно один пост, пока он ничего не построил', () => {
    const state = world(1)
    expect(postsAt(state, NEAR, PLAYER_ID)).toBe(BASE_POSTS)
    expect(postsAt(state, FAR, PLAYER_ID)).toBe(BASE_POSTS)
  })
})

// ─── ГЛАВНЫЙ ТЕСТ СРЕЗА ────────────────────────────────────────────────────

describe('очередь съедает выигрыш от лишней машины, терминал его возвращает', () => {
  const BOTH: readonly CityId[] = [NEAR, FAR]

  const one = run(world(1), DAYS)
  const free = run(world(FREE_FLEET), DAYS)
  const queued = run(world(QUEUE_FLEET), DAYS)
  const relieved = run(world(QUEUE_FLEET, BOTH), DAYS)

  it('пока сеть под потолком, парк масштабируется почти линейно', () => {
    // Выдержка интервала разводит машины по кольцу, и мешать друг другу им
    // негде. Это НЕ поблажка: пропускная способность обязана быть потолком, а
    // не налогом на каждую купленную машину.
    expect(free.tons / one.tons).toBeGreaterThan(FREE_FLEET * 0.9)
  })

  it('машина сверх потолка не привозит своей доли: очередь', () => {
    /*
     * ГЛАВНОЕ УТВЕРЖДЕНИЕ СРЕЗА. До него ответом на любую задачу было «купить
     * ещё грузовик»; теперь купленная машина возвращает заметно меньше своей
     * доли, и никакая следующая покупка этого не чинит — очередь только
     * удлинится.
     */
    expect(queued.tons / one.tons).toBeLessThan(QUEUE_FLEET * 0.9)
    // Но и не ноль: сеть всё-таки везёт больше, чем без этой машины.
    expect(queued.tons).toBeGreaterThan(free.tons)
  })

  it('терминал возвращает линейность', () => {
    // Тот же парк, то же кольцо, тот же мир — разница только в постах. Значит
    // всё, что сеть теряла, она теряла на очереди.
    expect(relieved.tons / one.tons).toBeGreaterThan(QUEUE_FLEET * 0.9)
    expect(relieved.tons).toBeGreaterThan(queued.tons)
  })

  it('терминал добавил именно посты', () => {
    expect(postsAt(relieved.end, NEAR, PLAYER_ID)).toBe(
      BASE_POSTS + BUILDING_SPEC['терминал'].posts,
    )
    expect(postsAt(relieved.end, FAR, PLAYER_ID)).toBe(
      BASE_POSTS + BUILDING_SPEC['терминал'].posts,
    )
  })

  it('мир не был узким местом: мерили посты, а не мир', () => {
    /*
     * САМАЯ ВАЖНАЯ ПРОВЕРКА ФАЙЛА ПОСЛЕ ГЛАВНОЙ. Кольцо упирается не только в
     * пост: кончится груз у отправителя или наестся город — и прогон покажет ту
     * же картину «лишняя машина не везёт», не имея к постам никакого отношения.
     * Проверяется на самом интенсивном из прогонов — с терминалами.
     */
    for (const industry of Object.values(relieved.end.world.industries)) {
      const output = RECIPE_BY_INDUSTRY[industry.type].output
      // Отгружать было что до последнего тика.
      expect(industry.stock[output] ?? 0, industry.id).toBeGreaterThan(0)
    }

    for (const [city, cargo] of [
      [NEAR, BACK],
      [FAR, THERE],
    ] as const) {
      const target = relieved.end.world.cities[city]
      const consumedPerDay =
        (CONSUMPTION_PER_1K[cargo] ?? 0) * (target.population / 1000)
      // Город ел быстрее, чем ему возили: на складе меньше, чем он съедает за
      // десять суток, то есть принять он мог всегда.
      expect(target.stock[cargo] ?? 0, city).toBeLessThan(consumedPerDay * 10)
    }
  })
})

// ─── Окупаемость ───────────────────────────────────────────────────────────

describe('терминал окупается там, где очередь, и проедает прибыль там, где её нет', () => {
  const BOTH: readonly CityId[] = [NEAR, FAR]

  const queuedPlain = run(world(QUEUE_FLEET), DAYS)
  const queuedTerminal = run(world(QUEUE_FLEET, BOTH), DAYS)
  const freePlain = run(world(FREE_FLEET), DAYS)
  const freeTerminal = run(world(FREE_FLEET, BOTH), DAYS)

  it('сравниваются прибыльные линии, а не убыточные', () => {
    // Иначе «терминал окупается» означало бы всего лишь «убыток стал меньше».
    expect(cash(queuedPlain.end)).toBeGreaterThan(START_CASH)
    expect(cash(freePlain.end)).toBeGreaterThan(START_CASH)
  })

  it('там, где очередь есть, терминал окупается', () => {
    // Он стоит денег дважды — единовременно и каждые сутки содержания, — и всё
    // равно выходит в плюс: расшитая очередь возвращает в работу машину,
    // которая уже куплена и которой уже платят зарплату.
    expect(cash(queuedTerminal.end)).toBeGreaterThan(cash(queuedPlain.end))
  })

  it('там, где очереди нет, терминал только проедает прибыль', () => {
    /*
     * РАДИ ЭТОГО В ИГРЕ И ЕСТЬ СОДЕРЖАНИЕ. Без него правильной стратегией было
     * бы застроить всю карту, как только появятся деньги, и никакого решения не
     * осталось бы. С ним игрок обязан отвечать не «где ещё построить», а «где
     * узкое место и стоит ли оно девятисот рублей в сутки».
     */
    expect(cash(freeTerminal.end)).toBeLessThan(cash(freePlain.end))
    // И расшивать было нечего: тонн не прибавилось.
    expect(freeTerminal.tons).toBeLessThan(freePlain.tons * 1.02)
  })

  it('содержание списывается каждый тик и видно в суточном потоке', () => {
    const bare = run(world(1), 1)
    const built = run(world(1, [NEAR]), 1)

    // Постройка не бывает бесплатной ни одного дня. Расход виден и на счету, и
    // в суточном потоке — единственном числе, по которому игрок судит о сети.
    expect(cash(built.end)).toBeLessThan(cash(bare.end))
    expect(built.end.companies[PLAYER_ID].dailyCosts).toBeGreaterThan(
      bare.end.companies[PLAYER_ID].dailyCosts,
    )
  })
})

// ─── Сохранение ────────────────────────────────────────────────────────────

describe('инфраструктура переживает сохранение и загрузку', () => {
  it('постройки восстанавливаются точь-в-точь вместе с постами', () => {
    const middle = run(world(QUEUE_FLEET, [NEAR, FAR]), 3).end
    const loaded = JSON.parse(JSON.stringify(middle)) as GameState

    expect(loaded).not.toBe(middle)
    expect(loaded).toEqual(middle)

    // Постройки — первое, что игрок в этом срезе строит САМ, и потерять их при
    // загрузке значит потерять партию.
    const yards = loaded.companies[PLAYER_ID].buildings
    expect(Object.keys(yards)).toHaveLength(2)
    for (const [key, building] of Object.entries(yards)) {
      expect(building.id).toBe(key)
      expect(building.ownerId).toBe(PLAYER_ID)
      expect(building.posts).toBe(BUILDING_SPEC['терминал'].posts)
    }
    expect(postsAt(loaded, NEAR, PLAYER_ID)).toBe(
      postsAt(middle, NEAR, PLAYER_ID),
    )
  })

  it('загруженная партия продолжается тик в тик так же, как незагруженная', () => {
    const middle = run(world(QUEUE_FLEET, [NEAR]), 3).end
    const loaded = JSON.parse(JSON.stringify(middle)) as GameState

    // Иначе баг «после загрузки поехало иначе» не воспроизводится ничем: ни
    // очередь, ни простой под погрузкой заново не вычислить — они и ЕСТЬ
    // состояние.
    expect(JSON.stringify(run(loaded, 1).end)).toBe(
      JSON.stringify(run(middle, 1).end),
    )
  })

  it('машина под погрузкой остаётся под погрузкой после загрузки', () => {
    // Ищем момент, когда кто-то стоит на посту: без этого проверка выше могла
    // бы пройти на состоянии, где все счётчики нулевые.
    let state = world(QUEUE_FLEET)
    let busy: Vehicle | undefined

    for (let i = 0; i < TICKS_PER_DAY && busy === undefined; i++) {
      state = tick(state)
      busy = Object.values(state.vehicles).find(
        (vehicle) => vehicle.serviceTicksLeft > 0,
      )
    }

    expect(busy).toBeDefined()

    const loaded = JSON.parse(JSON.stringify(state)) as GameState
    expect(loaded.vehicles[busy!.id].serviceTicksLeft).toBe(
      busy!.serviceTicksLeft,
    )
  })

  it('очередь тоже переживает загрузку', () => {
    let state = world(QUEUE_FLEET)
    let waiting: Vehicle | undefined

    for (let i = 0; i < TICKS_PER_DAY * 3 && waiting === undefined; i++) {
      state = tick(state)
      waiting = Object.values(state.vehicles).find(
        (vehicle) => vehicle.queuedTicks > 0,
      )
    }

    // Очередь на пороговом парке обязана появиться — иначе весь файл проверяет
    // не то, что заявляет.
    expect(waiting).toBeDefined()

    const loaded = JSON.parse(JSON.stringify(state)) as GameState
    expect(loaded.vehicles[waiting!.id].queuedTicks).toBe(waiting!.queuedTicks)
  })
})
