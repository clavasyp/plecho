import { describe, expect, it } from 'vitest'
import { cityId, companyId, industryId, TICKS_PER_DAY } from '../types'
import type {
  CargoType,
  GameState,
  Industry,
  IndustryId,
  IndustryType,
  Tons,
} from '../types'
import {
  capacityFactor,
  DEGRADE_AFTER_TICKS,
  runProduction,
  stockCapacity,
  STOCK_DAYS,
} from './production'

/**
 * Числа в этих тестах взяты из data/recipes.ts и посчитаны на бумаге, а не
 * выведены из кода производства. Так тест проверяет БАЛАНС, а не сам себя:
 * если формула выпуска поедет, ожидаемые тонны останутся прежними.
 *
 * Опорные величины при 96 тиках в сутках:
 *   элеватор     60 т/сут зерна          → 0.625     т/тик, склад 180 т
 *   ЦБК          30 т/сут пиломатериалов → 0.3125    т/тик, склад  90 т
 *                1.6 т кругляка на тонну → 0.5       т/тик входа
 *   мукомольный  40 т/сут муки           → 0.4166667 т/тик, склад 120 т
 *                1.25 т зерна на тонну   → 0.5208333 т/тик входа
 */

const TULA = cityId('tula')
const PLAYER = companyId('player')

const ELEV: IndustryId = industryId('elev')
const MILL: IndustryId = industryId('mill')
const CBK: IndustryId = industryId('cbk')

function makeIndustry(
  id: IndustryId,
  type: IndustryType,
  stock: Partial<Record<CargoType, Tons>> = {},
  idleTicks = 0,
): Industry {
  return { id, type, cityId: TULA, stock, utilization: 0, idleTicks }
}

function makeState(...industries: Industry[]): GameState {
  return {
    rngState: 1,
    tick: 0,
    startYear: 1994,
    world: {
      cities: {},
      edges: {},
      industries: Object.fromEntries(industries.map((it) => [it.id, it])),
    },
    companies: {
      // Поля среза 3 (линии, суточный итог, банкротство) достраиваются
      // пустыми: производству они не нужны, но без них фикстура не собирается.
      [PLAYER]: {
        id: PLAYER,
        name: 'Игрок',
        money: 0,
        controller: 'человек',
        lines: {},
        drivers: {},
        dailyRevenue: 0,
        dailyCosts: 0,
        bankrupt: false,
        daysInDebt: 0,
      },
    },
    playerId: PLAYER,
    vehicles: {},
  }
}

const at = (state: GameState, id: IndustryId): Industry =>
  state.world.industries[id]

/** Подменить склад предприятия — это и есть «приехала машина». */
function withStock(
  state: GameState,
  id: IndustryId,
  stock: Partial<Record<CargoType, Tons>>,
): GameState {
  return {
    ...state,
    world: {
      ...state.world,
      industries: {
        ...state.world.industries,
        [id]: { ...state.world.industries[id], stock },
      },
    },
  }
}

/**
 * Прогнать несколько тиков производства. Необязательный between имитирует
 * работу транспорта между тиками: вывоз продукции, подвоз сырья.
 */
function run(
  state: GameState,
  ticks: number,
  between?: (state: GameState) => GameState,
): GameState {
  let next = state
  for (let i = 0; i < ticks; i++) {
    next = runProduction(next)
    if (between) {
      next = between(next)
    }
  }
  return next
}

/** Машина, стоящая под погрузкой постоянно: склад вычищается каждый тик. */
const hauler = (id: IndustryId) => (state: GameState) => withStock(state, id, {})

describe('stockCapacity', () => {
  it('держит трое суток собственного оборота предприятия', () => {
    const elevator = makeIndustry(ELEV, 'элеватор')
    const mill = makeIndustry(MILL, 'мукомольный')

    expect(stockCapacity(elevator, 'зерно')).toBe(60 * STOCK_DAYS)
    // У переработки запас считается по КАЖДОМУ грузу отдельно и по её
    // собственному обороту: 40 т муки в сутки требуют 50 т зерна.
    expect(stockCapacity(mill, 'мука')).toBe(40 * STOCK_DAYS)
    expect(stockCapacity(mill, 'зерно')).toBe(50 * STOCK_DAYS)
  })

  it('не принимает груз, которого нет в рецепте', () => {
    expect(stockCapacity(makeIndustry(MILL, 'мукомольный'), 'нефть')).toBe(0)
  })
})

describe('runProduction: источники', () => {
  it('элеватор кладёт на склад ровно суточную норму за игровые сутки', () => {
    const state = makeState(makeIndustry(ELEV, 'элеватор'))

    const day = run(state, TICKS_PER_DAY)

    expect(at(day, ELEV).stock.зерно).toBeCloseTo(60, 9)
    expect(at(day, ELEV).utilization).toBe(1)
    expect(at(day, ELEV).idleTicks).toBe(0)
  })

  it('темп ровный: половина суток даёт половину нормы', () => {
    const state = makeState(makeIndustry(ELEV, 'элеватор'))

    const half = run(state, TICKS_PER_DAY / 2)

    expect(at(half, ELEV).stock.зерно).toBeCloseTo(30, 9)
  })

  it('полный склад останавливает предприятие', () => {
    // 180 т — трое суток выпуска, склад забит под завязку.
    const state = makeState(makeIndustry(ELEV, 'элеватор', { зерно: 180 }))

    const after = run(state, 1)

    expect(at(after, ELEV).utilization).toBe(0)
    expect(at(after, ELEV).stock.зерно).toBe(180)
    expect(at(after, ELEV).idleTicks).toBe(1)
  })

  it('перед остановкой тормозит, а не выключается', () => {
    // Места осталось 0.2 т при выпуске 0.625 т/тик — работаем на остаток.
    const state = makeState(makeIndustry(ELEV, 'элеватор', { зерно: 179.8 }))

    const after = run(state, 1)

    expect(at(after, ELEV).stock.зерно).toBeCloseTo(180, 9)
    expect(at(after, ELEV).utilization).toBeCloseTo(0.2 / 0.625, 9)
  })

  it('освобождение склада возобновляет работу', () => {
    const state = makeState(makeIndustry(ELEV, 'элеватор', { зерно: 180 }))

    const stalled = run(state, 5)
    expect(at(stalled, ELEV).utilization).toBe(0)
    expect(at(stalled, ELEV).idleTicks).toBe(5)

    // Приехала машина и забрала всё.
    const resumed = run(withStock(stalled, ELEV, {}), 1)

    expect(at(resumed, ELEV).utilization).toBe(1)
    expect(at(resumed, ELEV).stock.зерно).toBeCloseTo(0.625, 9)
    expect(at(resumed, ELEV).idleTicks).toBe(0)
  })
})

describe('runProduction: переработка', () => {
  it('потребляет вход и производит выход в пропорции рецепта', () => {
    // Трое суток зерна на складе — комбинату есть из чего работать сутки.
    const state = makeState(makeIndustry(MILL, 'мукомольный', { зерно: 150 }))

    const day = run(state, TICKS_PER_DAY)

    expect(at(day, MILL).stock.мука).toBeCloseTo(40, 9)
    expect(at(day, MILL).stock.зерно).toBeCloseTo(100, 9)
    expect(at(day, MILL).utilization).toBe(1)
  })

  it('при половине нужного сырья выпуск падает вдвое', () => {
    // ЦБК съедает 0.5 т кругляка за тик — даём ровно половину.
    const state = makeState(makeIndustry(CBK, 'ЦБК', { кругляк: 0.25 }))

    const after = run(state, 1)

    expect(at(after, CBK).stock.пиломатериалы).toBeCloseTo(0.3125 / 2, 9)
    expect(at(after, CBK).utilization).toBeCloseTo(0.5, 9)
    expect(at(after, CBK).stock.кругляк).toBe(0)
  })

  it('дефицит режет темп, а не выключает цепочку', () => {
    // Половина суточной нормы зерна должна дать половину суточной нормы муки —
    // неважно, что кончится она в середине суток.
    const state = makeState(makeIndustry(MILL, 'мукомольный', { зерно: 25 }))

    const day = run(state, TICKS_PER_DAY)

    expect(at(day, MILL).stock.мука).toBeCloseTo(20, 9)
  })

  it('без сырья стоит и ничего не создаёт', () => {
    const state = makeState(makeIndustry(CBK, 'ЦБК'))

    const after = run(state, 10)

    expect(at(after, CBK).stock).toEqual({})
    expect(at(after, CBK).utilization).toBe(0)
    expect(at(after, CBK).idleTicks).toBe(10)
  })

  it('полный склад продукции останавливает и расход сырья', () => {
    // Ключевое для среза: невывезенная мука не даёт сжечь зерно. Завод именно
    // задыхается, а не работает в никуда.
    const state = makeState(
      makeIndustry(MILL, 'мукомольный', { зерно: 150, мука: 120 }),
    )

    const day = run(state, TICKS_PER_DAY)

    expect(at(day, MILL).stock.зерно).toBe(150)
    expect(at(day, MILL).stock.мука).toBe(120)
    expect(at(day, MILL).utilization).toBe(0)
    expect(at(day, MILL).idleTicks).toBe(TICKS_PER_DAY)
  })

  it('баланс массы: на тонну выпуска уходит ровно perUnit сырья', () => {
    const grain = 37
    const state = makeState(makeIndustry(MILL, 'мукомольный', { зерно: grain }))

    // Времени с запасом: зерна хватает примерно на 71 тик.
    const after = run(state, 200)

    const flour = at(after, MILL).stock.мука ?? 0
    const left = at(after, MILL).stock.зерно ?? 0
    const eaten = grain - left

    expect(left).toBe(0)
    expect(eaten).toBeCloseTo(flour * 1.25, 9)
    expect(flour).toBeCloseTo(grain / 1.25, 9)
  })

  it('баланс массы держится и при непрерывном подвозе с вывозом', () => {
    const state = makeState(makeIndustry(MILL, 'мукомольный', { зерно: 150 }))

    // Машины стоят и на входе, и на выходе: муку увозят, зерно досыпают до
    // трёх суток. Проверяем, что за неделю не появилось лишней массы.
    let hauled = 0
    const day = run(state, TICKS_PER_DAY * 7, (s) => {
      hauled += at(s, MILL).stock.мука ?? 0
      return withStock(s, MILL, { зерно: 150 })
    })

    expect(hauled).toBeCloseTo(40 * 7, 6)
    expect(at(day, MILL).utilization).toBe(1)
  })
})

describe('runProduction: простой и деградация', () => {
  it('счётчик простоя растёт при остановке и обнуляется при работе', () => {
    const state = makeState(makeIndustry(ELEV, 'элеватор', { зерно: 180 }))

    const stalled = run(state, 7)
    expect(at(stalled, ELEV).idleTicks).toBe(7)

    const working = run(withStock(stalled, ELEV, {}), 1)
    expect(at(working, ELEV).idleTicks).toBe(0)
  })

  it('до порога мощность не теряется', () => {
    expect(capacityFactor(0)).toBe(1)
    expect(capacityFactor(DEGRADE_AFTER_TICKS)).toBe(1)
    // Сутки сверх порога — минус пять процентов.
    expect(capacityFactor(DEGRADE_AFTER_TICKS + TICKS_PER_DAY)).toBeCloseTo(
      0.95,
      9,
    )
  })

  it('мощность не проваливается ниже пола', () => {
    // Год простоя не должен превращать предприятие в мёртвую точку на карте.
    expect(capacityFactor(TICKS_PER_DAY * 365)).toBe(0.4)
  })

  it('долгий простой снижает выпуск', () => {
    const state = makeState(makeIndustry(ELEV, 'элеватор', { зерно: 180 }))

    // Пятнадцать суток забвения: пять суток сверх порога — минус 25%.
    const forgotten = run(state, TICKS_PER_DAY * 15)
    expect(at(forgotten, ELEV).idleTicks).toBe(TICKS_PER_DAY * 15)

    const first = run(withStock(forgotten, ELEV, {}), 1)

    expect(at(first, ELEV).utilization).toBeCloseTo(0.75, 9)
    expect(at(first, ELEV).stock.зерно).toBeCloseTo(0.625 * 0.75, 9)
  })

  it('работа восстанавливает мощность, но не мгновенно', () => {
    const forgotten = run(
      makeState(makeIndustry(ELEV, 'элеватор', { зерно: 180 })),
      TICKS_PER_DAY * 15,
    )
    const revived = withStock(forgotten, ELEV, {})

    // Двадцать тиков ровной работы — мощность уже растёт, но ещё не паспортная.
    const early = run(revived, 20, hauler(ELEV))
    expect(at(early, ELEV).utilization).toBeGreaterThan(0.75)
    expect(at(early, ELEV).utilization).toBeLessThan(1)

    // 480 тиков ямы при отдаче 4 тика за тик — 121-й рабочий тик уже полный.
    const restored = run(revived, 121, hauler(ELEV))
    expect(at(restored, ELEV).utilization).toBe(1)
    expect(at(restored, ELEV).idleTicks).toBe(0)
  })

  it('брошенный завод не восстанавливается сам, без машин', () => {
    const state = makeState(makeIndustry(ELEV, 'элеватор', { зерно: 180 }))

    const month = run(state, TICKS_PER_DAY * 30)

    expect(at(month, ELEV).utilization).toBe(0)
    expect(capacityFactor(at(month, ELEV).idleTicks)).toBe(0.4)
  })
})

describe('runProduction: чистота фазы', () => {
  it('не мутирует входное состояние', () => {
    const state = makeState(
      makeIndustry(ELEV, 'элеватор', { зерно: 100 }),
      makeIndustry(MILL, 'мукомольный', { зерно: 30 }),
      makeIndustry(CBK, 'ЦБК', { кругляк: 180, пиломатериалы: 90 }),
    )
    const before = JSON.stringify(state)

    run(state, 5)

    expect(JSON.stringify(state)).toBe(before)
  })

  it('возвращает новые объекты, а не правит старые', () => {
    const state = makeState(makeIndustry(ELEV, 'элеватор'))
    const industry = at(state, ELEV)

    const after = runProduction(state)

    expect(after).not.toBe(state)
    expect(at(after, ELEV)).not.toBe(industry)
    expect(at(after, ELEV).stock).not.toBe(industry.stock)
    // Города и дороги фаза не касается — ссылки те же.
    expect(after.world.cities).toBe(state.world.cities)
    expect(after.world.edges).toBe(state.world.edges)
    expect(after.vehicles).toBe(state.vehicles)
  })

  it('мир без предприятий возвращается той же ссылкой', () => {
    const state = makeState()

    expect(runProduction(state)).toBe(state)
  })

  it('предприятия считаются независимо друг от друга', () => {
    // Забитый элеватор не должен мешать работающему комбинату и наоборот.
    const state = makeState(
      makeIndustry(ELEV, 'элеватор', { зерно: 180 }),
      makeIndustry(MILL, 'мукомольный', { зерно: 150 }),
    )

    const day = run(state, TICKS_PER_DAY)

    expect(at(day, ELEV).utilization).toBe(0)
    expect(at(day, ELEV).idleTicks).toBe(TICKS_PER_DAY)
    expect(at(day, MILL).utilization).toBe(1)
    expect(at(day, MILL).stock.мука).toBeCloseTo(40, 9)
  })
})
