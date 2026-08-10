import { describe, expect, it } from 'vitest'
import { BUILDING_SPEC } from '../../data/infrastructure'
import { TRAILER_PRICE, VEHICLE_CLASS_BY_ID } from '../../data/vehicles'
import { buildBuilding, buildingIdFor } from '../economy/buildings'
import { MIN_LINE_STOPS } from '../logistics/line'
import {
  COMPETITORS,
  HOME_CITY,
  PLAYER_ID,
  STARTER_CLASS,
  STARTER_DRIVER_ID,
  STARTER_TRAILER,
  STARTER_VEHICLE_ID,
  createInitialState,
  starterDriverIdOf,
  starterVehicleIdOf,
} from '../state'
import { cityId, lineId, vehicleId } from '../types'
import type {
  Command,
  CompanyId,
  DriverId,
  GameState,
  LineId,
  Stop,
  VehicleId,
} from '../types'
import {
  MAX_COMMANDS_PER_TICK,
  MAX_LINE_NAME_LENGTH,
  applyCommand,
  isLegal,
  maxLineStops,
  runCommands,
} from './commands'

/**
 * Слой безопасности всей фичи с конкурентами.
 *
 * ПРЕДМЕТ ЭТОГО ТЕСТА — НЕ «РАБОТАЕТ ЛИ КОМАНДА», А «МОЖНО ЛИ ЕЮ ЖУЛЬНИЧАТЬ».
 * Через applyCommand проходит всё, что делает конкурент под управлением
 * языковой модели, то есть вход сюда приходит из сети и из сохранения, а не из
 * кода. Значит проверять надо не удачный случай, а враждебный: чужая машина,
 * деньги, которых нет, город, которого нет, NaN вместо идентификатора и сто
 * команд за тик.
 *
 * ВСЕ ОЖИДАНИЯ ВЫВОДЯТСЯ ИЗ КОНСТАНТ — из справочника техники, BUILDING_SPEC,
 * MIN_LINE_STOPS и MAX_COMMANDS_PER_TICK, — а не вписаны числами.
 * Перебалансировка цены ЗИЛа не должна ронять проверку, в которой не меняется ни
 * одного правила: красный тест обязан означать сломанное правило, а не
 * подвинутое число.
 */

const SEED = 1

/** Конкурент, от чьего имени идут команды, и его сосед — для проверок «чужое». */
const RIVAL: CompanyId = COMPETITORS[0].id
const NEIGHBOUR: CompanyId = COMPETITORS[1].id

const RIVAL_TRUCK: VehicleId = starterVehicleIdOf(RIVAL)
const RIVAL_DRIVER = starterDriverIdOf(RIVAL)

/**
 * Машина и водитель ИГРОКА. Идентификаторы у него свои, не по схеме
 * конкурентов: партия началась с него, и его ключи в сохранении древнее.
 */
const PLAYER_TRUCK: VehicleId = STARTER_VEHICLE_ID
const PLAYER_DRIVER = STARTER_DRIVER_ID

const TULA = cityId('tula')

/** Денег заведомо на что угодно: дороже всего в игре хаб и тягач. */
const RICH =
  10 *
  (BUILDING_SPEC.хаб.price +
    Math.max(...Object.values(VEHICLE_CLASS_BY_ID).map((vc) => vc.price)))

/** Прицеп, которого на стартовой машине нет, — значит покупка законна. */
const OTHER_TRAILER = STARTER_CLASS.trailers.filter(
  (trailer) => trailer !== STARTER_TRAILER,
)[0]

function base(): GameState {
  return createInitialState(SEED)
}

function withMoney(state: GameState, id: CompanyId, money: number): GameState {
  return {
    ...state,
    companies: {
      ...state.companies,
      [id]: { ...state.companies[id], money },
    },
  }
}

function withQueue(
  state: GameState,
  id: CompanyId,
  pendingCommands: Command[],
): GameState {
  return {
    ...state,
    companies: {
      ...state.companies,
      [id]: { ...state.companies[id], pendingCommands },
    },
  }
}

function money(state: GameState, id: CompanyId): number {
  return state.companies[id].money
}

function linesOf(state: GameState, id: CompanyId) {
  return state.companies[id].lines
}

function stop(city: string): Stop {
  return { nodeId: cityId(city), unload: [], load: [] }
}

/** Кольцо ровно минимальной длины — меньше уже не линия. */
function ring(): Stop[] {
  return [stop('moscow'), stop('tula')]
}

/** Снимок для проверки чистоты: вход не должен измениться ничем. */
function snapshot(state: GameState): string {
  return JSON.stringify(state)
}

/**
 * Одна команда от конкурента поверх состояния.
 *
 * Все проверки идут через applyCommand, а не через runCommands: фаза добавляет
 * к нему только разбор очереди, и мешать эти два предмета в одном тесте значит
 * не понять по красному тесту, что именно сломалось.
 */
function apply(state: GameState, command: unknown): GameState {
  return applyCommand(state, RIVAL, command as Command)
}

function legal(state: GameState, command: unknown): boolean {
  return isLegal(state, RIVAL, command as Command)
}

/** Заведомо законная и заведомо дешёвая команда — ею меряется потолок очереди. */
function buyZil(): Command {
  return { kind: 'купить-машину', classId: STARTER_CLASS.id }
}

function fleetOf(state: GameState, id: CompanyId): VehicleId[] {
  return (Object.keys(state.vehicles) as VehicleId[]).filter(
    (key) => state.vehicles[key].ownerId === id,
  )
}

// ─── Чужое ─────────────────────────────────────────────────────────────────
//
// Первая и главная группа. Конкурент распоряжается СВОИМ хозяйством; всё
// остальное для него не существует, и не существует одинаково — «чужое» и
// «которого нет» обязаны давать один и тот же ответ, иначе по разнице ответов
// можно было бы разведывать чужой парк.

describe('чужое имущество', () => {
  it('прицеп на машину игрока не ставится', () => {
    const state = withMoney(base(), RIVAL, RICH)
    const command: Command = {
      kind: 'купить-прицеп',
      vehicleId: PLAYER_TRUCK,
      trailer: OTHER_TRAILER,
    }

    expect(legal(state, command)).toBe(false)
    expect(apply(state, command)).toBe(state)
  })

  it('чужая машина не назначается на свою линию', () => {
    const withLine = apply(base(), {
      kind: 'создать-линию',
      name: 'кольцо',
      stops: ring(),
    })
    const line = Object.keys(linesOf(withLine, RIVAL))[0] as LineId

    const command: Command = {
      kind: 'назначить-машину',
      vehicleId: PLAYER_TRUCK,
      lineId: line,
    }

    expect(isLegal(withLine, RIVAL, command)).toBe(false)
    expect(applyCommand(withLine, RIVAL, command)).toBe(withLine)
  })

  it('чужая линия не удаляется', () => {
    const state = applyCommand(base(), NEIGHBOUR, {
      kind: 'создать-линию',
      name: 'соседское кольцо',
      stops: ring(),
    })
    const foreign = Object.keys(linesOf(state, NEIGHBOUR))[0] as LineId

    const command: Command = { kind: 'удалить-линию', lineId: foreign }

    expect(isLegal(state, RIVAL, command)).toBe(false)
    expect(applyCommand(state, RIVAL, command)).toBe(state)
    expect(linesOf(state, NEIGHBOUR)[foreign]).toBeDefined()
  })

  it('чужая постройка не сносится', () => {
    const rich = withMoney(base(), NEIGHBOUR, RICH)
    const state = buildBuilding(rich, NEIGHBOUR, TULA, 'склад')
    const foreign = buildingIdFor(NEIGHBOUR, TULA, 'склад')

    const command: Command = { kind: 'снести', buildingId: foreign }

    expect(isLegal(state, RIVAL, command)).toBe(false)
    expect(applyCommand(state, RIVAL, command)).toBe(state)
    expect(state.companies[NEIGHBOUR].buildings[foreign]).toBeDefined()
  })

  it('чужая машина не обслуживается за свой счёт', () => {
    const state = base()
    const worn = {
      ...state,
      vehicles: {
        ...state.vehicles,
        [PLAYER_TRUCK]: { ...state.vehicles[PLAYER_TRUCK], kmSinceService: 500 },
      },
    }
    const command: Command = { kind: 'обслужить', vehicleId: PLAYER_TRUCK }

    expect(isLegal(worn, RIVAL, command)).toBe(false)
    expect(applyCommand(worn, RIVAL, command)).toBe(worn)
  })

  it('свой водитель не садится за чужую машину', () => {
    const state = base()
    const command: Command = {
      kind: 'посадить-водителя',
      driverId: RIVAL_DRIVER,
      vehicleId: PLAYER_TRUCK,
    }

    expect(legal(state, command)).toBe(false)
    expect(apply(state, command)).toBe(state)
  })

  it('чужой водитель не увольняется', () => {
    const state = base()
    const command: Command = {
      kind: 'уволить-водителя',
      driverId: PLAYER_DRIVER,
    }

    expect(legal(state, command)).toBe(false)
    expect(apply(state, command)).toBe(state)
    expect(state.companies[PLAYER_ID].drivers[PLAYER_DRIVER]).toBeDefined()
  })
})

// ─── Деньги ────────────────────────────────────────────────────────────────

describe('деньги и доступность техники', () => {
  const ZIL = STARTER_CLASS

  it('на рубль меньше цены — покупки нет; ровно цена — есть', () => {
    const poor = withMoney(base(), RIVAL, ZIL.price - 1)
    expect(legal(poor, buyZil())).toBe(false)
    expect(apply(poor, buyZil())).toBe(poor)

    const exact = withMoney(base(), RIVAL, ZIL.price)
    const after = apply(exact, buyZil())
    expect(after).not.toBe(exact)
    expect(money(after, RIVAL)).toBe(0)
    expect(fleetOf(after, RIVAL)).toHaveLength(fleetOf(exact, RIVAL).length + 1)
  })

  it('списывается ровно цена из справочника, ни рублём больше', () => {
    const state = withMoney(base(), RIVAL, RICH)
    const after = apply(state, buyZil())

    expect(money(state, RIVAL) - money(after, RIVAL)).toBe(ZIL.price)
  })

  it('приезжает ГОЛЫЙ тягач в общий домашний город', () => {
    const state = withMoney(base(), RIVAL, RICH)
    const after = apply(state, buyZil())

    const bought = fleetOf(after, RIVAL).filter(
      (id) => state.vehicles[id] === undefined,
    )
    expect(bought).toHaveLength(1)

    const truck = after.vehicles[bought[0]]
    // Машина собирается из трёх решений, и покупка только первое из них: ни
    // прицепа, ни водителя, ровно как у игрока.
    expect(truck.trailer).toBeNull()
    expect(truck.driverId).toBeNull()
    expect(truck.position).toEqual({ kind: 'узел', nodeId: HOME_CITY })
    expect(truck.ownerId).toBe(RIVAL)
  })

  it('техника из будущего не продаётся ни за какие деньги', () => {
    const state = withMoney(base(), RIVAL, RICH)
    const future = Object.values(VEHICLE_CLASS_BY_ID).find(
      (vc) => vc.availableFrom > state.startYear,
    )
    expect(future).toBeDefined()

    const command: Command = { kind: 'купить-машину', classId: future!.id }
    expect(legal(state, command)).toBe(false)
    expect(apply(state, command)).toBe(state)
  })

  it('приписанное количество не покупает партию и не возвращает денег', () => {
    const state = withMoney(base(), RIVAL, RICH)
    // Поля count в контракте нет вовсе. Модель, которая его придумала, обязана
    // получить ровно одну машину по полной цене — а не минус три и не возврат.
    const after = apply(state, {
      kind: 'купить-машину',
      classId: ZIL.id,
      count: -3,
    })

    expect(fleetOf(after, RIVAL)).toHaveLength(fleetOf(state, RIVAL).length + 1)
    expect(money(after, RIVAL)).toBe(money(state, RIVAL) - ZIL.price)
  })

  it('прицеп не берётся в долг', () => {
    const price = TRAILER_PRICE[OTHER_TRAILER]
    const command: Command = {
      kind: 'купить-прицеп',
      vehicleId: RIVAL_TRUCK,
      trailer: OTHER_TRAILER,
    }

    const poor = withMoney(base(), RIVAL, price - 1)
    expect(isLegal(poor, RIVAL, command)).toBe(false)

    const exact = withMoney(base(), RIVAL, price)
    const after = applyCommand(exact, RIVAL, command)
    expect(after.vehicles[RIVAL_TRUCK].trailer).toBe(OTHER_TRAILER)
    expect(money(after, RIVAL)).toBe(0)
  })

  it('несовместимый с классом прицеп не ставится', () => {
    const state = withMoney(base(), RIVAL, RICH)
    const alien = Object.keys(TRAILER_PRICE).find(
      (trailer) => !STARTER_CLASS.trailers.includes(trailer as never),
    )
    expect(alien).toBeDefined()

    expect(
      legal(state, {
        kind: 'купить-прицеп',
        vehicleId: RIVAL_TRUCK,
        trailer: alien,
      }),
    ).toBe(false)
  })

  it('тот же прицеп второй раз не оплачивается', () => {
    const state = withMoney(base(), RIVAL, RICH)
    const command: Command = {
      kind: 'купить-прицеп',
      vehicleId: RIVAL_TRUCK,
      trailer: STARTER_TRAILER,
    }

    expect(isLegal(state, RIVAL, command)).toBe(false)
    expect(applyCommand(state, RIVAL, command)).toBe(state)
  })

  it('NaN на счету означает отказ, а не «условие не выполнилось»', () => {
    const broken = withMoney(base(), RIVAL, Number.NaN)

    expect(legal(broken, buyZil())).toBe(false)
    expect(apply(broken, buyZil())).toBe(broken)
  })
})

// ─── Линии ─────────────────────────────────────────────────────────────────

describe('создание линии', () => {
  it('кольцо короче MIN_LINE_STOPS не заводится', () => {
    const state = base()
    const short = ring().slice(0, MIN_LINE_STOPS - 1)

    expect(legal(state, { kind: 'создать-линию', name: 'куцая', stops: [] }))
      .toBe(false)
    expect(
      legal(state, { kind: 'создать-линию', name: 'куцая', stops: short }),
    ).toBe(false)
    expect(
      legal(state, { kind: 'создать-линию', name: 'кольцо', stops: ring() }),
    ).toBe(true)
  })

  it('остановка в несуществующем городе отбрасывает всю линию', () => {
    const state = base()
    const stops = [stop('moscow'), stop('атлантида')]

    expect(legal(state, { kind: 'создать-линию', name: 'мираж', stops })).toBe(
      false,
    )
    expect(apply(state, { kind: 'создать-линию', name: 'мираж', stops })).toBe(
      state,
    )
  })

  it('остановок не больше, чем городов на карте', () => {
    const state = base()
    const limit = maxLineStops(state)

    const atLimit = Array.from({ length: limit }, () => stop('moscow'))
    const overLimit = Array.from({ length: limit + 1 }, () => stop('moscow'))

    expect(legal(state, { kind: 'создать-линию', name: 'край', stops: atLimit }))
      .toBe(true)
    expect(
      legal(state, { kind: 'создать-линию', name: 'через край', stops: overLimit }),
    ).toBe(false)
  })

  it('гигантский массив остановок отбрасывается, а не разбирается', () => {
    const state = base()
    const huge = Array.from({ length: 10_000 }, () => stop('moscow'))

    expect(legal(state, { kind: 'создать-линию', name: 'полотно', stops: huge }))
      .toBe(false)
  })

  it('неизвестный груз на остановке отбрасывает линию', () => {
    const state = base()
    const stops: unknown[] = [
      { nodeId: cityId('moscow'), unload: [], load: ['золото'] },
      stop('tula'),
    ]

    expect(legal(state, { kind: 'создать-линию', name: 'клад', stops })).toBe(
      false,
    )
  })

  it('имя длиннее предела отбрасывается вместе с линией', () => {
    const state = base()
    const name = 'о'.repeat(MAX_LINE_NAME_LENGTH + 1)

    expect(legal(state, { kind: 'создать-линию', name, stops: ring() })).toBe(
      false,
    )
    expect(
      legal(state, {
        kind: 'создать-линию',
        name: name.slice(0, MAX_LINE_NAME_LENGTH),
        stops: ring(),
      }),
    ).toBe(true)
  })

  it('заведённая линия принадлежит своей компании и пуста по парку', () => {
    const state = base()
    const after = apply(state, {
      kind: 'создать-линию',
      name: 'зерновое кольцо',
      stops: ring(),
    })

    const lines = linesOf(after, RIVAL)
    const ids = Object.keys(lines) as LineId[]
    expect(ids).toHaveLength(1)

    const line = lines[ids[0]]
    expect(line.name).toBe('зерновое кольцо')
    expect(line.stops).toHaveLength(MIN_LINE_STOPS)
    expect(line.assignedVehicles).toEqual([])
    // Ключ с именем компании: нумерация конкурента не может столкнуться с
    // игроцкой схемой «line-N» из app/store.ts.
    expect(String(line.id)).toContain(String(RIVAL))
    // У соседа от этого ничего не появилось.
    expect(Object.keys(linesOf(after, NEIGHBOUR))).toHaveLength(0)
  })

  it('остановки копируются: правка исходного массива линию не меняет', () => {
    const stops = ring()
    const after = apply(base(), {
      kind: 'создать-линию',
      name: 'кольцо',
      stops,
    })

    stops[0].load.push('зерно')
    stops.push(stop('ryazan'))

    const line = Object.values(linesOf(after, RIVAL))[0]
    expect(line.stops).toHaveLength(MIN_LINE_STOPS)
    expect(line.stops[0].load).toEqual([])
  })

  it('удаление линии снимает с неё только свои машины', () => {
    const created = apply(base(), {
      kind: 'создать-линию',
      name: 'кольцо',
      stops: ring(),
    })
    const line = Object.keys(linesOf(created, RIVAL))[0] as LineId

    const assigned = apply(created, {
      kind: 'назначить-машину',
      vehicleId: RIVAL_TRUCK,
      lineId: line,
    })
    expect(assigned.vehicles[RIVAL_TRUCK].lineId).toBe(line)

    const removed = apply(assigned, { kind: 'удалить-линию', lineId: line })
    expect(linesOf(removed, RIVAL)[line]).toBeUndefined()
    // Машина осталась в парке и встала без задания — удалять её вместе с
    // линией было бы катастрофой в один ход.
    expect(removed.vehicles[RIVAL_TRUCK]).toBeDefined()
    expect(removed.vehicles[RIVAL_TRUCK].lineId).toBeNull()
    expect(removed.vehicles[RIVAL_TRUCK].route).toEqual([])
  })
})

describe('назначение машины', () => {
  it('несуществующая линия отвергается', () => {
    const state = base()
    const command: Command = {
      kind: 'назначить-машину',
      vehicleId: RIVAL_TRUCK,
      lineId: lineId('нет-такой-линии'),
    }

    expect(legal(state, command)).toBe(false)
    expect(apply(state, command)).toBe(state)
  })

  it('связь двусторонняя и снимается в обе стороны', () => {
    const created = apply(base(), {
      kind: 'создать-линию',
      name: 'кольцо',
      stops: ring(),
    })
    const line = Object.keys(linesOf(created, RIVAL))[0] as LineId

    const on = apply(created, {
      kind: 'назначить-машину',
      vehicleId: RIVAL_TRUCK,
      lineId: line,
    })
    expect(on.vehicles[RIVAL_TRUCK].lineId).toBe(line)
    expect(linesOf(on, RIVAL)[line].assignedVehicles).toEqual([RIVAL_TRUCK])

    // Повторное назначение на ту же линию — работы нет.
    expect(
      isLegal(on, RIVAL, {
        kind: 'назначить-машину',
        vehicleId: RIVAL_TRUCK,
        lineId: line,
      }),
    ).toBe(false)

    const off = apply(on, {
      kind: 'назначить-машину',
      vehicleId: RIVAL_TRUCK,
      lineId: null,
    })
    expect(off.vehicles[RIVAL_TRUCK].lineId).toBeNull()
    expect(linesOf(off, RIVAL)[line].assignedVehicles).toEqual([])
  })
})

// ─── Водители ──────────────────────────────────────────────────────────────

describe('водители', () => {
  it('наём растит штат, два найма в одном тике дают разных людей', () => {
    const state = base()
    const one = apply(state, { kind: 'нанять-водителя' })
    const two = apply(one, { kind: 'нанять-водителя' })

    const before = Object.keys(state.companies[RIVAL].drivers).length
    const after = Object.keys(two.companies[RIVAL].drivers)
    expect(after).toHaveLength(before + 2)
    expect(new Set(after).size).toBe(after.length)
  })

  it('посадка и высадка держат обе стороны связи', () => {
    const hired = apply(base(), { kind: 'нанять-водителя' })
    const roster = Object.keys(hired.companies[RIVAL].drivers) as DriverId[]
    const fresh = roster[roster.length - 1]

    // Стартовый водитель уже сидит за машиной — новый его вытесняет.
    const seated = apply(hired, {
      kind: 'посадить-водителя',
      driverId: fresh,
      vehicleId: RIVAL_TRUCK,
    })

    expect(seated.vehicles[RIVAL_TRUCK].driverId).toBe(fresh)
    expect(seated.companies[RIVAL].drivers[fresh].vehicleId).toBe(RIVAL_TRUCK)
    expect(seated.companies[RIVAL].drivers[RIVAL_DRIVER].vehicleId).toBeNull()
  })

  it('увольнение освобождает машину и не трогает чужой штат', () => {
    const state = base()
    const after = apply(state, {
      kind: 'уволить-водителя',
      driverId: RIVAL_DRIVER,
    })

    expect(after.companies[RIVAL].drivers[RIVAL_DRIVER]).toBeUndefined()
    expect(after.vehicles[RIVAL_TRUCK].driverId).toBeNull()
    expect(after.vehicles[PLAYER_TRUCK].driverId).not.toBeNull()
  })
})

// ─── Постройки и ТО: правило живёт не здесь ────────────────────────────────

describe('делегирование правил симуляции', () => {
  it('постройка через команду — тот же результат, что и прямой вызов', () => {
    const state = withMoney(base(), RIVAL, RICH)
    const command: Command = { kind: 'построить', cityId: TULA, type: 'склад' }

    const byCommand = apply(state, command)
    const bySim = buildBuilding(state, RIVAL, TULA, 'склад')

    // Совпадение доказывает главное: второй копии правил застройки в файле
    // команд нет. Разойдись они — конкуренту стало бы можно чуть больше игрока.
    expect(byCommand).toEqual(bySim)
    expect(money(state, RIVAL) - money(byCommand, RIVAL)).toBe(
      BUILDING_SPEC.склад.price,
    )
  })

  it('вторая постройка того же типа в том же городе не ставится', () => {
    const state = withMoney(base(), RIVAL, RICH)
    const command: Command = { kind: 'построить', cityId: TULA, type: 'склад' }
    const once = apply(state, command)

    expect(isLegal(once, RIVAL, command)).toBe(false)
    expect(applyCommand(once, RIVAL, command)).toBe(once)
  })

  it('постройка в несуществующем городе не ставится', () => {
    const state = withMoney(base(), RIVAL, RICH)

    expect(
      legal(state, { kind: 'построить', cityId: cityId('атлантида'), type: 'склад' }),
    ).toBe(false)
  })

  it('свою постройку сносит, и денег это не возвращает', () => {
    const state = withMoney(base(), RIVAL, RICH)
    const built = apply(state, { kind: 'построить', cityId: TULA, type: 'склад' })
    const id = buildingIdFor(RIVAL, TULA, 'склад')

    const razed = apply(built, { kind: 'снести', buildingId: id })
    expect(razed.companies[RIVAL].buildings[id]).toBeUndefined()
    expect(money(razed, RIVAL)).toBe(money(built, RIVAL))
  })

  it('ТО обнуляет счётчик пробега, а ненужное ТО не оплачивается', () => {
    const state = base()
    const worn = {
      ...state,
      vehicles: {
        ...state.vehicles,
        [RIVAL_TRUCK]: { ...state.vehicles[RIVAL_TRUCK], kmSinceService: 5_000 },
      },
    }

    const after = apply(worn, { kind: 'обслужить', vehicleId: RIVAL_TRUCK })
    expect(after.vehicles[RIVAL_TRUCK].kmSinceService).toBe(0)
    expect(money(after, RIVAL)).toBeLessThan(money(worn, RIVAL))

    // Счётчик уже на нуле — работы нет, и денег брать не за что.
    expect(
      isLegal(after, RIVAL, { kind: 'обслужить', vehicleId: RIVAL_TRUCK }),
    ).toBe(false)
  })
})

// ─── Банкрот ───────────────────────────────────────────────────────────────

describe('обанкротившаяся компания', () => {
  function broke(): GameState {
    const state = withMoney(base(), RIVAL, RICH)
    return {
      ...state,
      companies: {
        ...state.companies,
        [RIVAL]: { ...state.companies[RIVAL], bankrupt: true },
      },
    }
  }

  it('ни одна команда не проходит, даже при полном счёте', () => {
    const state = broke()
    const commands: unknown[] = [
      buyZil(),
      { kind: 'создать-линию', name: 'кольцо', stops: ring() },
      { kind: 'нанять-водителя' },
      { kind: 'построить', cityId: TULA, type: 'склад' },
      { kind: 'купить-прицеп', vehicleId: RIVAL_TRUCK, trailer: OTHER_TRAILER },
    ]

    for (const command of commands) {
      expect(legal(state, command)).toBe(false)
      expect(apply(state, command)).toBe(state)
    }
  })

  it('очередь банкрота всё равно чистится', () => {
    const state = withQueue(broke(), RIVAL, [buyZil(), buyZil()])
    const after = runCommands(state)

    expect(after.companies[RIVAL].pendingCommands).toEqual([])
    expect(fleetOf(after, RIVAL)).toEqual(fleetOf(state, RIVAL))
  })
})

// ─── Мусор на входе ────────────────────────────────────────────────────────

describe('битые команды', () => {
  const state = withMoney(base(), RIVAL, RICH)

  const garbage: unknown[] = [
    null,
    undefined,
    42,
    'купить-машину',
    [],
    {},
    { kind: 'взорвать-мост' },
    { kind: '' },
    // NaN и Infinity вместо идентификаторов.
    { kind: 'купить-машину', classId: Number.NaN },
    { kind: 'удалить-линию', lineId: Number.POSITIVE_INFINITY },
    { kind: 'обслужить', vehicleId: Number.NaN },
    { kind: 'снести', buildingId: Number.NEGATIVE_INFINITY },
    // Пустые строки.
    { kind: 'купить-машину', classId: '' },
    { kind: 'создать-линию', name: '', stops: [] },
    { kind: 'уволить-водителя', driverId: '' },
    { kind: 'назначить-машину', vehicleId: '', lineId: null },
    // Пропущенные и подменённые поля.
    { kind: 'купить-прицеп', vehicleId: RIVAL_TRUCK, trailer: 'ковёр-самолёт' },
    { kind: 'купить-прицеп', vehicleId: RIVAL_TRUCK },
    { kind: 'создать-линию', name: 'кольцо', stops: 'moscow-tula' },
    { kind: 'посадить-водителя', driverId: RIVAL_DRIVER, vehicleId: 7 },
    { kind: 'построить', cityId: TULA, type: 'дворец' },
  ]

  it.each(garbage.map((command, index) => [index, command] as const))(
    'мусор №%i отбрасывается и состояние не меняет',
    (_index, command) => {
      expect(legal(state, command)).toBe(false)
      expect(apply(state, command)).toBe(state)
    },
  )

  it('очередь из одного мусора не роняет фазу и вычищается', () => {
    const queued = withQueue(state, RIVAL, garbage as Command[])
    const after = runCommands(queued)

    expect(after.companies[RIVAL].pendingCommands).toEqual([])
    expect(money(after, RIVAL)).toBe(money(queued, RIVAL))
    expect(fleetOf(after, RIVAL)).toEqual(fleetOf(queued, RIVAL))
  })
})

// ─── Фаза: очередь, потолок, порядок ───────────────────────────────────────

describe('runCommands', () => {
  it('состояние без очередей возвращается по ссылке', () => {
    const state = base()
    expect(runCommands(state)).toBe(state)
  })

  it('очередь чистится, даже когда всё отброшено', () => {
    const state = withQueue(base(), RIVAL, [
      { kind: 'удалить-линию', lineId: lineId('нет') },
      { kind: 'обслужить', vehicleId: vehicleId('нет') },
    ])

    const after = runCommands(state)
    expect(after.companies[RIVAL].pendingCommands).toEqual([])
  })

  it('за тик разбирается не больше потолка, остальное отбрасывается', () => {
    const state = withQueue(
      withMoney(base(), RIVAL, RICH),
      RIVAL,
      Array.from({ length: 100 }, buyZil),
    )

    const after = runCommands(state)
    const bought = fleetOf(after, RIVAL).length - fleetOf(state, RIVAL).length

    expect(bought).toBe(MAX_COMMANDS_PER_TICK)
    expect(money(after, RIVAL)).toBe(
      money(state, RIVAL) - MAX_COMMANDS_PER_TICK * STARTER_CLASS.price,
    )
    // Хвост НЕ переносится на следующий тик: очередь пуста целиком.
    expect(after.companies[RIVAL].pendingCommands).toEqual([])
    expect(runCommands(after)).toBe(after)
  })

  it('команды одной компании применяются по очереди и видят работу предыдущей', () => {
    const state = withQueue(withMoney(base(), RIVAL, RICH), RIVAL, [
      { kind: 'создать-линию', name: 'кольцо', stops: ring() },
      { kind: 'купить-прицеп', vehicleId: RIVAL_TRUCK, trailer: OTHER_TRAILER },
      { kind: 'нанять-водителя' },
    ])

    const after = runCommands(state)
    expect(Object.keys(linesOf(after, RIVAL))).toHaveLength(1)
    expect(after.vehicles[RIVAL_TRUCK].trailer).toBe(OTHER_TRAILER)
    expect(Object.keys(after.companies[RIVAL].drivers).length).toBe(
      Object.keys(state.companies[RIVAL].drivers).length + 1,
    )
  })

  it('разбираются очереди всех компаний, каждая — своя', () => {
    const rich = withMoney(withMoney(base(), RIVAL, RICH), NEIGHBOUR, RICH)
    const state = withQueue(
      withQueue(rich, RIVAL, [
        { kind: 'создать-линию', name: 'первое', stops: ring() },
      ]),
      NEIGHBOUR,
      [{ kind: 'создать-линию', name: 'второе', stops: ring() }],
    )

    const after = runCommands(state)
    expect(Object.values(linesOf(after, RIVAL))[0].name).toBe('первое')
    expect(Object.values(linesOf(after, NEIGHBOUR))[0].name).toBe('второе')
    expect(after.companies[RIVAL].pendingCommands).toEqual([])
    expect(after.companies[NEIGHBOUR].pendingCommands).toEqual([])
  })
})

// ─── Детерминизм и чистота ─────────────────────────────────────────────────

describe('детерминизм и отсутствие мутации входа', () => {
  function loaded(): GameState {
    const rich = withMoney(withMoney(base(), RIVAL, RICH), NEIGHBOUR, RICH)
    return withQueue(
      withQueue(rich, RIVAL, [
        buyZil(),
        { kind: 'создать-линию', name: 'кольцо', stops: ring() },
        { kind: 'нанять-водителя' },
        { kind: 'построить', cityId: TULA, type: 'склад' },
        { kind: 'уволить-водителя', driverId: 'чужой' as never },
      ]),
      NEIGHBOUR,
      [{ kind: 'купить-прицеп', vehicleId: RIVAL_TRUCK, trailer: OTHER_TRAILER }],
    )
  }

  it('два прогона одного состояния дают побайтово одинаковый результат', () => {
    const state = loaded()
    expect(snapshot(runCommands(state))).toBe(snapshot(runCommands(state)))
  })

  it('фаза не меняет входное состояние', () => {
    const state = loaded()
    const before = snapshot(state)

    runCommands(state)

    expect(snapshot(state)).toBe(before)
  })

  it('applyCommand и isLegal не меняют входное состояние', () => {
    const state = withMoney(base(), RIVAL, RICH)
    const before = snapshot(state)

    isLegal(state, RIVAL, buyZil())
    applyCommand(state, RIVAL, buyZil())
    applyCommand(state, RIVAL, {
      kind: 'создать-линию',
      name: 'кольцо',
      stops: ring(),
    })
    applyCommand(state, RIVAL, { kind: 'построить', cityId: TULA, type: 'хаб' })

    expect(snapshot(state)).toBe(before)
  })

  it('очередь конкурента не задевает хозяйство игрока', () => {
    const state = loaded()
    const playerBefore = JSON.stringify(state.companies[PLAYER_ID])

    const after = runCommands(state)

    expect(JSON.stringify(after.companies[PLAYER_ID])).toBe(playerBefore)
    expect(after.vehicles[PLAYER_TRUCK]).toBe(state.vehicles[PLAYER_TRUCK])
  })
})
