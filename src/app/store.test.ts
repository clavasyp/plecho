import { beforeEach, describe, expect, it } from 'vitest'
import { TRAILER_PRICE, VEHICLE_CLASS_BY_ID } from '../data/vehicles'
import {
  createInitialState,
  HOME_CITY,
  STARTER_CLASS,
  STARTER_CLASS_ID,
  STARTER_DRIVER_ID,
  STARTER_TRAILER,
  STARTER_VEHICLE_ID,
} from '../sim/state'
import { cityId } from '../sim/types'
import type {
  CityId,
  DriverId,
  GameState,
  Stop,
  Vehicle,
  VehicleId,
} from '../sim/types'
import { useGameStore, WORLD_SEED } from './store'

/**
 * Действия стора — единственное место в проекте, где GameState меняется в обход
 * тика. Правила для них те же, что и для симуляции, и проверяются те же:
 *
 *   1. Ничего не мутируется. Рендер сравнивает снимки по ссылке, а сохранение —
 *      это JSON того самого объекта, который лежит в сторе.
 *   2. Двусторонняя связь «машина ↔ линия» всегда согласована. Разъехавшись,
 *      она не падает: машина просто перестаёт ездить, а линия показывает
 *      несуществующий парк.
 *   3. Отказ — это отказ, а не «почти получилось». Покупка без денег не должна
 *      оставлять после себя половину машины.
 *
 * Игровой логики здесь нет и быть не должно, поэтому нет и прогонов: всё, что
 * решает, как устроен мир, живёт в src/sim и проверяется там.
 */

const TULA = cityId('tula')
const KALUGA = cityId('kaluga')
const MOSCOW = cityId('moscow')

/** Стор — синглтон на модуль, поэтому каждый тест начинает с чистой партии. */
beforeEach(() => {
  const fresh = createInitialState(WORLD_SEED)
  useGameStore.setState({ state: fresh, prev: fresh, speed: 1 })
})

const store = () => useGameStore.getState()
const game = (): GameState => store().state
const player = () => game().companies[game().playerId]
const truck = (id: VehicleId = STARTER_VEHICLE_ID) => game().vehicles[id]
const drivers = () => player().drivers

/** Цена стартового класса — та, что и списывается при его покупке. */
const ZIL_PRICE = STARTER_CLASS.price

/** Идентификатор единственной купленной машины. */
function boughtId(): VehicleId {
  const ids = (Object.keys(game().vehicles) as VehicleId[]).filter(
    (id) => id !== STARTER_VEHICLE_ID,
  )
  expect(ids).toHaveLength(1)
  return ids[0]
}

/** Выдать компании игрока ровно столько денег, сколько нужно тесту. */
function setPlayerMoney(money: number): void {
  useGameStore.setState((current) => ({
    state: {
      ...current.state,
      companies: {
        ...current.state.companies,
        [current.state.playerId]: {
          ...current.state.companies[current.state.playerId],
          money,
        },
      },
    },
  }))
}

function stop(nodeId: CityId, unload: Stop['unload'], load: Stop['load']): Stop {
  return { nodeId, unload, load }
}

/** Кольцо из двух остановок — минимальная работающая линия. */
const RING: Stop[] = [stop(TULA, [], ['мука']), stop(MOSCOW, ['мука'], [])]

// ─── Линии ─────────────────────────────────────────────────────────────────

describe('createLine', () => {
  it('заводит линию в компании игрока и возвращает её идентификатор', () => {
    const id = store().createLine('Тульское кольцо', RING)

    const line = player().lines[id]
    expect(line).toBeDefined()
    expect(line.id).toBe(id)
    expect(line.name).toBe('Тульское кольцо')
    expect(line.stops).toHaveLength(RING.length)
    // Машин на новой линии нет: назначение — отдельное решение игрока.
    expect(line.assignedVehicles).toEqual([])
  })

  it('копирует остановки насквозь: форма редактора живёт своей жизнью', () => {
    const draft: Stop[] = [
      stop(TULA, [], ['мука']),
      stop(MOSCOW, ['мука'], []),
    ]
    const id = store().createLine('Кольцо', draft)

    // Игрок продолжает править форму после сохранения. Общий массив означал бы,
    // что уже работающая линия меняется задним числом.
    draft.push(stop(KALUGA, [], []))
    draft[0].load.push('зерно')

    const line = player().lines[id]
    expect(line.stops).toHaveLength(2)
    expect(line.stops[0].load).toEqual(['мука'])
  })

  it('не переиспользует идентификатор удалённой линии', () => {
    const first = store().createLine('a', RING)
    const second = store().createLine('b', RING)
    store().deleteLine(first)
    const third = store().createLine('c', RING)

    // Счётчик по количеству линий выдал бы здесь идентификатор второй линии —
    // вместе с её машинами в assignedVehicles.
    expect(third).not.toBe(first)
    expect(third).not.toBe(second)
    expect(Object.keys(player().lines).sort()).toEqual([second, third].sort())
  })
})

describe('updateLine', () => {
  it('переписывает остановки, машина остаётся на линии', () => {
    const id = store().createLine('Кольцо', RING)
    store().assignVehicle(STARTER_VEHICLE_ID, id)

    store().updateLine(id, [...RING, stop(KALUGA, [], ['пиломатериалы'])])

    expect(player().lines[id].stops).toHaveLength(3)
    expect(truck().lineId).toBe(id)
    expect(player().lines[id].assignedVehicles).toEqual([STARTER_VEHICLE_ID])
  })

  it('укоротив линию, возвращает машину на нулевую остановку', () => {
    const id = store().createLine('Кольцо', [
      ...RING,
      stop(KALUGA, [], ['пиломатериалы']),
    ])
    store().assignVehicle(STARTER_VEHICLE_ID, id)
    useGameStore.setState((current) => ({
      state: {
        ...current.state,
        vehicles: {
          ...current.state.vehicles,
          [STARTER_VEHICLE_ID]: {
            ...current.state.vehicles[STARTER_VEHICLE_ID],
            stopIndex: 2,
          },
        },
      },
    }))

    store().updateLine(id, RING)

    // Индекс смотрел на остановку, которой больше нет. Оставить его битым —
    // значит записать в сохранение состояние, которое диспетчер не сможет
    // истолковать.
    expect(truck().stopIndex).toBe(0)
    expect(truck().route).toEqual([])
  })

  it('неизвестную линию не трогает', () => {
    const before = game()
    store().updateLine('нет-такой' as never, RING)
    expect(game()).toBe(before)
  })
})

describe('deleteLine', () => {
  it('убирает линию, а её машины остаются в парке без задания', () => {
    const id = store().createLine('Кольцо', RING)
    store().assignVehicle(STARTER_VEHICLE_ID, id)

    store().deleteLine(id)

    expect(player().lines[id]).toBeUndefined()
    // Машина не удаляется вместе с линией: это была бы катастрофа в один клик.
    expect(truck()).toBeDefined()
    expect(truck().lineId).toBeNull()
    expect(truck().stopIndex).toBe(0)
    expect(truck().route).toEqual([])
  })
})

// ─── Назначение на линию ───────────────────────────────────────────────────

describe('assignVehicle', () => {
  it('связывает машину и линию с обеих сторон', () => {
    const id = store().createLine('Кольцо', RING)

    store().assignVehicle(STARTER_VEHICLE_ID, id)

    expect(truck().lineId).toBe(id)
    expect(player().lines[id].assignedVehicles).toEqual([STARTER_VEHICLE_ID])
    // Индекс с нуля и пустой маршрут: диспетчер выдаст своё задание на
    // ближайшем тике, а остатки прежнего увели бы машину не туда.
    expect(truck().stopIndex).toBe(0)
    expect(truck().route).toEqual([])
  })

  it('перевод на другую линию снимает машину с прежней', () => {
    const first = store().createLine('Первая', RING)
    const second = store().createLine('Вторая', RING)

    store().assignVehicle(STARTER_VEHICLE_ID, first)
    store().assignVehicle(STARTER_VEHICLE_ID, second)

    // Машина, оставшаяся в списке двух линий, показывала бы игроку парк,
    // которого нет, — а ездила бы всё равно по одной.
    expect(player().lines[first].assignedVehicles).toEqual([])
    expect(player().lines[second].assignedVehicles).toEqual([
      STARTER_VEHICLE_ID,
    ])
    expect(truck().lineId).toBe(second)
  })

  it('снятие с линии убирает машину из списка линии', () => {
    const id = store().createLine('Кольцо', RING)
    store().assignVehicle(STARTER_VEHICLE_ID, id)

    store().assignVehicle(STARTER_VEHICLE_ID, null)

    expect(truck().lineId).toBeNull()
    expect(player().lines[id].assignedVehicles).toEqual([])
  })

  it('несуществующие линию и машину игнорирует', () => {
    const before = game()
    store().assignVehicle(STARTER_VEHICLE_ID, 'нет-такой' as never)
    expect(game()).toBe(before)

    store().createLine('Кольцо', RING)
    const withLine = game()
    store().assignVehicle('нет-такой' as never, null)
    expect(game()).toBe(withLine)
  })
})

// ─── Покупка машины ────────────────────────────────────────────────────────

describe('buyVehicle', () => {
  /** Положить компании денег ровно столько, сколько нужно тесту. */
  function setMoney(money: number): void {
    useGameStore.setState((current) => ({
      state: {
        ...current.state,
        companies: {
          ...current.state.companies,
          [current.state.playerId]: {
            ...current.state.companies[current.state.playerId],
            money,
          },
        },
      },
    }))
  }

  it('на старте денег не хватает и ничего не происходит', () => {
    // Смысл стартового капитала (см. START_MONEY в sim/state.ts): первое
    // решение в игре принимает игрок, а не баланс. Мерой стала цена РАБОТАЮЩЕЙ
    // машины — тягач плюс прицеп, — потому что голый тягач груза не берёт.
    const working = ZIL_PRICE + Math.min(...Object.values(TRAILER_PRICE))
    expect(player().money).toBeLessThan(working)

    // Денег не хватает даже на голый тягач самого дорогого класса.
    const before = game()
    store().buyVehicle('tractor')

    expect(game()).toBe(before)
    expect(Object.keys(game().vehicles)).toHaveLength(1)
  })

  it('списывает цену и ставит новую машину в домашнем городе', () => {
    setMoney(ZIL_PRICE * 2)

    store().buyVehicle(STARTER_CLASS_ID)

    expect(player().money).toBe(ZIL_PRICE)

    const bought = game().vehicles[boughtId()]
    expect(bought.position).toEqual({ kind: 'узел', nodeId: HOME_CITY })
    expect(bought.ownerId).toBe(game().playerId)
    expect(bought.lineId).toBeNull()
    expect(bought.cargo).toBeNull()
    expect(bought.odometer).toBe(0)
    // Купленная машина обязана быть той же, что стартовая: разойдись сборка —
    // и второй ЗИЛ поехал бы, например, с нулевым расходом топлива, то есть
    // даром. Такой дефект ничего не роняет, он просто ломает баланс.
    expect(bought.classId).toBe(truck().classId)
    expect(bought.fuelPer100Km).toBe(truck().fuelPer100Km)
    expect(bought.capacity).toBe(truck().capacity)
    expect(bought.cruiseKmh).toBe(truck().cruiseKmh)
  })

  it('приезжает ГОЛЫЙ тягач: без прицепа и без водителя', () => {
    setMoney(ZIL_PRICE * 2)
    store().buyVehicle(STARTER_CLASS_ID)

    const bought = game().vehicles[boughtId()]
    // Машина в этой игре собирается из трёх решений, покупка — только первое.
    // Купивший один тягач видит, что тот не берёт груз и не трогается с места.
    expect(bought.trailer).toBeNull()
    expect(bought.driverId).toBeNull()
    expect(bought.wear).toBe(0)
    expect(bought.brokenDown).toBe(false)
  })

  it('ровно на цену — покупка проходит и оставляет ноль', () => {
    setMoney(ZIL_PRICE)
    store().buyVehicle(STARTER_CLASS_ID)
    expect(player().money).toBe(0)
    expect(Object.keys(game().vehicles)).toHaveLength(2)
  })

  it('рубля не хватает — покупки нет', () => {
    setMoney(ZIL_PRICE - 1)
    store().buyVehicle(STARTER_CLASS_ID)
    // Покупка в кредит — механика более позднего среза, а не «ну ладно, уйдём
    // в минус».
    expect(player().money).toBe(ZIL_PRICE - 1)
    expect(Object.keys(game().vehicles)).toHaveLength(1)
  })

  it('цена берётся у класса, а не общая на весь парк', () => {
    const heavy = VEHICLE_CLASS_BY_ID['kamaz-5320']
    setMoney(heavy.price)

    // Дешёвого класса хватило бы, дорогого — впритык. Общая цена сделала бы
    // выбор класса бессмысленным: брали бы всегда самый большой.
    store().buyVehicle(heavy.id)
    expect(player().money).toBe(0)
    expect(game().vehicles[boughtId()].classId).toBe(heavy.id)
    expect(heavy.price).not.toBe(ZIL_PRICE)
  })

  it('технику из будущего не продают', () => {
    const future = VEHICLE_CLASS_BY_ID['tractor']
    setMoney(future.price * 2)

    // Партия начинается в 1994-м, магистральный тягач появляется в 2000-м.
    // Без этой проверки эпоха в справочнике была бы украшением.
    expect(future.availableFrom).toBeGreaterThan(1994)
    const before = game()
    store().buyVehicle(future.id)
    expect(game()).toBe(before)
  })

  it('неизвестный класс ничего не делает и не роняет стор', () => {
    setMoney(ZIL_PRICE * 5)
    const before = game()
    store().buyVehicle('нет-такого')
    expect(game()).toBe(before)
  })

  it('каждая следующая машина получает свой идентификатор', () => {
    setMoney(ZIL_PRICE * 5)
    store().buyVehicle(STARTER_CLASS_ID)
    store().buyVehicle(STARTER_CLASS_ID)
    store().buyVehicle(STARTER_CLASS_ID)

    const ids = Object.keys(game().vehicles)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(4)
  })
})

// ─── Прицепы ───────────────────────────────────────────────────────────────

describe('buyTrailer', () => {
  /** Второй прицеп, подходящий стартовому классу, — цель смены специализации. */
  const OTHER = STARTER_CLASS.trailers.find((t) => t !== STARTER_TRAILER)!

  it('списывает цену прицепа и меняет специализацию машины', () => {
    const before = player().money
    store().buyTrailer(STARTER_VEHICLE_ID, OTHER)

    expect(truck().trailer).toBe(OTHER)
    expect(player().money).toBe(before - TRAILER_PRICE[OTHER])
  })

  it('стартового капитала хватает на смену специализации', () => {
    // Ради этого запаса капитал и пересматривался в срезе 4: первое решение
    // партии не должно быть необратимым.
    expect(player().money).toBeGreaterThanOrEqual(TRAILER_PRICE[OTHER])
  })

  it('тот же прицеп второй раз не покупается', () => {
    const before = game()
    store().buyTrailer(STARTER_VEHICLE_ID, STARTER_TRAILER)
    // Двойное нажатие кнопки не должно стоить вторых денег.
    expect(game()).toBe(before)
  })

  it('несовместимый с классом прицеп не ставится', () => {
    const before = game()
    // Полуприцеп-цистерну к бортовому ЗИЛу не прицепить, сколько бы ни платил.
    expect(STARTER_CLASS.trailers).not.toContain('реф')
    store().buyTrailer(STARTER_VEHICLE_ID, 'реф')
    expect(game()).toBe(before)
  })

  it('без денег прицепа нет', () => {
    setPlayerMoney(TRAILER_PRICE[OTHER] - 1)
    store().buyTrailer(STARTER_VEHICLE_ID, OTHER)

    expect(truck().trailer).toBe(STARTER_TRAILER)
    expect(player().money).toBe(TRAILER_PRICE[OTHER] - 1)
  })

  it('несуществующую машину не переоборудовать', () => {
    const before = game()
    store().buyTrailer('нет-такой' as VehicleId, OTHER)
    expect(game()).toBe(before)
  })
})

// ─── Водители ──────────────────────────────────────────────────────────────

describe('hireDriver и fireDriver', () => {
  it('нанятый приходит в резерв, а не сразу за руль', () => {
    store().hireDriver()

    const roster = Object.values(drivers())
    expect(roster).toHaveLength(2)

    const hired = roster.find((d) => d.id !== STARTER_DRIVER_ID)!
    // Назначение на машину — отдельное решение игрока, ровно как назначение
    // машины на линию при покупке.
    expect(hired.vehicleId).toBeNull()
    expect(hired.employerId).toBe(game().playerId)
    expect(hired.wagePerDay).toBeGreaterThan(0)
    // И он не выгнал с места того, кто уже сидит за рулём.
    expect(truck().driverId).toBe(STARTER_DRIVER_ID)
  })

  it('увольнение освобождает машину, а не удаляет её', () => {
    store().fireDriver(STARTER_DRIVER_ID)

    expect(drivers()[STARTER_DRIVER_ID]).toBeUndefined()
    // Машина осталась в парке и встала без водителя: настоящая цена
    // увольнения не в пособии, а в остановленном кольце.
    expect(truck()).toBeDefined()
    expect(truck().driverId).toBeNull()
  })

  it('уволить несуществующего — ничего не происходит', () => {
    const before = game()
    store().fireDriver('нет-такого' as DriverId)
    expect(game()).toBe(before)
  })
})

describe('assignDriver', () => {
  function hire(): DriverId {
    store().hireDriver()
    const hired = Object.values(drivers()).find(
      (d) => d.id !== STARTER_DRIVER_ID,
    )!
    return hired.id
  }

  function buy(): VehicleId {
    setPlayerMoney(STARTER_CLASS.price * 3)
    store().buyVehicle(STARTER_CLASS_ID)
    return boughtId()
  }

  it('связь двусторонняя: машина помнит водителя, водитель — машину', () => {
    const hired = hire()
    const second = buy()

    store().assignDriver(hired, second)

    expect(game().vehicles[second].driverId).toBe(hired)
    expect(drivers()[hired].vehicleId).toBe(second)
  })

  it('в резерв: обе стороны связи снимаются', () => {
    store().assignDriver(STARTER_DRIVER_ID, null)

    expect(truck().driverId).toBeNull()
    expect(drivers()[STARTER_DRIVER_ID].vehicleId).toBeNull()
  })

  it('пересадка освобождает и прежнюю машину, и прежнего водителя', () => {
    const hired = hire()
    const second = buy()

    // Новичок садится за вторую машину, потом переходит на первую, где уже
    // сидит стартовый водитель.
    store().assignDriver(hired, second)
    store().assignDriver(hired, STARTER_VEHICLE_ID)

    // Прежняя машина новичка освободилась.
    expect(game().vehicles[second].driverId).toBeNull()
    // Согнанный водитель ушёл в резерв, а не остался «за той же машиной».
    expect(drivers()[STARTER_DRIVER_ID].vehicleId).toBeNull()
    // И за рулём ровно один человек.
    expect(truck().driverId).toBe(hired)
    expect(drivers()[hired].vehicleId).toBe(STARTER_VEHICLE_ID)
  })

  it('несуществующих водителя и машину не назначить', () => {
    const before = game()
    store().assignDriver('нет-такого' as DriverId, STARTER_VEHICLE_ID)
    expect(game()).toBe(before)

    store().assignDriver(STARTER_DRIVER_ID, 'нет-такой' as VehicleId)
    expect(game()).toBe(before)
  })
})

// ─── Обслуживание и ремонт ─────────────────────────────────────────────────

describe('serviceVehicle и repairVehicle', () => {
  function patchTruck(patch: Partial<Vehicle>): void {
    useGameStore.setState((current) => ({
      state: {
        ...current.state,
        vehicles: {
          ...current.state.vehicles,
          [STARTER_VEHICLE_ID]: {
            ...current.state.vehicles[STARTER_VEHICLE_ID],
            ...patch,
          },
        },
      },
    }))
  }

  it('ТО обнуляет счётчик пробега за деньги', () => {
    patchTruck({ kmSinceService: 12_000 })
    const before = player().money

    store().serviceVehicle(STARTER_VEHICLE_ID)

    expect(truck().kmSinceService).toBe(0)
    expect(player().money).toBeLessThan(before)
    // Ресурс при этом не возвращается: ТО — регламент, а не капремонт.
    expect(truck().wear).toBe(0)
  })

  it('ТО на нулевом счётчике бесплатно', () => {
    const before = game()
    store().serviceVehicle(STARTER_VEHICLE_ID)
    expect(game()).toBe(before)
  })

  it('ремонт снимает поломку за деньги', () => {
    patchTruck({ brokenDown: true })
    const before = player().money

    store().repairVehicle(STARTER_VEHICLE_ID)

    expect(truck().brokenDown).toBe(false)
    expect(player().money).toBeLessThan(before)
  })

  it('чинить исправную — не платная услуга', () => {
    const before = game()
    store().repairVehicle(STARTER_VEHICLE_ID)
    expect(game()).toBe(before)
  })
})

// ─── Разовые рейсы ─────────────────────────────────────────────────────────

describe('dispatchTo', () => {
  it('выдаёт маршрут свободной машине', () => {
    store().dispatchTo(TULA)

    expect(truck().route.length).toBeGreaterThan(0)
    expect(truck().route[truck().route.length - 1]).toBe(TULA)
  })

  it('машину на линии не трогает', () => {
    const id = store().createLine('Кольцо', RING)
    store().assignVehicle(STARTER_VEHICLE_ID, id)

    const before = game()
    store().dispatchTo(TULA)

    // Диспетчеризация следующего же тика переписала бы такой маршрут своим, и
    // игрок увидел бы кнопку, которая просто не работает.
    expect(game()).toBe(before)
    expect(truck().route).toEqual([])
  })
})

// ─── Чистота ───────────────────────────────────────────────────────────────

describe('действия стора не мутируют прежний снимок', () => {
  it('прежнее состояние остаётся прежним после всех правок', () => {
    const before = game()
    const snapshot = JSON.stringify(before)

    const id = store().createLine('Кольцо', RING)
    store().assignVehicle(STARTER_VEHICLE_ID, id)
    store().updateLine(id, [...RING, stop(KALUGA, [], [])])
    store().assignVehicle(STARTER_VEHICLE_ID, null)
    store().deleteLine(id)

    // Снимок, который держит рендер для интерполяции, обязан пережить все
    // правки: иначе «предыдущий кадр» поедет вместе с текущим и машины будут
    // прыгать.
    expect(JSON.stringify(before)).toBe(snapshot)
    expect(game()).not.toBe(before)
  })

  it('замороженное состояние выдерживает правку линий', () => {
    // Заморозка ловит мутацию физически: запись в чужой объект бросает
    // TypeError, а сравнение JSON её бы не заметило.
    useGameStore.setState((current) => ({
      state: deepFreeze(current.state),
    }))

    expect(() => {
      const id = store().createLine('Кольцо', RING)
      store().assignVehicle(STARTER_VEHICLE_ID, id)
      store().deleteLine(id)
    }).not.toThrow()
  })
})

/** Рекурсивная заморозка. Возвращает тот же объект — удобно для инлайна. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const inner of Object.values(value as Record<string, unknown>)) {
    deepFreeze(inner)
  }
  return Object.freeze(value)
}
