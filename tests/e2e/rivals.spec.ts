import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { EDGES } from '../../src/data/roads'
import { palette } from '../../src/render/palette'
import { COMPETITORS } from '../../src/sim/state'
import { THINKING_LIMIT } from '../../src/sim/tick'
import { TICKS_PER_DAY } from '../../src/sim/types'

/**
 * Срез 6 целиком: соперники, которых видно и слышно.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ. Дважды подряд в проекте случалось одно и то же:
 * модуль написан, покрыт юнит-тестами, зелёный — и не подключён ни к чему. В
 * срезе 1 так пропал поиск пути, в срезе 2 — три панели интерфейса на две с
 * лишним тысячи строк. Юнит-тест по устройству не способен это поймать: он сам
 * вызывает проверяемый модуль, и вопрос «а кто его вызывает в игре» перед ним не
 * стоит. Здесь стоит только он.
 *
 * У СРЕЗА 6 ЭТОТ РИСК ВЫШЕ, ЧЕМ У ВСЕХ ПРЕДЫДУЩИХ, и не на чуть-чуть. Весь путь
 * языковой модели — снимок мира, промпт, разбор ответа, раннер — устроен так,
 * чтобы игра работала БЕЗ НЕГО: нет ключа, нет сети, пришёл мусор — конкурентов
 * ведёт скрипт, и внешне ничего не меняется. Свойство прекрасное и оно же самое
 * опасное: мёртвый код на этом пути ничем себя не выдаёт. Мир населён,
 * экономика крутится, тесты зелёные — а половина среза просто не существует в
 * собранной игре. Проверка началась ровно с этого и нашла ровно это: обход
 * графа импортов от src/main.tsx показал, что src/app/ai/ целиком —
 * runner.ts, gemini.ts, prompt.ts — не был достижим ни по одной цепочке.
 *
 * ЧТО ПРОВЕРЯЕТСЯ ЗДЕСЬ:
 *
 *   • страница поднялась без единой ошибки в консоли;
 *   • панель соперников смонтирована в App.tsx, открывается и показывает
 *     ЛЕНТУ РАССУЖДЕНИЙ, а не только цифры;
 *   • конкуренты существуют, у них есть машины и машины ЕЗДЯТ;
 *   • за несколько игровых суток лента пополняется;
 *   • без ключа Gemini игра полна: конкурентов ведёт скрипт, а каждая запись
 *     ленты честно помечена источником;
 *   • чужие машины нарисованы на карте ОТДЕЛЬНО от своих — числа читаются с
 *     живых InstancedMesh через дев-хук __plechoRigs;
 *   • снимок экрана ложится в tests/e2e/screenshots/rivals.png.
 *
 * ЧИСЛА ЗДЕСЬ НЕ ВПИСАНЫ РУКАМИ. Имена контор берутся из COMPETITORS, длина
 * суток — из TICKS_PER_DAY, предел ленты — из THINKING_LIMIT, а цвета, с
 * которыми сравнивается чужой тон, — из самой палитры. Прошлые срезы научили:
 * перебалансировка данных дважды роняла тесты, в которых не менялось ни одного
 * правила, — потому что в них лежали посчитанные когда-то значения.
 */

// ─── Сколько времени прокручивать ──────────────────────────────────────────

/**
 * Сколько игровых суток прокручивается, прежде чем спрашивать с конкурента.
 *
 * ВЫВЕДЕНО ИЗ РИТМА РЕШЕНИЙ, а не подобрано. Конкурент думает РАЗ В ИГРОВЫЕ
 * СУТКИ (isDecisionTick в sim/tick.ts), и одного решения ему мало на что
 * хватает: первым ходом он подбирает прицеп, только следующими — строит кольцо и
 * выводит на него машину. Неделя — это семь решений, то есть заведомо больше,
 * чем нужно на «купить прицеп, построить линию, поехать», и заведомо меньше
 * предела ленты (THINKING_LIMIT записей), так что вытеснение старого в этот срок
 * ещё не начинается и проверка роста ленты остаётся честной.
 */
const WARMUP_DAYS = 7

/** Проверка «лента пополняется» смотрит на прирост за столько суток. */
const FEED_GROWTH_DAYS = 3

/**
 * Сколько суток крутится мир перед снимком экрана.
 *
 * Больше разогрева намеренно: к этому времени часть парка уже разъехалась с
 * общей стартовой площадки в Москве, и на снимке видно РАЗНЫЕ машины в разных
 * местах, а не четыре силуэта, стоящих друг в друге. Меньше предела ленты — по
 * той же причине, что и WARMUP_DAYS.
 */
const SCENE_DAYS = 14

/**
 * Кратность зума на снимке — к вписанному в экран кадру, а не абсолютная.
 *
 * Абсолютное число означало бы разный охват на разных экранах: сам вписанный
 * кадр считается от размера окна. Пятикратное приближение показывает окрестности
 * города примерно на сто километров вокруг — сцеп машины (девять километров)
 * занимает при этом десятки пикселей, то есть силуэт различим, а соседние города
 * ещё видны и понятно, где мы находимся.
 */
const SCENE_ZOOM = 5

/**
 * Насколько своя машина должна отъехать от города к моменту снимка, км.
 *
 * ВЫВЕДЕНО ИЗ КАРТЫ, а не подобрано: треть самого короткого ребра. Ближе —
 * машина остаётся внутри городской застройки, а высокие коробки домов закрывают
 * её с изометрии почти целиком (именно так выглядел первый вариант этого
 * снимка: числа сходились, а на кадре не было видно ничего). Дальше — она уходит
 * за край кадра, потому что при SCENE_ZOOM в поле зрения около полусотни
 * километров от центра. Треть самого короткого плеча удовлетворяет обоим
 * условиям на любой карте, а не только на этой.
 */
const AWAY_KM = Math.min(...EDGES.map((edge) => edge.km)) / 3

/**
 * Во сколько раз дальше AWAY_KM ещё считается «в кадре».
 *
 * Дальняя граница нужна с той же строгостью, что и ближняя: машина, ушедшая на
 * полтораста километров, честно нарисована и совершенно бесполезна для снимка.
 * Полтора — это примерно край кадра при SCENE_ZOOM.
 */
const FRAME_REACH = 1.5

/**
 * Сколько игровых суток искать момент, когда обе машины окажутся в кадре.
 *
 * Кольцо конкурента проходится за сутки-двое, поэтому четверо суток дают ему
 * несколько заходов на нужный луч. Больше держать не за чем: снимок — не
 * проверка, и не сложившаяся встреча ничего не опровергает (см. ниже).
 */
const SCENE_SEARCH_DAYS = 4

// ─── Дев-хуки ──────────────────────────────────────────────────────────────

type Thought = { tick: number; text: string; fromModel: boolean }

type Stop = { nodeId: string }
type Line = { id: string; stops: Stop[] }

type Company = {
  id: string
  name: string
  controller: string
  personality: string | null
  lines?: Record<string, Line>
  thinking?: Thought[]
  bankrupt: boolean
}

type Vehicle = {
  id: string
  ownerId: string
  odometer: number
  position:
    | { kind: 'узел'; nodeId: string }
    | { kind: 'ребро'; edgeId: string; fromId: string; progress: number }
}

type GameState = {
  tick: number
  playerId: string
  companies: Record<string, Company>
  vehicles: Record<string, Vehicle>
}

/**
 * Что докладывает VehicleMesh о СВОЁМ ПОСЛЕДНЕМ КАДРЕ.
 *
 * Числа сняты с живых InstancedMesh, а не пересчитаны по состоянию, и в этом вся
 * их ценность: посчитать матрицы и не смонтировать меш — ровно тот дефект, ради
 * которого этот файл написан, и хук, отвечающий из состояния, его бы не заметил.
 */
type RigsReport = {
  own: number
  hot: number
  cold: number
  bodies: number
  rivals: number
  rivalTone: string
}

type Dev = {
  __plecho: {
    getState: () => {
      state: GameState
      setSpeed: (speed: number) => void
      advance: (ticks: number) => void
      /** Разовый рейс своей машиной — то же действие, что у игрока в панели. */
      dispatchTo: (destination: string) => void
    }
  }
  __plechoRigs?: () => RigsReport
  __plechoLook?: (id: string, factor?: number) => void
}

// ─── Управление временем из теста ──────────────────────────────────────────

/**
 * Поднять игру и ОСТАНОВИТЬ ВРЕМЯ.
 *
 * Пауза здесь не для скорости, а ради воспроизводимости. Игровой цикл считает
 * тики от реальных часов (loop.ts), то есть от того, насколько быстра машина, на
 * которой гоняется тест, и сколько кадров съел запуск браузера. Проверка «за
 * трое суток лента выросла» на таком времени превращается в проверку
 * производительности. Поэтому время двигает сам тест — ровно теми же вызовами
 * advance, которыми его двигает цикл.
 */
async function boot(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(
    () => (globalThis as Record<string, unknown>).__plecho !== undefined,
  )
  await page.evaluate(() => {
    (globalThis as unknown as Dev).__plecho.getState().setSpeed(0)
  })
}

/**
 * Прокрутить игровые сутки — ПО ОДНОМУ ВЫЗОВУ НА СУТКИ, а не одной пачкой.
 *
 * Разница существенная и касается ровно того, что здесь проверяется. Раннер
 * конкурентов (app/ai/runner.ts) подписан на СТОР и просыпается на каждое его
 * обновление; одна пачка в семьсот тиков дала бы ему одно пробуждение на всю
 * неделю, и решение он принял бы один раз вместо семи. Игра ведёт себя иначе —
 * там обновление приходит каждый кадр, — и тест обязан воспроизводить её ритм, а
 * не свой собственный.
 */
async function advanceDays(page: Page, days: number): Promise<void> {
  await page.evaluate(
    ([count, ticksPerDay]) => {
      const store = (globalThis as unknown as Dev).__plecho
      for (let day = 0; day < count; day += 1) {
        store.getState().advance(ticksPerDay)
      }
    },
    [days, TICKS_PER_DAY] as const,
  )
}

const readState = (page: Page): Promise<GameState> =>
  page.evaluate(() => {
    // Через JSON, а не ссылкой: Playwright сериализует результат сам, но
    // состояние — граф с общими объектами, и честная копия дешевле сюрпризов.
    const state = (globalThis as unknown as Dev).__plecho.getState().state
    return JSON.parse(JSON.stringify(state)) as GameState
  })

const rivalsOf = (state: GameState): Company[] =>
  Object.values(state.companies).filter((company) => company.id !== state.playerId)

/** Открыть панель соперников её собственной кнопкой вызова. */
async function openRivalPanel(page: Page): Promise<void> {
  const anchor = page.locator('[data-testid="rival-panel"]')
  await expect(
    anchor,
    'панель соперников смонтирована в App.tsx',
  ).toHaveCount(1)

  // Свёрнутая панель — это её кнопка вызова, и это единственная дверь внутрь
  // (открытость живёт в useState самой панели). Разворачиваем ровно так же, как
  // это делает игрок, а не подменой состояния снаружи.
  const launcher = anchor.getByRole('button', { name: /соперники/i })
  if ((await launcher.count()) > 0) await launcher.first().click()
}

// ─── Проверки ──────────────────────────────────────────────────────────────

test('страница поднимается без ошибок в консоли, панель соперников смонтирована', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(err.message))

  await boot(page)
  // Раннер конкурентов заводится на монтировании и трогает стор в первом же
  // проходе: если он взорвётся, взорвётся тихо и именно здесь.
  await advanceDays(page, 1)

  expect(errors, 'консоль чистая').toEqual([])

  const anchor = page.locator('[data-testid="rival-panel"]')
  await expect(anchor, 'якорь панели соперников есть в дереве').toHaveCount(1)
  // Непустой текст внутри якоря отличает «панель есть, но свёрнута» от «панель
  // забыли смонтировать»: у свёрнутой внутри лежит её кнопка вызова.
  await expect(anchor).not.toBeEmpty()
})

test('панель соперников открывается и показывает ленту рассуждений', async ({
  page,
}) => {
  await boot(page)
  await advanceDays(page, WARMUP_DAYS)
  await openRivalPanel(page)

  const panel = page.locator('[data-testid="rival-panel"]')
  const shown = (await panel.textContent()) ?? ''

  // Имена контор берутся из данных мира, а не переписываются сюда: ровно те
  // конторы, которые заводит createInitialState, обязаны оказаться на экране.
  const names = COMPETITORS.map((spec) => spec.name)
  const listed = names.filter((name) => shown.includes(name))
  expect(
    listed,
    `панель называет конкурентов по именам (ожидались: ${names.join(', ')})`,
  ).not.toHaveLength(0)

  /*
   * ГЛАВНАЯ ПРОВЕРКА ФАЙЛА, И ОНА ПРО ЛЕНТУ, А НЕ ПРО ЦИФРЫ. Соперник, чьи
   * мотивы видны, читается как соперник; невидимый — как случайный шум в
   * экономике. Поэтому сверяется не «есть какой-то текст», а СОВПАДЕНИЕ с тем,
   * что лежит в состоянии: панель обязана показывать мысль конкурента, а не
   * собственную выдумку.
   */
  const state = await readState(page)
  const feeds = rivalsOf(state)
    .map((company) => company.thinking ?? [])
    .filter((feed) => feed.length > 0)

  expect(
    feeds,
    'к этому сроку хоть один конкурент уже о чём-то подумал',
  ).not.toHaveLength(0)

  const displayed = feeds.filter((feed) =>
    feed.some((thought) => shown.includes(thought.text)),
  )
  expect(
    displayed,
    'лента рассуждений видна в панели: её текст совпадает с состоянием',
  ).not.toHaveLength(0)
})

test('конкуренты существуют, у них есть машины и машины ездят', async ({
  page,
}) => {
  await boot(page)

  const start = await readState(page)
  const rivals = rivalsOf(start)

  expect(
    rivals.map((company) => company.id).sort(),
    'в мире ровно те конторы, что заведены в COMPETITORS',
  ).toEqual(COMPETITORS.map((spec) => spec.id).sort())

  for (const company of rivals) {
    expect(
      company.personality,
      `у конкурента ${company.name} есть характер`,
    ).not.toBeNull()

    const fleet = Object.values(start.vehicles).filter(
      (vehicle) => vehicle.ownerId === company.id,
    )
    expect(fleet.length, `у конкурента ${company.name} есть машины`).toBeGreaterThan(0)
  }

  await advanceDays(page, WARMUP_DAYS)
  const later = await readState(page)

  /*
   * ЕЗДЯТ — ЭТО ОДОМЕТР, А НЕ КООРДИНАТА. Машина, стоящая в том же городе, могла
   * уехать и вернуться; машина на ребре могла оказаться там от одного тика
   * движения. Пройденные километры не врут ни в ту, ни в другую сторону, и они
   * же — та самая величина, из которой экономика считает топливо.
   */
  const driven = Object.values(later.vehicles).filter(
    (vehicle) => vehicle.ownerId !== later.playerId && vehicle.odometer > 0,
  )
  expect(
    driven.length,
    `за ${WARMUP_DAYS} игровых суток хоть одна чужая машина проехала хоть сколько-то`,
  ).toBeGreaterThan(0)
})

test('за несколько игровых суток лента рассуждений пополняется', async ({
  page,
}) => {
  await boot(page)
  await advanceDays(page, WARMUP_DAYS)

  const before = await readState(page)
  const countBefore = rivalsOf(before).reduce(
    (sum, company) => sum + (company.thinking ?? []).length,
    0,
  )
  expect(countBefore, 'к разогреву лента уже не пуста').toBeGreaterThan(0)

  await advanceDays(page, FEED_GROWTH_DAYS)

  const after = await readState(page)
  const countAfter = rivalsOf(after).reduce(
    (sum, company) => sum + (company.thinking ?? []).length,
    0,
  )

  expect(
    countAfter,
    `за ${FEED_GROWTH_DAYS} игровых суток записей стало больше`,
  ).toBeGreaterThan(countBefore)

  // Лента ограничена и обязана вытеснять старое: распухшая лента — это распухшее
  // сохранение, потому что она входит в JSON состояния целиком.
  for (const company of rivalsOf(after)) {
    expect(
      (company.thinking ?? []).length,
      `лента ${company.name} не длиннее предела`,
    ).toBeLessThanOrEqual(THINKING_LIMIT)
  }

  // И новая мысль обязана доехать до экрана, а не осесть в состоянии.
  await openRivalPanel(page)
  const shown = (await page.locator('[data-testid="rival-panel"]').textContent()) ?? ''
  const fresh = rivalsOf(after)
    .flatMap((company) => company.thinking ?? [])
    .filter((thought) => thought.tick >= before.tick)
  expect(
    fresh.some((thought) => shown.includes(thought.text)),
    'свежая мысль видна в панели',
  ).toBe(true)
})

test('без ключа Gemini мир полон, а лента честно помечена источником', async ({
  page,
}) => {
  await boot(page)
  await advanceDays(page, WARMUP_DAYS)

  const state = await readState(page)
  const rivals = rivalsOf(state)

  /*
   * ЕСТЬ ЛИ КЛЮЧ — СПРАШИВАЕТСЯ У САМОЙ ИГРЫ, а не у окружения теста.
   * import.meta.env.VITE_GEMINI_API_KEY подставляется на этапе сборки и в
   * браузер как переменная не попадает, зато у ключа есть НАБЛЮДАЕМОЕ следствие:
   * раннер, нашедший ключ, забирает конкурентов себе и метит их 'модель'
   * (adopt в app/ai/runner.ts). Без ключа он честно возвращает их скрипту.
   * Поэтому режим определяется по контроллеру — то есть по тому же признаку, по
   * которому его различает сама игра.
   */
  const modelled = rivals.filter((company) => company.controller === 'модель')
  const keyless = modelled.length === 0

  const feed = rivals.flatMap((company) => company.thinking ?? [])
  expect(feed.length, 'конкуренты думают в любом случае').toBeGreaterThan(0)

  // Отметка об источнике стоит у КАЖДОЙ записи и обязана быть настоящей: тихая
  // подмена модели скриптом обесценивает всю ленту разом.
  for (const thought of feed) {
    expect(typeof thought.fromModel, 'у записи есть отметка об источнике').toBe(
      'boolean',
    )
  }

  const scripted = feed.filter((thought) => !thought.fromModel)
  expect(
    scripted.length,
    'скриптовые мысли помечены честно (fromModel: false)',
  ).toBeGreaterThan(0)

  if (keyless) {
    // Запасной путь и есть основной: без ключа конкурентов ведёт фаза решений
    // тика, и НИ ОДНА запись не смеет назваться модельной.
    for (const company of rivals) {
      expect(
        company.controller,
        `без ключа ${company.name} остаётся за скриптом`,
      ).toBe('скрипт')
    }
    expect(
      feed.every((thought) => !thought.fromModel),
      'без ключа вся лента скриптовая',
    ).toBe(true)
  }

  // И в любом режиме игра ОСТАЁТСЯ ИГРОЙ: мир крутится, конкуренты живы, панель
  // на месте. «Модель недоступна» — штатное состояние, а не происшествие.
  expect(
    rivals.filter((company) => !company.bankrupt).length,
    'конкуренты живы',
  ).toBeGreaterThan(0)

  await openRivalPanel(page)
  const shown = (await page.locator('[data-testid="rival-panel"]').textContent()) ?? ''
  expect(shown, 'панель называет источник мысли словом').toContain('скрипт')
})

test('машины конкурента отличаются от своих на карте', async ({ page }) => {
  await boot(page)

  const report = await page.evaluate(() => (globalThis as unknown as Dev).__plechoRigs?.() ?? null)
  expect(
    report,
    'VehicleMesh смонтирован и докладывает о нарисованном',
  ).not.toBeNull()

  const rigs = report as RigsReport

  /*
   * СВОИ И ЧУЖИЕ УХОДЯТ В РАЗНЫЕ МЕШИ — вот и всё различие, выраженное числом.
   * Один и тот же грузовик в оба счёта попасть не может по построению цикла
   * отрисовки, поэтому два ненулевых числа означают ровно то, что на карте два
   * РАЗНЫХ вида машин, нарисованных разными материалами.
   */
  expect(rigs.own, 'свои машины нарисованы').toBeGreaterThan(0)
  expect(
    rigs.rivals,
    `чужие машины нарисованы отдельно (контор в мире ${COMPETITORS.length})`,
  ).toBeGreaterThanOrEqual(COMPETITORS.length)

  // Ни одна машина мира не потерялась и ни одна не посчитана дважды.
  const state = await readState(page)
  const total = Object.keys(state.vehicles).length
  expect(rigs.own + rigs.rivals, 'нарисован весь парк мира и ровно один раз').toBe(
    total,
  )

  const ownCount = Object.values(state.vehicles).filter(
    (vehicle) => vehicle.ownerId === state.playerId,
  ).length
  expect(rigs.own, 'своих нарисовано ровно столько, сколько их есть').toBe(ownCount)
  expect(rigs.rivals, 'чужих — тоже').toBe(total - ownCount)

  /*
   * СТИЛЕВОЙ ЗАМОК ЦЕЛ: чужое рисуется НЕ АКЦЕНТОМ. Сравнение идёт с самой
   * палитрой, а не с переписанной сюда шестнадцатеричной строкой, — иначе
   * проверка охраняла бы вчерашний цвет, а не правило.
   */
  expect(rigs.rivalTone, 'чужая машина не берёт тёплый акцент').not.toBe(
    palette.accent,
  )
  expect(rigs.rivalTone, 'и его приглушённый вариант тоже').not.toBe(
    palette.accentDim,
  )
  expect(
    rigs.rivalTone,
    'чужая машина взята из палитры проекта',
  ).toBe(palette.textDim)

  /*
   * СНИМОК ЭКРАНА. Камера наводится на город, где в этот момент стоят машины
   * РАЗНЫХ компаний: на кадре по умолчанию весь округ влезает в экран, и
   * разницу силуэтов там не разглядеть — вышла бы вырожденная проверка «что-то
   * нарисовалось» вместо доказательства.
   *
   * ПАНЕЛЬ ПРИ ЭТОМ ЗАКРЫТА, и это не мелочь: развёрнутая, она занимает
   * полэкрана и закрывает ровно то, ради чего снимок делается. Панель со своей
   * лентой доказана выше проверками по дереву — и снята отдельным кадром, чтобы
   * оба доказательства остались глазами, а не только числами.
   */
  await advanceDays(page, SCENE_DAYS)

  const moved = await readState(page)

  /** Где стоит или откуда вышла машина — ребро тоже привязано к городу. */
  const cityOf = (vehicle: Vehicle): string =>
    vehicle.position.kind === 'узел'
      ? vehicle.position.nodeId
      : vehicle.position.fromId

  const own = Object.values(moved.vehicles).find(
    (vehicle) => vehicle.ownerId === moved.playerId,
  )
  expect(own, 'у игрока есть машина').toBeDefined()

  const where = cityOf(own as Vehicle)

  /*
   * СВОЯ МАШИНА ОТПРАВЛЯЕТСЯ В ГОРОД ЧУЖОГО КОЛЬЦА — разовым рейсом, тем же
   * действием, что и у игрока.
   *
   * Без этого снимок доказывал бы меньше, чем должен. Стартовая машина стоит в
   * Москве, а московская застройка — самая плотная на карте: высокие коробки
   * домов закрывают грузовик с изометрии целиком. Первый вариант этого кадра
   * ровно так и выглядел — числа сходились, а на картинке не было ни одной
   * машины.
   *
   * Город выбирается не наугад, а из ЧУЖИХ КОЛЕЦ: туда конкурент ходит каждый
   * круг, и там же встанет своя машина, закончив рейс. Тогда в одном кадре
   * оказываются обе — и снимок отвечает на тот вопрос, ради которого делается:
   * отличается ли чужое от своего, когда они рядом.
   */
  const rivalStops = new Set(
    rivalsOf(moved)
      .flatMap((company) => Object.values(company.lines ?? {}))
      .flatMap((line) => line.stops.map((stop) => stop.nodeId)),
  )
  const neighbours = EDGES.filter(
    (edge) => edge.from === where || edge.to === where,
  ).map((edge) => (edge.from === where ? edge.to : edge.from))

  const target = neighbours.find((city) => rivalStops.has(city)) ?? neighbours[0]
  expect(target, 'из города игрока есть куда поехать').toBeDefined()

  await page.evaluate(
    (id) => (globalThis as unknown as Dev).__plecho.getState().dispatchTo(id),
    target,
  )

  /*
   * Дальше время идёт ПО ТИКУ, пока в окрестностях выбранного города не окажутся
   * ОБЕ машины: своя — доехавшая и вставшая в нём, чужая — идущая по одному из
   * его лучей на видимом отдалении от застройки.
   *
   * Считать нужные тики заранее нельзя ни для одной из них: водитель уходит на
   * обязательный отдых, чужая машина встаёт под погрузку, и оба простоя законны.
   * Поэтому условие проверяется каждый тик, а предел стоит по времени.
   */
  const radials = Object.fromEntries(
    EDGES.filter((edge) => edge.from === target || edge.to === target).map(
      (edge) => [edge.id as string, edge.km],
    ),
  )

  const together = await page.evaluate(
    ([limit, near, far, lanes, city]) => {
      const store = (globalThis as unknown as Dev).__plecho
      const radial = lanes as Record<string, number>

      /** Сколько километров машина отъехала от города по его лучу. null — не там. */
      const awayFrom = (vehicle: Vehicle): number | null => {
        if (vehicle.position.kind !== 'ребро') return null
        const km = radial[vehicle.position.edgeId]
        if (km === undefined) return null
        const share =
          vehicle.position.fromId === city
            ? vehicle.position.progress
            : 1 - vehicle.position.progress
        return share * km
      }

      /** На виду: либо стоит в самом городе, либо идёт по лучу не слишком далеко. */
      const visible = (vehicle: Vehicle): boolean => {
        if (
          vehicle.position.kind === 'узел' &&
          vehicle.position.nodeId === city
        ) {
          return true
        }
        const away = awayFrom(vehicle)
        return away !== null && away >= (near as number) && away <= (far as number)
      }

      for (let step = 0; step < (limit as number); step += 1) {
        const state = store.getState().state
        const fleet = Object.values(state.vehicles)

        const mine = fleet.some(
          (vehicle) => vehicle.ownerId === state.playerId && visible(vehicle),
        )
        const theirs = fleet.some(
          (vehicle) => vehicle.ownerId !== state.playerId && visible(vehicle),
        )
        if (mine && theirs) return true

        store.getState().advance(1)
      }
      return false
    },
    [
      TICKS_PER_DAY * SCENE_SEARCH_DAYS,
      AWAY_KM,
      AWAY_KM * FRAME_REACH,
      radials,
      target,
    ] as const,
  )

  /*
   * НЕ ПРОВЕРКА, А УСЛОВИЕ СЪЁМКИ. Встреча своей и чужой машины у одного города —
   * дело расписания, а не правил игры: конкурент мог в эти сутки чинить машину
   * или стоять под погрузкой. Роняя тест на несостоявшейся встрече, мы получили
   * бы мигающую проверку, которая ничего не охраняет. Само же различие своих и
   * чужих доказано выше числами со сцены, и оно не зависит от того, кто где
   * оказался.
   */
  if (!together) {
    test.info().annotations.push({
      type: 'снимок',
      description:
        'в кадр не попали обе машины разом: чужая в этот момент не шла по лучам города',
    })
  }

  await page.evaluate(
    ([id, factor]) =>
      (globalThis as unknown as Dev).__plechoLook?.(id as string, factor as number),
    [target, SCENE_ZOOM] as const,
  )
  await page.waitForTimeout(400)

  const after = await page.evaluate(
    () => (globalThis as unknown as Dev).__plechoRigs?.() ?? null,
  )
  expect(
    (after as RigsReport).rivals,
    'чужие машины на карте и после прокрутки времени',
  ).toBeGreaterThan(0)
  expect(
    (after as RigsReport).own,
    'свои машины на карте там же',
  ).toBeGreaterThan(0)

  await page.screenshot({ path: 'tests/e2e/screenshots/rivals.png' })

  await openRivalPanel(page)
  await page.screenshot({ path: 'tests/e2e/screenshots/rivals-panel.png' })
})
