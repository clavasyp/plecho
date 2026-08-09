import { describe, expect, it } from 'vitest'
import { INDUSTRIES, INDUSTRIES_BY_ID } from './industries'
import { CITIES_BY_ID } from './cities'
import { EDGES } from './roads'
import { RECIPES, RECIPE_BY_INDUSTRY } from './recipes'
import { cityId } from '../sim/types'
import type { CargoType, CityId, IndustryType, Recipe } from '../sim/types'

/**
 * Проверки на расстановку предприятий.
 *
 * Здесь почти нет проверок типов — их держит компилятор. Здесь проверяется то,
 * что компилятор проверить не может и что ломается молча: цепочка, замкнувшаяся
 * внутри одного города, источник без потребителя, переработка без сырья. Ни
 * одна из этих ошибок не падает при запуске — игра просто перестаёт быть игрой,
 * и заметить это можно только сыграв партию.
 */

// ─── Разбор цепочек из данных ──────────────────────────────────────────────

/** Источник — предприятие без входного сырья. Определение из recipes.ts. */
const isSource = (recipe: Recipe) => recipe.inputs.length === 0

const SOURCE_RECIPES = RECIPES.filter(isSource)
const PROCESSING_RECIPES = RECIPES.filter((recipe) => !isSource(recipe))

/**
 * Цепочка: кто добывает сырьё, кто его перерабатывает и что получается.
 *
 * Цепочки выводятся из RECIPES, а не перечисляются здесь списком. Добавят
 * четвёртую цепочку в данных — тест начнёт проверять и её, не заметив разницы.
 * Список в тесте пришлось бы править вручную, и когда-нибудь его бы забыли.
 */
type Chain = {
  cargo: CargoType
  sourceType: IndustryType
  processingType: IndustryType
}

const CHAINS: Chain[] = PROCESSING_RECIPES.flatMap((processing) =>
  processing.inputs.map((input) => {
    const source = SOURCE_RECIPES.find(
      (candidate) => candidate.output === input.type,
    )
    if (!source) {
      throw new Error(
        `в RECIPES нет источника груза «${input.type}» для ${processing.industryType}`,
      )
    }
    return {
      cargo: input.type,
      sourceType: source.industryType,
      processingType: processing.industryType,
    }
  }),
)

/** Города, в которых стоит хотя бы одно предприятие данного типа. */
const citiesOf = (type: IndustryType): CityId[] =>
  INDUSTRIES.filter((industry) => industry.type === type).map(
    (industry) => industry.cityId,
  )

// ─── Расстояния по дорогам ─────────────────────────────────────────────────

/**
 * Кратчайшее расстояние между городами по километрам.
 *
 * Дейкстра на восемнадцати рёбрах — здесь это дешевле, чем тянуть в тест
 * src/sim/world/pathfind.ts: тот считает по ВРЕМЕНИ и требует машину, а нас
 * интересует длина плеча сама по себе, безотносительно того, кто по ней едет.
 */
function roadDistance(from: CityId, to: CityId): number {
  const best = new Map<string, number>([[from, 0]])
  const pending = new Set<string>([from])

  while (pending.size > 0) {
    let current = ''
    let currentCost = Number.POSITIVE_INFINITY
    for (const candidate of pending) {
      const cost = best.get(candidate)!
      if (cost < currentCost) {
        current = candidate
        currentCost = cost
      }
    }
    pending.delete(current)

    for (const edge of EDGES) {
      if (edge.from !== current && edge.to !== current) continue
      const next = edge.from === current ? edge.to : edge.from
      const cost = currentCost + edge.km
      if (cost < (best.get(next) ?? Number.POSITIVE_INFINITY)) {
        best.set(next, cost)
        pending.add(next)
      }
    }
  }

  return best.get(to) ?? Number.POSITIVE_INFINITY
}

/** Есть ли прямая дорога между городами — то есть плечо в одно ребро. */
const areAdjacent = (a: CityId, b: CityId): boolean =>
  EDGES.some(
    (edge) =>
      (edge.from === a && edge.to === b) || (edge.from === b && edge.to === a),
  )

/** Кратчайшее плечо цепочки: от ближайшего источника до ближайшей переработки. */
function shortestLeg(chain: Chain): number {
  const legs = citiesOf(chain.sourceType).flatMap((source) =>
    citiesOf(chain.processingType).map((plant) => roadDistance(source, plant)),
  )
  return Math.min(...legs)
}

// ─── Тесты ─────────────────────────────────────────────────────────────────

describe('предприятия ЦФО', () => {
  it('предприятия есть — тест не проходит вхолостую', () => {
    expect(INDUSTRIES.length).toBeGreaterThan(0)
    expect(CHAINS.length).toBeGreaterThan(0)
  })

  it('идентификаторы уникальны', () => {
    const ids = INDUSTRIES.map((industry) => industry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('INDUSTRIES_BY_ID согласован с INDUSTRIES', () => {
    expect(Object.keys(INDUSTRIES_BY_ID)).toHaveLength(INDUSTRIES.length)
    for (const industry of INDUSTRIES) {
      // Именно тот же объект, а не копия: два представления одного завода —
      // источник неотлаживаемых расхождений в складе.
      expect(INDUSTRIES_BY_ID[industry.id]).toBe(industry)
    }
  })

  it('каждое предприятие стоит в существующем городе', () => {
    for (const industry of INDUSTRIES) {
      // Опечатка в идентификаторе города не ломает сборку, а тихо отвязывает
      // завод от карты: он есть в состоянии, но его нигде не видно.
      expect(CITIES_BY_ID[industry.cityId], industry.id).toBeDefined()
    }
  })

  it('тип каждого предприятия описан рецептом', () => {
    for (const industry of INDUSTRIES) {
      expect(RECIPE_BY_INDUSTRY[industry.type], industry.id).toBeDefined()
    }
  })

  it('источник и переработка одной цепочки стоят в разных городах', () => {
    // ГЛАВНОЕ ПРАВИЛО ФАЙЛА. Элеватор рядом с мельницей — цепочка, замкнутая
    // внутри забора: сырьё доходит транспортёром, машина не нужна, и игра в
    // этом месте кончается. Проверяем ВСЕ пары, а не только очевидные: одного
    // совпадения хватит, чтобы обесценить цепочку целиком.
    for (const chain of CHAINS) {
      const sources = new Set<string>(citiesOf(chain.sourceType))
      const collisions = citiesOf(chain.processingType).filter((city) =>
        sources.has(city),
      )
      expect(collisions, `${chain.sourceType} → ${chain.processingType}`).toEqual(
        [],
      )
    }
  })

  it('ни один город не содержит цепочку целиком', () => {
    // Формулировка от города, а не от цепочки: та же беда, увиденная с другой
    // стороны. Если правило когда-нибудь обойдут хитрым третьим звеном, здесь
    // это будет видно как «в Туле есть всё, что нужно, и ехать некуда».
    const guilty = Object.keys(CITIES_BY_ID)
      .map(cityId)
      .filter((city) => {
        const types = new Set(
          INDUSTRIES.filter((industry) => industry.cityId === city).map(
            (industry) => industry.type,
          ),
        )
        return CHAINS.some(
          (chain) =>
            types.has(chain.sourceType) && types.has(chain.processingType),
        )
      })
    expect(guilty).toEqual([])
  })

  it('у каждой переработки есть источник её сырья на карте', () => {
    // Завод без источника сырья не остановится драматично — он просто никогда
    // не запустится после того, как проест стартовый запас, и игрок будет
    // ходить вокруг него, не понимая, чего тот хочет.
    for (const chain of CHAINS) {
      if (citiesOf(chain.processingType).length === 0) continue
      expect(
        citiesOf(chain.sourceType).length,
        `${chain.processingType} ждёт ${chain.cargo}, а ${chain.sourceType} на карте нет`,
      ).toBeGreaterThan(0)
    }
  })

  it('у каждого источника есть потребитель его продукции', () => {
    // Зеркальная проверка. Источник без потребителя забивает склад и встаёт
    // навсегда: возить его груз некуда, и он превращается в декорацию.
    for (const chain of CHAINS) {
      if (citiesOf(chain.sourceType).length === 0) continue
      expect(
        citiesOf(chain.processingType).length,
        `${chain.sourceType} даёт ${chain.cargo}, а ${chain.processingType} на карте нет`,
      ).toBeGreaterThan(0)
    }
  })

  it('на карте нет предприятия без цепочки', () => {
    // Тип, не попавший ни в одну цепочку, — либо забытый рецепт, либо забытая
    // расстановка. И то и другое лучше узнать здесь.
    const inChains = new Set<IndustryType>()
    for (const chain of CHAINS) {
      inChains.add(chain.sourceType)
      inChains.add(chain.processingType)
    }
    for (const industry of INDUSTRIES) {
      expect(inChains.has(industry.type), industry.id).toBe(true)
    }
  })

  it('выпуск источников покрывает потребность переработки', () => {
    // Меньше — цепочка не может работать на полную даже при идеальной
    // логистике, и виноват будет не игрок. Много больше — источники встают
    // с забитым складом, что тоже не его вина. Коридор узкий сознательно.
    for (const chain of CHAINS) {
      const supply = citiesOf(chain.sourceType).length
      const supplyTons = supply * RECIPE_BY_INDUSTRY[chain.sourceType].dailyRate

      const processing = RECIPE_BY_INDUSTRY[chain.processingType]
      const perUnit = processing.inputs.find(
        (input) => input.type === chain.cargo,
      )!.perUnit
      const demandTons =
        citiesOf(chain.processingType).length * processing.dailyRate * perUnit

      expect(supplyTons, chain.cargo).toBeGreaterThanOrEqual(demandTons)
      expect(supplyTons, chain.cargo).toBeLessThanOrEqual(demandTons * 1.5)
    }
  })

  it('в столице нет предприятий', () => {
    // Москва в срезе 2 — чистый спрос. Завод здесь отгружал бы продукцию через
    // дорогу: нулевое плечо, нулевая выручка и конец главного конфликта игры,
    // где в столицу едет всё, а обратно ехать не с чем.
    const capitals = Object.values(CITIES_BY_ID)
      .filter((city) => city.profile === 'столица')
      .map((city) => city.id)

    const inCapital = INDUSTRIES.filter((industry) =>
      capitals.includes(industry.cityId),
    ).map((industry) => industry.id)

    expect(inCapital).toEqual([])
  })

  it('не все цепочки замыкаются одним ребром', () => {
    // Если бы каждая цепочка укладывалась в одну дорогу между соседями, все
    // рейсы в игре были бы на одно лицо и выбор маршрута исчез бы.
    const adjacentChains = CHAINS.filter((chain) =>
      citiesOf(chain.sourceType).some((source) =>
        citiesOf(chain.processingType).some((plant) =>
          areAdjacent(source, plant),
        ),
      ),
    )
    expect(adjacentChains.length).toBeLessThan(CHAINS.length)
  })

  it('плечи цепочек различаются по длине в разы', () => {
    // Разнообразие плеч — это и есть разнообразие задач: короткое кормит
    // новичка частыми рейсами, длинное требует второй машины и планирования.
    const legs = CHAINS.map(shortestLeg)
    for (const leg of legs) expect(Number.isFinite(leg)).toBe(true)

    expect(Math.min(...legs)).toBeGreaterThan(0)
    expect(Math.max(...legs)).toBeGreaterThanOrEqual(Math.min(...legs) * 2)
  })

  it('на старте предприятия ещё не работали', () => {
    for (const industry of INDUSTRIES) {
      // Ноль здесь означает «тика ещё не было», а не «завод стоит».
      expect(industry.utilization, industry.id).toBe(0)
      expect(industry.idleTicks, industry.id).toBe(0)
    }
  })

  it('на складе лежат только грузы своего рецепта', () => {
    // Тонна нефти на элеваторе никого не сломает, но означает опечатку в
    // данных, а дальше — груз, который невозможно ни произвести, ни потребить.
    for (const industry of INDUSTRIES) {
      const recipe = RECIPE_BY_INDUSTRY[industry.type]
      const allowed = new Set<CargoType>([
        recipe.output,
        ...recipe.inputs.map((input) => input.type),
      ])
      for (const cargo of Object.keys(industry.stock) as CargoType[]) {
        expect(allowed.has(cargo), `${industry.id}: ${cargo}`).toBe(true)
      }
    }
  })

  it('количества на складе положительные и конечные', () => {
    for (const industry of INDUSTRIES) {
      for (const [cargo, tons] of Object.entries(industry.stock)) {
        expect(Number.isFinite(tons), `${industry.id}: ${cargo}`).toBe(true)
        expect(tons, `${industry.id}: ${cargo}`).toBeGreaterThan(0)
      }
    }
  })

  it('у переработки на старте есть сырьё на несколько суток', () => {
    // Пустой входной склад означал бы, что завод встаёт на первом тике и копит
    // простой, пока единственный ЗИЛ ещё едет через полкарты. Наказание за
    // расстояние, а не за решение игрока.
    for (const industry of INDUSTRIES) {
      const recipe = RECIPE_BY_INDUSTRY[industry.type]
      for (const input of recipe.inputs) {
        const perDay = recipe.dailyRate * input.perUnit
        const stock = industry.stock[input.type] ?? 0
        expect(stock, `${industry.id}: ${input.type}`).toBeGreaterThanOrEqual(
          perDay * 2,
        )
      }
    }
  })

  it('на складе есть готовая продукция — первой машине есть что взять', () => {
    for (const industry of INDUSTRIES) {
      const recipe = RECIPE_BY_INDUSTRY[industry.type]
      expect(
        industry.stock[recipe.output] ?? 0,
        `${industry.id}: ${recipe.output}`,
      ).toBeGreaterThan(0)
    }
  })

  it('идентификатор предприятия начинается с города, в котором оно стоит', () => {
    // Соглашение вида 'orel-elevator': в отладке и в логе сразу видно, где
    // именно встал завод, без похода в справочник.
    for (const industry of INDUSTRIES) {
      expect(industry.id.startsWith(`${industry.cityId}-`), industry.id).toBe(
        true,
      )
    }
  })
})
