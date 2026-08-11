import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * ДОРОГА НА КАРТЕ СТРАНЫ.
 *
 * Здесь проверяется не то, что лежит в буферах, — это уже доказывает
 * __plechoRoads, — а то, ПОПАДАЕТ ЛИ ЛЕНТА В ПИКСЕЛИ КАДРА.
 *
 * Разница между двумя вопросами стоила проекту дорожной сети дважды. Первый раз
 * зимой: полотно #4d5a6b и заснеженная земля #4d5a68 оказались одним цветом с
 * точностью до последнего разряда. Второй раз на карте страны: при 4 км на
 * пиксель лента шириной 3.4 км даёт 0.85 пикселя, а полоса тоньше пикселя не
 * тускнеет — она рассыпается в рваный пунктир, потому что растеризатор берёт
 * фрагмент только когда центр пикселя попал внутрь треугольника. Оба раза все
 * тесты были зелёными: и буферы, и цвета, и число вершин были ровно те, что
 * задуманы.
 *
 * Прибор — __plechoRibbonWidth (Scene.tsx): читает нарисованный холст и меряет
 * ширину ленты на полувысоте, как меряют линию в оптике.
 */

type Dev = {
  __plecho: {
    getState: () => {
      setSpeed: (speed: number) => void
      advance: (ticks: number) => void
    }
  }
  __plechoLook?: (id: string, factor?: number) => void
  __plechoRoads?: () => {
    roadClass: string
    quads: number
    tint: number
    widened: boolean
  }[]
  __plechoRibbonWidth?: (
    edgeId: string,
    reach?: number,
  ) => {
    width: number
    contrast: number
    at: { x: number; y: number }
    profile: number[]
  } | null
}

/**
 * Во сколько раз отдалена камера в «карте страны».
 *
 * 0.34 — это ZOOM_OUT_LIMIT из Scene.tsx, то есть САМЫЙ ДАЛЬНИЙ вид, который
 * игрок вообще может получить колесом мыши. Проверять надо именно предел:
 * промежуточные зумы лента переживала и без пола.
 */
const COUNTRY = 0.34

/**
 * Ребро для замера — М-7 Нижний Новгород — Казань, 400 км, федеральная.
 *
 * Выбрано не наугад. Оно ДАЛЕКО ОТ МОСКВЫ, а под Москвой на общем плане в один
 * пиксель сходится восемь трасс, и прибор мерил бы не ленту, а их сумму: замер
 * на М-2 давал там пятнадцать пикселей ширины вместо двух с небольшим. Здесь
 * рядом нет ничего, и число означает ровно то, что написано.
 */
const LONE_EDGE = 'nizhny-kazan'

/**
 * Сколько тиков прокрутить до лета.
 *
 * Замер идёт НА ЛЕТНЕЙ ЗЕМЛЕ, и это честная оговорка, а не удобство. Зимой
 * контраст полотна к снегу держится на 0.02 при уровне плёночного зерна 0.012,
 * то есть лента едва отличима от фона и замер её ширины неустойчив: соседние
 * прогоны дают от нуля до четырёх пикселей на одном и том же ребре. Это
 * отдельная незакрытая беда карты, и подпирать ею проверку пиксельного пола
 * нельзя — тест обязан падать от того, что сломался пол, а не от того, что
 * пошёл снег.
 */
const SUMMER_TICKS = 96 * 190

async function boot(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(
    () => (globalThis as Record<string, unknown>).__plechoRibbonWidth !== undefined,
    undefined,
    { timeout: 30_000 },
  )
  await page.evaluate(() => {
    ;(globalThis as unknown as Dev).__plecho.getState().setSpeed(0)
  })
}

async function frame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
}

async function ribbonAt(
  page: Page,
  factor: number,
  reach: number,
  edge: string,
): Promise<{ width: number; contrast: number; profile: number[] }> {
  await page.evaluate(
    ([f]) => (globalThis as unknown as Dev).__plechoLook?.('moscow', f as number),
    [factor] as const,
  )
  // Два кадра: первый рисует новую камеру, второй гарантирует, что холст, из
  // которого читает прибор, — уже новый.
  await frame(page)
  await frame(page)

  const report = await page.evaluate(
    ([id, r]) =>
      (globalThis as unknown as Dev).__plechoRibbonWidth?.(
        id as string,
        r as number,
      ) ?? null,
    [edge, reach] as const,
  )

  expect(report, `прибор видит ${edge} на кратности ${factor}`).not.toBeNull()
  return report as { width: number; contrast: number; profile: number[] }
}

test('на карте страны федеральная лента не тоньше пикселя', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })

  await boot(page)
  await page.evaluate(
    (ticks) => (globalThis as unknown as Dev).__plecho.getState().advance(ticks),
    SUMMER_TICKS,
  )

  const country = await ribbonAt(page, COUNTRY, 14, LONE_EDGE)

  /*
   * ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ И ПОЧЕМУ ЭТОГО ХВАТАЕТ.
   *
   * На предельном отдалении геометрическая ширина федеральной ленты — от 0.32
   * до 0.55 пикселя: 3.4 км при 0.227 пикселя на километр, с поправкой на то,
   * что изометрия по-разному сжимает диагонали. Значит замер в ДВА пикселя и
   * больше не может получиться из геометрии — он получается только из
   * пиксельного пола в вершинном шейдере (render/pixelFloor.ts), который
   * поднимает ленту до 2.2. Отдельный замер «до правки» для этого не нужен:
   * его роль играет арифметика.
   *
   * Замерено на этом ребре: 3–4 пикселя при контрасте 0.07–0.105 в трёх
   * прогонах подряд.
   */
  expect(
    country.width,
    'лента шире двух пикселей, то есть пол сработал',
  ).toBeGreaterThanOrEqual(2)

  expect(
    country.contrast,
    'лента отличается от земли заметно сильнее плёночного зерна',
  ).toBeGreaterThan(0.03)

  await page.screenshot({ path: 'tests/e2e/screenshots/roads-country.png' })
  expect(errors, 'консоль чистая').toEqual([])
})

test('смещение от оси доезжает до геометрии всех классов', async ({ page }) => {
  await boot(page)
  await frame(page)

  const report = await page.evaluate(
    () => (globalThis as unknown as Dev).__plechoRoads?.() ?? null,
  )
  expect(report, 'RoadMesh докладывает о живых буферах').not.toBeNull()

  /*
   * САМЫЙ ТИХИЙ ИЗ ВОЗМОЖНЫХ ОТКАЗОВ: атрибут aWiden не доехал до геометрии.
   *
   * Тогда драйвер подставляет нули, каждая вершина решает, что она и так лежит
   * на оси ленты, и пиксельный пол не срабатывает НИ РАЗУ — без единой ошибки
   * компиляции, без предупреждения в консоли и без разницы в буферах позиций.
   * Проверка стоит здесь, потому что она дешевле замера пикселей и ловит ровно
   * тот случай, который замер объяснить не сможет.
   */
  for (const layer of report as { roadClass: string; widened: boolean }[]) {
    expect(layer.widened, `у ленты «${layer.roadClass}» есть смещение`).toBe(true)
  }
})

test('полотно весь год держится темнее земли', async ({ page }) => {
  await boot(page)

  /*
   * САМАЯ ВАЖНАЯ ПРОВЕРКА ЭТОГО ФАЙЛА, И ОНА НЕ ПРО ПИКСЕЛИ.
   *
   * Здесь охраняется структурное свойство: множитель полотна считается ОТ
   * ЗЕМЛИ (RoadMesh.tsx) и потому никогда не проводит дорогу сквозь её тон.
   * До этой правки множитель был функцией одной лишь зимы и за год проходил от
   * 0.42 до 1.0, а земля стояла на 0.099 при полотне 0.0995 — пересечение было
   * неизбежным, и замер понедельно ловил его: контраст 0.005–0.015 на 42–56-е
   * сутки при уровне плёночного зерна 0.012.
   *
   * Проверять это ПИКСЕЛЯМИ было бы неправильно. Замер по кадру честен, но
   * шумен: погода, снежная пелена и соседняя геометрия дают разброс вдвое на
   * одном и том же ребре, и порог по нему получился бы либо мигающим, либо
   * бессмысленно мягким. Множитель же — число детерминированное, и коридор для
   * него — ровно то утверждение, которое мы хотим сделать: «полотно ВСЕГДА
   * заметно темнее земли и никогда не равно ей».
   *
   * Замерено на прогоне в год с шагом 28 суток: 0.33…0.49.
   */
  const tints: number[] = []
  for (let step = 0; step < 13; step++) {
    if (step > 0) {
      await page.evaluate(
        (ticks) =>
          (globalThis as unknown as Dev).__plecho.getState().advance(ticks),
        96 * 28,
      )
    }
    await frame(page)
    const report = await page.evaluate(
      () => (globalThis as unknown as Dev).__plechoRoads?.() ?? null,
    )
    expect(report, 'RoadMesh докладывает о живых буферах').not.toBeNull()
    tints.push((report as { tint: number }[])[0].tint)
  }

  const lowest = Math.min(...tints)
  const highest = Math.max(...tints)

  expect(
    highest,
    `полотно не подходит к тону земли (множители за год: ${tints.map((t) => t.toFixed(2)).join(' ')})`,
  ).toBeLessThan(0.7)
  expect(
    lowest,
    'и не проваливается в чёрное на тёмной летней земле',
  ).toBeGreaterThan(0.2)
})

test('туман не съедает страну на общем плане', async ({ page }) => {
  await boot(page)

  /*
   * Числа fogRange подбирались под округ в 600 км. Страна вчетверо шире, и на
   * общем плане дальний край кадра уходил в дымку на 61% — половина России
   * растворялась ровно тогда, когда игрок хотел её увидеть. Теперь туман
   * растягивается вместе с кадром (Scene.tsx), и перепад дымки поперёк экрана
   * одинаков на любом зуме.
   *
   * Проверяется СЛЕДСТВИЕ, а не сама формула: дальняя граница тумана обязана
   * уехать за карту, когда камера отошла. Триста километров — это меньше
   * половины ЦФО, то есть заведомо ближе любой правдоподобной границы для
   * страны; больше пяти тысяч — дальше самой карты, тумана нет вовсе.
   */
  const near = await page.evaluate(() => {
    const w = globalThis as unknown as { __plechoSky?: () => { fogFar: number } }
    return w.__plechoSky?.().fogFar ?? 0
  })

  await page.evaluate(
    ([f]) => (globalThis as unknown as Dev).__plechoLook?.('moscow', f as number),
    [COUNTRY] as const,
  )
  await frame(page)
  await frame(page)

  const far = await page.evaluate(() => {
    const w = globalThis as unknown as { __plechoSky?: () => { fogFar: number } }
    return w.__plechoSky?.().fogFar ?? 0
  })

  expect(far, 'на общем плане туман отодвигается').toBeGreaterThan(near * 2)
  expect(far, 'и отодвигается за пределы карты').toBeGreaterThan(3000)
})
