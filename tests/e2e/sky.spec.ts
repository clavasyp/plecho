import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { dateFromTick, daysInMonth, daysInYear } from '../../src/sim/time'
import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../../src/sim/types'

/**
 * Время суток, сезон и эпоха — НА ЭКРАНЕ, а не в панели.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ. Кривая света проверена юнит-тестом
 * (src/render/sky.test.ts): там доказано, что полдень светлее полуночи, что цвет
 * не прыгает на границе суток и года, что зимой земля белеет. Юнит-тест не
 * способен доказать одного — что всё это КУДА-ТО ПОДКЛЮЧЕНО. В проекте дважды
 * случалось ровно это: модуль написан, зелёный и не смонтирован ни в одну сцену
 * (разбор — в шапке render/Scene.tsx). Свет суток — идеальный кандидат на третий
 * раз: он не добавляет ни одного объекта в кадр, поэтому его отсутствие
 * выглядит не как поломка, а как «ну, тускловато».
 *
 * ЧТО ИМЕННО ЗДЕСЬ ПРОВЕРЯЕТСЯ. Показания снимаются с ЖИВЫХ объектов Three
 * через __plechoSky: цвет фона канваса, цвет и дальность тумана, цвет, сила и
 * положение обоих источников, цвет материала подложки, насыщенность грейда.
 * Повторный вызов чистой функции подтвердил бы только сам себя; здесь
 * подтверждается, что числа доехали до сцены.
 *
 * ПОЧЕМУ ВРЕМЯ ПОДМЕНЯЕТСЯ, А НЕ ОТМАТЫВАЕТСЯ. Партия начинается 1 января в
 * 00:00, до июльского полудня — около семнадцати тысяч тиков симуляции, и
 * прогонять их в браузере ради одного снимка бессмысленно. Дев-хук
 * __plechoTime подменяет время ТОЛЬКО для рендера и ничего не пишет в
 * состояние. Последний тест в файле закрывает дыру, которую подмена оставляет:
 * там время идёт само, без всяких хуков.
 *
 * НИ ОДНОГО ВПИСАННОГО РУКАМИ ТИКА. Номера тиков считаются из календаря
 * (sim/time.ts) по датам, а год начала партии читается из состояния: партия,
 * начавшаяся не в 1994-м, не должна ронять тест на арифметике.
 */

// ─── Показания сцены ───────────────────────────────────────────────────────

type Sky = {
  background: string | null
  fog: string | null
  fogFar: number | null
  key: string | null
  keyIntensity: number | null
  keyDirection: { x: number; y: number; z: number } | null
  fill: string | null
  fillIntensity: number | null
  ambient: string | null
  ambientIntensity: number | null
  ground: string | null
  saturation: number
  sun: number
  daylight: number
  twilight: number
  winter: number
}

declare global {
  interface Window {
    __plechoSky?: () => Sky
    __plechoTime?: (tick: number | null) => void
    __plecho?: {
      getState: () => {
        state: { startYear: number; tick: number }
        setSpeed: (speed: number) => void
        advance: (ticks: number) => void
      }
    }
  }
}

/** Тик заданной даты. Считается по тому же календарю, что и в игре. */
function tickOf(
  startYear: number,
  year: number,
  month: number,
  day: number,
  hour: number,
): number {
  let days = 0
  for (let y = startYear; y < year; y++) days += daysInYear(y)
  for (let m = 1; m < month; m++) days += daysInMonth(year, m)
  days += day - 1
  return days * TICKS_PER_DAY + hour * TICKS_PER_HOUR
}

/** Яркость по каналам '#rrggbb' без решётки — как отдаёт getHexString(). */
function luma(hex: string | null): number {
  if (hex === null) throw new Error('цвет не прочитан со сцены')
  const packed = Number.parseInt(hex, 16)
  const r = ((packed >> 16) & 0xff) / 255
  const g = ((packed >> 8) & 0xff) / 255
  const b = (packed & 0xff) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Насколько цвет тёплый: красный минус синий. */
function warmth(hex: string | null): number {
  if (hex === null) throw new Error('цвет не прочитан со сцены')
  const packed = Number.parseInt(hex, 16)
  return ((packed >> 16) & 0xff) / 255 - (packed & 0xff) / 255
}

/** Наибольшее расхождение двух цветов по каналам. */
function gap(a: string | null, b: string | null): number {
  if (a === null || b === null) throw new Error('цвет не прочитан со сцены')
  const left = Number.parseInt(a, 16)
  const right = Number.parseInt(b, 16)
  let worst = 0
  for (let shift = 0; shift <= 16; shift += 8) {
    const delta = Math.abs(((left >> shift) & 0xff) - ((right >> shift) & 0xff))
    worst = Math.max(worst, delta / 255)
  }
  return worst
}

/** Поднять игру и дождаться дев-хуков сцены. */
async function open(page: Page): Promise<number> {
  await page.goto('/')
  await page.waitForFunction(
    () => window.__plechoSky !== undefined && window.__plechoTime !== undefined,
  )
  // Пауза: на фиксированном времени в кадре не должно двигаться ничего лишнего,
  // иначе снимок экрана зависит от того, где оказалась машина.
  await page.evaluate(() => window.__plecho?.getState().setSpeed(0))
  return page.evaluate(() => window.__plecho?.getState().state.startYear ?? 1994)
}

/** Показать сцене заданный тик и снять с неё показания. */
async function look(page: Page, tick: number): Promise<Sky> {
  await page.evaluate((value) => window.__plechoTime?.(value), tick)
  // Хук пишет модульную переменную, а читает её useFrame: между вызовом и
  // применением обязан пройти кадр. Ждём именно кадра, а не «немного времени».
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        requestAnimationFrame(() => requestAnimationFrame(() => done()))
      }),
  )
  const sky = await page.evaluate(() => window.__plechoSky?.())
  if (sky === undefined) throw new Error('__plechoSky не отдал показания')
  return sky
}

// ─── Опыты ─────────────────────────────────────────────────────────────────

test('сутки видны: полдень против полуночи', async ({ page }) => {
  const startYear = await open(page)

  const noon = await look(page, tickOf(startYear, startYear, 7, 15, 12))
  const midnight = await look(page, tickOf(startYear, startYear, 7, 15, 0))

  // Свет.
  expect(noon.daylight).toBeGreaterThan(0.95)
  expect(midnight.daylight).toBeLessThan(0.05)
  expect(noon.keyIntensity ?? 0).toBeGreaterThan(2)
  expect(midnight.keyIntensity ?? 1).toBeLessThan(0.3)
  expect(noon.ambientIntensity ?? 0).toBeGreaterThan(midnight.ambientIntensity ?? 1)

  // Воздух: ночью сцена заметно темнее, и это видно по фону канваса.
  expect(luma(noon.background)).toBeGreaterThan(luma(midnight.background) * 2)

  // Ночь холодная: в ключевом свете синего больше красного.
  expect(warmth(midnight.key)).toBeLessThan(0)

  // Солнце в зените против низкой луны — отсюда разница в длине теней.
  expect(noon.keyDirection?.y ?? 0).toBeGreaterThan(0.9)
  expect(midnight.keyDirection?.y ?? 1).toBeLessThan(0.5)
})

test('фон канваса и туман совпадают в любое время суток', async ({ page }) => {
  const startYear = await open(page)

  for (const hour of [0, 4, 6, 9, 12, 17, 19, 22]) {
    const sky = await look(page, tickOf(startYear, startYear, 5, 20, hour))
    expect(sky.fog, `час ${hour}`).toBe(sky.background)
  }
})

test('солнце ходит с востока на запад, закат теплее рассвета', async ({ page }) => {
  const startYear = await open(page)

  const dawn = await look(page, tickOf(startYear, startYear, 4, 15, 6))
  const dusk = await look(page, tickOf(startYear, startYear, 4, 15, 18))

  expect(dawn.keyDirection?.x ?? 0).toBeGreaterThan(0.3)
  expect(dusk.keyDirection?.x ?? 0).toBeLessThan(-0.3)
  expect(warmth(dusk.key)).toBeGreaterThan(warmth(dawn.key))
  // И то и другое — сумерки: тёплый оттенок вообще должен появиться.
  expect(Math.min(dawn.twilight, dusk.twilight)).toBeGreaterThan(0.2)
})

test('зимой карта белеет, летом темнеет', async ({ page }) => {
  const startYear = await open(page)

  const january = await look(page, tickOf(startYear, startYear, 1, 15, 12))
  const july = await look(page, tickOf(startYear, startYear, 7, 15, 12))

  expect(january.winter).toBeGreaterThan(0.9)
  expect(july.winter).toBeLessThan(0.05)

  // Подложка — самая большая поверхность кадра, снег виден прежде всего по ней.
  expect(luma(january.ground)).toBeGreaterThan(luma(july.ground) * 2)
  // Зимняя дымка светлее летней.
  expect(luma(january.background)).toBeGreaterThan(luma(july.background))

  // Но не настолько, чтобы поле начало светиться: светится только акцент.
  expect(luma(january.ground)).toBeLessThan(0.45)
})

test('эпоха сдвигает насыщенность кадра от выцветшей к насыщенной', async ({
  page,
}) => {
  const startYear = await open(page)

  const nineties = await look(page, tickOf(startYear, startYear, 6, 1, 12))
  const twenties = await look(page, tickOf(startYear, startYear + 30, 6, 1, 12))

  expect(nineties.saturation).toBeLessThan(0)
  expect(twenties.saturation).toBeGreaterThan(nineties.saturation + 0.2)
  // Не кислота: акцент обязан остаться акцентом, а не неоновой полосой.
  expect(twenties.saturation).toBeLessThan(0.35)
})

test('на границе суток и года цвет не прыгает', async ({ page }) => {
  const startYear = await open(page)

  const newYear = tickOf(startYear, startYear + 1, 1, 1, 0)
  const before = await look(page, newYear - 1)
  const after = await look(page, newYear)

  // Тик — пятнадцать игровых минут. Соседние тики обязаны отличаться на глаз
  // неразличимо: рывок цвета на границе суток заметен мгновенно.
  expect(gap(before.background, after.background)).toBeLessThan(0.02)
  expect(gap(before.key, after.key)).toBeLessThan(0.02)
  expect(gap(before.ground, after.ground)).toBeLessThan(0.02)
  expect(Math.abs(before.saturation - after.saturation)).toBeLessThan(0.01)
  expect(Math.abs((before.keyIntensity ?? 0) - (after.keyIntensity ?? 0)))
    .toBeLessThan(0.1)

  // Календарь подмены и календарь игры — один и тот же.
  expect(dateFromTick(newYear, startYear).year).toBe(startYear + 1)
  expect(dateFromTick(newYear, startYear).month).toBe(1)
  expect(dateFromTick(newYear - 1, startYear).year).toBe(startYear)
})

test('время идёт само: без всяких хуков свет меняется по ходу партии', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto('/')
  await page.waitForFunction(() => window.__plechoSky !== undefined)

  await page.evaluate(() => window.__plechoTime?.(0))
  // Подмена времени доходит до сцены СЛЕДУЮЩИМ кадром, а не тем же вызовом:
  // свет считает useFrame. Читать снимок сразу — значит прочитать прежний.
  await page.waitForFunction(
    () => (window.__plechoSky?.().daylight ?? 1) < 0.1,
    undefined,
    { timeout: 15_000 },
  )

  const before = await page.evaluate(() => window.__plechoSky?.())
  expect(before).toBeDefined()
  // Дальше время идёт своим ходом — подмена снимается.
  await page.evaluate(() => window.__plechoTime?.(null))

  /*
   * Время СНИМАЕТСЯ с подмены и дальше идёт само.
   *
   * Проверка ровно про это: свет меняется по ходу партии без единого хука
   * снаружи. Начальную точку задаём явно (полночь), потому что партия теперь
   * открывается утром, а рассвет надо увидеть как СОБЫТИЕ, а не как стартовое
   * состояние. Игровые сутки идут двадцать реальных секунд (REAL_MS_PER_GAME_DAY
   * в app/loop.ts), на восьмикратной скорости рассвет наступает меньше чем за
   * секунду.
   */
  await page.evaluate(() => window.__plecho?.getState().setSpeed(8))
  await page.waitForFunction(
    () => (window.__plechoSky?.().daylight ?? 0) > 0.5,
    undefined,
    { timeout: 15_000 },
  )

  const after = await page.evaluate(() => window.__plechoSky?.())
  expect(after).toBeDefined()
  if (before === undefined || after === undefined) return

  expect(before.daylight).toBeLessThan(0.1)
  expect(after.keyIntensity ?? 0).toBeGreaterThan((before.keyIntensity ?? 0) + 1)
  expect(luma(after.background)).toBeGreaterThan(luma(before.background))
  expect(errors).toEqual([])
})

test('снимки суток и сезонов сохраняются', async ({ page }) => {
  // Свой срок: снимок канваса под программным растеризатором стоит несколько
  // секунд, а кадров здесь семь. Общий тридцатисекундный предел рассчитан на
  // проверки, а не на съёмку.
  test.setTimeout(150_000)

  const startYear = await open(page)

  /*
   * ВСЕ КАДРЫ — ОДНИ И ТЕ ЖЕ СУТКИ, и это не лень.
   *
   * Подмена времени действует только на свет (render/sky.ts). Погода
   * (render/Weather.tsx) читает НАСТОЯЩИЙ тик из состояния, то есть на паузе в
   * начале партии всегда рисует январь. Снимок «июльский полдень» вышел бы с
   * январским снегопадом поверх летнего света — картинка, которой в игре не
   * бывает, и судить по ней было бы нельзя. Час суток погода не использует,
   * поэтому четыре времени одного дня сравнимы честно.
   *
   * Разницу сезонов доказывает не снимок, а показания сцены в опыте «зимой
   * карта белеет» выше: там сравниваются цвета живого материала подложки.
   */
  const day = { month: 1, day: 1 }
  const frames: [string, number][] = [
    ['sky-night', tickOf(startYear, startYear, day.month, day.day, 1)],
    ['sky-dawn', tickOf(startYear, startYear, day.month, day.day, 8)],
    ['sky-noon', tickOf(startYear, startYear, day.month, day.day, 12)],
    ['sky-dusk', tickOf(startYear, startYear, day.month, day.day, 16)],
    // Тот же час и тот же сезон, но тридцать лет спустя: отличаться обязана
    // ровно насыщенность, и её видно, если положить снимки рядом.
    ['sky-noon-2024', tickOf(startYear, startYear + 30, day.month, day.day, 12)],
  ]

  for (const [name, tick] of frames) {
    await look(page, tick)
    await page.screenshot({
      path: `tests/e2e/screenshots/${name}.png`,
      fullPage: false,
    })
  }

  /*
   * И то же самое летом — но уже ПО-НАСТОЯЩЕМУ.
   *
   * Партия отматывается тиками до середины июля, то есть в состояние приходит
   * настоящее лето, и погода перестаёт сыпать январским снегом. Только на этих
   * кадрах свет суток видно в чистом виде: над зимней пеленой он читается
   * заметно слабее. Час по-прежнему подменяется — погода его не использует, а
   * ждать заката в реальном времени незачем.
   */
  await page.evaluate(
    ([days, ticksPerDay]) => {
      const store = window.__plecho?.getState()
      // Посуточно, а не одним вызовом на восемнадцать тысяч тиков: так вкладка
      // остаётся отзывчивой, и видно, на каком дне всё встало, если встанет.
      for (let day = 0; day < days; day++) store?.advance(ticksPerDay)
    },
    [195, TICKS_PER_DAY],
  )

  const summer = await page.evaluate(() => window.__plecho?.getState().state.tick ?? 0)
  const summerMidnight = Math.floor(summer / TICKS_PER_DAY) * TICKS_PER_DAY

  /*
   * Часы выбраны по солнцу, а не по круглым числам. В середине июля по этой
   * модели светло с половины пятого до половины восьмого вечера, поэтому 5:00 и
   * 19:00 — это одна и та же высота солнца по разные стороны от полудня: разница
   * между кадрами будет ровно в оттенке, холодном утреннем против тёплого
   * вечернего, и ни в чём больше.
   */
  for (const [name, hour] of [
    ['sky-summer-night', 1],
    ['sky-summer-dawn', 5],
    ['sky-summer-noon', 12],
    ['sky-summer-dusk', 19],
  ] as [string, number][]) {
    await look(page, summerMidnight + hour * TICKS_PER_HOUR)
    await page.screenshot({
      path: `tests/e2e/screenshots/${name}.png`,
      fullPage: false,
    })
  }
})
