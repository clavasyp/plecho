import { describe, expect, it } from 'vitest'
import { CITIES_BY_ID } from '../../data/cities'
import { CONSUMER_CARGO, CONSUMPTION_PER_1K } from '../../data/recipes'
import { cityId, companyId, TICKS_PER_DAY } from '../types'
import type {
  CargoType,
  City,
  CityId,
  CompanyId,
  GameState,
  Tons,
} from '../types'
import {
  demandPerDay,
  GROWTH_PER_MONTH,
  GROWTH_THRESHOLD_DAYS,
  populationLimits,
  runConsumption,
  SHRINK_PER_MONTH,
} from './consumption'

/**
 * Ожидания ВЫВОДЯТСЯ из норм потребления, а не вписаны числами.
 *
 * Раньше здесь стояли посчитанные вручную 30, 25 и 10 тонн. Первая же
 * перебалансировка норм (спрос превышал выпуск мира в двадцать раз, и рост
 * города был недостижим в принципе) уронила тринадцать тестов разом — при том
 * что ни одно ПРАВИЛО не изменилось, изменились только данные. Тест обязан
 * проверять логику потребления, а не помнить цифры из чужого файла.
 *
 * Население в тестах круглое (500 000), а не паспортное: на нём доли считаются
 * ровно. Идентификаторы при этом настоящие — границы населения отсчитываются
 * от справочника мира, и на выдуманном городе эта половина логики просто не
 * проверялась бы.
 */

const TULA = cityId('tula')
const RYAZAN = cityId('ryazan')
const PLAYER: CompanyId = companyId('player')

/** Круглое население для проверок спроса. */
const ROUND_POPULATION = 500_000

/** Суточный спрос по одному грузу на круглом населении, тонн. */
const dailyFor = (cargo: string) =>
  (CONSUMPTION_PER_1K[cargo] ?? 0) * (ROUND_POPULATION / 1000)

/** Суточный спрос города на круглом населении по всем грузам, тонн. */
const DAILY_DEMAND = CONSUMER_CARGO.reduce((sum, c) => sum + dailyFor(c), 0)

/** Суточный спрос на муку — самый частый ориентир в проверках ниже. */
const FLOUR_DAILY = dailyFor('мука')

function makeCity(id: CityId, patch: Partial<City> = {}): City {
  const base = CITIES_BY_ID[id]
  return {
    ...base,
    coord: { ...base.coord },
    population: base.population,
    stock: {},
    suppliedDays: 0,
    ...patch,
  }
}

function makeState(cities: City[]): GameState {
  return {
    rngState: 1,
    tick: 0,
    startYear: 1994,
    world: {
      cities: Object.fromEntries(cities.map((c) => [c.id, c])) as Record<
        CityId,
        City
      >,
      edges: {},
      industries: {},
    },
    companies: {
      // Поля среза 3 (линии, суточный итог, банкротство) достраиваются
      // пустыми: потреблению они не нужны, но без них фикстура не собирается.
      [PLAYER]: {
        id: PLAYER,
        name: 'Игрок',
        money: 0,
        controller: 'человек',
        lines: {},
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

/** Склад, забитый одинаковым количеством каждого потребительского груза. */
function fullStock(tons: Tons): Partial<Record<CargoType, Tons>> {
  return Object.fromEntries(CONSUMER_CARGO.map((cargo) => [cargo, tons]))
}

function runTicks(state: GameState, ticks: number): GameState {
  let next = state
  for (let i = 0; i < ticks; i++) {
    next = runConsumption(next)
  }
  return next
}

function runDays(state: GameState, days: number): GameState {
  return runTicks(state, days * TICKS_PER_DAY)
}

function cityOf(state: GameState, id: CityId): City {
  return state.world.cities[id]
}

/** Сколько всего тонн лежит на складе города. */
function totalStock(city: City): Tons {
  return CONSUMER_CARGO.reduce(
    (sum, cargo) => sum + (city.stock[cargo] ?? 0),
    0,
  )
}

/** Сколько тонн город съест за одни сутки из текущего состояния. */
function eatenPerDay(state: GameState, id: CityId): Tons {
  const before = totalStock(cityOf(state, id))
  const after = totalStock(cityOf(runDays(state, 1), id))
  return before - after
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value)) {
      deepFreeze(inner)
    }
    Object.freeze(value)
  }
  return value
}

describe('потребление со склада', () => {
  it('за игровые сутки город съедает ровно суточную норму', () => {
    const city = makeCity(TULA, {
      population: ROUND_POPULATION,
      stock: fullStock(1000),
    })
    const after = cityOf(runDays(makeState([city]), 1), TULA)

    expect(after.stock['мука']).toBeCloseTo(1000 - FLOUR_DAILY, 9)
    expect(after.stock['топливо']).toBeCloseTo(1000 - dailyFor('топливо'), 9)
    expect(after.stock['пиломатериалы']).toBeCloseTo(
      1000 - dailyFor('пиломатериалы'),
      9,
    )
    expect(totalStock(after)).toBeCloseTo(3000 - DAILY_DEMAND, 9)
  })

  it('за один тик съедает ровно 1/96 суточной нормы', () => {
    const city = makeCity(TULA, {
      population: ROUND_POPULATION,
      stock: fullStock(1000),
    })
    const after = cityOf(runTicks(makeState([city]), 1), TULA)

    expect(after.stock['мука']).toBeCloseTo(1000 - FLOUR_DAILY / TICKS_PER_DAY, 9)
  })

  it('спрос пропорционален населению', () => {
    const small = makeCity(TULA, {
      population: ROUND_POPULATION,
      stock: fullStock(1000),
    })
    const big = makeCity(RYAZAN, {
      population: ROUND_POPULATION * 2,
      stock: fullStock(1000),
    })
    const after = runDays(makeState([small, big]), 1)

    expect(totalStock(cityOf(after, small.id))).toBeCloseTo(
      3000 - DAILY_DEMAND,
      9,
    )
    expect(totalStock(cityOf(after, big.id))).toBeCloseTo(
      3000 - DAILY_DEMAND * 2,
      9,
    )
  })

  it('город без склада не уходит в отрицательный запас', () => {
    // Полсуточной нормы муки: склад кончится к обеду первого же дня, а город
    // будет голодать ещё почти пять суток. Величина выводится из нормы —
    // зашитое число пережило бы перебалансировку и перестало бы значить
    // «меньше суток».
    const city = makeCity(TULA, {
      population: ROUND_POPULATION,
      stock: { 'мука': FLOUR_DAILY / 2 },
    })
    const after = cityOf(runDays(makeState([city]), 5), TULA)

    for (const cargo of CONSUMER_CARGO) {
      expect(after.stock[cargo] ?? 0).toBeGreaterThanOrEqual(0)
    }
    // Опустевшая позиция уходит со склада целиком, а не висит нулём.
    expect(after.stock['мука']).toBeUndefined()
    expect(totalStock(after)).toBe(0)
  })

  it('пустой склад не порождает лишних позиций', () => {
    const city = makeCity(TULA, { population: ROUND_POPULATION })
    const after = cityOf(runDays(makeState([city]), 3), TULA)

    expect(Object.keys(after.stock)).toEqual([])
  })
})

describe('счётчик устойчивости снабжения', () => {
  it('растёт на единицу за сутки полного снабжения', () => {
    const city = makeCity(TULA, {
      population: ROUND_POPULATION,
      stock: fullStock(1000),
    })
    const state = makeState([city])

    expect(cityOf(runTicks(state, 1), TULA).suppliedDays).toBeCloseTo(
      1 / TICKS_PER_DAY,
      9,
    )
    expect(cityOf(runDays(state, 1), TULA).suppliedDays).toBeCloseTo(1, 9)
    expect(cityOf(runDays(state, 3), TULA).suppliedDays).toBeCloseTo(3, 9)
  })

  it('обнуляется, как только не хватило хотя бы одного груза', () => {
    // Пиломатериалов ровно на сутки, остального — с запасом.
    const city = makeCity(TULA, {
      population: ROUND_POPULATION,
      stock: {
        'мука': 1000,
        'топливо': 1000,
        'пиломатериалы': dailyFor('пиломатериалы'),
      },
    })
    const state = makeState([city])

    expect(cityOf(runDays(state, 1), TULA).suppliedDays).toBeCloseTo(1, 6)

    // Следующий же тик — недостача по одному грузу из трёх, серия рвётся.
    const starved = cityOf(runTicks(state, TICKS_PER_DAY + 1), TULA)
    expect(starved.suppliedDays).toBe(0)
    expect(starved.stock['мука']).toBeGreaterThan(0)
  })

  it('после срыва серия считается заново, а не продолжается', () => {
    const city = makeCity(TULA, {
      population: ROUND_POPULATION,
      suppliedDays: 12,
      stock: {},
    })
    const state = makeState([city])

    expect(cityOf(runTicks(state, 1), TULA).suppliedDays).toBe(0)

    // Одна разовая поставка не возвращает потерянные двенадцать суток.
    const restocked = makeState([
      makeCity(TULA, {
        population: ROUND_POPULATION,
        suppliedDays: 0,
        stock: fullStock(1000),
      }),
    ])
    expect(cityOf(runDays(restocked, 1), TULA).suppliedDays).toBeCloseTo(1, 9)
  })
})

describe('рост населения', () => {
  it('не растёт, пока порог устойчивого снабжения не пройден', () => {
    const city = makeCity(TULA, {
      population: ROUND_POPULATION,
      stock: fullStock(100_000),
    })
    const state = makeState([city])

    const before = cityOf(runDays(state, GROWTH_THRESHOLD_DAYS - 1), TULA)
    expect(before.population).toBe(ROUND_POPULATION)
    expect(before.suppliedDays).toBeCloseTo(GROWTH_THRESHOLD_DAYS - 1, 6)
  })

  it('растёт после порога', () => {
    const city = makeCity(TULA, {
      population: ROUND_POPULATION,
      stock: fullStock(100_000),
    })
    const state = makeState([city])

    const after = cityOf(runDays(state, GROWTH_THRESHOLD_DAYS + 1), TULA)
    expect(after.population).toBeGreaterThan(ROUND_POPULATION)

    // Ровно сутки роста — тридцатая часть месячного темпа. Допуск в сотую долю
    // процента, потому что дробный счётчик суток приходит к порогу с ошибкой в
    // последнем знаке и рост может начаться на тик раньше или позже. Пятнадцать
    // игровых минут из трёх недель — цена, которую не жалко.
    const oneDay = ROUND_POPULATION * (1 + GROWTH_PER_MONTH) ** (1 / 30)
    expect(after.population).toBeGreaterThan(oneDay * 0.9999)
    expect(after.population).toBeLessThan(oneDay * 1.0001)
  })

  it('разовая поставка роста не даёт, даже очень большая', () => {
    // Склад на год вперёд, но по одному грузу — серия не наберётся никогда.
    const city = makeCity(TULA, {
      population: ROUND_POPULATION,
      stock: { 'мука': 1_000_000 },
    })
    const after = cityOf(runDays(makeState([city]), 90), TULA)

    expect(after.suppliedDays).toBe(0)
    expect(after.population).toBeLessThan(ROUND_POPULATION)
  })

  it('темп роста — заявленный процент за игровой месяц', () => {
    const city = makeCity(TULA, {
      population: ROUND_POPULATION,
      // Порог уже пройден: проверяем чистый темп, а не разгон.
      suppliedDays: GROWTH_THRESHOLD_DAYS + 1,
      stock: fullStock(100_000),
    })
    const after = cityOf(runDays(makeState([city]), 30), TULA)

    expect(after.population).toBeCloseTo(
      ROUND_POPULATION * (1 + GROWTH_PER_MONTH),
      6,
    )
  })
})

describe('обратная связь: выросший город требует больше', () => {
  it('после роста город съедает за сутки БОЛЬШЕ, чем до него', () => {
    const city = makeCity(TULA, {
      population: ROUND_POPULATION,
      suppliedDays: GROWTH_THRESHOLD_DAYS + 1,
      stock: fullStock(100_000),
    })
    const start = makeState([city])

    // Чуть больше 65: город растёт прямо в течение этих суток, и спрос вместе
    // с ним. Именно это и проверяется дальше, только в большем масштабе.
    const before = eatenPerDay(start, TULA)
    expect(before).toBeCloseTo(DAILY_DEMAND, 1)

    // Полгода устойчивого снабжения — шесть расчётных месяцев роста.
    const grown = runDays(start, 30 * 6)
    const grownPopulation = cityOf(grown, TULA).population
    expect(grownPopulation).toBeCloseTo(
      ROUND_POPULATION * (1 + GROWTH_PER_MONTH) ** 6,
      3,
    )

    const after = eatenPerDay(grown, TULA)

    // Ядро игры: сеть, которая справлялась вчера, сегодня уже не справляется.
    expect(after).toBeGreaterThan(before)
    // И ровно настолько, насколько выросло население.
    expect(after / before).toBeCloseTo(grownPopulation / ROUND_POPULATION, 3)
    // Порог — доля суточной нормы, а не абсолютные тонны: при перебалансировке
    // норм абсолютное число теряет смысл, а отношение остаётся верным.
    expect(after - before).toBeGreaterThan(DAILY_DEMAND * 0.05)
  })

  it('норма считается от текущего населения, а не от стартового', () => {
    const grown = makeCity(TULA, { population: ROUND_POPULATION * 1.5 })
    expect(demandPerDay(grown.population, 'мука')).toBeCloseTo(FLOUR_DAILY * 1.5, 9)
    // Паспортное население Тулы — норма обязана считаться и от него тоже.
    expect(demandPerDay(CITIES_BY_ID[TULA].population, 'мука')).toBeCloseTo(
      (CONSUMPTION_PER_1K['мука'] ?? 0) * (CITIES_BY_ID[TULA].population / 1000),
      9,
    )
  })
})

describe('сжатие населения', () => {
  it('брошенный город теряет жителей', () => {
    const city = makeCity(TULA, { population: ROUND_POPULATION, stock: {} })
    const after = cityOf(runDays(makeState([city]), 30), TULA)

    expect(after.population).toBeLessThan(ROUND_POPULATION)
    expect(after.population).toBeCloseTo(
      ROUND_POPULATION * (1 - SHRINK_PER_MONTH),
      6,
    )
  })

  it('сжимается медленнее, чем растёт: минимум втрое', () => {
    // Один город снабжается сверх порога, другой брошен. Оба стартуют с
    // одинакового населения и оба внутри своего коридора — сравнение честное.
    const growing = makeCity(TULA, {
      population: ROUND_POPULATION,
      suppliedDays: GROWTH_THRESHOLD_DAYS + 1,
      stock: fullStock(100_000),
    })
    const dying = makeCity(RYAZAN, {
      population: ROUND_POPULATION,
      stock: {},
    })
    const after = runDays(makeState([growing, dying]), 30)

    const gain = cityOf(after, TULA).population - ROUND_POPULATION
    const loss = ROUND_POPULATION - cityOf(after, RYAZAN).population

    expect(gain).toBeGreaterThan(0)
    expect(loss).toBeGreaterThan(0)
    // Час игры, вложенный в сеть, не должен обнуляться сутками простоя.
    expect(loss * 3).toBeLessThan(gain)
  })

  it('город, снабжаемый наполовину, теряет меньше брошенного', () => {
    // Мука с запасом, остального нет: закрыта только её доля спроса.
    const partial = makeCity(TULA, {
      population: ROUND_POPULATION,
      stock: { 'мука': 100_000 },
    })
    const abandoned = makeCity(RYAZAN, {
      population: ROUND_POPULATION,
      stock: {},
    })
    const after = runDays(makeState([partial, abandoned]), 30)

    const partialLoss = ROUND_POPULATION - cityOf(after, TULA).population
    const fullLoss = ROUND_POPULATION - cityOf(after, RYAZAN).population

    expect(partialLoss).toBeGreaterThan(0)
    expect(partialLoss).toBeLessThan(fullLoss)
    // Дефицит 1 − 30/65 масштабирует темп сжатия напрямую.
    expect(partialLoss / fullLoss).toBeCloseTo(1 - FLOUR_DAILY / DAILY_DEMAND, 3)
  })
})

describe('границы населения', () => {
  it('рост упирается в потолок и не переходит его', () => {
    const { max } = populationLimits(makeCity(TULA))
    const city = makeCity(TULA, {
      population: max * 0.999,
      suppliedDays: GROWTH_THRESHOLD_DAYS + 1,
      stock: fullStock(1_000_000),
    })
    const state = makeState([city])

    // Двух месяцев роста хватило бы на +2% — потолок ближе.
    expect(cityOf(runDays(state, 60), TULA).population).toBeCloseTo(max, 6)
    // И дальше он не сдвигается ни на человека.
    expect(cityOf(runDays(state, 360), TULA).population).toBeCloseTo(max, 6)
  })

  it('сжатие упирается в пол и не переходит его', () => {
    const { min } = populationLimits(makeCity(TULA))
    const city = makeCity(TULA, { population: min * 1.02, stock: {} })
    const state = makeState([city])

    expect(cityOf(runDays(state, 365 * 3), TULA).population).toBeCloseTo(min, 6)
    expect(cityOf(runDays(state, 365 * 10), TULA).population).toBeCloseTo(
      min,
      6,
    )
  })

  it('город вне коридора не телепортируется к границе', () => {
    // Такое состояние приходит из сейва другой версии или из сценария.
    // Коридор обязан только останавливать движение, но не толкать.
    const { min } = populationLimits(makeCity(TULA))
    const tiny = min / 3
    const city = makeCity(TULA, { population: tiny, stock: {} })

    expect(cityOf(runDays(makeState([city]), 30), TULA).population).toBe(tiny)

    // При этом выбраться наверх такой город может — рост ему не запрещён.
    const fed = makeCity(TULA, {
      population: tiny,
      suppliedDays: GROWTH_THRESHOLD_DAYS + 1,
      stock: fullStock(100_000),
    })
    expect(
      cityOf(runDays(makeState([fed]), 30), TULA).population,
    ).toBeGreaterThan(tiny)
  })

  it('коридор отсчитывается от паспортного населения города', () => {
    const limits = populationLimits(makeCity(TULA))
    const base = CITIES_BY_ID[TULA].population

    expect(limits.min).toBeCloseTo(base * 0.6, 6)
    expect(limits.max).toBeCloseTo(base * 2, 6)
    // Текущее население на коридор не влияет — иначе он ездил бы за городом.
    expect(populationLimits(makeCity(TULA, { population: 1 }))).toEqual(limits)
  })
})

describe('чистота функции', () => {
  it('не мутирует вход ни на одном уровне вложенности', () => {
    const city = makeCity(TULA, {
      population: ROUND_POPULATION,
      suppliedDays: GROWTH_THRESHOLD_DAYS + 1,
      stock: fullStock(1000),
    })
    const state = deepFreeze(makeState([city]))

    // На замороженном состоянии любая мутация — исключение (модули строгие).
    const after = runConsumption(state)

    expect(city.population).toBe(ROUND_POPULATION)
    expect(city.stock['мука']).toBe(1000)
    expect(city.suppliedDays).toBe(GROWTH_THRESHOLD_DAYS + 1)

    // Результат — новые объекты на всех тронутых уровнях.
    expect(after).not.toBe(state)
    expect(after.world.cities).not.toBe(state.world.cities)
    expect(cityOf(after, TULA)).not.toBe(city)
    expect(cityOf(after, TULA).stock).not.toBe(city.stock)
    expect(cityOf(after, TULA).population).toBeGreaterThan(ROUND_POPULATION)
  })

  it('выдерживает сотню тиков на замороженном состоянии', () => {
    const state = deepFreeze(
      makeState([
        makeCity(TULA, {
          population: ROUND_POPULATION,
          stock: fullStock(1000),
        }),
        makeCity(RYAZAN, { population: ROUND_POPULATION }),
      ]),
    )

    expect(() => runTicks(state, 100)).not.toThrow()
  })

  it('возвращает то же состояние, когда меняться нечему', () => {
    // Город на полу, склад пуст, серия снабжения уже нулевая.
    const { min } = populationLimits(makeCity(TULA))
    const state = makeState([
      makeCity(TULA, { population: min, stock: {}, suppliedDays: 0 }),
    ])

    expect(runConsumption(state)).toBe(state)
  })

  it('пустой мир проходит фазу без изменений', () => {
    const state = makeState([])
    expect(runConsumption(state)).toBe(state)
  })
})
