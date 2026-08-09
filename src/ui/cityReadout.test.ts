/**
 * Проверка того, что панель города говорит игроку ПРАВДУ.
 *
 * Проверяется не разметка (ui/CityPanel.tsx), а слой чтения мира
 * (ui/cityReadout.ts) — функции, превращающие снимок состояния в ответ на
 * вопрос «почему завод стоит». Разметку ломает дизайнер, и это видно глазом;
 * эти же функции ломаются молча: числа остаются правдоподобными, а смысл
 * меняется на противоположный.
 *
 * ГЛАВНЫЙ ТЕСТ ЗДЕСЬ — «диагноз совпадает с настоящим прогоном». Он гоняет
 * реальный runProduction на тех же предприятиях и сверяет предсказание панели с
 * фактической загрузкой. Именно такое расхождение в проекте уже случалось: две
 * формулы скорости разъехались, машина ездила медленнее, чем считал поиск пути,
 * и ни один тест не покраснел (разбор — в шапке sim/world/speed.ts). Панель,
 * рисующая «нет сырья» у работающего завода, — та же ошибка, только заметнее.
 */

import { describe, expect, it } from 'vitest'
import { CONSUMPTION_PER_1K } from '../data/recipes'

import { RECIPE_BY_INDUSTRY } from '../data/recipes'
import {
  IDLE_UTILIZATION,
  STOCK_DAYS,
  runProduction,
} from '../sim/economy/production'
import { GROWTH_THRESHOLD_DAYS } from '../sim/economy/consumption'
import { createInitialState } from '../sim/state'
import { TICKS_PER_DAY, cityId, industryId } from '../sim/types'
import type {
  CargoType,
  City,
  GameState,
  Industry,
  IndustryId,
  IndustryType,
  Tons,
} from '../sim/types'
import {
  cityStockLines,
  citySupplyStatus,
  describeIndustry,
} from './cityReadout'

/** Предприятие с заданным складом. Счётчики нулевые, если не сказано иначе. */
function makeIndustry(
  type: IndustryType,
  stock: Partial<Record<CargoType, Tons>>,
  idleTicks = 0,
): Industry {
  return {
    id: industryId(`test-${type}`),
    type,
    cityId: cityId('test-city'),
    stock,
    utilization: 0,
    idleTicks,
  }
}

/**
 * Прогнать одно предприятие через настоящую фазу производства.
 *
 * Собирается минимальное состояние, потому что runProduction смотрит только в
 * world.industries. Подсовывать сюда полноценную партию значило бы завязать
 * тест на данные мира — а проверяется формула, а не Тула.
 */
function tickOnce(industry: Industry): Industry {
  const state = {
    world: { cities: {}, edges: {}, industries: { [industry.id]: industry } },
  } as unknown as GameState

  return runProduction(state).world.industries[industry.id]
}

/** Город с заданным населением и складом. */
function makeCity(population: number, stock: City['stock'] = {}): City {
  return {
    id: cityId('test-city'),
    name: 'Тест',
    coord: { lat: 55, lon: 37 },
    profile: 'промышленный',
    population,
    stock,
    suppliedDays: 0,
  }
}

describe('диагноз предприятия', () => {
  it('снабжённая переработка работает и ни на что не жалуется', () => {
    // Зерна на трое суток, склад муки почти пуст — ничто не мешает.
    const view = describeIndustry(makeIndustry('мукомольный', { зерно: 150 }))

    expect(view.status).toBe('работает')
    expect(view.reasons).toEqual([])
    expect(view.factor).toBe(1)
  })

  it('пустой склад сырья читается как «нет сырья», а не как «мало»', () => {
    const view = describeIndustry(makeIndustry('мукомольный', { зерно: 0 }))

    expect(view.status).toBe('стоит')
    expect(view.reasons).toContain('нет сырья — зерно')
    expect(view.inputs[0].note).toBe('нет')
    expect(view.inputs[0].urgent).toBe(true)
  })

  it('крохи сырья дают «не хватает», а не «нет» — это разные советы игроку', () => {
    // Тонны зерна хватит на 0.8 тонны муки, а паспортный темп — 0.42 т за тик.
    // Завод работает, но в четверть силы, и игроку надо ускорить подвоз, а не
    // начинать его с нуля.
    const view = describeIndustry(makeIndustry('мукомольный', { зерно: 0.1 }))

    expect(view.status).toBe('снижает темп')
    expect(view.reasons).toContain('сырья не хватает — зерно')
    expect(view.reasons).not.toContain('нет сырья — зерно')
  })

  it('полный склад продукции останавливает даже снабжённый завод', () => {
    const capacity = RECIPE_BY_INDUSTRY['мукомольный'].dailyRate * STOCK_DAYS
    const view = describeIndustry(
      makeIndustry('мукомольный', { зерно: 150, мука: capacity }),
    )

    expect(view.status).toBe('стоит')
    expect(view.reasons).toContain('склад продукции полон — некуда производить')
    // Сырьё при этом есть, и панель не должна валить вину на него: игрок,
    // повёзший сюда ещё зерна, потерял бы рейс впустую.
    expect(view.reasons.join(' ')).not.toContain('сырья')
    expect(view.output?.note).toBe('полон')
  })

  it('источник останавливается только собственным складом', () => {
    const capacity = RECIPE_BY_INDUSTRY['элеватор'].dailyRate * STOCK_DAYS
    const full = describeIndustry(makeIndustry('элеватор', { зерно: capacity }))

    expect(full.inputs).toEqual([])
    expect(full.status).toBe('стоит')
    expect(full.reasons).toEqual(['склад продукции полон — некуда производить'])

    // Пустой источник работает: сырьё ему не нужно по определению.
    expect(describeIndustry(makeIndustry('элеватор', {})).status).toBe('работает')
  })

  it('запас выхода считается в сутках ДО ЗАПОЛНЕНИЯ — это дедлайн приезда', () => {
    // Мельница: 40 т/сут, склад 120 т. Лежит 40 → свободно 80 → двое суток.
    const view = describeIndustry(
      makeIndustry('мукомольный', { зерно: 150, мука: 40 }),
    )

    expect(view.output?.note).toBe('2.0 сут')
  })

  it('долгий простой урезает мощность и объясняет это отдельной строкой', () => {
    // Двадцать суток простоя: десять до порога деградации и десять после,
    // по пять процентов за сутки — половина мощности.
    const view = describeIndustry(
      makeIndustry('мукомольный', { зерно: 150 }, 20 * TICKS_PER_DAY),
    )

    expect(view.factor).toBeCloseTo(0.5, 5)
    expect(view.idleDays).toBe(20)
    // Завод при этом РАБОТАЕТ — просто вполсилы. Назвать это остановкой значило
    // бы отправить игрока чинить то, что уже чинится само.
    expect(view.status).toBe('работает')
  })
})

describe('диагноз совпадает с настоящим прогоном производства', () => {
  /**
   * Вместимость склада по грузу — по той же формуле, что в производстве.
   *
   * Тест обязан считать её сам, а не звать stockCapacity: иначе он проверял бы
   * согласованность панели с самой собой. Совпадение чисел здесь и в
   * production.ts — часть того, что проверяется.
   */
  function capacity(type: IndustryType, cargo: CargoType): Tons {
    const recipe = RECIPE_BY_INDUSTRY[type]
    const perUnit =
      cargo === recipe.output
        ? 1
        : (recipe.inputs.find((it) => it.type === cargo)?.perUnit ?? 0)
    return recipe.dailyRate * perUnit * STOCK_DAYS
  }

  const cases: [name: string, industry: Industry][] = [
    ['мельница со снабжением', makeIndustry('мукомольный', { зерно: 150 })],
    ['мельница без зерна', makeIndustry('мукомольный', {})],
    [
      'мельница с забитым складом',
      makeIndustry('мукомольный', {
        зерно: 150,
        мука: capacity('мукомольный', 'мука'),
      }),
    ],
    ['мельница на крохах', makeIndustry('мукомольный', { зерно: 0.1 })],
    ['ЦБК без кругляка', makeIndustry('ЦБК', {})],
    ['НПЗ со снабжением', makeIndustry('НПЗ', { нефть: 200 })],
    ['элеватор', makeIndustry('элеватор', {})],
    [
      'элеватор с забитым складом',
      makeIndustry('элеватор', { зерно: capacity('элеватор', 'зерно') }),
    ],
    [
      'мельница после месяца простоя',
      makeIndustry('мукомольный', { зерно: 150 }, 30 * TICKS_PER_DAY),
    ],
  ]

  it.each(cases)('%s', (_name, industry) => {
    const view = describeIndustry(industry)
    const after = tickOnce(industry)

    if (view.status === 'стоит') {
      // Порог простоя в симуляции — тот же самый: предприятие, объявленное
      // стоящим, обязано начать копить idleTicks.
      expect(after.utilization).toBeLessThanOrEqual(IDLE_UTILIZATION)
      expect(after.idleTicks).toBe(industry.idleTicks + 1)
    } else if (view.status === 'работает') {
      // Ничем не ограничено — значит выпуск равен доступной мощности, а она
      // и есть factor от паспортной.
      expect(after.utilization).toBeCloseTo(view.factor, 9)
    } else {
      expect(after.utilization).toBeGreaterThan(IDLE_UTILIZATION)
      expect(after.utilization).toBeLessThan(view.factor)
    }
  })

  it('на стартовой партии панель согласна с миром по каждому предприятию', () => {
    const state = createInitialState(1)
    const next = runProduction(state)

    for (const id of Object.keys(state.world.industries) as IndustryId[]) {
      const view = describeIndustry(state.world.industries[id])
      const after = next.world.industries[id]

      // Стартовые склады собраны так, чтобы всё работало (см. data/industries.ts):
      // это и проверяем — партия не должна начинаться со стоящих заводов.
      expect(view.status, id).toBe('работает')
      expect(after.utilization, id).toBeCloseTo(1, 9)
    }
  })
})

describe('склад города', () => {
  it('пустой склад при живом спросе — «нет», а не «0.0 сут»', () => {
    const lines = cityStockLines(makeCity(100_000))

    for (const line of lines) {
      expect(line.note).toBe('нет')
      expect(line.urgent).toBe(true)
    }
  })

  it('запас переводится в сутки по той же норме, по которой город ест', () => {
    // Запас ровно на пять суток — величина выводится из нормы, а не вписана
    // числом: перебалансировка норм не должна ронять проверку формата.
    const daily = (CONSUMPTION_PER_1K['мука'] ?? 0) * 100
    const lines = cityStockLines(makeCity(100_000, { мука: daily * 5 }))
    const flour = lines.find((line) => line.cargo === 'мука')

    expect(flour?.note).toBe('5.0 сут')
    expect(flour?.urgent).toBe(false)
  })

  it('город без жителей не получает выдуманного спроса', () => {
    for (const line of cityStockLines(makeCity(0))) {
      expect(line.note).toBe('—')
      expect(line.urgent).toBe(false)
    }
  })
})

describe('снабжение и рост города', () => {
  it('обнулённая серия названа прямо', () => {
    expect(citySupplyStatus(makeCity(100_000))).toContain('прервано')
  })

  it('накопление серии показывает, сколько осталось до порога роста', () => {
    const city = { ...makeCity(100_000), suppliedDays: 5 }

    expect(citySupplyStatus(city)).toContain(String(GROWTH_THRESHOLD_DAYS))
  })

  it('порог взят из симуляции, а не переписан числом', () => {
    const growing = {
      ...makeCity(100_000),
      suppliedDays: GROWTH_THRESHOLD_DAYS + 0.01,
    }
    const waiting = {
      ...makeCity(100_000),
      suppliedDays: GROWTH_THRESHOLD_DAYS - 0.01,
    }

    expect(citySupplyStatus(growing)).toContain('растёт')
    expect(citySupplyStatus(waiting)).not.toContain('растёт')
  })
})
