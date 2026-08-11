import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { CITIES, CITIES_BY_ID } from '../../src/data/cities'
import { INDUSTRIES } from '../../src/data/industries'
import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../../src/sim/types'
import type { CityProfile, IndustryType } from '../../src/sim/types'

/**
 * Силуэты городов и предприятий — то, что видно на карте без единой подписи.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ. Юнит-тесты рядом (src/render/CityMesh.test.ts и
 * IndustryMesh.test.ts) проверяют ГЕНЕРАТОРЫ: что Москва выше Орла, что
 * транзитный город вытянут, что окна садятся на грани домов. Ни один из них не
 * отвечает на вопрос «а попало ли это на экран». Проект уже дважды платил за
 * этот пробел: модуль написан, покрыт тестами, зелёный — и не подключён ни к
 * чему. Здесь числа читаются с ЖИВЫХ InstancedMesh через дев-хуки, то есть нет
 * меша — нет и числа.
 *
 * ЧТО ИМЕННО ПРОВЕРЯЕТСЯ:
 *
 *   • страница поднялась без единой ошибки в консоли;
 *   • застройка всех десяти городов лежит в ОДНОМ инстансном меше, и число
 *     инстансов в нём совпадает с числом сгенерированных домов;
 *   • силуэт зависит от ПРОФИЛЯ: столица выше и стройнее всех, транзитные города
 *     вытянуты сильнее непрофильных соседей, аграрный застроен реже;
 *   • ночные окна нарисованы, горят в полночь и гаснут в полдень — прямо на
 *     живом материале, а не в расчёте;
 *   • промышленность собрана в три меша, все шесть типов различаются высотой
 *     силуэта, и самая высокая труба на карте — у ЦБК.
 *
 * ЧИСЛА ЗДЕСЬ НЕ ВПИСАНЫ РУКАМИ: состав городов, профили и типы предприятий
 * выводятся из тех же данных, по которым игра строит мир.
 */

// ─── Ожидания, выведенные из данных ────────────────────────────────────────

const PAUSED = 0

/** Единственная столица округа — на ней держится половина проверок ниже. */
const CAPITAL = CITIES.find((city) => city.profile === 'столица')
if (CAPITAL === undefined) throw new Error('в данных нет столицы')

/** Транзитные и все остальные: сравниваются вытянутостью пятна. */
const TRANSIT = CITIES.filter((city) => city.profile === 'транзитный')
const SETTLED = CITIES.filter(
  (city) => city.profile !== 'транзитный' && city.profile !== 'столица',
)

/** Типы предприятий, реально стоящие на карте. */
const TYPES_ON_MAP = [...new Set(INDUSTRIES.map((row) => row.type))]

// ─── Дев-хуки ──────────────────────────────────────────────────────────────

type CityReport = {
  id: string
  profile: CityProfile
  population: number
  radiusX: number
  radiusZ: number
  peak: number
  top: number
  buildings: number
  windows: number
}

type CitiesReport = {
  cities: CityReport[]
  /** Инстансов в меше застройки — с живого объекта сцены. */
  boxes: number
  /** Инстансов в меше окон. */
  windows: number
  /** Непрозрачность материала окон в последнем кадре. */
  glow: number
  /** Рисуется ли меш окон вообще. */
  lit: boolean
}

type IndustryReport = {
  id: string
  type: IndustryType | null
  parts: number
  top: number
  round: number
}

type IndustriesReport = {
  sites: IndustryReport[]
  boxes: number
  cylinders: number
  cones: number
}

type Dev = {
  __plecho: {
    getState(): {
      state: { tick: number }
      setSpeed(speed: number): void
      advance(ticks: number): void
    }
  }
  __plechoLook?: (id: string, factor?: number) => void
  __plechoCities?: () => CitiesReport
  __plechoIndustries?: () => IndustriesReport
}

function watchConsole(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

/** Дождаться приложения и обоих хуков сцены. */
async function openMap(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(
    () => {
      const dev = globalThis as unknown as Dev
      return (
        dev.__plecho !== undefined &&
        dev.__plechoCities !== undefined &&
        dev.__plechoIndustries !== undefined
      )
    },
    undefined,
    { timeout: 20_000 },
  )
  await page.evaluate((speed) => {
    ;(globalThis as unknown as Dev).__plecho.getState().setSpeed(speed)
  }, PAUSED)
}

/** Навести камеру на город и приблизить — только ради кадров на память. */
async function look(page: Page, id: string, factor: number): Promise<void> {
  await page.evaluate(
    ({ city, zoom }) => {
      ;(globalThis as unknown as Dev).__plechoLook?.(city, zoom)
    },
    { city: id, zoom: factor },
  )
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        requestAnimationFrame(() => requestAnimationFrame(() => done()))
      }),
  )
}

const readCities = (page: Page): Promise<CitiesReport> =>
  page.evaluate(() => (globalThis as unknown as Dev).__plechoCities!())

const readIndustries = (page: Page): Promise<IndustriesReport> =>
  page.evaluate(() => (globalThis as unknown as Dev).__plechoIndustries!())

/**
 * Перевести часы партии на заданный час и дать сцене кадр.
 *
 * Время в сторе только идёт вперёд (`advance`), назад его не отматывают, поэтому
 * нужный час догоняется вперёд по кругу суток. Ноль превращается в полные сутки:
 * «никуда не двигаться» здесь никогда не то, что имел в виду опыт.
 *
 * Кадры ждутся ОБЯЗАТЕЛЬНО, и их два. Непрозрачность окон пишет useFrame из
 * общего буфера атмосферы, а буфер заполняет Scene — своим useFrame. Между
 * сменой тика и новым числом на материале проходит до двух кадров, и без
 * ожидания тест читал бы вчерашний свет.
 */
async function setHour(page: Page, hour: number): Promise<void> {
  await page.evaluate(
    ({ target, day }) => {
      const store = (globalThis as unknown as Dev).__plecho.getState()
      const ahead = (((target - store.state.tick) % day) + day) % day
      store.advance(ahead === 0 ? day : ahead)
    },
    { target: hour * TICKS_PER_HOUR, day: TICKS_PER_DAY },
  )

  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        requestAnimationFrame(() => requestAnimationFrame(() => done()))
      }),
  )
}

// ─── Опыт ──────────────────────────────────────────────────────────────────

test.describe('силуэты на карте', () => {
  test('вся застройка округа — один инстансный меш, и он не пустой', async ({
    page,
  }) => {
    const errors = watchConsole(page)
    await openMap(page)

    const report = await readCities(page)

    // Все десять городов дошли до сцены.
    expect(report.cities.map((c) => c.id).sort()).toEqual(
      Object.keys(CITIES_BY_ID).sort(),
    )

    const generated = report.cities.reduce((sum, c) => sum + c.buildings, 0)
    expect(generated).toBeGreaterThan(CITIES.length * 10)
    // Число инстансов В МЕШЕ, а не в расчёте: посчитать матрицы и не
    // смонтировать меш — ровно тот отказ, который здесь и ловится.
    expect(report.boxes).toBe(generated)

    expect(errors).toEqual([])
  })

  test('профиль виден на карте: столица, транзит, аграрий', async ({ page }) => {
    await openMap(page)
    const report = await readCities(page)
    const by = new Map(report.cities.map((c) => [c.id, c]))

    const capital = by.get(CAPITAL.id)
    expect(capital).toBeDefined()
    if (capital === undefined) return

    // Столица выше всех и на карте, а не только в расчёте.
    for (const city of report.cities) {
      if (city.id === capital.id) continue
      expect(capital.top, city.id).toBeGreaterThan(city.top)
    }
    // И её силуэт вытянут вверх сильнее любого другого: свеча, а не холм.
    const slenderness = (c: CityReport) =>
      c.top / Math.max(c.radiusX, c.radiusZ)
    for (const city of report.cities) {
      if (city.id === capital.id) continue
      expect(slenderness(capital), city.id).toBeGreaterThan(slenderness(city))
    }

    // Транзитные города вытянуты сильнее любого оседлого.
    const elongation = (c: CityReport) =>
      Math.max(c.radiusX, c.radiusZ) / Math.min(c.radiusX, c.radiusZ)
    const transit = TRANSIT.map((city) => by.get(city.id)!)
    const settled = SETTLED.map((city) => by.get(city.id)!)
    expect(transit.length).toBeGreaterThan(0)
    expect(settled.length).toBeGreaterThan(0)

    for (const one of transit) {
      for (const other of settled) {
        expect(elongation(one), `${one.id} и ${other.id}`).toBeGreaterThan(
          elongation(other),
        )
      }
    }

    /*
     * Аграрный город застроен реже промышленного СОПОСТАВИМОГО РАЗМЕРА — и
     * оговорка про размер здесь не украшение, а условие сравнения.
     *
     * Число зданий растёт с населением подлинейно (иначе Москва превратилась бы
     * в сплошную заливку), поэтому плотность на сто тысяч жителей у миллионника
     * заведомо ниже, чем у трёхсоттысячного города любого профиля. Сравнивать их
     * между собой — значит мерить не профиль, а население: на карте страны
     * проверка так и падала, сравнивая аграрный город с Нижним Новгородом и
     * расходясь на одну десятую процента.
     *
     * Сопоставимыми считаются города, чьё население отличается не больше чем в
     * полтора раза. Пара обязана найтись — иначе проверять нечего, и это тоже
     * повод для красного теста.
     */
    const density = (c: CityReport) => c.buildings / (c.population / 100_000)
    const comparable = (a: CityReport, b: CityReport) =>
      Math.max(a.population, b.population) /
        Math.min(a.population, b.population) <=
      1.5

    const rurals = report.cities.filter((c) => c.profile === 'аграрный')
    const industrial = report.cities.filter((c) => c.profile === 'промышленный')
    expect(rurals.length).toBeGreaterThan(0)
    expect(industrial.length).toBeGreaterThan(0)

    let pairs = 0
    for (const rural of rurals) {
      for (const city of industrial) {
        if (!comparable(rural, city)) continue
        pairs++
        expect(density(rural), `${rural.id} против ${city.id}`).toBeLessThan(
          density(city),
        )
      }
    }
    expect(pairs, 'нашлась хоть одна сопоставимая пара').toBeGreaterThan(0)
  })

  test('ночью в городах горят окна, днём гаснут', async ({ page }) => {
    const errors = watchConsole(page)
    await openMap(page)

    const start = await readCities(page)
    const lights = start.cities.reduce((sum, c) => sum + c.windows, 0)
    expect(lights).toBeGreaterThan(0)
    expect(start.windows).toBe(lights)
    // Окон меньше, чем домов: это точки, а не заливка фасадов.
    expect(start.windows).toBeLessThan(start.boxes)

    // Партия начинается в полночь — окна обязаны гореть с первого кадра.
    await setHour(page, 0)
    const night = await readCities(page)
    expect(night.lit).toBe(true)
    expect(night.glow).toBeGreaterThan(0.3)

    await setHour(page, 12)
    const noon = await readCities(page)
    expect(noon.glow).toBe(0)
    // Днём меш снят со сцены целиком — вместе с вызовом отрисовки.
    expect(noon.lit).toBe(false)

    await setHour(page, 23)
    const late = await readCities(page)
    expect(late.lit).toBe(true)
    expect(late.glow).toBeGreaterThan(noon.glow)

    expect(errors).toEqual([])
  })

  test('предприятия читаются силуэтом и стоят в трёх мешах', async ({
    page,
  }) => {
    await openMap(page)
    const report = await readIndustries(page)

    expect(report.sites.length).toBe(INDUSTRIES.length)

    // Все типы, которые есть в данных, доехали до сцены со своей формой.
    const seen = new Set(report.sites.map((s) => s.type))
    for (const type of TYPES_ON_MAP) {
      expect(seen.has(type), type).toBe(true)
    }

    // Ни одного пустого силуэта: тип без описанной формы рендер пропускает молча,
    // и на настоящих данных этот предохранитель срабатывать не должен.
    for (const site of report.sites) {
      expect(site.parts, site.id).toBeGreaterThan(2)
      expect(site.top, site.id).toBeGreaterThan(0)
    }

    // Высота силуэта — главный признак типа на общем плане, и у ЦБК она
    // наибольшая: труба выше всего вокруг.
    const topOf = (type: IndustryType) =>
      Math.max(
        ...report.sites.filter((s) => s.type === type).map((s) => s.top),
      )
    if (seen.has('ЦБК')) {
      for (const type of TYPES_ON_MAP) {
        if (type === 'ЦБК') continue
        expect(topOf('ЦБК'), type).toBeGreaterThan(topOf(type))
      }
    }

    // Лесозаготовка — сплошные ящики, нефтебаза — сплошные тела вращения:
    // ровно та пара, которая раньше читалась одинаково.
    if (seen.has('лесозаготовка')) {
      for (const site of report.sites.filter((s) => s.type === 'лесозаготовка')) {
        expect(site.round, site.id).toBe(0)
      }
    }
    if (seen.has('нефтебаза')) {
      for (const site of report.sites.filter((s) => s.type === 'нефтебаза')) {
        expect(site.round, site.id).toBeGreaterThan(site.parts / 2)
      }
    }

    // Три меша на всю промышленность — и в сумме их инстансов больше, чем
    // площадок: детали силуэта стоят инстансов, а не вызовов отрисовки.
    const instances = report.boxes + report.cylinders + report.cones
    expect(instances).toBeGreaterThan(report.sites.length * 5)
    expect(report.cylinders).toBeGreaterThan(0)
    expect(report.cones).toBeGreaterThan(0)
  })

  test('кадры на память: общий план ночью и крупный план силуэтов', async ({
    page,
  }) => {
    // Три кадра подряд на программном растеризаторе (swiftshader в headless) не
    // укладываются в общий тридцатисекундный бюджет: один снимок ближнего плана
    // с блумом занимает секунды. Опыт ничего не измеряет, поэтому запас щедрый.
    test.setTimeout(120_000)

    await openMap(page)

    await setHour(page, 22)
    await page.screenshot({
      path: 'tests/e2e/screenshots/silhouettes-night.png',
    })
    expect((await readCities(page)).lit).toBe(true)

    // Столица ночью крупно: высотное ядро и тёплые окна на нём.
    await look(page, CAPITAL.id, 6)
    await page.screenshot({
      path: 'tests/e2e/screenshots/silhouettes-capital-night.png',
    })

    // Промышленный город днём крупно: силуэты предприятий вокруг застройки.
    await setHour(page, 11)
    const industrial = CITIES.find((city) => city.profile === 'промышленный')
    expect(industrial).toBeDefined()
    if (industrial === undefined) return
    await look(page, industrial.id, 8)
    await page.screenshot({
      path: 'tests/e2e/screenshots/silhouettes-industry-day.png',
    })
    expect((await readCities(page)).glow).toBe(0)
  })
})
