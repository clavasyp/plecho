import { describe, expect, it } from 'vitest'
import { STARTER_CLASS } from '../state'

/** Тариф стартового класса: тесты писались под ЗИЛ, и он им и остаётся. */
const TARIFF = STARTER_CLASS.tariffPerTonKm
const HANDLING = STARTER_CLASS.handlingPerTon
import { BUILDING_SPEC } from '../../data/infrastructure'
import { CARGO_PREMIUM } from '../../data/recipes'
import { EDGES } from '../../data/roads'
import { VEHICLE_CLASSES, costPerKm } from '../../data/vehicles'
import { HOME_CITY, PLAYER_ID, createInitialState } from '../state'
import { TICKS_PER_DAY, buildingId, cityId, companyId } from '../types'
import type { CargoType, Company, GameState } from '../types'
import { deliveryRevenue } from './finance'
import {
  TRANSSHIPMENT_SHARE,
  acceptToStorage,
  buildBuilding,
  buildingIdFor,
  demolishBuilding,
  extraPosts,
  freeStorageIn,
  releaseFromStorage,
  runUpkeep,
  storedIn,
  transshipmentRevenue,
  upkeepPerTick,
  withStoredAt,
} from './buildings'

/**
 * Постройки: цена, содержание, посты, склад и снос.
 *
 * ВСЕ ОЖИДАНИЯ ВЫВОДЯТСЯ ИЗ КОНСТАНТ — из BUILDING_SPEC, TICKS_PER_DAY и
 * справочника техники, — а не вписаны числами. Перебалансировка цены терминала
 * не должна ронять проверки, в которых не меняется ни одного правила; красный
 * тест обязан означать сломанное правило, а не подвинутое число.
 */

const TULA = cityId('tula')

/** Денег заведомо на любую постройку: стартовый капитал меньше цены терминала. */
const RICH = 1_000_000

function base(): GameState {
  const state = createInitialState(1)
  const company = state.companies[PLAYER_ID]

  return {
    ...state,
    companies: {
      ...state.companies,
      [PLAYER_ID]: { ...company, money: RICH },
    },
  }
}

function player(state: GameState): Company {
  return state.companies[PLAYER_ID]
}

function money(state: GameState): number {
  return player(state).money
}

function buildingsOf(state: GameState): Company['buildings'] {
  return player(state).buildings ?? {}
}

/** Снимок состояния для проверки чистоты: вход не должен измениться ничем. */
function snapshot(state: GameState): string {
  return JSON.stringify(state)
}

// ─── Строительство ─────────────────────────────────────────────────────────

describe('buildBuilding: цена и отказ', () => {
  it('списывает ровно цену из справочника и ставит постройку в городе', () => {
    const before = base()
    const after = buildBuilding(before, PLAYER_ID, TULA, 'терминал')

    expect(money(after)).toBeCloseTo(money(before) - BUILDING_SPEC.терминал.price, 9)

    const built = Object.values(buildingsOf(after))
    expect(built).toHaveLength(1)
    expect(built[0].cityId).toBe(TULA)
    expect(built[0].ownerId).toBe(PLAYER_ID)
    expect(built[0].type).toBe('терминал')
  })

  it('постройка получает посты и вместимость из справочника, а склад пуст', () => {
    for (const type of Object.keys(BUILDING_SPEC) as (keyof typeof BUILDING_SPEC)[]) {
      const after = buildBuilding(base(), PLAYER_ID, TULA, type)
      const built = buildingsOf(after)[buildingIdFor(PLAYER_ID, TULA, type)]

      expect(built.posts).toBe(BUILDING_SPEC[type].posts)
      expect(built.storage).toBe(BUILDING_SPEC[type].storage)
      expect(built.stock).toEqual({})
    }
  })

  it('отказывает, когда денег не хватает ровно рубля', () => {
    const state = base()
    const poor: GameState = {
      ...state,
      companies: {
        ...state.companies,
        [PLAYER_ID]: {
          ...player(state),
          money: BUILDING_SPEC.хаб.price - 1,
        },
      },
    }

    // Отказ возвращает ТО ЖЕ состояние по ссылке: по совпадению ссылок
    // интерфейс отличает состоявшуюся сделку от несостоявшейся.
    expect(buildBuilding(poor, PLAYER_ID, TULA, 'хаб')).toBe(poor)
  })

  it('строит ровно на границе: денег в обрез хватает', () => {
    const state = base()
    const exact: GameState = {
      ...state,
      companies: {
        ...state.companies,
        [PLAYER_ID]: { ...player(state), money: BUILDING_SPEC.хаб.price },
      },
    }

    const after = buildBuilding(exact, PLAYER_ID, TULA, 'хаб')
    expect(after).not.toBe(exact)
    expect(money(after)).toBeCloseTo(0, 9)
  })

  it('идентификатор детерминирован: он выводится из компании, города и типа', () => {
    const once = buildBuilding(base(), PLAYER_ID, TULA, 'склад')
    const twice = buildBuilding(base(), PLAYER_ID, TULA, 'склад')

    expect(Object.keys(buildingsOf(once))).toEqual(Object.keys(buildingsOf(twice)))
    expect(buildingsOf(once)[buildingIdFor(PLAYER_ID, TULA, 'склад')]).toBeDefined()
  })

  it('второй постройки того же типа в том же городе не бывает', () => {
    const one = buildBuilding(base(), PLAYER_ID, TULA, 'терминал')
    const two = buildBuilding(one, PLAYER_ID, TULA, 'терминал')

    // Правило держится формой ключа: тот же ключ — то же место, место занято.
    expect(two).toBe(one)
    expect(Object.keys(buildingsOf(one))).toHaveLength(1)
    expect(money(two)).toBe(money(one))
  })

  it('разные типы в одном городе и тот же тип в другом — можно', () => {
    let state = base()
    state = buildBuilding(state, PLAYER_ID, TULA, 'терминал')
    state = buildBuilding(state, PLAYER_ID, TULA, 'склад')
    state = buildBuilding(state, PLAYER_ID, HOME_CITY, 'терминал')

    expect(Object.keys(buildingsOf(state))).toHaveLength(3)
    expect(money(state)).toBeCloseTo(
      RICH -
        2 * BUILDING_SPEC.терминал.price -
        BUILDING_SPEC.склад.price,
      9,
    )
  })

  it('отказывает в неизвестном городе, неизвестной компании и банкроту', () => {
    const state = base()

    expect(buildBuilding(state, PLAYER_ID, cityId('atlantis'), 'склад')).toBe(state)
    expect(buildBuilding(state, companyId('nobody'), TULA, 'склад')).toBe(state)

    const broke: GameState = {
      ...state,
      companies: {
        ...state.companies,
        [PLAYER_ID]: { ...player(state), bankrupt: true },
      },
    }
    expect(buildBuilding(broke, PLAYER_ID, TULA, 'склад')).toBe(broke)
  })

  it('не меняет входное состояние', () => {
    const state = base()
    const before = snapshot(state)

    buildBuilding(state, PLAYER_ID, TULA, 'хаб')

    expect(snapshot(state)).toBe(before)
  })
})

// ─── Посты ─────────────────────────────────────────────────────────────────

describe('extraPosts: терминал расшивает СВОЙ город', () => {
  it('добавляет посты в своём городе и ничего — в чужом', () => {
    const state = buildBuilding(base(), PLAYER_ID, TULA, 'терминал')
    const company = player(state)

    expect(extraPosts(company, TULA)).toBe(BUILDING_SPEC.терминал.posts)
    // Вот ради этой строки постройки и привязаны к городу: пропускная
    // способность местная, и расшить сеть целиком одной покупкой нельзя.
    expect(extraPosts(company, HOME_CITY)).toBe(0)
  })

  it('постройки в одном городе складываются', () => {
    let state = base()
    state = buildBuilding(state, PLAYER_ID, TULA, 'терминал')
    state = buildBuilding(state, PLAYER_ID, TULA, 'хаб')

    expect(extraPosts(player(state), TULA)).toBe(
      BUILDING_SPEC.терминал.posts + BUILDING_SPEC.хаб.posts,
    )
  })

  it('у компании без построек постов не прибавляется', () => {
    expect(extraPosts(player(base()), TULA)).toBe(0)
  })
})

// ─── Содержание ────────────────────────────────────────────────────────────

describe('runUpkeep: содержание начисляется посуточно', () => {
  it('за игровые сутки списывается ровно суточная ставка', () => {
    const built = buildBuilding(base(), PLAYER_ID, TULA, 'терминал')

    let state = built
    for (let i = 0; i < TICKS_PER_DAY; i++) {
      state = runUpkeep(state)
    }

    expect(money(built) - money(state)).toBeCloseTo(
      BUILDING_SPEC.терминал.upkeepPerDay,
      6,
    )
  })

  it('ставки построек складываются', () => {
    let state = base()
    state = buildBuilding(state, PLAYER_ID, TULA, 'склад')
    state = buildBuilding(state, PLAYER_ID, HOME_CITY, 'хаб')

    expect(upkeepPerTick(player(state))).toBeCloseTo(
      (BUILDING_SPEC.склад.upkeepPerDay + BUILDING_SPEC.хаб.upkeepPerDay) /
        TICKS_PER_DAY,
      9,
    )
  })

  it('содержание попадает в суточный поток расходов, а не только в счёт', () => {
    // Затухание окна — забота economy/operating.ts, она применяется один раз за
    // тик и только там. Здесь проверяется сам факт стыковки: расход, не
    // попавший в dailyCosts, не виден игроку нигде, а деньги при этом уходят.
    const built = buildBuilding(base(), PLAYER_ID, TULA, 'склад')
    const after = runUpkeep(built)

    const bill = BUILDING_SPEC.склад.upkeepPerDay / TICKS_PER_DAY
    expect(player(after).dailyCosts - player(built).dailyCosts).toBeCloseTo(bill, 9)
    expect(money(built) - money(after)).toBeCloseTo(bill, 9)
  })

  it('компании без построек фаза не касается вовсе', () => {
    const state = base()
    expect(runUpkeep(state)).toBe(state)
  })

  it('банкрот не платит: партия для него окончена', () => {
    const built = buildBuilding(base(), PLAYER_ID, TULA, 'хаб')
    const broke: GameState = {
      ...built,
      companies: {
        ...built.companies,
        [PLAYER_ID]: { ...player(built), bankrupt: true },
      },
    }

    expect(runUpkeep(broke)).toBe(broke)
  })

  it('не меняет входное состояние', () => {
    const state = buildBuilding(base(), PLAYER_ID, TULA, 'хаб')
    const before = snapshot(state)

    runUpkeep(state)

    expect(snapshot(state)).toBe(before)
  })
})

// ─── Склад ─────────────────────────────────────────────────────────────────

describe('склад принимает и отдаёт груз в пределах вместимости', () => {
  const CAPACITY = BUILDING_SPEC.склад.storage
  const HALF = CAPACITY / 2

  function depot(): GameState {
    return buildBuilding(base(), PLAYER_ID, TULA, 'склад')
  }

  it('принимает, пока есть место, и отказывает в остатке', () => {
    const state = depot()

    const first = acceptToStorage(player(state), TULA, 'зерно', HALF)
    expect(first.accepted).toBeCloseTo(HALF, 9)
    expect(storedIn(first.company, TULA, 'зерно')).toBeCloseTo(HALF, 9)
    expect(freeStorageIn(first.company, TULA)).toBeCloseTo(CAPACITY - HALF, 9)

    // Просим вдвое больше, чем осталось места: принимается ровно остаток, а
    // непринятое едет дальше — как и с полным складом предприятия.
    const second = acceptToStorage(first.company, TULA, 'зерно', CAPACITY)
    expect(second.accepted).toBeCloseTo(CAPACITY - HALF, 9)
    expect(storedIn(second.company, TULA, 'зерно')).toBeCloseTo(CAPACITY, 9)
    expect(freeStorageIn(second.company, TULA)).toBe(0)
  })

  it('вместимость ОБЩАЯ на все грузы, а не своя у каждого', () => {
    const state = depot()
    const full = acceptToStorage(player(state), TULA, 'зерно', CAPACITY)

    // Хранилище, забитое зерном, не примет муку. Отсюда и растёт решение
    // «подо что держать склад» — иначе он был бы бездонным по каждому грузу.
    const flour = acceptToStorage(full.company, TULA, 'мука', 1)
    expect(flour.accepted).toBe(0)
    expect(flour.company).toBe(full.company)
  })

  it('отдаёт не больше, чем лежит', () => {
    const state = depot()
    const stored = acceptToStorage(player(state), TULA, 'зерно', HALF)

    const taken = releaseFromStorage(stored.company, TULA, 'зерно', CAPACITY)
    expect(taken.released).toBeCloseTo(HALF, 9)
    expect(storedIn(taken.company, TULA, 'зерно')).toBe(0)
    expect(freeStorageIn(taken.company, TULA)).toBeCloseTo(CAPACITY, 9)

    // Пустой склад ничего не отдаёт и не подменяет запись компании.
    const again = releaseFromStorage(taken.company, TULA, 'зерно', 1)
    expect(again.released).toBe(0)
    expect(again.company).toBe(taken.company)
  })

  it('отдаёт частями: машина берёт сколько влезет и уезжает', () => {
    const state = depot()
    const stored = acceptToStorage(player(state), TULA, 'зерно', CAPACITY)

    const taken = releaseFromStorage(stored.company, TULA, 'зерно', 6)
    expect(taken.released).toBeCloseTo(6, 9)
    expect(storedIn(taken.company, TULA, 'зерно')).toBeCloseTo(CAPACITY - 6, 9)
  })

  it('терминал ничего не хранит, а чужой город ничего не принимает', () => {
    const term = buildBuilding(base(), PLAYER_ID, TULA, 'терминал')
    const toTerminal = acceptToStorage(player(term), TULA, 'зерно', 1)
    expect(toTerminal.accepted).toBe(0)
    expect(toTerminal.company).toBe(player(term))

    const elsewhere = acceptToStorage(player(depot()), HOME_CITY, 'зерно', 1)
    expect(elsewhere.accepted).toBe(0)
  })

  it('withStoredAt не даёт ни переполнить постройку, ни увести остаток в минус', () => {
    const id = buildingIdFor(PLAYER_ID, TULA, 'склад')
    const company = player(depot())

    // Тонны — единственная величина, которая обязана сходиться, поэтому
    // ошибка вызывающего обрезается, а не проходит насквозь.
    const overfilled = withStoredAt(company, id, 'зерно', CAPACITY * 10)
    expect(storedIn(overfilled, TULA, 'зерно')).toBeCloseTo(CAPACITY, 9)

    const drained = withStoredAt(overfilled, id, 'зерно', -CAPACITY * 10)
    expect(storedIn(drained, TULA, 'зерно')).toBe(0)

    // Пустое действие не подменяет запись компании.
    expect(withStoredAt(company, id, 'зерно', 0)).toBe(company)
    expect(withStoredAt(company, id, 'зерно', -1)).toBe(company)
    expect(withStoredAt(company, buildingId('нет-такого'), 'зерно', 1)).toBe(company)
  })

  it('не меняет входную компанию ни на одном уровне вложенности', () => {
    const company = player(depot())
    const before = JSON.stringify(company)

    const stored = acceptToStorage(company, TULA, 'зерно', HALF)
    releaseFromStorage(stored.company, TULA, 'зерно', 1)
    withStoredAt(company, buildingIdFor(PLAYER_ID, TULA, 'склад'), 'мука', 5)

    expect(JSON.stringify(company)).toBe(before)
    expect(storedIn(company, TULA, 'зерно')).toBe(0)
  })
})

// ─── Снос ──────────────────────────────────────────────────────────────────

describe('demolishBuilding: груз пропадает, деньги не возвращаются', () => {
  const CAPACITY = BUILDING_SPEC.склад.storage
  const ID = buildingIdFor(PLAYER_ID, TULA, 'склад')

  function loadedDepot(): GameState {
    const state = buildBuilding(base(), PLAYER_ID, TULA, 'склад')
    const stored = acceptToStorage(player(state), TULA, 'зерно', CAPACITY)

    return {
      ...state,
      companies: { ...state.companies, [PLAYER_ID]: stored.company },
    }
  }

  it('убирает постройку и её посты', () => {
    const state = loadedDepot()
    const after = demolishBuilding(state, ID)

    expect(buildingsOf(after)[ID]).toBeUndefined()
    expect(extraPosts(player(after), TULA)).toBe(0)
  })

  it('груз списывается: он не уходит ни в город, ни в деньги', () => {
    const state = loadedDepot()
    const after = demolishBuilding(state, ID)

    expect(storedIn(player(after), TULA, 'зерно')).toBe(0)
    // Высыпать содержимое в город значило бы, что снос — способ доставки:
    // городской склад кормит население, и снабжать его бесплатно нельзя.
    // Продать груз на месте — завести второго покупателя без перевозки.
    expect(JSON.stringify(after.world)).toBe(JSON.stringify(state.world))
    expect(money(after)).toBe(money(state))
  })

  it('после сноса содержание больше не начисляется', () => {
    const state = loadedDepot()
    expect(upkeepPerTick(player(state))).toBeGreaterThan(0)

    const after = demolishBuilding(state, ID)
    expect(upkeepPerTick(player(after))).toBe(0)
    expect(runUpkeep(after)).toBe(after)
  })

  it('снесённое место освобождается: там можно построить заново, заплатив ещё раз', () => {
    const state = demolishBuilding(loadedDepot(), ID)
    const rebuilt = buildBuilding(state, PLAYER_ID, TULA, 'склад')

    expect(buildingsOf(rebuilt)[ID]).toBeDefined()
    expect(money(rebuilt)).toBeCloseTo(money(state) - BUILDING_SPEC.склад.price, 9)
    // Заново — значит пустым: старые тонны не воскресают.
    expect(storedIn(player(rebuilt), TULA, 'зерно')).toBe(0)
  })

  it('неизвестный идентификатор оставляет состояние тем же', () => {
    const state = loadedDepot()
    expect(demolishBuilding(state, buildingId('нет-такого'))).toBe(state)
  })

  it('не меняет входное состояние', () => {
    const state = loadedDepot()
    const before = snapshot(state)

    demolishBuilding(state, ID)

    expect(snapshot(state)).toBe(before)
  })
})

// ─── Перевалка и главный инвариант ─────────────────────────────────────────

describe('TRANSSHIPMENT_SHARE выведен из главного инварианта', () => {
  /*
   * Груз, сданный на склад, можно оттуда забрать. Значит два склада образуют
   * кольцо, по которому одни и те же тонны ездят вечно, ничего не потребляя. При
   * полной оплате такого плеча это вечный двигатель: два гружёных плеча кольца
   * прибыльны по инварианту. Половинная оплата сводит перевалочное кольцо ровно
   * к «кольцу с одним гружёным плечом», а оно инвариантом объявлено убыточным.
   *
   * Проверка идёт по КЛАССАМ ТЕХНИКИ и по САМОМУ ДОРОГОМУ грузу при САМЫХ
   * ДЕШЁВЫХ расходах — то есть в наиболее выгодных для двигателя условиях, какие
   * в игре бывают. Так же устроен коридор инварианта в tick.invariant.test.ts.
   */
  const maxPremium = Math.max(...Object.values(CARGO_PREMIUM))
  const SHORT_KM = Math.min(...EDGES.map((e) => e.km))
  const LONG_KM = Math.max(...EDGES.map((e) => e.km))

  /** Выручка за гружёное плечо по тарифу КЛАССА — формула инварианта. */
  function legRevenue(
    vc: (typeof VEHICLE_CLASSES)[number],
    km: number,
    premium: number,
  ): number {
    return vc.capacity * (vc.handlingPerTon + vc.tariffPerTonKm * km) * premium
  }

  it('перевалочное кольцо приносит ровно столько же, сколько ОДНО гружёное плечо', () => {
    /*
     * ГЛАВНОЕ УТВЕРЖДЕНИЕ ПРО КОНСТАНТУ, и оно не про числа, а про сведение
     * одного случая к другому. Кольцо «склад → склад → склад» состоит из двух
     * гружёных плеч, каждое оплачено долей TRANSSHIPMENT_SHARE. При доле в
     * половину выручка такого кольца равна выручке кольца с ОДНИМ гружёным
     * плечом — а оно объявлено убыточным главным инвариантом игры. Значит вечный
     * двигатель на двух складах закрыт тем же неравенством, которым проверяется
     * вся экономика, и отдельной ручки баланса не завелось.
     */
    for (const vc of VEHICLE_CLASSES) {
      const leg = legRevenue(vc, LONG_KM, maxPremium)
      expect(2 * TRANSSHIPMENT_SHARE * leg).toBeCloseTo(leg, 9)
    }
  })

  it('доля не больше половины: выше — двигатель оживает', () => {
    expect(TRANSSHIPMENT_SHARE).toBeLessThanOrEqual(0.5)
    expect(TRANSSHIPMENT_SHARE).toBeGreaterThan(0)
  })

  for (const vc of VEHICLE_CLASSES) {
    for (const km of [SHORT_KM, LONG_KM]) {
      it(`${vc.name}: кольцо «склад → склад» на ${km} км убыточно`, () => {
        /*
         * Расходы берутся ПАСПОРТНЫЕ (costPerKm из справочника техники) — на той
         * же основе, на которой выведен сам инвариант в шапке data/operating.ts,
         * включая порог короткого плеча в 80.8 км против самого короткого ребра
         * карты. Считать здесь расходы по самому экономичному водителю было бы
         * строже, но проверяло бы уже не эту константу: скидка за навык двигает
         * порог короткого плеча к 122 км, то есть на 110-километровом ребре
         * ломает БАЗОВЫЙ инвариант, а не перевалку. Это отдельный вопрос к
         * балансу, и решать его подкруткой доли перевалки нельзя.
         */
        const ringRevenue = 2 * TRANSSHIPMENT_SHARE * legRevenue(vc, km, maxPremium)
        expect(ringRevenue).toBeLessThan(2 * km * costPerKm(vc))
      })
    }
  }

  it('проверка не холостая: честное кольцо с двумя плечами прибыльно', () => {
    // Страховка. Если бы расходы были заданы с потолка, «убыточно» доказывалось
    // бы само собой для чего угодно, и проверки выше ничего не значили бы.
    for (const vc of VEHICLE_CLASSES) {
      const minPremium = Math.min(...Object.values(CARGO_PREMIUM))
      const honest = 2 * legRevenue(vc, LONG_KM, minPremium)
      expect(honest).toBeGreaterThan(2 * LONG_KM * costPerKm(vc))
    }
  })

  it('transshipmentRevenue — это доля от общей формулы тарифа, а не своя', () => {
    const full = deliveryRevenue('мука', 6, LONG_KM, TARIFF, HANDLING)
    expect(transshipmentRevenue('мука', 6, LONG_KM, TARIFF, HANDLING)).toBeCloseTo(
      full * TRANSSHIPMENT_SHARE,
      9,
    )
    // Битые входы гасятся там же, где и у прямой доставки.
    expect(transshipmentRevenue('зерно', 6, 0, TARIFF, HANDLING)).toBe(0)
    expect(transshipmentRevenue('зерно', Number.NaN, 100, TARIFF, HANDLING)).toBe(0)
  })

  it('перевалка всегда даёт меньше денег, чем прямая доставка', () => {
    const cargo: CargoType = 'зерно'
    const tons = 6

    // Плечо, разрезанное складом надвое, против того же плеча одним рейсом.
    // Разница в пользу прямого рейса — ½·m·p·(t·L₁ − h), и она положительна,
    // пока плечо до склада длиннее h/t ≈ 21 км. Самое короткое ребро карты — 110.
    const split =
      transshipmentRevenue(cargo, tons, SHORT_KM, TARIFF, HANDLING) +
      deliveryRevenue(cargo, tons, LONG_KM, TARIFF, HANDLING)
    const direct = deliveryRevenue(cargo, tons, SHORT_KM + LONG_KM, TARIFF, HANDLING)

    expect(split).toBeLessThan(direct)
  })
})
