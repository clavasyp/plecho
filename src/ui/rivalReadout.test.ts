import { describe, expect, it } from 'vitest'

import { BUILDING_SPEC } from '../data/infrastructure'
import { TRAILER_PRICE, VEHICLE_CLASS_BY_ID } from '../data/vehicles'
import { buildBuilding } from '../sim/economy/buildings'
import {
  COMPETITORS,
  HOME_CITY,
  PLAYER_ID,
  START_MONEY,
  STARTER_CLASS_ID,
  STARTER_TRAILER,
  createInitialState,
  createVehicle,
} from '../sim/state'
import { THINKING_LIMIT } from '../sim/tick'
import { dateFromTick, formatDate, formatTime } from '../sim/time'
import { cityId, lineId, vehicleId } from '../sim/types'
import type {
  CargoType,
  CityId,
  Company,
  CompanyId,
  GameState,
  LineId,
  Stop,
  Thought,
  Vehicle,
  VehicleId,
} from '../sim/types'
import {
  buildingsValue,
  networkOf,
  rivalRows,
  rivalSummary,
  thoughtFeed,
  vehicleValue,
} from './rivalReadout'

/**
 * Панель соперников обязана быть ЧЕСТНОЙ в двух разных смыслах, и тест держит
 * оба.
 *
 *   1. ЧЕСТНОСТЬ ПЕРЕД ПРАВИЛАМИ ИГРЫ. Чужой остаток на счету игроку не виден.
 *      Это решение записано в rivalReadout.ts словами, но словами оно и
 *      останется: подставить в разметку company.money — одна строка, и никакой
 *      компилятор её не остановит. Останавливает первый тест ниже.
 *
 *   2. ЧЕСТНОСТЬ ПЕРЕД ИГРОКОМ. Пометка «думала модель» или «думал скрипт»
 *      обязана ехать с каждой записью ленты по отдельности и переживать
 *      разворот ленты. Перепутанный порядок и потерянный флаг глазом не
 *      ловятся: обе версии выглядят одинаково правдоподобно.
 *
 * ЧИСЛА В ОЖИДАНИЯХ НИГДЕ НЕ ВПИСАНЫ РУКАМИ. Цена техники приходит из
 * VEHICLE_CLASS_BY_ID, прицепа — из TRAILER_PRICE, постройки — из
 * BUILDING_SPEC, длина ленты — из THINKING_LIMIT, стартовые деньги — из
 * START_MONEY. Перебалансировка обязана двигать и панель, и этот тест вместе с
 * ней; тест с вписанной двадцаткой тысяч просто начал бы врать.
 */

const ZIL_PRICE = VEHICLE_CLASS_BY_ID[STARTER_CLASS_ID].price
const STARTER_TRAILER_PRICE = TRAILER_PRICE[STARTER_TRAILER]
/** Стартовая машина — ЗИЛ с тентом: и тягач, и кузов уже куплены. */
const STARTER_VALUE = ZIL_PRICE + STARTER_TRAILER_PRICE

const RIVAL_ID: CompanyId = COMPETITORS[0].id

/**
 * Денег на постройку. Стартового капитала на терминал не хватает (это и есть
 * решение среза 5), а тесту нужен факт постройки, а не проверка кассы.
 */
function funded(state: GameState, id: CompanyId): GameState {
  return withCompany(state, id, (company) => ({
    ...company,
    money: BUILDING_SPEC['хаб'].price * 2,
  }))
}

/** Заменить компанию в снимке, ничего не мутируя, — как это делает симуляция. */
function withCompany(
  state: GameState,
  id: CompanyId,
  patch: (company: Company) => Company,
): GameState {
  return {
    ...state,
    companies: { ...state.companies, [id]: patch(state.companies[id]) },
  }
}

/** Положить машину в мир. */
function withVehicle(state: GameState, vehicle: Vehicle): GameState {
  return { ...state, vehicles: { ...state.vehicles, [vehicle.id]: vehicle } }
}

/** Проставить машине пробег — фазы движения тут не нужно. */
function driven(vehicle: Vehicle, loadedKm: number, emptyKm: number): Vehicle {
  return { ...vehicle, loadedKm, emptyKm }
}

function thought(tick: number, text: string, fromModel: boolean): Thought {
  return { tick, text, fromModel }
}

function stop(city: string, load: CargoType[] = []): Stop {
  return { nodeId: cityId(city), unload: [], load }
}

describe('чужие деньги', () => {
  it('не попадают в строку конкурента', () => {
    const state = createInitialState(1)
    const rows = rivalRows(state)

    for (const row of rows) {
      if (row.isPlayer) continue
      expect(row.money).toBeNull()
    }
  })

  it('не попадают туда и после того, как конкурент разбогател', () => {
    // Богатство меняет ВСЁ, что видно снаружи, и не меняет видимости счёта.
    const rich = withCompany(createInitialState(1), RIVAL_ID, (company) => ({
      ...company,
      money: START_MONEY * 1000,
    }))

    const row = rivalRows(rich).find((candidate) => candidate.id === RIVAL_ID)
    expect(row?.money).toBeNull()
  })

  it('у игрока показываются как есть — это его собственный счёт', () => {
    const rows = rivalRows(createInitialState(1))
    const player = rows.find((row) => row.isPlayer)

    expect(player?.id).toBe(PLAYER_ID)
    expect(player?.money).toBe(START_MONEY)
  })

  it('заменены вложением, и оно считается по прайсу справочника', () => {
    const state = createInitialState(1)
    const row = rivalRows(state).find((candidate) => candidate.id === RIVAL_ID)

    // На старте у каждой конторы ровно одна машина и ни одной постройки.
    expect(row?.fleet).toBe(1)
    expect(row?.invested).toBe(STARTER_VALUE)
  })

  it('вложение растёт на цену постройки, а не на выдуманную величину', () => {
    const state = funded(createInitialState(1), RIVAL_ID)
    const before = rivalRows(state).find((row) => row.id === RIVAL_ID)?.invested

    const built = buildBuilding(state, RIVAL_ID, HOME_CITY, 'терминал')
    const after = rivalRows(built).find((row) => row.id === RIVAL_ID)?.invested

    expect(after).toBe((before ?? 0) + BUILDING_SPEC['терминал'].price)
  })

  it('вложение считает и тягач, и прицеп, и постройки', () => {
    const state = createInitialState(1)
    const company = state.companies[RIVAL_ID]

    const bare = createVehicle(
      vehicleId('bare'),
      RIVAL_ID,
      HOME_CITY,
      STARTER_CLASS_ID,
      null,
    )
    const withTank = createVehicle(
      vehicleId('tank'),
      RIVAL_ID,
      HOME_CITY,
      STARTER_CLASS_ID,
      'цистерна',
    )

    expect(vehicleValue(bare)).toBe(ZIL_PRICE)
    expect(vehicleValue(withTank)).toBe(ZIL_PRICE + TRAILER_PRICE['цистерна'])
    // Пустая контора без бетона стоит ноль — а не «немного на всякий случай».
    expect(buildingsValue(company)).toBe(0)
  })
})

describe('доля рынка', () => {
  it('считается по гружёным километрам и делится на всех, включая игрока', () => {
    let state = createInitialState(1)

    // Игрок наездил вдвое больше гружёного, чем конкурент; порожний пробег в
    // долю не входит вовсе — иначе катание порожняком поднимало бы «долю
    // рынка», то есть метрика поощряла бы ровно то, что игра осуждает.
    state = withVehicle(
      state,
      driven(
        createVehicle(vehicleId('p-2'), PLAYER_ID, HOME_CITY),
        200,
        1000,
      ),
    )
    state = withVehicle(
      state,
      driven(createVehicle(vehicleId('r-2'), RIVAL_ID, HOME_CITY), 100, 0),
    )

    const rows = rivalRows(state)
    const player = rows.find((row) => row.isPlayer)
    const rival = rows.find((row) => row.id === RIVAL_ID)

    expect(player?.share).toBeCloseTo(200 / 300, 10)
    expect(rival?.share).toBeCloseTo(100 / 300, 10)
  })

  it('в первые сутки не выдумывает нулей: никто ещё не вёз', () => {
    const rows = rivalRows(createInitialState(1))
    for (const row of rows) {
      expect(row.share).toBeNull()
      expect(row.empty).toBeNull()
    }
  })

  it('порядок строк — по возящему, а не по алфавиту', () => {
    let state = createInitialState(1)
    state = withVehicle(
      state,
      driven(createVehicle(vehicleId('r-2'), RIVAL_ID, HOME_CITY), 500, 0),
    )

    expect(rivalRows(state)[0].id).toBe(RIVAL_ID)
  })

  it('кнопка загорается, только когда соперник ОБОШЁЛ игрока', () => {
    const start = createInitialState(1)
    // Равные доли — это старт партии. Загоревшаяся тут кнопка научила бы
    // игрока не смотреть на неё.
    expect(rivalSummary(rivalRows(start)).leader).toBeNull()

    const ahead = withVehicle(
      start,
      driven(createVehicle(vehicleId('r-2'), RIVAL_ID, HOME_CITY), 500, 0),
    )
    const summary = rivalSummary(rivalRows(ahead))

    expect(summary.leader?.id).toBe(RIVAL_ID)
    expect(summary.rivals).toBe(COMPETITORS.length)
    expect(summary.alive).toBe(COMPETITORS.length)
  })
})

describe('лента рассуждений', () => {
  it('идёт свежим вверх и сохраняет пометку источника у каждой записи', () => {
    const state = withCompany(createInitialState(1), RIVAL_ID, (company) => ({
      ...company,
      thinking: [
        thought(0, 'первая', false),
        thought(96, 'вторая', true),
        thought(192, 'третья', false),
      ],
    }))

    const feed = thoughtFeed(state.companies[RIVAL_ID], state.startYear)

    expect(feed.map((entry) => entry.text)).toEqual([
      'третья',
      'вторая',
      'первая',
    ])
    // Флаг едет с текстом, а не с местом в ленте: разворот его не путает.
    expect(feed.map((entry) => entry.fromModel)).toEqual([false, true, false])
  })

  it('печатает игровое время записи, а не номер тика', () => {
    const state = createInitialState(1)
    const tick = 96 * 3 + 5
    const company = {
      ...state.companies[RIVAL_ID],
      thinking: [thought(tick, 'беру зерно', true)],
    }

    const date = dateFromTick(tick, state.startYear)
    const feed = thoughtFeed(company, state.startYear)

    expect(feed[0].when).toBe(`${formatDate(date)}, ${formatTime(date)}`)
    expect(feed[0].tick).toBe(tick)
  })

  it('не режет ленту по-своему: длину держит симуляция', () => {
    const full: Thought[] = Array.from({ length: THINKING_LIMIT }, (_, index) =>
      thought(index * 96, `мысль ${index}`, index % 2 === 0),
    )
    const state = withCompany(createInitialState(1), RIVAL_ID, (company) => ({
      ...company,
      thinking: full,
    }))

    expect(thoughtFeed(state.companies[RIVAL_ID], state.startYear)).toHaveLength(
      THINKING_LIMIT,
    )
  })

  it('считает, сколько записей от модели, а сколько подставил скрипт', () => {
    const state = withCompany(createInitialState(1), RIVAL_ID, (company) => ({
      ...company,
      thinking: [
        thought(0, 'скриптовая', false),
        thought(96, 'модельная', true),
        thought(192, 'ещё модельная', true),
      ],
    }))

    const row = rivalRows(state).find((candidate) => candidate.id === RIVAL_ID)
    expect(row?.thoughts).toBe(3)
    expect(row?.fromModel).toBe(2)
  })

  it('пустая лента — пустой список, а не запись-заглушка', () => {
    const state = createInitialState(1)
    expect(thoughtFeed(state.companies[RIVAL_ID], state.startYear)).toEqual([])
    expect(thoughtFeed(undefined, state.startYear)).toEqual([])
  })

  it('у игрока ленты нет: решения принимает он сам', () => {
    const rows = rivalRows(createInitialState(1))
    const player = rows.find((row) => row.isPlayer)

    expect(player?.thoughts).toBe(0)
    expect(player?.personality).toBeNull()
    expect(player?.controller).toBe('человек')
  })
})

describe('где он работает', () => {
  it('собирает города из колец по порядку обхода и не повторяет их', () => {
    const ring: LineId = lineId('rival-ring')
    const state = withCompany(createInitialState(1), RIVAL_ID, (company) => ({
      ...company,
      lines: {
        [ring]: {
          id: ring,
          name: 'Зерновое кольцо',
          stops: [
            stop('orel', ['зерно']),
            stop('tula', ['мука']),
            // Повтор города в кольце законен: машина может заезжать дважды.
            stop('orel', ['зерно']),
          ],
          assignedVehicles: [],
        },
      },
    }))

    const network = networkOf(state, RIVAL_ID)

    expect(network.lines).toHaveLength(1)
    expect(network.lines[0].cargo).toEqual(['зерно', 'мука'])
    expect(network.cities.map((city) => city.id)).toEqual([
      cityId('orel'),
      cityId('tula'),
    ])
  })

  it('называет города, где у него бетон, даже без остановок', () => {
    const built = buildBuilding(
      funded(createInitialState(1), RIVAL_ID),
      RIVAL_ID,
      HOME_CITY,
      'терминал',
    )
    const network = networkOf(built, RIVAL_ID)

    const home = network.cities.find((city) => city.id === HOME_CITY)
    expect(home?.building).toBe('терминал')
  })

  it('считает машины, назначенные на кольцо', () => {
    const ring: LineId = lineId('rival-ring')
    let state = withCompany(createInitialState(1), RIVAL_ID, (company) => ({
      ...company,
      lines: {
        [ring]: {
          id: ring,
          name: 'Кольцо',
          stops: [stop('moscow'), stop('tula')],
          assignedVehicles: [],
        },
      },
    }))

    const onLine: VehicleId = vehicleId('r-line')
    state = withVehicle(state, {
      ...createVehicle(onLine, RIVAL_ID, HOME_CITY),
      lineId: ring,
    })

    expect(networkOf(state, RIVAL_ID).lines[0].vehicles).toBe(1)
  })

  it('чужая сеть не приписывается конкуренту', () => {
    const ring: LineId = lineId('player-ring')
    const state = withCompany(createInitialState(1), PLAYER_ID, (company) => ({
      ...company,
      lines: {
        [ring]: {
          id: ring,
          name: 'Моё кольцо',
          stops: [stop('moscow'), stop('tula')],
          assignedVehicles: [],
        },
      },
    }))

    expect(networkOf(state, RIVAL_ID).lines).toHaveLength(0)
    expect(networkOf(state, PLAYER_ID).lines).toHaveLength(1)
  })

  it('остановка в неизвестном городе не печатается идентификатором', () => {
    const ring: LineId = lineId('broken')
    const ghost: CityId = cityId('atlantis')
    const state = withCompany(createInitialState(1), RIVAL_ID, (company) => ({
      ...company,
      lines: {
        [ring]: {
          id: ring,
          name: 'Кольцо из чужого сейва',
          stops: [stop('moscow'), { nodeId: ghost, unload: [], load: [] }],
          assignedVehicles: [],
        },
      },
    }))

    const network = networkOf(state, RIVAL_ID)
    expect(network.lines[0].cities.map((city) => city.id)).toEqual([
      cityId('moscow'),
    ])
    expect(network.cities.some((city) => city.id === ghost)).toBe(false)
  })
})

describe('что видно про парк', () => {
  it('стоящие машины считаются: грузовик у обочины виден лучше едущего', () => {
    const state = createInitialState(1)

    const broken: Vehicle = {
      ...createVehicle(vehicleId('r-broken'), RIVAL_ID, HOME_CITY),
      brokenDown: true,
    }
    const driverless: Vehicle = {
      ...createVehicle(vehicleId('r-idle'), RIVAL_ID, HOME_CITY),
      driverId: null,
    }

    const row = rivalRows(
      withVehicle(withVehicle(state, broken), driverless),
    ).find((candidate) => candidate.id === RIVAL_ID)

    // Стартовая машина при деле, две новые — нет.
    expect(row?.fleet).toBe(3)
    expect(row?.stalled).toBe(2)
  })

  it('банкротство названо: это публичный факт, а не подсмотренный', () => {
    const dead = withCompany(createInitialState(1), RIVAL_ID, (company) => ({
      ...company,
      bankrupt: true,
    }))

    const rows = rivalRows(dead)
    expect(rows.find((row) => row.id === RIVAL_ID)?.bankrupt).toBe(true)
    expect(rivalSummary(rows).alive).toBe(COMPETITORS.length - 1)
  })
})
