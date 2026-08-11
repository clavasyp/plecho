import { describe, expect, it } from 'vitest'

import { BASE_POSTS, BUILDING_SPEC } from '../data/infrastructure'
import { buildBuilding } from '../sim/economy/buildings'
import { wagePerTick } from '../sim/economy/operating'
import { wageFor } from '../sim/logistics/driver'
import { postsAt } from '../sim/logistics/service'
import {
  PLAYER_ID,
  STARTER_DRIVER_SKILL,
  STARTER_TRAILER,
  createVehicle,
  createInitialState,
} from '../sim/state'
import { tick } from '../sim/tick'
import {
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  cityId,
  companyId,
  driverId,
  vehicleId,
} from '../sim/types'
import type {
  CityId,
  Company,
  CompanyId,
  Driver,
  DriverId,
  GameState,
  Vehicle,
  VehicleId,
} from '../sim/types'
import {
  RELIEF_BUILDING,
  bottleneckRows,
  bottleneckSummary,
  cityQueue,
  foreignBuildings,
  ownBuildings,
} from './bottleneckReadout'

/**
 * Панель узких мест обязана считать ДЕНЬГИ, а не тики.
 *
 * Проверяется здесь три вещи, и все три — про доверие к числам на экране.
 *
 *   1. Панель читает ТЕ ЖЕ поля, которые пишет фаза обслуживания. Для этого одна
 *      очередь собирается не руками, а настоящим прогоном тика: разойдись
 *      определение простоя в симуляции и в интерфейсе, и панель показывала бы
 *      пустой список ровно тогда, когда сеть встала.
 *   2. Потеря равна зарплате за время стояния — ровно ей, без выдуманных
 *      надбавок. Ставка берётся у wagePerTick, то есть у той же функции, которой
 *      деньги списываются на самом деле.
 *   3. Оценка окупаемости выводится из BUILDING_SPEC и из очереди, а не из
 *      подобранного числа. Правка цены терминала или его постов обязана
 *      двигать и оценку, и этот тест вместе с ней.
 *
 * ЧИСЛА В ОЖИДАНИЯХ НИГДЕ НЕ ВПИСАНЫ РУКАМИ: цена, содержание и посты приходят
 * из BUILDING_SPEC, ставка простоя — из wagePerTick, число базовых постов — из
 * BASE_POSTS. Тест обязан краснеть при перебалансировке, а не переживать её.
 */

/** Сид фиксирован: прогоны обязаны совпадать между запусками. */
const SEED = 20260810

/** Орёл: элеватор с зерном на складе, то есть машине здесь есть что грузить. */
const LOADING_CITY: CityId = cityId('orel')
/** Тула: мукомольный, второй узел с работой — нужен для проверки сортировки. */
const OTHER_CITY: CityId = cityId('tula')

const TERMINAL = BUILDING_SPEC[RELIEF_BUILDING]

/** Конкурент. Нужен ровно затем, чтобы проверить видимость чужих построек. */
const RIVAL: CompanyId = companyId('rival')

/** Водитель со стартовым навыком и без допусков — ставка считается wageFor. */
function makeDriver(n: number, vehicle: VehicleId | null): Driver {
  return {
    id: driverId(`drv-${n}`),
    name: `Водитель ${n}`,
    employerId: PLAYER_ID,
    vehicleId: vehicle,
    skill: STARTER_DRIVER_SKILL,
    licenses: [],
    fatigue: 0,
    hoursOnDuty: 0,
    wagePerDay: wageFor(STARTER_DRIVER_SKILL, []),
    loyalty: 0.5,
  }
}

/** Одна машина игрока, стоящая в городе, с водителем и тентом. */
function makeVehicle(n: number, at: CityId, driver: DriverId | null): Vehicle {
  return {
    ...createVehicle(
      vehicleId(`truck-${n}`),
      PLAYER_ID,
      at,
      undefined,
      STARTER_TRAILER,
    ),
    driverId: driver,
  }
}

/**
 * Счёт прогона.
 *
 * Заведомо больше самой дорогой постройки справочника: тест меряет ОЦЕНКУ
 * окупаемости, а не стартовый капитал. При START_MONEY игрок не может построить
 * даже терминал, и половина проверок молча превратилась бы в «денег не хватило».
 */
const CASH = Math.max(...Object.values(BUILDING_SPEC).map((it) => it.price)) * 10

/**
 * Мир с указанным парком.
 *
 * Стартовая машина из createInitialState убирается: она стоит в Москве и в
 * очередях не участвует, но своим существованием сдвигала бы порядок ключей
 * парка, от которого зависит разрыв ничьих в очереди.
 */
function world(
  fleet: readonly { at: CityId; queued: number; service: number; driver: boolean }[],
): GameState {
  const base = createInitialState(SEED)

  const vehicles: Record<VehicleId, Vehicle> = {}
  const drivers: Record<DriverId, Driver> = {}

  fleet.forEach((spec, index) => {
    const n = index + 1
    const driver = spec.driver ? makeDriver(n, vehicleId(`truck-${n}`)) : null
    const vehicle: Vehicle = {
      ...makeVehicle(n, spec.at, driver?.id ?? null),
      queuedTicks: spec.queued,
      serviceTicksLeft: spec.service,
    }

    vehicles[vehicle.id] = vehicle
    if (driver !== null) drivers[driver.id] = driver
  })

  const player: Company = {
    ...base.companies[PLAYER_ID],
    money: CASH,
    drivers,
  }

  return { ...base, companies: { ...base.companies, [PLAYER_ID]: player }, vehicles }
}

/** Ставка простоя одного водителя прогона, рубли за тик. */
const WAGE_PER_TICK = wagePerTick(makeDriver(1, null))

// ─── Очередь появляется из настоящего тика ─────────────────────────────────

describe('панель читает те же поля, которые пишет фаза обслуживания', () => {
  it('на старте партии очередей нет, и список пуст', () => {
    // «Если очередей нет — так и скажи» начинается здесь: пустой массив, а не
    // строка с нулями. Одна машина в Москве никуда не встаёт.
    const state = createInitialState(SEED)
    expect(bottleneckRows(state, PLAYER_ID)).toEqual([])
    expect(bottleneckSummary(bottleneckRows(state, PLAYER_ID)).waiting).toBe(0)
  })

  it('две машины у одного завода дают очередь после первого же тика', () => {
    /*
     * ОЧЕРЕДЬ СОБИРАЕТСЯ ПРОГОНОМ, А НЕ РУКАМИ. Это единственная проверка файла,
     * которая доказывает, что панель и симуляция понимают простой ОДИНАКОВО:
     * поля queuedTicks и serviceTicksLeft расставляет runService, а читает их
     * bottleneckRows. Всё остальное здесь можно было бы проверить на выдуманном
     * состоянии, а это — нет.
     */
    const start = world([
      { at: LOADING_CITY, queued: 0, service: 0, driver: true },
      { at: LOADING_CITY, queued: 0, service: 0, driver: true },
    ])

    const after = tick(start)
    const rows = bottleneckRows(after, PLAYER_ID)

    expect(rows).toHaveLength(1)
    expect(rows[0].cityId).toBe(LOADING_CITY)
    expect(rows[0].cityName).toBe(after.world.cities[LOADING_CITY].name)

    // Пост один — базовый, построек нет. Одна машина на нём, вторая ждёт.
    expect(rows[0].posts).toBe(BASE_POSTS)
    expect(rows[0].busy).toBe(BASE_POSTS)
    expect(rows[0].waiting).toBe(1)

    // Машина на посту РАБОТАЕТ и в потери не попадает: тонны идут через рампу,
    // за это и платят.
    expect(rows[0].entries).toHaveLength(1)
    expect(rows[0].entries[0].queuedTicks).toBeGreaterThan(0)
  })

  it('терминал в этом же городе очередь снимает', () => {
    const start = buildBuilding(
      world([
        { at: LOADING_CITY, queued: 0, service: 0, driver: true },
        { at: LOADING_CITY, queued: 0, service: 0, driver: true },
      ]),
      PLAYER_ID,
      LOADING_CITY,
      RELIEF_BUILDING,
    )

    const after = tick(start)

    // Постов стало больше ровно на то, что обещает справочник, и обе машины
    // встали на посты. Проверяется через postsAt, то есть через симуляцию.
    expect(postsAt(after, LOADING_CITY, PLAYER_ID)).toBe(
      BASE_POSTS + TERMINAL.posts,
    )
    expect(bottleneckRows(after, PLAYER_ID)).toEqual([])
  })
})

// ─── Потери в рублях ───────────────────────────────────────────────────────

describe('простой считается зарплатой, уплаченной за стояние', () => {
  const QUEUED_TICKS = TICKS_PER_HOUR * 3

  it('потеря равна ставке водителя за время ожидания', () => {
    const state = world([
      { at: LOADING_CITY, queued: 0, service: 1, driver: true },
      { at: LOADING_CITY, queued: QUEUED_TICKS, service: 0, driver: true },
    ])

    const row = cityQueue(state, PLAYER_ID, LOADING_CITY)

    // Ровно зарплата, без надбавок: топливо и обслуживание в игре начисляются
    // по километрам, а стоящая машина не проезжает ни метра.
    expect(row.lost).toBeCloseTo(WAGE_PER_TICK * QUEUED_TICKS, 9)
    // Ставка простоя — та же зарплата, растянутая на сутки.
    expect(row.lostPerDay).toBeCloseTo(WAGE_PER_TICK * TICKS_PER_DAY, 9)
    expect(row.worstTicks).toBe(QUEUED_TICKS)
  })

  it('машина без водителя видна в очереди, но зарплаты не жжёт', () => {
    const state = world([
      { at: LOADING_CITY, queued: QUEUED_TICKS, service: 0, driver: false },
    ])

    const row = cityQueue(state, PLAYER_ID, LOADING_CITY)

    // Место в очереди она занимает — игрок должен видеть, кто держит пост.
    expect(row.waiting).toBe(1)
    expect(row.entries[0].driverName).toBeNull()
    // А платить за её стояние некому: зарплата — единственная статья, идущая по
    // времени, и у машины без водителя её нет.
    expect(row.lost).toBe(0)
    expect(row.lostPerDay).toBe(0)
  })

  it('города сортируются по деньгам, а не по алфавиту', () => {
    /*
     * «Орёл» стоит в алфавите раньше «Тулы», и очередь в нём ДЛИННЕЕ по числу
     * машин — но короче по времени. Дороже обходится Тула, и она обязана быть
     * первой: панель отвечает на вопрос «куда бежать первым делом».
     */
    const state = world([
      { at: LOADING_CITY, queued: 1, service: 0, driver: true },
      { at: LOADING_CITY, queued: 1, service: 0, driver: true },
      { at: OTHER_CITY, queued: 10, service: 0, driver: true },
    ])

    const rows = bottleneckRows(state, PLAYER_ID)

    expect(rows.map((row) => row.cityId)).toEqual([OTHER_CITY, LOADING_CITY])
    expect(rows[0].lost).toBeGreaterThan(rows[1].lost)

    const summary = bottleneckSummary(rows)
    expect(summary.cities).toBe(2)
    expect(summary.waiting).toBe(3)
    expect(summary.lost).toBeCloseTo(rows[0].lost + rows[1].lost, 9)
  })

  it('очередь показана в порядке обслуживания: кто дольше ждёт, тот первый', () => {
    // Тот же порядок, по которому посты раздаёт runService. Разойдись он — и
    // оценка окупаемости обещала бы расшить не тех, кого расшьёт на самом деле.
    const state = world([
      { at: LOADING_CITY, queued: 2, service: 0, driver: true },
      { at: LOADING_CITY, queued: 9, service: 0, driver: true },
      { at: LOADING_CITY, queued: 5, service: 0, driver: true },
    ])

    const row = cityQueue(state, PLAYER_ID, LOADING_CITY)
    expect(row.entries.map((entry) => entry.queuedTicks)).toEqual([9, 5, 2])
  })
})

// ─── Окупаемость ───────────────────────────────────────────────────────────

describe('окупаемость выводится из справочника и из очереди', () => {
  /** Очередь ровно на все посты терминала: он расшивает её целиком. */
  const FULL_QUEUE = TERMINAL.posts

  function offerFor(state: GameState, city: CityId, type = RELIEF_BUILDING) {
    const row = cityQueue(state, PLAYER_ID, city)
    const offer = row.offers.find((candidate) => candidate.type === type)
    expect(offer).toBeDefined()
    return offer!
  }

  it('терминал расшивает не больше машин, чем у него постов', () => {
    const many = world(
      Array.from({ length: FULL_QUEUE + 2 }, () => ({
        at: LOADING_CITY,
        queued: 4,
        service: 0,
        driver: true,
      })),
    )

    expect(offerFor(many, LOADING_CITY).relieved).toBe(TERMINAL.posts)

    // И не больше, чем стоит в очереди: три поста при одной ждущей машине
    // спасают одну зарплату, а не три.
    const one = world([
      { at: LOADING_CITY, queued: 4, service: 0, driver: true },
    ])
    expect(offerFor(one, LOADING_CITY).relieved).toBe(1)
  })

  it('срок окупаемости — цена, делённая на чистый выигрыш в сутки', () => {
    const state = world(
      Array.from({ length: FULL_QUEUE }, () => ({
        at: LOADING_CITY,
        queued: 4,
        service: 0,
        driver: true,
      })),
    )

    const offer = offerFor(state, LOADING_CITY)
    const saved = FULL_QUEUE * WAGE_PER_TICK * TICKS_PER_DAY

    expect(offer.price).toBe(TERMINAL.price)
    expect(offer.upkeepPerDay).toBe(TERMINAL.upkeepPerDay)
    expect(offer.savedPerDay).toBeCloseTo(saved, 9)
    expect(offer.netPerDay).toBeCloseTo(saved - TERMINAL.upkeepPerDay, 9)

    // Содержание обязано вычитаться: без него любая постройка «окупалась» бы, и
    // строительство перестало бы быть решением.
    expect(offer.netPerDay).toBeLessThan(offer.savedPerDay)
    expect(offer.paybackDays).toBeCloseTo(
      TERMINAL.price / (saved - TERMINAL.upkeepPerDay),
      6,
    )
    expect(offer.verdict).toContain('окупится')
  })

  it('в городе без очереди терминал не окупается и говорит об этом', () => {
    const state = world([
      { at: LOADING_CITY, queued: 0, service: 0, driver: true },
    ])

    const offer = offerFor(state, OTHER_CITY)

    expect(offer.relieved).toBe(0)
    expect(offer.savedPerDay).toBe(0)
    expect(offer.netPerDay).toBe(-TERMINAL.upkeepPerDay)
    expect(offer.paybackDays).toBeNull()
    expect(offer.verdict).toContain('очереди здесь нет')
    // И при этом кнопка остаётся доступной: строить впрок игрок вправе.
    expect(offer.available).toBe(true)
  })

  it('короткая очередь не окупает содержание, и это отдельная фраза', () => {
    /*
     * Разные формулировки для «очереди нет» и «очередь есть, но короткая» — не
     * придирка к словам: в первом случае строить не надо вовсе, во втором стоит
     * подождать, пока сеть подрастёт. Одна фраза на оба случая не советует
     * ничего.
     *
     * Одна ждущая машина экономит одну зарплату; окупится она или нет, решает
     * соотношение ставки водителя и содержания терминала, поэтому проверяется
     * именно ветка, а не знак.
     */
    const state = world([
      { at: LOADING_CITY, queued: 4, service: 0, driver: true },
    ])

    const offer = offerFor(state, LOADING_CITY)
    const wagePerDay = WAGE_PER_TICK * TICKS_PER_DAY

    if (wagePerDay > TERMINAL.upkeepPerDay) {
      expect(offer.paybackDays).not.toBeNull()
    } else {
      expect(offer.paybackDays).toBeNull()
      expect(offer.verdict).toContain('не окупается')
    }
  })

  it('уже построенное не предлагается второй раз', () => {
    const state = buildBuilding(
      world([{ at: LOADING_CITY, queued: 4, service: 0, driver: true }]),
      PLAYER_ID,
      LOADING_CITY,
      RELIEF_BUILDING,
    )

    const offer = offerFor(state, LOADING_CITY)
    expect(offer.built).toBe(true)
    expect(offer.available).toBe(false)
    expect(offer.reason).toBe('уже построен')
  })

  it('без денег кнопка гаснет, но цена остаётся на виду', () => {
    const poor = world([])
    const state: GameState = {
      ...poor,
      companies: {
        ...poor.companies,
        [PLAYER_ID]: { ...poor.companies[PLAYER_ID], money: 0 },
      },
    }

    const offer = offerFor(state, LOADING_CITY)
    expect(offer.affordable).toBe(false)
    expect(offer.available).toBe(false)
    // Копить невозможно на то, чего не видно: цена обязана остаться в строке, а
    // причина — назвать недостающую сумму, а не «нельзя».
    expect(offer.price).toBe(TERMINAL.price)
    expect(offer.reason).toContain('не хватает')
  })
})

// ─── Постройки города ──────────────────────────────────────────────────────

describe('постройки в городе: свои и чужие', () => {
  it('своя постройка отдаёт посты, вместимость и содержание', () => {
    const state = buildBuilding(
      world([]),
      PLAYER_ID,
      LOADING_CITY,
      RELIEF_BUILDING,
    )

    const mine = ownBuildings(state, PLAYER_ID, LOADING_CITY)
    expect(mine).toHaveLength(1)
    expect(mine[0].type).toBe(RELIEF_BUILDING)
    expect(mine[0].posts).toBe(TERMINAL.posts)
    expect(mine[0].storage).toBe(TERMINAL.storage)
    expect(mine[0].upkeepPerDay).toBe(TERMINAL.upkeepPerDay)
    // Склад пустой: всё, что на нём окажется, привезёт машина игрока.
    expect(mine[0].stored).toBe(0)
    expect(mine[0].cargo).toEqual([])
  })

  it('чужая постройка видна в чужом списке и не попадает в свой', () => {
    const base = world([])
    const rival: Company = {
      ...base.companies[PLAYER_ID],
      id: RIVAL,
      name: 'ТОО «Конкурент»',
      buildings: {},
    }

    const state = buildBuilding(
      { ...base, companies: { ...base.companies, [RIVAL]: rival } },
      RIVAL,
      LOADING_CITY,
      'хаб',
    )

    expect(ownBuildings(state, PLAYER_ID, LOADING_CITY)).toEqual([])

    const theirs = foreignBuildings(state, PLAYER_ID, LOADING_CITY)
    expect(theirs).toHaveLength(1)
    expect(theirs[0].ownerName).toBe(rival.name)
    expect(theirs[0].type).toBe('хаб')

    // И главное: чужой хаб не добавил игроку ни одного поста.
    expect(postsAt(state, LOADING_CITY, PLAYER_ID)).toBe(BASE_POSTS)
    expect(cityQueue(state, PLAYER_ID, LOADING_CITY).posts).toBe(BASE_POSTS)
  })

  it('чужая очередь в свою не попадает', () => {
    // Посты считаются по компаниям (см. logistics/service.ts), поэтому машины
    // конкурента очередь игрока не удлиняют — и в его панели им не место.
    const base = world([])
    const foreign: Vehicle = {
      ...makeVehicle(9, LOADING_CITY, null),
      ownerId: RIVAL,
      queuedTicks: 10,
    }

    const state: GameState = {
      ...base,
      companies: {
        ...base.companies,
        [RIVAL]: { ...base.companies[PLAYER_ID], id: RIVAL, name: 'Чужие' },
      },
      vehicles: { ...base.vehicles, [foreign.id]: foreign },
    }

    expect(bottleneckRows(state, PLAYER_ID)).toEqual([])
    expect(bottleneckRows(state, RIVAL)).toHaveLength(1)
  })
})

// ─── Чистота ───────────────────────────────────────────────────────────────

describe('разбор ничего не меняет', () => {
  it('состояние на входе остаётся тем же до последнего вложенного поля', () => {
    const state = world([
      { at: LOADING_CITY, queued: 3, service: 0, driver: true },
      { at: OTHER_CITY, queued: 0, service: 2, driver: true },
    ])
    const before = JSON.stringify(state)

    bottleneckRows(state, PLAYER_ID)
    cityQueue(state, PLAYER_ID, LOADING_CITY)
    ownBuildings(state, PLAYER_ID, LOADING_CITY)
    foreignBuildings(state, PLAYER_ID, LOADING_CITY)

    expect(JSON.stringify(state)).toBe(before)
  })
})

describe('непринятый груз — не очередь', () => {
  /**
   * САМЫЙ ДОРОГОЙ ВИД ВРАНЬЯ, КОТОРЫЙ ПАНЕЛЬ УМЕЛА. Машина, которой некуда сдать
   * груз, стоит так же неподвижно, как машина в очереди на рампу, и зарплата у
   * неё горит так же. Но лечится это по-разному: очередь расшивается терминалом,
   * а полный склад получателя — нет, сколько рамп ни построй. Слитые в одно
   * число, они давали правдоподобный совет купить терминал за 90 000 там, где он
   * не изменил бы ничего: в замере 12.9 из 13 процентных пунктов очереди узла
   * были именно мёртвым стоянием.
   */
  it('машина с отказом не попадает в окупаемость терминала', () => {
    const queue = Array.from({ length: BUILDING_SPEC[RELIEF_BUILDING].posts }, () => ({
      at: LOADING_CITY,
      queued: 4,
      service: 0,
      driver: true,
    }))

    const waiting = world(queue)
    const before = cityQueue(waiting, PLAYER_ID, LOADING_CITY)
    const offer = before.offers.find((o) => o.type === RELIEF_BUILDING)
    expect(offer, 'терминал предлагается').toBeDefined()
    expect(offer?.savedPerDay ?? 0, 'и что-то обещает').toBeGreaterThan(0)

    // Тот же узел, но все машины стоят с непринятым грузом.
    const refused: GameState = {
      ...waiting,
      vehicles: Object.fromEntries(
        Object.entries(waiting.vehicles).map(([id, vehicle]) => [
          id,
          { ...vehicle, blockedTicks: 1 },
        ]),
      ) as Record<VehicleId, Vehicle>,
    }

    const after = cityQueue(refused, PLAYER_ID, LOADING_CITY)
    const offerAfter = after.offers.find((o) => o.type === RELIEF_BUILDING)

    // Очередь никуда не делась — машины по-прежнему стоят и жгут зарплату.
    expect(after.entries.length).toBe(before.entries.length)
    expect(after.lostPerDay).toBeCloseTo(before.lostPerDay, 6)
    // А вот обещать за них возврат терминал больше не имеет права.
    expect(offerAfter?.savedPerDay ?? 0).toBe(0)
  })
})
