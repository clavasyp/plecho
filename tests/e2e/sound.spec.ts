import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { STARTER_CLASS_ID } from '../../src/sim/state'
import { TICKS_PER_HOUR } from '../../src/sim/types'

/**
 * Звук: доказательство того, что он в игре ЕСТЬ и что без спроса он молчит.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ. Услышать headless-браузер нельзя, и это ровно тот случай,
 * когда юнит-тест особенно опасен: расчёт громкости и выбор отклика проверяются
 * в Node до последней цифры (src/app/sound.test.ts, 32 проверки), и при этом
 * зелёными они останутся, даже если кнопку забыли смонтировать, подписку не
 * завели, а AudioContext не создаётся вовсе. Здесь проверяется вторая половина:
 * кнопка на экране, контекст поднялся от нажатия, отклик доехал до графа, гул
 * поехал вместе с сутками.
 *
 * Смотрим через дев-хук __plechoSound — счётчики того, что модуль реально
 * отправил в Web Audio. Это единственный честный способ увидеть звук глазами.
 *
 * ЧИСЛА ГРОМКОСТИ СЮДА НЕ ВПИСАНЫ. Проверяется отношение — «днём громче и
 * звонче, чем ночью», — а не значения из палитры звука: подкрутка гула не
 * меняет ни одного правила игры и не должна ронять тест.
 */

type SoundProbe = {
  enabled: boolean
  available: boolean
  /** Состояние AudioContext или «нет», если контекста ещё не существует. */
  state: string
  /** Сколько откликов ушло в граф с начала страницы. */
  cues: number
  lastEvent: string | null
  /** Громкость, которую модуль ПОСЧИТАЛ и отправил в граф. */
  ambientGain: number
  ambientCutoff: number
  /** Громкость, которая в графе звучит НА САМОМ ДЕЛЕ. */
  ambientLive: number
}

type StoreShape = {
  state: {
    tick: number
    playerId: string
    companies: Record<string, { money: number }>
    vehicles: Record<string, { ownerId: string }>
  }
  setSpeed(speed: number): void
  advance(ticks: number): void
  buyVehicle(classId: string): void
}

type Dev = {
  __plecho: {
    getState(): StoreShape
    setState(patch: (store: { state: StoreShape['state'] }) => unknown): void
  }
  __plechoSound?: () => SoundProbe
}

/** Скорость игры на время опыта. Ноль: состояние меняем только сами. */
const PAUSED = 0

/** Час дня, когда мир шумит громче всего, — см. QUIETEST_HOUR в sound.ts. */
const LOUD_HOUR = 16

/** Час, когда тише всего. */
const QUIET_HOUR = 4

/** Денег на опыт с покупкой: заведомо больше любого тягача в справочнике. */
const PLENTY = 1_000_000

/** Дождаться, пока приложение поднимется и заведёт дев-хуки. */
async function waitForGame(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const dev = globalThis as Record<string, unknown>
      return dev.__plecho !== undefined && dev.__plechoSound !== undefined
    },
    undefined,
    { timeout: 20_000 },
  )
}

/** Собрать ошибки консоли и страницы за весь прогон. */
function watchConsole(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

/** Остановить время: партия стартует на ×1 и живёт с первого же кадра. */
async function pause(page: Page): Promise<void> {
  await page.evaluate((speed) => {
    ;(globalThis as unknown as Dev).__plecho.getState().setSpeed(speed)
  }, PAUSED)
}

/** Что модуль звука отправил в граф на этот момент. */
async function probe(page: Page): Promise<SoundProbe> {
  return page.evaluate(() => {
    const read = (globalThis as unknown as Dev).__plechoSound
    if (read === undefined) throw new Error('дев-хук звука не заведён')
    return read()
  })
}

/** Перевести часы партии ровно на указанный час тех же или следующих суток. */
async function advanceToHour(page: Page, hour: number): Promise<void> {
  await page.evaluate(
    ({ target, perHour }) => {
      const store = (globalThis as unknown as Dev).__plecho.getState()
      const perDay = perHour * 24
      const tick = store.state.tick
      const goal = target * perHour
      const now = tick % perDay
      store.advance(goal > now ? goal - now : perDay - now + goal)
    },
    { target: hour, perHour: TICKS_PER_HOUR },
  )
}

/** Выдать денег в обход тика — опыт про звук, а не про накопление. */
async function grantMoney(page: Page): Promise<void> {
  await page.evaluate((money) => {
    const store = (globalThis as unknown as Dev).__plecho
    store.setState(({ state }) => ({
      state: {
        ...state,
        companies: {
          ...state.companies,
          [state.playerId]: { ...state.companies[state.playerId], money },
        },
      },
    }))
  }, PLENTY)
}

/** Кнопка звука в панели времени. */
function soundButton(page: Page) {
  return page.getByRole('button', { name: 'Звук' })
}

/**
 * Дождаться, пока гул действительно зазвучит.
 *
 * Смотрим на ЖИВОЕ значение узла громкости, а не на посчитанное модулем:
 * посчитать можно и то, что в граф не доехало. Ждать приходится потому, что
 * громкость выводится плавно — мгновенный скачок был бы слышен щелчком.
 */
async function waitForHum(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const read = (globalThis as unknown as Dev).__plechoSound
      return read !== undefined && read().ambientLive > 0
    },
    undefined,
    { timeout: 5_000 },
  )
}

test('звук выключен по умолчанию и AudioContext не создаётся сам', async ({
  page,
}) => {
  const errors = watchConsole(page)

  await page.goto('/')
  await waitForGame(page)
  await pause(page)

  const button = soundButton(page)
  await expect(button).toBeVisible()
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  await expect(button).toContainText('выкл')

  const before = await probe(page)
  expect(before.enabled).toBe(false)
  // Главное в этом тесте: контекста НЕ СУЩЕСТВУЕТ, пока его не попросили.
  // Звук, начавшийся без спроса, — худшее первое впечатление от игры в браузере.
  expect(before.state).toBe('нет')
  expect(before.cues).toBe(0)

  expect(errors).toEqual([])
})

test('нажатие кнопки поднимает Web Audio, повторное — гасит', async ({
  page,
}) => {
  const errors = watchConsole(page)

  await page.goto('/')
  await waitForGame(page)
  await pause(page)

  /*
   * Часы переводятся на самый тихий час суток НАМЕРЕННО, и это не украшение
   * опыта, а его суть. Ровно здесь расчёт гула совпадает с нижним краем шкалы,
   * и модуль, сравнивающий «что посчитано» с «что уже отправлено», однажды на
   * этом и сломался: ночь равна ночи, менять нечего, громкость остаётся на
   * нуле, с которого стартует граф. В любой другой час поломка невидима.
   */
  await advanceToHour(page, QUIET_HOUR)

  const button = soundButton(page)
  await button.click()

  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(button).toContainText('вкл')

  // Контекст, созданный в обработчике нажатия, рождается сразу работающим:
  // это и есть тот жест пользователя, без которого браузер звук не даёт.
  await page.waitForFunction(() => {
    const read = (globalThis as unknown as Dev).__plechoSound
    return read !== undefined && read().state === 'running'
  })

  const on = await probe(page)
  expect(on.enabled).toBe(true)
  expect(on.available).toBe(true)
  expect(on.ambientGain).toBeGreaterThan(0)

  // И гул действительно звучит, а не только посчитан: смотрим на живое
  // значение узла громкости, а не на намерение модуля.
  await waitForHum(page)

  /*
   * Снимок панели во включённом состоянии.
   *
   * Кнопка добавлена в чужую панель, ширина которой зафиксирована числом
   * (172 в ui/TimeControls.tsx), и единственный способ убедиться, что она туда
   * влезла и не разъехалась, — посмотреть. Кадрирование по углу, а не по всему
   * экрану: панель прижата к левому верхнему углу и на общем снимке занимала бы
   * сотую долю площади.
   */
  await page.screenshot({
    path: 'tests/e2e/screenshots/sound-toggle.png',
    clip: { x: 0, y: 0, width: 240, height: 180 },
  })

  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'false')

  // Выключение усыпляет контекст, но только после затухания гула — иначе
  // выключение щёлкало бы.
  await page.waitForFunction(
    () => {
      const read = (globalThis as unknown as Dev).__plechoSound
      return read !== undefined && read().state === 'suspended'
    },
    undefined,
    { timeout: 5_000 },
  )

  /*
   * И включаем обратно в ТОТ ЖЕ ЧАС. Это не повтор первой половины теста, а
   * проверка того самого случая, ради которого часы переведены на четыре утра:
   * второе включение обязано снова поднять громкость с нуля, хотя сутки с
   * прошлого раза не сдвинулись ни на минуту.
   */
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await waitForHum(page)

  expect(errors).toEqual([])
})

test('покупка машины отзывается звуком, а выключенный звук молчит', async ({
  page,
}) => {
  const errors = watchConsole(page)

  await page.goto('/')
  await waitForGame(page)
  await pause(page)
  await grantMoney(page)

  const count = async (): Promise<number> =>
    page.evaluate(() => {
      const state = (globalThis as unknown as Dev).__plecho.getState().state
      return Object.values(state.vehicles).filter(
        (vehicle) => vehicle.ownerId === state.playerId,
      ).length
    })

  const buy = async (): Promise<void> => {
    await page.evaluate((classId) => {
      ;(globalThis as unknown as Dev).__plecho.getState().buyVehicle(classId)
    }, STARTER_CLASS_ID)
  }

  // Сначала с выключенным звуком: парк растёт, счётчик откликов — нет.
  const parkBefore = await count()
  await buy()
  expect(await count()).toBe(parkBefore + 1)
  expect((await probe(page)).cues).toBe(0)

  // Теперь со включённым.
  await soundButton(page).click()
  const quiet = await probe(page)

  await buy()
  expect(await count()).toBe(parkBefore + 2)

  const loud = await probe(page)
  expect(loud.cues).toBe(quiet.cues + 1)
  expect(loud.lastEvent).toBe('покупка')

  expect(errors).toEqual([])
})

test('гул мира едет вместе с сутками', async ({ page }) => {
  const errors = watchConsole(page)

  await page.goto('/')
  await waitForGame(page)
  await pause(page)

  await soundButton(page).click()

  await advanceToHour(page, LOUD_HOUR)
  const day = await probe(page)

  await advanceToHour(page, QUIET_HOUR)
  const night = await probe(page)

  // Отношения, а не значения: подкрутка гула не меняет правил игры.
  expect(day.ambientGain).toBeGreaterThan(night.ambientGain)
  // Ночь не просто тише — она глуше: срез фильтра над дорожным шумом уходит
  // вниз, и от трассы остаётся один нижний край.
  expect(day.ambientCutoff).toBeGreaterThan(night.ambientCutoff * 2)

  expect(errors).toEqual([])
})
