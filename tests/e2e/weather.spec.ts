import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Погода на экране.
 *
 * ЗАЧЕМ СКВОЗНОЙ, А НЕ ЮНИТ. Модель погоды — чистая функция, и её кривые
 * проверяет src/render/Weather.test.ts. Здесь проверяется другое и непроверяемое
 * иначе: что слой СМОНТИРОВАН в сцену, что зимой он показывает снег, осенью —
 * дождь, а в ясный день честно уходит из отрисовки. Ровно на этом месте в срезах
 * 1 и 2 умирали целые компоненты — написанные, покрытые тестами и никуда не
 * подключённые.
 *
 * ПОЧЕМУ НЕ СРАВНЕНИЕ ПИКСЕЛЕЙ. Кадр каждый раз разный: поверх сцены лежит
 * зерно, которое меняется каждый кадр по построению. Поэтому спрашиваем у живых
 * объектов сцены (дев-хук __plechoWeather) и у счётчика вызовов отрисовки
 * рендерера — величины, которые нельзя получить, не нарисовав.
 *
 * ПОЧЕМУ ВРЕМЯ ПЕРЕВОДИТСЯ РУКАМИ. Игровые сутки на ×1 идут двадцать секунд, то
 * есть до октября живая партия добиралась бы два часа. Тик правится в обход
 * симуляции — это законно ровно потому, что опыт про КАРТИНКУ: погода читает из
 * состояния два числа, tick и startYear, и больше ничего.
 */

/** Скорость «пауза» — время не идёт, тик стоит там, куда его поставили. */
const PAUSED = 0

/**
 * Тики, на которых снимается погода. Все — ровно полночь, чтобы сравнение
 * вызовов отрисовки не задевало ничего, что зависит от часа суток.
 *
 * Даты выбраны по модели (см. Weather.test.ts): 1 января — снегопад на полном
 * покрове, 10 сентября — ливень с дымкой, 26 мая — сухой день без покрова.
 */
const TICKS_PER_DAY = 96
/** Полдень: тик — пятнадцать минут, значит половина суток это 48 тиков. */
const NOON = TICKS_PER_DAY / 2
const SNOWFALL = 0
const DOWNPOUR = 252 * TICKS_PER_DAY
const CLEAR_DAY = 145 * TICKS_PER_DAY

type Report = {
  intensity: number
  rain: number
  cover: number
  haze: number
  kind: string
  flakes: boolean
  veil: boolean
  capacity: number
}

type Dev = {
  __plecho: {
    getState(): {
      setSpeed(speed: number): void
      state: { tick: number; startYear: number }
    }
    setState(patch: (store: { state: object }) => unknown): void
  }
  __plechoLook?: (id: string, factor?: number) => void
  __plechoWeather?: () => Report
  __plechoRenderer?: { info: { render: { calls: number } } }
}

async function boot(page: Page): Promise<string[]> {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(
    () => (globalThis as Record<string, unknown>).__plechoWeather !== undefined,
    undefined,
    { timeout: 20_000 },
  )
  await page.evaluate((speed) => {
    ;(globalThis as unknown as Dev).__plecho.getState().setSpeed(speed)
  }, PAUSED)

  return errors
}

/** Перевести часы партии на заданный тик и дождаться, пока это увидит кадр. */
async function setTick(page: Page, tick: number): Promise<void> {
  await page.evaluate((value) => {
    const store = (globalThis as unknown as Dev).__plecho
    // Правка без мутации, теми же правилами, что и действия стора: prev тоже
    // переводится, иначе интерполяция машин попыталась бы проехать полгода за
    // один кадр.
    store.setState(({ state }) => ({
      state: { ...state, tick: value },
      prev: { ...state, tick: value },
    }))
  }, tick)

  // Ждём не таймаутом, а самим отчётом: он обновляется в кадре, значит его
  // изменение и есть доказательство, что кадр прошёл.
  await page.waitForFunction(
    (value) => {
      const report = (globalThis as unknown as Dev).__plechoWeather
      const store = (globalThis as unknown as Dev).__plecho
      return report !== undefined && store.getState().state.tick === value
    },
    tick,
    { timeout: 10_000 },
  )
  await page.waitForTimeout(300)
}

async function weather(page: Page): Promise<Report> {
  return page.evaluate(() => {
    const report = (globalThis as unknown as Dev).__plechoWeather
    if (report === undefined) throw new Error('дев-хук погоды не поднялся')
    return report()
  })
}

/**
 * Вызовов отрисовки за ОДИН полный кадр, со всеми проходами постпроцессинга.
 *
 * Читать info.render.calls «когда придётся» бессмысленно: рендерер сбрасывает
 * счётчик на каждом вызове render, а композер вызывает его по разу на эффект —
 * снаружи всегда виден хвост последнего прохода, то есть единица. Поэтому
 * автосброс выключается, а счётчик обнуляется и снимается на границах соседних
 * кадров.
 *
 * Порядок обработчиков requestAnimationFrame — порядок их регистрации, а цикл
 * игры зарегистрировался при монтировании, то есть задолго до нас: наш
 * обработчик кадра N выполняется уже ПОСЛЕ того, как кадр N нарисован. Значит
 * обнуление на кадре N и снятие на кадре N+1 отмеряют ровно один кадр.
 */
async function framePasses(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const renderer = (globalThis as unknown as Dev).__plechoRenderer
        if (renderer === undefined) {
          resolve(0)
          return
        }

        const info = renderer.info as unknown as {
          autoReset: boolean
          reset(): void
          render: { calls: number }
        }

        info.autoReset = false
        requestAnimationFrame(() => {
          info.reset()
          requestAnimationFrame(() => {
            const calls = info.render.calls
            info.autoReset = true
            resolve(calls)
          })
        })
      }),
  )
}

// Времени кадра здесь намеренно нет. Headless-хром рисует программным
// растеризатором и в два потока сразу: замеры на нём отличались втрое от прогона
// к прогону и однажды показали ЯСНЫЙ день дороже снегопада. Число, которое врёт
// в обе стороны, хуже отсутствия числа — цена погоды меряется вызовами
// отрисовки, а они детерминированы.

test('зимой на карте идёт снег и лежит снежный покров', async ({ page }) => {
  const errors = await boot(page)

  const winter = await weather(page)
  expect(winter.kind).toBe('снег')
  expect(winter.intensity).toBeGreaterThan(0.5)
  expect(winter.rain).toBeLessThan(0.1)
  // Покров — это и есть «карта белеет»: он лежит на земле независимо от того,
  // сыплет ли прямо сейчас.
  expect(winter.cover).toBeGreaterThan(0.9)

  // Оба объекта в списке отрисовки — то, ради чего этот тест существует.
  expect(winter.flakes, 'осадки смонтированы и видны').toBe(true)
  expect(winter.veil, 'снежное поле смонтировано и видно').toBe(true)
  expect(winter.capacity).toBeGreaterThan(1000)

  expect(errors).toEqual([])
})

test('осенью идёт дождь и стоит дымка, а снега на земле нет', async ({ page }) => {
  const errors = await boot(page)
  await setTick(page, DOWNPOUR)

  const autumn = await weather(page)
  expect(autumn.kind).toBe('дождь')
  expect(autumn.intensity).toBeGreaterThan(0.3)
  expect(autumn.rain).toBeGreaterThan(0.8)
  expect(autumn.haze).toBeGreaterThan(0.4)
  // Земля осенью голая, но пелена всё равно на сцене — её держит дымка.
  expect(autumn.cover).toBeLessThan(0.1)
  expect(autumn.flakes).toBe(true)
  expect(autumn.veil).toBe(true)

  expect(errors).toEqual([])
})

test('в ясный день погоды нет ни на экране, ни в счёте кадра', async ({ page }) => {
  test.setTimeout(120_000)
  const errors = await boot(page)

  // Оба замера — на один и тот же час суток. Сцена вокруг погоды живёт своей
  // жизнью (свет, огни городов), и сравнивать полдень с полуночью значило бы
  // мерить чужую разницу вместе со своей.
  await setTick(page, SNOWFALL + NOON)
  const snowyPasses = await framePasses(page)

  await setTick(page, CLEAR_DAY + NOON)

  const clear = await weather(page)
  expect(clear.kind).toBe('ясно')
  expect(clear.intensity).toBeLessThan(0.05)
  expect(clear.cover).toBeLessThan(0.1)
  expect(clear.haze).toBeLessThan(0.05)

  // Главное требование среза: выключенный эффект не стоит ничего. Невидимый
  // объект остаётся в сцене, но не попадает в список отрисовки — и это видно
  // счётчиком рендерера, а не рассуждением.
  expect(clear.flakes).toBe(false)
  expect(clear.veil).toBe(false)

  const clearPasses = await framePasses(page)

  // eslint-disable-next-line no-console
  console.log(
    `вызовов отрисовки за кадр: снегопад ${snowyPasses}, ясно ${clearPasses}`,
  )

  expect(snowyPasses, 'зимой рисуются оба погодных объекта').toBeGreaterThan(2)
  expect(clearPasses, 'в ясный день на два вызова отрисовки меньше').toBe(
    snowyPasses - 2,
  )

  expect(errors).toEqual([])
})

test('снимки погоды', async ({ page }) => {
  test.setTimeout(180_000)
  await boot(page)

  // Снимки — полуденные. Ночью в кадре решает не погода, а свет, и по ночному
  // снимку нельзя судить, белеет ли карта.
  await setTick(page, SNOWFALL + NOON)
  await page.screenshot({ path: 'tests/e2e/screenshots/weather-winter.png' })

  // Вблизи видно форму частиц и позёмку по земле.
  await page.evaluate(() => {
    ;(globalThis as unknown as Dev).__plechoLook?.('moscow', 6)
  })
  await page.waitForTimeout(600)
  await page.screenshot({ path: 'tests/e2e/screenshots/weather-winter-close.png' })

  await setTick(page, DOWNPOUR + NOON)
  await page.screenshot({ path: 'tests/e2e/screenshots/weather-autumn-close.png' })

  await page.evaluate(() => {
    ;(globalThis as unknown as Dev).__plechoLook?.('moscow', 1)
  })
  await page.waitForTimeout(600)
  await page.screenshot({ path: 'tests/e2e/screenshots/weather-autumn.png' })

  await setTick(page, CLEAR_DAY + NOON)
  await page.screenshot({ path: 'tests/e2e/screenshots/weather-clear.png' })

  await setTick(page, SNOWFALL)
  await page.screenshot({ path: 'tests/e2e/screenshots/weather-winter-night.png' })
})
