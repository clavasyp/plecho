import { beforeEach, describe, expect, it } from 'vitest'
import { BASE_POSTS, BUILDING_SPEC } from '../data/infrastructure'
import { TRAILER_PRICE, VEHICLE_CLASS_BY_ID } from '../data/vehicles'
import { postsAt } from '../sim/logistics/service'
import {
  COMPETITORS,
  createInitialState,
  HOME_CITY,
  STARTER_CLASS,
  STARTER_CLASS_ID,
  STARTER_DRIVER_ID,
  STARTER_TRAILER,
  STARTER_VEHICLE_ID,
} from '../sim/state'
import { TICKS_PER_DAY, cityId, companyId } from '../sim/types'
import type {
  BuildingId,
  CityId,
  Command,
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

/**
 * Парк ИГРОКА, а не весь мир.
 *
 * С среза 6 в состоянии живут ещё три конкурента, и у каждого свой грузовик у
 * ворот (COMPETITORS в sim/state.ts). Считать «сколько машин в игре» после этого
 * бессмысленно: проверки стора говорят о том, что купил или потерял ИГРОК, а
 * чужой парк к этому отношения не имеет.
 */
function fleet(): VehicleId[] {
  return (Object.keys(game().vehicles) as VehicleId[]).filter(
    (id) => game().vehicles[id].ownerId === game().playerId,
  )
}

/** Идентификатор единственной купленной машины. */
function boughtId(): VehicleId {
  const ids = fleet().filter((id) => id !== STARTER_VEHICLE_ID)
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
    expect(fleet()).toHaveLength(1)
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
    expect(fleet()).toHaveLength(2)
  })

  it('рубля не хватает — покупки нет', () => {
    setMoney(ZIL_PRICE - 1)
    store().buyVehicle(STARTER_CLASS_ID)
    // Покупка в кредит — механика более позднего среза, а не «ну ладно, уйдём
    // в минус».
    expect(player().money).toBe(ZIL_PRICE - 1)
    expect(fleet()).toHaveLength(1)
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

    const ids = fleet()
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

  it('машину под погрузкой и в очереди не отправляет', () => {
    for (const patch of [{ serviceTicksLeft: 3 }, { queuedTicks: 2 }]) {
      const fresh = createInitialState(WORLD_SEED)
      useGameStore.setState({
        state: {
          ...fresh,
          vehicles: {
            ...fresh.vehicles,
            [STARTER_VEHICLE_ID]: {
              ...fresh.vehicles[STARTER_VEHICLE_ID],
              ...patch,
            },
          },
        },
        prev: fresh,
      })

      const before = game()
      store().dispatchTo(TULA)

      /*
       * Иначе кнопка «отправить» становится способом ОБОЙТИ пропускную
       * способность: нажал — и машина уехала порожней прямо из-под рампы, не
       * отстояв своё и никого не пропустив вперёд. Весь срез 5 отменялся бы
       * одним кликом, и заметить это было бы нечем: машина ведь поехала.
       */
      expect(game()).toBe(before)
      expect(truck().route).toEqual([])
    }
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

// ─── Инфраструктура ────────────────────────────────────────────────────────

describe('build и demolish', () => {
  const TERMINAL = BUILDING_SPEC['терминал']

  /** Постройки игрока — по ним видно и наличие, и владельца. */
  const yards = () => player().buildings

  it('на старте построек нет и в городе ровно базовый пост', () => {
    // Условие, на котором держится весь срез: вторая машина на том же заводе
    // встаёт в очередь СРАЗУ, а не после пятой.
    expect(yards()).toEqual({})
    expect(postsAt(game(), MOSCOW, game().playerId)).toBe(BASE_POSTS)
  })

  it('списывает цену и ставит постройку в указанном городе', () => {
    setPlayerMoney(TERMINAL.price * 2)

    store().build(TULA, 'терминал')

    const built = Object.values(yards())
    expect(built).toHaveLength(1)
    expect(built[0].type).toBe('терминал')
    expect(built[0].cityId).toBe(TULA)
    expect(built[0].ownerId).toBe(game().playerId)
    // Пустой: всё, что окажется на складе, привезёт машина игрока.
    expect(built[0].stock).toEqual({})
    expect(player().money).toBe(TERMINAL.price)
  })

  it('терминал добавляет посты, и только в своём городе', () => {
    setPlayerMoney(TERMINAL.price)
    store().build(TULA, 'терминал')

    // РАДИ ЭТОГО ЧИСЛА КНОПКА И СУЩЕСТВУЕТ. Очередь у завода расшивается не
    // покупкой машины, а постами: их стало на TERMINAL.posts больше.
    expect(postsAt(game(), TULA, game().playerId)).toBe(
      BASE_POSTS + TERMINAL.posts,
    )
    // Соседний город при этом не изменился: постройка стоит в конкретном узле,
    // а не «у компании вообще».
    expect(postsAt(game(), MOSCOW, game().playerId)).toBe(BASE_POSTS)
  })

  it('денег не хватает — ничего не происходит', () => {
    setPlayerMoney(TERMINAL.price - 1)
    const before = game()

    store().build(TULA, 'терминал')

    // Покупка в кредит — механика более позднего среза, а не «ну ладно, уйдём
    // в минус»: содержание постройки пришлось бы платить с отрицательного счёта.
    expect(game()).toBe(before)
    expect(yards()).toEqual({})
  })

  it('вторая постройка того же типа в том же городе не ставится', () => {
    setPlayerMoney(TERMINAL.price * 3)
    store().build(TULA, 'терминал')

    const afterFirst = game()
    store().build(TULA, 'терминал')

    /*
     * Потолок пропускной способности узла обязан быть КОНЕЧНЫМ. Разреши второй
     * терминал — и посты снова покупаются деньгами линейно, ровно как раньше
     * покупался десятый грузовик, а срез затевался затем, чтобы у сети появился
     * предел. Упершись в него, игрок обязан менять СЕТЬ, а не докупать бетон.
     */
    expect(game()).toBe(afterFirst)
    expect(Object.keys(yards())).toHaveLength(1)
    expect(player().money).toBe(TERMINAL.price * 2)
  })

  it('разные типы в одном городе разрешены', () => {
    setPlayerMoney(TERMINAL.price + BUILDING_SPEC['склад'].price)
    store().build(TULA, 'терминал')
    store().build(TULA, 'склад')

    // Терминал плюс склад — осмысленная ступень к хабу: дешевле, слабее и
    // доступно раньше.
    expect(Object.keys(yards())).toHaveLength(2)
    expect(postsAt(game(), TULA, game().playerId)).toBe(
      BASE_POSTS + TERMINAL.posts + BUILDING_SPEC['склад'].posts,
    )
  })

  it('в несуществующем городе не строится', () => {
    setPlayerMoney(TERMINAL.price * 2)
    const before = game()

    store().build('нет-такого' as CityId, 'терминал')

    // Иначе содержание списывалось бы за узел, которого нет на карте.
    expect(game()).toBe(before)
  })

  it('снос убирает постройку и не возвращает денег', () => {
    setPlayerMoney(TERMINAL.price)
    store().build(TULA, 'терминал')
    const id = Object.keys(yards())[0] as BuildingId

    store().demolish(id)

    expect(yards()[id]).toBeUndefined()
    // Возврат хотя бы части цены превратил бы постройку в бесплатную примерку:
    // поставил, посмотрел на очередь, снёс. Смысл сноса — перестать платить
    // содержание, и этого достаточно.
    expect(player().money).toBe(0)
    expect(postsAt(game(), TULA, game().playerId)).toBe(BASE_POSTS)
  })

  it('снести несуществующую — ничего не происходит', () => {
    const before = game()
    store().demolish('нет-такой' as BuildingId)
    expect(game()).toBe(before)
  })

  it('чужую постройку игрок не сносит', () => {
    setPlayerMoney(TERMINAL.price)
    store().build(TULA, 'терминал')
    const id = Object.keys(yards())[0] as BuildingId

    // Переписываем постройку конкуренту, оставив идентификатор прежним.
    const rival = companyId('rival')
    useGameStore.setState((current) => {
      const owner = current.state.companies[current.state.playerId]
      const moved = owner.buildings[id]
      return {
        state: {
          ...current.state,
          companies: {
            ...current.state.companies,
            [current.state.playerId]: { ...owner, buildings: {} },
            [rival]: { ...owner, id: rival, buildings: { [id]: moved } },
          },
        },
      }
    })

    const before = game()
    store().demolish(id)

    // Симуляция снесла бы и её — этой команды законно требует и конкурент, —
    // поэтому фильтр владельца стоит в сторе.
    expect(game()).toBe(before)
    expect(game().companies[rival].buildings[id]).toBeDefined()
  })

  it('строительство не мутирует прежний снимок', () => {
    setPlayerMoney(TERMINAL.price * 2)
    const before = game()
    const snapshot = JSON.stringify(before)

    store().build(TULA, 'терминал')
    const id = Object.keys(yards())[0] as BuildingId
    store().demolish(id)

    // Снимок, который держит рендер для интерполяции, обязан пережить правку:
    // иначе «предыдущий кадр» поедет вместе с текущим.
    expect(JSON.stringify(before)).toBe(snapshot)
    expect(game()).not.toBe(before)
  })
})

// ─── Асинхронный адаптер ───────────────────────────────────────────────────

describe('deliverPlan и setController: дверь из сети в состояние', () => {
  /*
   * ТОЧКА, РАДИ КОТОРОЙ ВЕСЬ СРЕЗ И ЗАТЕВАЛСЯ. Ответ языковой модели приходит
   * асинхронно и не попадает в тик: он ложится в СОСТОЯНИЕ — в очередь команд
   * компании, — а разбирает его первая фаза ближайшего тика как обычные данные.
   * Проверяется здесь именно граница: что кладётся, кому и что при этом
   * отвергается. Сами команды проверяет sim/ai/commands.ts, их эту дверь не
   * касается.
   */
  const RIVAL = COMPETITORS[0].id
  const rival = () => game().companies[RIVAL]

  const plan = (commands: Command[], thought: string, fromModel = true) => ({
    commands,
    thought,
    fromModel,
  })

  it('кладёт команды в очередь и мысль в ленту одним действием', () => {
    store().deliverPlan(RIVAL, plan([{ kind: 'нанять-водителя' }], 'Беру человека.'))

    expect(rival().pendingCommands).toEqual([{ kind: 'нанять-водителя' }])

    const feed = rival().thinking
    expect(feed).toHaveLength(1)
    expect(feed[0].text).toBe('Беру человека.')
    // Происхождение обязано быть честным: тихая подмена модели скриптом
    // обесценила бы ленту рассуждений целиком.
    expect(feed[0].fromModel).toBe(true)
    expect(feed[0].tick).toBe(game().tick)
  })

  it('положенное разбирается ближайшим тиком, а не копится', () => {
    const before = Object.keys(rival().drivers).length
    store().deliverPlan(RIVAL, plan([{ kind: 'нанять-водителя' }], 'Беру человека.'))

    store().advance(1)

    expect(Object.keys(rival().drivers).length).toBe(before + 1)
    expect(rival().pendingCommands).toEqual([])
  })

  it('второй ответ не затирает первый', () => {
    store().deliverPlan(RIVAL, plan([{ kind: 'нанять-водителя' }], 'Раз.'))
    store().deliverPlan(RIVAL, plan([{ kind: 'нанять-водителя' }], 'Два.'))

    // Два ответа между двумя тиками — это два решения одной компании, и молча
    // потерять первое нельзя.
    expect(rival().pendingCommands).toHaveLength(2)
    expect(rival().thinking.map((t) => t.text)).toEqual(['Раз.', 'Два.'])
  })

  it('за игрока план не принимается никогда', () => {
    const before = game()
    store().deliverPlan(game().playerId, plan([{ kind: 'нанять-водителя' }], 'Я сам.'))

    // Игрок — это тот, кто решает сам. Разберись он потом, почему грузовик
    // уехал без его ведома, ему было бы нечем.
    expect(game()).toBe(before)
    expect(player().pendingCommands).toEqual([])
    expect(player().thinking).toEqual([])
  })

  it('несуществующей компании и пустому плану дверь не открывается', () => {
    const before = game()
    store().deliverPlan(companyId('никого'), plan([{ kind: 'нанять-водителя' }], 'Ау.'))
    expect(game()).toBe(before)

    // Пустой план с пустой мыслью — не событие: будить подписчиков нечем.
    store().deliverPlan(RIVAL, plan([], ''))
    expect(game()).toBe(before)
  })

  it('setController передаёт компанию модели и возвращает скрипту', () => {
    expect(rival().controller).toBe('скрипт')

    store().setController(RIVAL, 'модель')
    expect(rival().controller).toBe('модель')

    // Повторный перевод в то же состояние — не событие.
    const settled = game()
    store().setController(RIVAL, 'модель')
    expect(game()).toBe(settled)

    store().setController(RIVAL, 'скрипт')
    expect(rival().controller).toBe('скрипт')
  })

  it('компания под моделью перестаёт слушать скриптовую фазу решений', () => {
    store().setController(RIVAL, 'модель')

    // Ровно игровые сутки: столько между двумя решениями скрипта (isDecisionTick
    // в sim/tick.ts). Компания, взятая моделью, за эти сутки не должна получить
    // ни одной мысли — иначе у неё два хозяина и две стратегии разом.
    store().advance(TICKS_PER_DAY)

    expect(rival().thinking).toEqual([])
    expect(rival().pendingCommands).toEqual([])
    // А у соседа со скриптом мысль появилась — значит фаза решений работала, и
    // проверка выше не холостая.
    expect(game().companies[COMPETITORS[1].id].thinking.length).toBeGreaterThan(0)
  })

  it('игрока модели не отдать', () => {
    const before = game()
    store().setController(game().playerId, 'модель')

    // 'человек' — не одна из стратегий, а отсутствие автомата за спиной.
    expect(game()).toBe(before)
    expect(player().controller).toBe('человек')
  })
})

describe('sellVehicle', () => {
  it('возвращает половину цены класса и убирает машину из парка', () => {
    const before = player().money
    store().sellVehicle(STARTER_VEHICLE_ID)

    expect(game().vehicles[STARTER_VEHICLE_ID]).toBeUndefined()
    expect(player().money).toBe(before + Math.round(STARTER_CLASS.price / 2))
  })

  it('водитель возвращается в резерв, а не увольняется', () => {
    store().sellVehicle(STARTER_VEHICLE_ID)

    const driver = drivers()[STARTER_DRIVER_ID]
    expect(driver, 'человек остаётся в штате').toBeDefined()
    expect(driver.vehicleId, 'но уже без машины').toBeNull()
  })

  it('машину с грузом продать нельзя: груз исчез бы вместе с ней', () => {
    useGameStore.setState(({ state }) => ({
      state: {
        ...state,
        vehicles: {
          ...state.vehicles,
          [STARTER_VEHICLE_ID]: {
            ...state.vehicles[STARTER_VEHICLE_ID],
            cargo: { type: 'зерно' as const, tons: 3, originId: MOSCOW },
          },
        },
      },
    }))

    const before = player().money
    store().sellVehicle(STARTER_VEHICLE_ID)

    expect(game().vehicles[STARTER_VEHICLE_ID]).toBeDefined()
    expect(player().money).toBe(before)
  })

  it('машину в пути продать нельзя', () => {
    useGameStore.setState(({ state }) => ({
      state: {
        ...state,
        vehicles: {
          ...state.vehicles,
          [STARTER_VEHICLE_ID]: {
            ...state.vehicles[STARTER_VEHICLE_ID],
            position: {
              kind: 'ребро' as const,
              edgeId: Object.keys(state.world.edges)[0] as never,
              fromId: MOSCOW,
              progress: 0.5,
            },
          },
        },
      },
    }))

    const before = player().money
    store().sellVehicle(STARTER_VEHICLE_ID)

    expect(game().vehicles[STARTER_VEHICLE_ID]).toBeDefined()
    expect(player().money).toBe(before)
  })

  /**
   * ПРАВИЛА У ИГРОКА И У КОНКУРЕНТА ОДНИ И ТЕ ЖЕ — это и есть смысл единого
   * набора команд из шапки sim/ai/commands.ts. До этой правки продажа была
   * доступна ТОЛЬКО конкуренту: команда в наборе была, а действия у игрока не
   * существовало, то есть соперник играл по более широким правилам.
   */
  it('продажа идёт тем же путём, что и у конкурента, — через команду', () => {
    store().sellVehicle(STARTER_VEHICLE_ID)
    expect(game().vehicles[STARTER_VEHICLE_ID]).toBeUndefined()
  })
})
