import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

import { EDGES } from '../../src/data/roads'
import { TRAILER_PRICE, VEHICLE_CLASSES, VEHICLE_CLASS_BY_ID } from '../../src/data/vehicles'
import {
  NEGLECT_WEAR_GAIN,
  ROAD_WEAR_GAIN,
  WEAR_LIFE_KM,
} from '../../src/sim/logistics/wear'
import {
  START_YEAR,
  STARTER_CLASS_ID,
  STARTER_VEHICLE_ID,
} from '../../src/sim/state'
import { TICKS_PER_DAY } from '../../src/sim/types'

/**
 * Срез 4 целиком, от кнопки до износа: классы техники, прицепы, водители, ТО.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ. Дважды подряд в проекте случалось одно и то же:
 * модуль написан, покрыт юнит-тестами, зелёный — и не подключён ни к чему. В
 * срезе 1 так пропал поиск пути, в срезе 2 — три панели интерфейса на две с
 * лишним тысячи строк. Юнит-тест по устройству не способен это поймать: он сам
 * вызывает проверяемый модуль, и вопрос «а кто его вызывает в игре» перед ним
 * не стоит. Здесь стоит только он.
 *
 * Поэтому проверки ниже сквозные и идут через настоящую страницу: игра
 * поднялась без единой ошибки в консоли, панель парка есть в DOM и показывает
 * машину, покупка другого класса и прицепа проходит штатными действиями стора,
 * машина без водителя получает маршрут и НЕ ЕДЕТ, с водителем — едет, а ресурс
 * машины стирается пробегом.
 *
 * ЧИСЛА ЗДЕСЬ НЕ ВПИСАНЫ РУКАМИ — ни одно. Класс покупаемой машины выбирается
 * из справочника по правилам самой игры (другой, чем стартовый, и уже
 * выпускается в стартовом году), прицеп берётся из списка совместимых с этим
 * классом, цены — из справочника, длительность наблюдения — из TICKS_PER_DAY, а
 * границы для износа выведены из констант модели износа. Прошлые срезы научили:
 * перебалансировка данных дважды роняла тесты, в которых не менялось ни одного
 * правила, — потому что в них лежали посчитанные когда-то значения.
 */

// ─── Условия опыта ─────────────────────────────────────────────────────────

/**
 * Класс, который покупает тест: любой ДРУГОЙ, уже выпускающийся на старте.
 *
 * Выбирается справочником, а не назван по имени, и оба условия содержательные.
 * «Другой» — потому что проверяется именно разнообразие парка: покупка второго
 * ЗИЛа не доказала бы, что classId вообще куда-то доходит. «Уже выпускается» —
 * потому что buyVehicle молча отказывает в технике из будущего (магистральный
 * тягач доступен с 2000 года, партия начинается в 1994-м), и тест, назвавший
 * тягач поимённо, падал бы на совершенно правильном поведении игры.
 */
const BOUGHT_CLASS = VEHICLE_CLASSES.find(
  (vc) => vc.id !== STARTER_CLASS_ID && vc.availableFrom <= START_YEAR,
)

if (BOUGHT_CLASS === undefined) {
  throw new Error(
    'в справочнике нет второго класса, доступного в стартовом году: ' +
      'опыт про разнообразие парка поставить не на чем',
  )
}

/**
 * Прицеп для купленной машины — первый совместимый с её классом.
 *
 * Берётся из самого класса, потому что совместимость решает справочник техники:
 * полуприцеп-цистерну на бортовой ЗИЛ не повесить, и вписанное сюда имя прицепа
 * разъехалось бы со справочником при первой же его правке.
 */
const BOUGHT_TRAILER = BOUGHT_CLASS.trailers[0]

/**
 * Кольцо Москва ⇄ Тула — самое короткое осмысленное задание в игре.
 *
 * Прямое федеральное ребро (М-2, 185 км) и мукомольный в Туле: машина не только
 * ездит, но и возит, то есть на снимке экрана видно работающую сеть, а не два
 * порожних сцепа. Для того, что проверяется здесь — едет или не едет, — груз
 * безразличен, и тест на него ничего не ставит.
 */
const RING = [
  { nodeId: 'moscow', unload: ['мука'], load: [] },
  { nodeId: 'tula', unload: [], load: ['мука'] },
] as const

/**
 * Ребро между остановками кольца — на нём расставляется парк для снимка карты.
 *
 * Ищется в данных дорог по концам, а не пишется строкой «moscow-tula».
 * Идентификатор ребра там выводится из пары городов (см. EDGES в
 * src/data/roads.ts), и повторить эту склейку здесь значило бы завести вторую
 * копию правила, которую некому сверить с первой.
 */
const RING_EDGE = EDGES.find(
  (edge) =>
    (edge.from === RING[0].nodeId && edge.to === RING[1].nodeId) ||
    (edge.from === RING[1].nodeId && edge.to === RING[0].nodeId),
)

if (RING_EDGE === undefined) {
  throw new Error(
    `в данных дорог нет прямого ребра ${RING[0].nodeId} — ${RING[1].nodeId}: ` +
      'кольцо опыта построить не на чем',
  )
}

/**
 * Денег на расстановку кадра: три машины с прицепами и запас на зарплату.
 *
 * Считается из справочника, а не выдаётся круглым миллионом: сумма обязана
 * пережить подорожание техники, а не «ну столько-то точно хватит». Двойка —
 * запас на всё остальное, чего в этом кадре нет.
 */
const EXTRA_BUDGET =
  3 * (BOUGHT_CLASS.price + TRAILER_PRICE[BOUGHT_TRAILER]) * 2

/**
 * Кратность зума для снимка карты.
 *
 * Вписанный кадр показывает весь округ, около восьмисот километров поперёк
 * экрана; на шестикратном приближении в кадр попадает полторы сотни, то есть
 * около девяти пикселей на километр. Девятикилометровый сцеп ЗИЛа занимает при
 * этом порядка восьмидесяти пикселей — достаточно, чтобы различить кабину и
 * кузов и увидеть, во сколько раз кузов КамАЗа крупнее.
 */
const LOOK_ZOOM = 6

/**
 * КАЖДОЙ МАШИНЕ — СВОЯ ЛИНИЯ, хотя кольцо у них одно и то же.
 *
 * Не педантизм: диспетчер держит машины одной линии на интервале друг от друга
 * (headway в sim/logistics/line.ts). Машина без водителя навсегда занимает своё
 * место в кольце, и вторая, подойдя к ней сзади, честно встала бы по интервалу —
 * то есть контрольная машина остановила бы подопытную, и опыт измерял бы
 * очередь, а не водителя. Две линии разводят их полностью.
 */
const LINE_A = 'Мука на Москву'
const LINE_B = 'Мука на Москву — вторая'

/** Скорость игры на время опыта. Пятикратная — потолок GameSpeed. */
const TEST_SPEED = 5

/**
 * Сколько игровых суток идёт каждая половина опыта.
 *
 * Двое суток — это около десяти плеч Москва — Тула и, что важнее, больше одного
 * полного цикла режима труда и отдыха (9 часов смены плюс 11 часов отдыха, см.
 * MAX_SHIFT_HOURS в sim/logistics/driver.ts). Меньше — и результат зависел бы от
 * того, на какую фазу смены пришлось окно наблюдения.
 */
const PHASE_DAYS = 2

/**
 * Границы для износа, выведенные из модели, а не из прогона.
 *
 * Фаза износа прибавляет к wear и к kmSinceService ОДИН И ТОТ ЖЕ пробег: wear
 * растёт на km·rate, счётчик ТО — на km (runWear в sim/logistics/wear.ts).
 * Значит отношение между ними зажато множителями самой модели и не зависит ни
 * от скорости прогона, ни от того, сколько машина успела проехать:
 *
 *   минимум — идеальная дорога и ТО вовремя:        1 / WEAR_LIFE_KM
 *   максимум — худшая дорога и полностью просроченное ТО:
 *              (1 + ROAD_WEAR_GAIN)·(1 + NEGLECT_WEAR_GAIN) / WEAR_LIFE_KM
 *
 * Это не «примерно столько получилось», а утверждение о правилах: ресурс
 * стирается ровно тем пробегом, по которому ведётся счётчик обслуживания. Разъедься
 * они — и игрок увидел бы машину, которая изнашивается не от работы.
 */
const WEAR_PER_KM_MIN = 1 / WEAR_LIFE_KM
const WEAR_PER_KM_MAX =
  ((1 + ROAD_WEAR_GAIN) * (1 + NEGLECT_WEAR_GAIN)) / WEAR_LIFE_KM

/**
 * По чему видно, что панель парка развёрнута.
 *
 * Закрепляется ФАКТ, а не формулировка: панель, показывающая парк, обязана
 * называть либо машину, либо её класс. И то, и другое берётся из данных игры, а
 * не переписывается сюда строкой, — иначе тест начнёт падать от переименования
 * ЗИЛа в справочнике, ничего при этом не проверив.
 */
const FLEET_MARK = new RegExp(
  [VEHICLE_CLASS_BY_ID[STARTER_CLASS_ID].name, STARTER_VEHICLE_ID]
    .map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'i',
)

// ─── Доступ к игре из теста ────────────────────────────────────────────────
//
// Только через дев-хук __plecho (игровой стор). Кликать по трёхмерной сцене
// экранными координатами нельзя — такой тест ломается от любой правки
// кадрирования и ничего не проверяет по существу; тот же довод записан в шапке
// ui/selection.ts. По панели, наоборот, кликаем по-настоящему: доказать, что она
// в игре ЕСТЬ, можно только тем, что до неё дотянулась мышь.

type StoreShape = {
  state: {
    tick: number
    playerId: string
    companies: Record<
      string,
      {
        money: number
        drivers: Record<string, { id: string; vehicleId: string | null }>
      }
    >
    vehicles: Record<
      string,
      {
        classId: string
        capacity: number
        trailer: string | null
        driverId: string | null
        route: string[]
        position: { kind: string }
        odometer: number
        wear: number
        kmSinceService: number
      }
    >
  }
  setSpeed(speed: number): void
  buyVehicle(classId: string): void
  buyTrailer(vehicleId: string, trailer: string): void
  hireDriver(): void
  assignDriver(driverId: string, vehicleId: string | null): void
  createLine(name: string, stops: unknown[]): string
  assignVehicle(vehicleId: string, lineId: string | null): void
}

type Dev = {
  __plecho: {
    getState(): StoreShape
    setState(patch: (store: { state: StoreShape['state'] }) => unknown): void
  }
}

/** Дождаться, пока приложение поднимется и заведёт дев-хук стора. */
async function waitForGame(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (globalThis as Record<string, unknown>).__plecho !== undefined,
    undefined,
    { timeout: 20_000 },
  )
}

/**
 * Остановить время.
 *
 * Вызывается сразу после подъёма игры во ВСЕХ тестах файла. Партия стартует на
 * ×1, то есть мир начинает жить с первого же кадра: пока тест выдаёт компании
 * деньги и покупает машину, симуляция успевает списать зарплату за несколько
 * тиков, и проверка «на счету осталось ровно ноль» превращается в лотерею.
 * Наблюдаемое время в этом файле включается только явно, через liveDays.
 */
async function pause(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(globalThis as unknown as Dev).__plecho.getState().setSpeed(0)
  })
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

/** Снимок одной машины из стора. */
async function vehicleOf(page: Page, id: string) {
  return page.evaluate((vehicleId) => {
    const store = (globalThis as unknown as Dev).__plecho
    const vehicle = store.getState().state.vehicles[vehicleId]
    if (vehicle === undefined) return null

    return {
      classId: vehicle.classId,
      capacity: vehicle.capacity,
      trailer: vehicle.trailer,
      driverId: vehicle.driverId,
      routeLength: vehicle.route.length,
      standing: vehicle.position.kind === 'узел',
      odometer: vehicle.odometer,
      wear: vehicle.wear,
      kmSinceService: vehicle.kmSinceService,
    }
  }, id)
}

/** Идентификаторы всего парка игрока — по ним ловится только что купленная машина. */
async function fleetIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.keys((globalThis as unknown as Dev).__plecho.getState().state.vehicles),
  )
}

/** Выдать компании денег, минуя тик: опыт про парк, а не про накопление. */
async function grantMoney(page: Page, amount: number): Promise<void> {
  await page.evaluate((money) => {
    const store = (globalThis as unknown as Dev).__plecho

    // Состояние правится в обход тика ровно так же, как это делают действия
    // самого стора: новые объекты до изменённого поля, никакой мутации. Иначе
    // рендер сравнивает снимки по ссылке и правки просто не замечает.
    store.setState(({ state }) => ({
      state: {
        ...state,
        companies: {
          ...state.companies,
          [state.playerId]: { ...state.companies[state.playerId], money },
        },
      },
    }))
  }, amount)
}

/** Прожить в игре указанное число суток и вернуться к паузе. */
async function liveDays(page: Page, days: number): Promise<void> {
  const from = await page.evaluate(
    () => (globalThis as unknown as Dev).__plecho.getState().state.tick,
  )

  await page.evaluate((speed) => {
    ;(globalThis as unknown as Dev).__plecho.getState().setSpeed(speed)
  }, TEST_SPEED)

  // Ждём игровое ВРЕМЯ, а не реальное. Сколько тиков успеет пройти за секунду,
  // зависит от машины, на которой гоняют тест, и от того, насколько бодро
  // headless-хром рисует WebGL программным растеризатором; номер тика не зависит
  // ни от того, ни от другого.
  await page.waitForFunction(
    ({ start, ticks }) =>
      (globalThis as unknown as Dev).__plecho.getState().state.tick - start >= ticks,
    { start: from, ticks: Math.round(days * TICKS_PER_DAY) },
    { timeout: 120_000, polling: 250 },
  )

  // Пауза после каждой половины опыта: измерения и снимок экрана обязаны быть из
  // одного момента партии, а мир на ×5 успевает уехать между двумя вызовами.
  await page.evaluate(() => {
    ;(globalThis as unknown as Dev).__plecho.getState().setSpeed(0)
  })
}

/**
 * Развернуть панель парка и вернуть её точку монтирования.
 *
 * Панель ищется по точке монтирования из App.tsx, а не по тексту из
 * ui/FleetPanel.tsx: так проверяется ровно то, что этот тест обязан проверять, —
 * что компонент ВСТАВЛЕН в дерево, — и утверждение не начинает зависеть от
 * формулировок в чужом файле. Обёртка не рисует ничего своего (display:
 * contents), поэтому непустой текст внутри может взяться только из самой панели.
 *
 * РАЗВОРАЧИВАЕТСЯ НАСТОЯЩИМ КЛИКОМ по её собственной кнопке, а не дев-хуком.
 * Свёрнутое и развёрнутое состояние — разные ветки компонента, и «смонтирован»
 * второй из них не покрывает: панель со списком машин могла бы и не собраться.
 * Кнопка ищется как первая внутри точки монтирования — у свёрнутой панели она
 * там ровно одна, и это единственное предположение о чужом файле, которое тест
 * себе позволяет: ни одного слова из него он не знает.
 */
async function openFleet(page: Page): Promise<Locator> {
  const panel = page.locator('[data-testid="fleet-panel"]')

  await expect(panel, 'панель парка смонтирована в App.tsx').toHaveCount(1)
  await expect(
    panel,
    'свёрнутая панель показывает хотя бы кнопку вызова',
  ).not.toBeEmpty()

  // Панель могла быть развёрнута изначально — тогда разворачивать нечего.
  if (FLEET_MARK.test(await panel.innerText())) return panel

  const toggle = panel.locator('button, [role="button"]').first()
  await expect(toggle, 'у свёрнутой панели есть кнопка вызова').toBeVisible()
  await toggle.click()

  await expect(
    panel,
    'развёрнутая панель называет машину или её класс',
  ).toContainText(FLEET_MARK, { timeout: 5_000 })

  return panel
}

// ─── Тесты ─────────────────────────────────────────────────────────────────

test('игра со срезом 4 поднимается, панель парка есть в DOM', async ({ page }) => {
  const errors = watchConsole(page)

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await waitForGame(page)
  await pause(page)

  // Ошибки консоли проверяются ПЕРВЫМИ. Ненайденный модуль, сломанный импорт и
  // упавший компонент проявляются именно здесь, и без этой проверки все
  // остальные утверждения ниже разбирали бы уже мёртвую страницу.
  expect(errors, 'консоль чистая').toEqual([])

  await openFleet(page)

  expect(errors, 'открытие панели парка не уронило ни одного компонента').toEqual(
    [],
  )
})

test('покупка машины другого класса и прицепа увеличивает парк', async ({
  page,
}) => {
  const errors = watchConsole(page)

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await waitForGame(page)
  await pause(page)

  const before = await fleetIds(page)

  // Денег ровно на машину с прицепом и ни рублём меньше: так проверяется, что
  // покупка списывает именно эти суммы, а не «где-то около».
  const budget = BOUGHT_CLASS.price + TRAILER_PRICE[BOUGHT_TRAILER]
  await grantMoney(page, budget)

  await page.evaluate((classId) => {
    ;(globalThis as unknown as Dev).__plecho.getState().buyVehicle(classId)
  }, BOUGHT_CLASS.id)

  const after = await fleetIds(page)
  const added = after.filter((id) => !before.includes(id))

  expect(after.length, 'парк вырос ровно на одну машину').toBe(before.length + 1)
  expect(added, 'новая машина появилась одна').toHaveLength(1)

  const id = added[0]

  await page.evaluate(
    ({ vehicleId, trailer }) => {
      ;(globalThis as unknown as Dev).__plecho
        .getState()
        .buyTrailer(vehicleId, trailer)
    },
    { vehicleId: id, trailer: BOUGHT_TRAILER },
  )

  const bought = await vehicleOf(page, id)

  expect(bought, 'купленная машина есть в парке').not.toBeNull()
  expect(bought!.classId, 'машина именно того класса, который заказан').toBe(
    BOUGHT_CLASS.id,
  )
  // Грузоподъёмность приезжает из справочника, а не из воздуха: машина с чужим
  // тоннажем ломает главный инвариант игры молча, не уронив ни одного теста.
  expect(bought!.capacity, 'грузоподъёмность взята у класса').toBe(
    BOUGHT_CLASS.capacity,
  )
  expect(bought!.trailer, 'прицеп поставлен').toBe(BOUGHT_TRAILER)
  // Голый тягач без человека — это и есть суть покупки в срезе 4: машина
  // собирается из трёх решений, и куплено пока только первое.
  expect(bought!.driverId, 'водителя за руль никто не сажал').toBeNull()

  const money = await page.evaluate(() => {
    const state = (globalThis as unknown as Dev).__plecho.getState().state
    return state.companies[state.playerId].money
  })

  expect(money, 'списаны ровно цена машины и цена прицепа').toBeCloseTo(0, 6)

  // Панель обязана показать выросший парк, а не только стор. Купленная машина
  // опознаётся по классу ИЛИ по идентификатору: как именно панель называет
  // строку парка — её дело, но назвать новую машину она обязана хоть чем-то из
  // того, чего до покупки в игре не было.
  const panel = await openFleet(page)
  await expect(panel, 'купленная машина видна в панели парка').toContainText(
    new RegExp([BOUGHT_CLASS.name, id].join('|'), 'i'),
    { timeout: 5_000 },
  )

  expect(errors, 'за всю покупку консоль осталась чистой').toEqual([])
})

test('без водителя машина стоит, с водителем едет, а ресурс стирается пробегом', async ({
  page,
}) => {
  // Опыт идёт две половины по PHASE_DAYS игровых суток на пятикратной скорости —
  // это заметно дольше умолчания из playwright.config.ts.
  test.setTimeout(300_000)

  const errors = watchConsole(page)

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await waitForGame(page)
  await pause(page)

  // ─── Подготовка парка ────────────────────────────────────────────────────

  const before = await fleetIds(page)
  await grantMoney(page, BOUGHT_CLASS.price + TRAILER_PRICE[BOUGHT_TRAILER])

  await page.evaluate(
    ({ classId, trailer, ringA, ringB, nameA, nameB, starter }) => {
      const store = (globalThis as unknown as Dev).__plecho

      store.getState().buyVehicle(classId)

      // Новая машина ловится сравнением ключей, а не собирается из classId по
      // формуле имени: схема идентификаторов — дело стора, и повторять её здесь
      // значило бы завести вторую копию правила, которое некому сверить.
      const fresh = Object.keys(store.getState().state.vehicles).find(
        (id) => store.getState().state.vehicles[id].driverId === null,
      )
      if (fresh === undefined) return

      store.getState().buyTrailer(fresh, trailer)

      const a = store.getState().createLine(nameA, ringA)
      const b = store.getState().createLine(nameB, ringB)
      store.getState().assignVehicle(starter, a)
      store.getState().assignVehicle(fresh, b)
    },
    {
      classId: BOUGHT_CLASS.id,
      trailer: BOUGHT_TRAILER,
      // Остановки копируются поимённо: стор кладёт их в состояние, и общий с
      // тестом массив означал бы правку работающей линии из другого места.
      ringA: RING.map((stop) => ({ ...stop, unload: [...stop.unload], load: [...stop.load] })),
      ringB: RING.map((stop) => ({ ...stop, unload: [...stop.unload], load: [...stop.load] })),
      nameA: LINE_A,
      nameB: LINE_B,
      starter: STARTER_VEHICLE_ID,
    },
  )

  const added = (await fleetIds(page)).filter((id) => !before.includes(id))
  expect(added, 'вторая машина куплена штатным действием стора').toHaveLength(1)
  const bought = added[0]

  // ─── Половина первая: машина без водителя ────────────────────────────────

  await liveDays(page, PHASE_DAYS)

  const idle = await vehicleOf(page, bought)

  expect(idle, 'купленная машина никуда не делась').not.toBeNull()
  expect(idle!.driverId, 'за рулём по-прежнему никого').toBeNull()

  /*
   * ГЛАВНОЕ УТВЕРЖДЕНИЕ ПОЛОВИНЫ, и оно нужно именно в такой паре.
   *
   * Маршрут машине ВЫДАН — диспетчер линии не смотрит, есть ли водитель, и
   * честно отправляет её к следующей остановке. Значит стоит она не оттого, что
   * ей нечего делать: задание есть, а поехать некому. Без первой половины пары
   * тест был бы пустым — машина без задания не двигается и в исправной игре.
   */
  expect(idle!.routeLength, 'диспетчер выдал маршрут').toBeGreaterThan(0)
  expect(idle!.odometer, 'машина без водителя не проехала ни километра').toBe(0)
  expect(idle!.standing, 'машина без водителя осталась стоять в городе').toBe(true)
  expect(idle!.wear, 'у стоящей машины ресурс не тратится').toBe(0)

  // ─── Половина вторая: за руль сажают человека ────────────────────────────

  const worn = await vehicleOf(page, STARTER_VEHICLE_ID)
  expect(worn, 'стартовая машина на месте').not.toBeNull()

  await page.evaluate((vehicleId) => {
    const store = (globalThis as unknown as Dev).__plecho

    const owner = () => {
      const state = store.getState().state
      return state.companies[state.playerId]
    }

    const known = Object.keys(owner().drivers)
    store.getState().hireDriver()

    // Нанятый приходит В РЕЗЕРВ — за руль его сажают отдельным решением. Это и
    // проверяется: цепочка «нанять → посадить» должна работать целиком.
    const hired = Object.keys(owner().drivers).find((id) => !known.includes(id))
    if (hired === undefined) return

    store.getState().assignDriver(hired, vehicleId)
  }, bought)

  const manned = await vehicleOf(page, bought)
  expect(manned!.driverId, 'нанятый водитель сел за руль').not.toBeNull()

  await liveDays(page, PHASE_DAYS)

  // Снимок живой игры со срезом 4: панель парка над работающей сетью. Делается
  // сразу после остановки времени и ДО утверждений — во-первых, это тот самый
  // момент партии, который меряют цифры ниже, во-вторых, при упавшей проверке
  // смотреть на игру нужнее всего, а после исключения снимок бы уже не сделался.
  // Карта со всеми различиями машин снимается отдельно, следующим тестом: панель
  // модальная и закрывает собой ровно то, что там нужно разглядеть.
  await openFleet(page)
  await page.screenshot({ path: 'tests/e2e/screenshots/fleet.png' })

  const drove = await vehicleOf(page, bought)

  console.log(
    `за ${PHASE_DAYS} сут с водителем ${BOUGHT_CLASS.name} прошёл ` +
      `${Math.round(drove!.odometer)} км, износ ${(drove!.wear * 100).toFixed(2)}%`,
  )

  expect(
    drove!.odometer,
    'та же машина с водителем поехала — значит стояла именно из-за него',
  ).toBeGreaterThan(0)

  // ─── Износ ───────────────────────────────────────────────────────────────

  const driven = await vehicleOf(page, STARTER_VEHICLE_ID)

  console.log(
    `стартовый ${VEHICLE_CLASS_BY_ID[STARTER_CLASS_ID].name} за ` +
      `${PHASE_DAYS * 2} сут: ${Math.round(driven!.kmSinceService)} км от ТО, ` +
      `износ ${(driven!.wear * 100).toFixed(2)}%`,
  )

  expect(driven!.kmSinceService, 'машина с водителем работала').toBeGreaterThan(0)
  expect(
    driven!.wear,
    'ресурс машины стирается пробегом, а не остаётся вечным',
  ).toBeGreaterThan(worn!.wear)

  /*
   * Износ и счётчик ТО ведутся ОДНИМ пробегом, и это проверяется отношением, а
   * не величиной. Границы взяты из самой модели (см. WEAR_PER_KM_MIN и MAX), то
   * есть перебалансировка ресурса или коэффициента дороги двигает их вместе с
   * игрой и теста не роняет. Разъедься два счётчика — и игрок увидел бы машину,
   * которая изнашивается не от работы.
   */
  expect(
    driven!.wear,
    'износ не меньше, чем даёт идеальная дорога на этом пробеге',
  ).toBeGreaterThanOrEqual(driven!.kmSinceService * WEAR_PER_KM_MIN)
  expect(
    driven!.wear,
    'износ не больше, чем даёт худшая дорога с просроченным ТО',
  ).toBeLessThanOrEqual(driven!.kmSinceService * WEAR_PER_KM_MAX)

  expect(errors, 'за весь прогон консоль осталась чистой').toEqual([])
})

test('классы, поломка и отсутствие водителя различаются на карте', async ({
  page,
}) => {
  const errors = watchConsole(page)

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await waitForGame(page)
  await pause(page)

  /*
   * ЗАЧЕМ ЭТОТ ТЕСТ ОТДЕЛЬНЫЙ, А НЕ ПРОДОЛЖЕНИЕ ПРЕДЫДУЩЕГО.
   *
   * Он не измеряет игру, а СТАВИТ КАДР: четыре машины рядом на одном ребре, все
   * различия среза сразу. В прогоне такая расстановка не случается — машины
   * разъезжаются по кольцу, — а ждать её было бы гаданием. Поэтому парк здесь
   * расставляется руками, а время не идёт вовсе.
   *
   * Утверждать по пикселям тест не пытается: сравнение снимков с эталоном на
   * программном растеризаторе WebGL — это ложные падения от версии драйвера.
   * Проверяется то, что проверить честно можно, — что кадр собрался без единой
   * ошибки, — а сам снимок остаётся тем, ради чего роль существует: на него
   * смотрят глазами, когда правят VehicleMesh.
   */
  await grantMoney(page, EXTRA_BUDGET)

  const staged = await page.evaluate(
    ({ classId, trailer, edge, from, starter, cargo }) => {
      const store = (globalThis as unknown as Dev).__plecho

      const known = new Set(Object.keys(store.getState().state.vehicles))
      for (let i = 0; i < 3; i++) store.getState().buyVehicle(classId)

      const bought = Object.keys(store.getState().state.vehicles).filter(
        (id) => !known.has(id),
      )
      if (bought.length < 3) return null

      // Прицепы: первым двум ставим, третий остаётся голым тягачом — он и должен
      // выглядеть одной коробкой без кузова.
      store.getState().buyTrailer(bought[0], trailer)
      store.getState().buyTrailer(bought[1], trailer)

      // Двое наёмных: один сядет за исправную машину, второй — за сломанную.
      // Третья машина остаётся без человека намеренно.
      const owner = () => {
        const state = store.getState().state
        return state.companies[state.playerId]
      }
      const seats = [bought[0], bought[2]]
      for (const seat of seats) {
        const before = new Set(Object.keys(owner().drivers))
        store.getState().hireDriver()
        const hired = Object.keys(owner().drivers).find((id) => !before.has(id))
        if (hired !== undefined) store.getState().assignDriver(hired, seat)
      }

      /*
       * Расстановка правится в обход тика — новыми объектами до самого поля,
       * никакой мутации, ровно как это делают действия стора.
       *
       * ПОДМЕНЯЮТСЯ ОБА СНИМКА, state и prev. Рендер рисует интерполяцию между
       * ними по clock.alpha; оставь мы prev прежним — и машины оказались бы на
       * экране где-то между старым и новым положением, то есть кадр показывал бы
       * не то, что расставлено.
       */
      const line = [starter, bought[0], bought[1], bought[2]]

      store.setState(({ state }) => {
        const vehicles: Record<string, unknown> = { ...state.vehicles }

        line.forEach((id, index) => {
          const vehicle = state.vehicles[id]
          if (vehicle === undefined) return

          vehicles[id] = {
            ...vehicle,
            route: [],
            position: {
              kind: 'ребро',
              edgeId: edge,
              fromId: from,
              // Ставим цепочкой от дальнего конца ребра к ближнему, с шагом
              // заведомо большим длины самого длинного сцепа: машины должны
              // стоять рядом, но не влезать друг в друга.
              progress: 0.94 - index * 0.08,
            },
            // Первая — гружёная: у неё кузов обязан быть тёплым, у остальных
            // холодным. Это единственное различие среза, которое существовало и
            // до него, и кадр обязан показать, что оно не потерялось.
            cargo: index === 0 ? cargo : null,
            // Последняя — сломанная: кабина гаснет, хотя человек за рулём есть.
            brokenDown: index === 3,
          }
        })

        const next = { ...state, vehicles }
        return { state: next, prev: next }
      })

      return line
    },
    {
      classId: BOUGHT_CLASS.id,
      trailer: BOUGHT_TRAILER,
      edge: RING_EDGE.id,
      from: RING_EDGE.from,
      starter: STARTER_VEHICLE_ID,
      cargo: { type: 'мука', tons: 1, originId: RING_EDGE.to },
    },
  )

  expect(staged, 'четыре машины расставлены на одном ребре').not.toBeNull()

  // Наводим камеру на ближний конец ребра: во вписанном по умолчанию кадре сцеп
  // занимает около десятка пикселей, и на таком снимке не видно ни разницы
  // классов, ни того, горит ли кабина.
  const looked = await page.evaluate(
    ({ city, factor }) => {
      const look = (globalThis as unknown as { __plechoLook?: (id: string, f: number) => void })
        .__plechoLook
      if (look === undefined) return false
      look(city, factor)
      return true
    },
    { city: RING_EDGE.to, factor: LOOK_ZOOM },
  )

  expect(looked, 'дев-хук наводки камеры заведён в render/Scene.tsx').toBe(true)

  // Кадр собирается не мгновенно: между правкой состояния и картинкой проходит
  // как минимум один проход useFrame, а MapControls доводит камеру с затуханием.
  await page.waitForTimeout(1_000)

  await page.screenshot({ path: 'tests/e2e/screenshots/fleet-map.png' })

  expect(errors, 'кадр со всем разнообразием парка собрался без ошибок').toEqual(
    [],
  )
})
