import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { TICKS_PER_DAY } from '../../src/sim/types'

/**
 * Срез 3 целиком, от клика до денег: линии, парк, расходы, порожний пробег.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ. Дважды подряд в проекте случалось одно и то же:
 * модуль написан, покрыт юнит-тестами, зелёный — и не подключён ни к чему. В
 * срезе 1 так пропал поиск пути, в срезе 2 — три панели интерфейса на две с
 * лишним тысячи строк. Юнит-тест по устройству не способен это поймать: он сам
 * вызывает проверяемый модуль, и вопрос «а кто его вызывает в игре» перед ним не
 * стоит. Здесь стоит только он.
 *
 * Поэтому проверки ниже намеренно СКВОЗНЫЕ и идут через настоящую страницу:
 * поднялась игра, редактор линий есть в DOM, линия дошла из стора до кольца на
 * карте, машина на кольце возит груз в обе стороны, а машина без линии —
 * порожняком в одну, и разница между ними видна в рублях за сутки.
 *
 * ЧИСЛА ЗДЕСЬ НЕ ВПИСАНЫ РУКАМИ. Длительность наблюдения считается из
 * TICKS_PER_DAY, пороги порожнего пробега выведены из ГЕОМЕТРИИ маршрутов
 * (сколько плеч из скольких может быть гружёными), а не из прогона. Прошлый срез
 * научил: перебалансировка данных уронила тринадцать тестов, в которых не
 * менялось ни одного правила, — потому что в них лежали посчитанные когда-то
 * значения.
 */

// ─── Условия опыта ─────────────────────────────────────────────────────────

/**
 * Кольцо, которое строит тест: Орёл → Тула → Орёл.
 *
 * Маршрут выбран не за красоту, а за то, что он ЗАМКНУТ ПО ГРУЗУ и выполним
 * СТАРТОВОЙ ТЕХНИКОЙ:
 *
 *   Орёл — элеватор, источник зерна: оно там есть всегда. И он же город,
 *          потребляющий муку, — то есть обратное плечо гружёное.
 *   Тула — мукомольный: принимает зерно и отдаёт муку, обратная загрузка
 *          получается из того же самого, что мы привезли.
 *
 * ОБА плеча гружёные — идеальное кольцо, и в этом мире оно существует.
 *
 * До среза 4 здесь стояло кольцо Владимир → Рязань → Москва на кругляке и
 * пиломатериалах. Оно перестало быть выполнимым, и это не поломка теста, а
 * ровно то, что срез добавляет: кругляк требует лесовоза или платформы, а у
 * ЗИЛ-130 из справочника техники таких кузовов нет. Стартовая машина физически
 * не может обслуживать лесную цепочку — под неё нужен КамАЗ. Зерно же и мука
 * возятся тентом, который на ЗИЛе стоит с самого начала.
 */
const RING = [
  { nodeId: 'orel', unload: ['мука'], load: ['зерно'] },
  { nodeId: 'tula', unload: ['зерно'], load: ['мука'] },
] as const

const LINE_NAME = 'Зерно и мука'

/**
 * Контрольный маршрут для машины БЕЗ линии: Москва ⇄ Тула, разовыми рейсами.
 *
 * Это самая обычная первая работа новичка, а не подстроенный худший случай. В
 * Туле стоит мукомольный, и муку оттуда машина берёт автоматически; в Москве
 * брать нечего вовсе — предприятий в ней нет. Значит гружёной может быть в
 * лучшем случае ровно половина её километров, и никакая ловкость диспетчера
 * этого не изменит: груз лежит только на одном конце плеча.
 */
const SHUTTLE: [string, string] = ['moscow', 'tula']

/** Идентификаторы машин опыта. Стартовая — на линию, купленная — в контроль. */
const LINE_TRUCK = 'zil-1'
/**
 * Машина, купленная в ходе теста.
 *
 * Идентификатор собирает стор из класса и номера: 'zil-130-1'. Раньше здесь
 * стояло 'zil-2' — формат до среза 4, когда классов ещё не было.
 */
const CONTROL_TRUCK = 'zil-130-1'
/** Машина, выданная на старте партии. */
const STARTER_TRUCK = 'zil-1'

/**
 * Сколько игровых суток наблюдаем.
 *
 * Четверо суток — это около восьми оборотов кольца. Меньше двух оборотов
 * измерять нечего: первый перегон из Москвы к началу кольца тоже порожний, и на
 * коротком прогоне он один определял бы всю метрику. Больше — только дольше
 * ждать, разница между машинами к этому моменту уже вышла на полку.
 */
const OBSERVED_DAYS = 4

/** Скорость игры на время опыта. Пятикратная — потолок GameSpeed. */
const TEST_SPEED = 5

/**
 * Порожняя доля идеального челнока — половина.
 *
 * Не замер, а свойство маршрута: груз есть на одном конце из двух, обратно
 * машина едет пустой всегда. Реальный контроль может быть только ХУЖЕ (в Туле
 * может не оказаться муки), поэтому величина годится как нижняя граница для
 * него и как верхняя — для линии.
 */
const SHUTTLE_EMPTY_SHARE = 1 / 2

/**
 * Порожняя доля кольца — треть.
 *
 * Тоже геометрия, а не прогон: из трёх плеч гружёных два. Ориентир, ниже
 * которого линия не опустится, и потому в утверждениях он стоит как СПРАВОЧНЫЙ —
 * тест сравнивает машины между собой, а не с этим числом.
 */
const RING_EMPTY_SHARE = 1 / 3

/**
 * Как выглядит суточный итог в интерфейсе.
 *
 * Закрепляется ФАКТ, а не формулировка: где-то на экране есть величина «за
 * сутки». Слова принадлежат ui/CompanyPanel.tsx, и держать их копию здесь
 * значило бы ронять этот тест на каждой правке подписи — при том, что проверять
 * он должен совсем другое.
 *
 * Голое «сут» в набор не входит намеренно: им подписаны сутки простоя завода в
 * карточке города, и оно давало бы ложное «да» на совершенно постороннюю
 * панель.
 */
const DAILY_TOTAL = /(руб\s*\/\s*сут|за сутки|в сутки|суточн)/i

// ─── Доступ к игре из теста ────────────────────────────────────────────────
//
// Только через дев-хуки: __plecho (игровой стор) и __plechoLines (режим работы
// с линиями). Кликать по трёхмерной сцене экранными координатами нельзя — такой
// тест ломается от любой правки кадрирования и ничего не проверяет по существу;
// тот же довод записан в шапке ui/selection.ts.

type Mileage = { loadedKm: number; emptyKm: number; share: number }

/** Дождаться, пока приложение поднимется и заведёт дев-хуки. */
async function waitForGame(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const dev = globalThis as Record<string, unknown>
      return dev.__plecho !== undefined && dev.__plechoLines !== undefined
    },
    undefined,
    { timeout: 20_000 },
  )
}

/** Открыть редактор и показать в нём конкретную линию. */
async function openEditor(page: Page, line: string | null): Promise<void> {
  await page.evaluate((id) => {
    const selection = (
      globalThis as unknown as {
        __plechoLines: {
          getState(): {
            openEditor(): void
            selectLine(line: string | null): void
          }
        }
      }
    ).__plechoLines

    selection.getState().openEditor()
    selection.getState().selectLine(id)
  }, line)
}

/** Пробег одной машины, разложенный на гружёный и порожний. */
async function mileageOf(page: Page, id: string): Promise<Mileage> {
  return page.evaluate((vehicleId) => {
    const store = (
      globalThis as unknown as {
        __plecho: { getState(): { state: { vehicles: Record<string, unknown> } } }
      }
    ).__plecho

    const vehicle = store.getState().state.vehicles[vehicleId] as
      | { loadedKm: number; emptyKm: number }
      | undefined

    if (vehicle === undefined) return { loadedKm: 0, emptyKm: 0, share: 0 }

    const total = vehicle.loadedKm + vehicle.emptyKm
    return {
      loadedKm: vehicle.loadedKm,
      emptyKm: vehicle.emptyKm,
      // Ноль километров — ноль порожней доли: делить не на что, а NaN в
      // сравнении молча даст ложь в обе стороны.
      share: total > 0 ? vehicle.emptyKm / total : 0,
    }
  }, id)
}

/** Суточные потоки компании игрока — то, что панель обязана показывать. */
async function dailyTotals(
  page: Page,
): Promise<{ revenue: number; costs: number }> {
  return page.evaluate(() => {
    const store = (
      globalThis as unknown as {
        __plecho: {
          getState(): {
            state: {
              playerId: string
              companies: Record<
                string,
                { dailyRevenue: number; dailyCosts: number }
              >
            }
          }
        }
      }
    ).__plecho

    const state = store.getState().state
    const company = state.companies[state.playerId]
    return { revenue: company.dailyRevenue, costs: company.dailyCosts }
  })
}

// ─── Тесты ─────────────────────────────────────────────────────────────────

test('игра со срезом 3 поднимается, редактор линий есть в DOM', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await waitForGame(page)

  // Ошибки консоли проверяются ПЕРВЫМИ. Ненайденный модуль, сломанный импорт и
  // упавший компонент проявляются именно здесь, и без этой проверки все
  // остальные утверждения ниже разбирали бы уже мёртвую страницу.
  expect(errors, 'консоль чистая').toEqual([])

  /*
   * Редактор ищется по точке монтирования в App.tsx, а не по тексту из
   * ui/LineEditor.tsx. Так проверяется ровно то, что этот тест обязан
   * проверять, — что компонент ВСТАВЛЕН в дерево, — и утверждение не начинает
   * зависеть от формулировок в чужом файле.
   *
   * Требование к содержимому при этом настоящее: обёртка не рисует ничего
   * своего (display: contents), поэтому непустой текст внутри может взяться
   * только из самого редактора. Пустая точка монтирования проверку не пройдёт.
   */
  const editor = page.locator('[data-testid="line-editor"]')
  await expect(editor, 'редактор линий смонтирован').toHaveCount(1)
  await expect(editor, 'свёрнутый редактор показывает кнопку вызова').not.toBeEmpty()

  // Развёрнутое состояние — отдельная ветка компонента, и «смонтирован» её не
  // покрывает: свёрнутый редактор это одна кнопка, а панель со списком линий
  // могла бы и не собраться.
  await openEditor(page, null)
  await expect(editor, 'редактор разворачивается в панель').toContainText(
    /лини/i,
    { timeout: 5_000 },
  )
})

test('в режиме добавления клик по городу дописывает остановку', async ({
  page,
}) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await waitForGame(page)

  const id = await page.evaluate(() =>
    (
      globalThis as unknown as {
        __plecho: {
          getState(): { createLine(name: string, stops: unknown[]): string }
        }
      }
    ).__plecho.getState().createLine('Проба', []),
  )

  await openEditor(page, id)

  // Режим включается ровно тем же действием, что и переключателем в редакторе.
  await page.evaluate(() => {
    ;(
      globalThis as unknown as {
        __plechoLines: { getState(): { setAdding(adding: boolean): void } }
      }
    ).__plechoLines.getState().setAdding(true)
  })

  // Тула дважды и не подряд: город ЗАКОННО стоит в кольце два раза — узловая
  // база, куда заезжают и по дороге туда, и по дороге обратно. Это же и главная
  // проверка правила «клик указывает, а не переключает»: повторное указание на
  // город, который уже выбран, обязано ставить остановку, а не снимать выбор.
  await page.evaluate(() => {
    const pick = (
      globalThis as unknown as { __plechoPick: (city: string) => void }
    ).__plechoPick
    pick('tula')
    pick('ryazan')
    pick('tula')
  })

  const stops = await page.evaluate((line) => {
    const state = (
      globalThis as unknown as {
        __plecho: {
          getState(): {
            state: {
              playerId: string
              companies: Record<
                string,
                { lines: Record<string, { stops: { nodeId: string }[] }> }
              >
            }
          }
        }
      }
    ).__plecho.getState().state

    return state.companies[state.playerId].lines[line].stops.map(
      (stop) => stop.nodeId,
    )
  }, id)

  expect(stops, 'каждый клик дописал остановку в конец кольца').toEqual([
    'tula',
    'ryazan',
    'tula',
  ])

  // И карточка города при этом не открылась ни разу. «Жителей» пишет только
  // ui/CityPanel.tsx — по этому слову её и видно. Названия городов для проверки
  // не годятся: они же стоят в списке остановок редактора.
  const ui = await page.locator('.ui-layer').innerText()
  expect(ui, 'клик в режиме добавления не открывает город').not.toContain(
    'жителей',
  )
})

test('линия держит машину гружёной, а разовые рейсы — нет', async ({
  page,
}) => {
  // Опыт идёт четверо игровых суток на пятикратной скорости — это заметно
  // дольше умолчания из playwright.config.ts.
  test.setTimeout(180_000)

  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await waitForGame(page)

  // ─── Подготовка парка ────────────────────────────────────────────────────
  //
  // Второй машины на старте не купить: START_MONEY — треть от цены ЗИЛа, и это
  // ровно тот выбор, который игрок делает весь первый час. Опыту нужны две
  // машины сразу, поэтому деньги выдаются напрямую, а сама покупка идёт штатным
  // действием стора — проверять надо линии, а не накопление.
  await page.evaluate(() => {
    type Store = {
      state: {
        playerId: string
        companies: Record<string, { money: number }>
      }
    }

    const store = (
      globalThis as unknown as {
        __plecho: {
          getState(): {
            buyVehicle(classId: string): void
            hireDriver(): void
            assignDriver(driverId: string, vehicleId: string): void
            state: {
              playerId: string
              vehicles: Record<string, unknown>
              companies: Record<
                string,
                { drivers: Record<string, { id: string; vehicleId: string | null }> }
              >
            }
          }
          setState(patch: (store: Store) => Partial<Store>): void
        }
      }
    ).__plecho

    // Состояние правится в обход тика — ровно так же, как это делают действия
    // самого стора: новые объекты до изменённого поля, никакой мутации. Иначе
    // рендер сравнивает снимки по ссылке и правки просто не замечает.
    store.setState(({ state }) => ({
      state: {
        ...state,
        companies: {
          ...state.companies,
          [state.playerId]: {
            ...state.companies[state.playerId],
            money: 1_000_000,
          },
        },
      },
    }))

    store.getState().buyVehicle('zil-130')

    // В срезе 4 купленная машина без водителя не трогается с места. Для
    // контрольной машины это не предмет проверки, а препятствие: нанимаем и
    // сажаем за руль, иначе тест меряет не порожний пробег, а простой.
    const s2 = store.getState()
    s2.hireDriver()
    const after = store.getState()
    const player = after.state.companies[after.state.playerId]
    const freeDriver = Object.values(player.drivers).find(
      (d) => d.vehicleId === null,
    )
    const newTruck = Object.keys(after.state.vehicles).find(
      (id) => id !== 'zil-1',
    )
    if (freeDriver && newTruck) {
      after.assignDriver(freeDriver.id, newTruck)
    }
  })

  // Идентификатор новой машины назначает стор, и его формат — его дело:
  // в срезе 4 он стал зависеть от класса. Тест ищет машину, которой не было,
  // а не угадывает имя.
  const bought = await page.evaluate(
    (known) =>
      Object.keys(
        (
          globalThis as unknown as {
            __plecho: {
              getState(): { state: { vehicles: Record<string, unknown> } }
            }
          }
        ).__plecho.getState().state.vehicles,
      ).some((id) => id !== known),
    STARTER_TRUCK,
  )
  expect(bought, 'вторая машина куплена штатным действием стора').toBe(true)

  // ─── Линия ───────────────────────────────────────────────────────────────

  const assigned = await page.evaluate(
    ({ stops, name, truck }) => {
      const store = (
        globalThis as unknown as {
          __plecho: {
            getState(): {
              createLine(name: string, stops: unknown[]): string
              assignVehicle(vehicle: string, line: string | null): void
              setSpeed(speed: number): void
              state: { vehicles: Record<string, { lineId: string | null }> }
            }
          }
        }
      ).__plecho

      const id = store.getState().createLine(name, stops)
      store.getState().assignVehicle(truck, id)

      return {
        id,
        // Читаем ПОСЛЕ назначения: назначение — двусторонняя связь (машина
        // помнит линию, линия помнит машины), и молчаливый отказ одной из
        // сторон превратил бы весь опыт в сравнение двух одинаковых машин.
        lineId: store.getState().state.vehicles[truck].lineId,
      }
    },
    { stops: RING.map((stop) => ({ ...stop })), name: LINE_NAME, truck: LINE_TRUCK },
  )

  expect(assigned.id, 'линия создана').toBeTruthy()
  expect(assigned.lineId, 'машина стоит на линии').toBe(assigned.id)

  // ─── Редактор показывает линию ───────────────────────────────────────────

  await openEditor(page, assigned.id)

  const editor = page.locator('[data-testid="line-editor"]')
  await expect(editor, 'линия дошла из стора в редактор').toContainText(
    LINE_NAME,
    { timeout: 10_000 },
  )

  // ─── Диспетчер контрольной машины ────────────────────────────────────────
  //
  // Живёт ВНУТРИ страницы, а не в тесте. На пятикратной скорости плечо в 185 км
  // проезжается меньше чем за секунду реального времени, и опрос из Node
  // успевал бы отправить машину не на каждой стоянке: контрольная машина
  // простаивала бы, а простой — это не порожний пробег, он метрику не портит, а
  // разбавляет. Интервал в сто миллисекунд внутри вкладки такой щели не
  // оставляет.
  //
  // dispatchTo сам выбирает первую СВОБОДНУЮ машину игрока — ту, у которой нет
  // линии. Машину с кольца он не тронет, и это его собственное правило, а не
  // случайность порядка ключей.
  await page.evaluate(([from, to]) => {
    const store = (
      globalThis as unknown as {
        __plecho: {
          getState(): {
            dispatchTo(city: string): void
            state: {
              vehicles: Record<
                string,
                {
                  route: string[]
                  position: { kind: string; nodeId?: string }
                }
              >
            }
          }
        }
      }
    ).__plecho

    const drive = () => {
      const vehicle = store.getState().state.vehicles['zil-130-1']
      if (vehicle === undefined) return
      // Задание есть или машина в пути — не мешаем: перевыдача маршрута на
      // ходу развернула бы её посреди плеча и смазала бы сам опыт.
      if (vehicle.route.length > 0) return
      if (vehicle.position.kind !== 'узел') return

      store.getState().dispatchTo(vehicle.position.nodeId === from ? to : from)
    }

    ;(globalThis as unknown as { __plechoShuttle?: number }).__plechoShuttle =
      window.setInterval(drive, 100)
  }, SHUTTLE)

  // ─── Прогон ──────────────────────────────────────────────────────────────

  const startTick = await page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __plecho: { getState(): { state: { tick: number } } }
        }
      ).__plecho.getState().state.tick,
  )

  await page.evaluate((speed) => {
    ;(
      globalThis as unknown as {
        __plecho: { getState(): { setSpeed(speed: number): void } }
      }
    ).__plecho.getState().setSpeed(speed)
  }, TEST_SPEED)

  // Ждём игровое ВРЕМЯ, а не реальное. Сколько тиков успеет пройти за секунду,
  // зависит от машины, на которой гоняют тест, и от того, насколько бодро
  // headless-хром рисует WebGL программным растеризатором; номер тика не
  // зависит ни от того, ни от другого.
  await page.waitForFunction(
    ({ from, ticks }) =>
      (
        globalThis as unknown as {
          __plecho: { getState(): { state: { tick: number } } }
        }
      ).__plecho.getState().state.tick -
        from >=
      ticks,
    { from: startTick, ticks: OBSERVED_DAYS * TICKS_PER_DAY },
    { timeout: 150_000, polling: 250 },
  )

  // Останавливаем время и диспетчера: дальше идут измерения, и мир под ними
  // меняться не должен — иначе снимок метрик и снимок экрана окажутся из разных
  // моментов партии.
  await page.evaluate(() => {
    const dev = globalThis as unknown as {
      __plecho: { getState(): { setSpeed(speed: number): void } }
      __plechoShuttle?: number
    }
    dev.__plecho.getState().setSpeed(0)
    if (dev.__plechoShuttle !== undefined) window.clearInterval(dev.__plechoShuttle)
  })

  // Снимок живой игры со срезом 3: кольцо на карте, парк, панели. Делается ДО
  // утверждений и сразу после остановки времени — во-первых, это тот самый
  // момент, который меряют цифры ниже, во-вторых, при упавшей проверке смотреть
  // на игру нужнее всего, а после исключения снимок бы уже не сделался.
  await page.screenshot({ path: 'tests/e2e/screenshots/lines.png' })

  // ─── Главное утверждение среза ───────────────────────────────────────────

  const line = await mileageOf(page, LINE_TRUCK)
  const control = await mileageOf(page, CONTROL_TRUCK)

  const percent = (share: number) => `${Math.round(share * 100)}%`

  // Замер печатается всегда, а не только при падении: это и есть результат
  // опыта, и на него смотрят, когда правят баланс или маршруты кольца.
  console.log(
    `порожний пробег за ${OBSERVED_DAYS} сут: ` +
      `линия ${percent(line.share)} (${Math.round(line.emptyKm)} из ` +
      `${Math.round(line.loadedKm + line.emptyKm)} км), ` +
      `разовые рейсы ${percent(control.share)} (${Math.round(
        control.emptyKm,
      )} из ${Math.round(control.loadedKm + control.emptyKm)} км)`,
  )

  // Обе машины действительно работали. Без этой проверки нулевые счётчики
  // сравнились бы как «0 меньше 0» и тест был бы зелёным на мёртвой игре.
  expect(line.loadedKm, 'машина на линии возила груз').toBeGreaterThan(0)
  expect(control.emptyKm, 'контрольная машина ездила порожняком').toBeGreaterThan(
    0,
  )

  expect(
    line.share,
    `порожний пробег: линия ${percent(line.share)}, разовые рейсы ${percent(
      control.share,
    )} — линия обязана быть НИЖЕ`,
  ).toBeLessThan(control.share)

  // Челнок гружён в лучшем случае наполовину: груз лежит на одном конце плеча
  // из двух. Линия с двумя гружёными плечами из трёх обязана быть по эту
  // сторону границы, контроль — по ту.
  expect(line.share, 'кольцо лучше челнока').toBeLessThan(SHUTTLE_EMPTY_SHARE)
  expect(control.share, 'челнок не лучше кольца').toBeGreaterThan(
    RING_EMPTY_SHARE,
  )

  // ─── Деньги и метрики в интерфейсе ───────────────────────────────────────

  const totals = await dailyTotals(page)

  expect(
    totals.costs,
    'суточные расходы начисляются: топливо, зарплата, обслуживание',
  ).toBeGreaterThan(0)

  const ui = await page.locator('.ui-layer').innerText()

  expect(
    ui,
    'суточный итог компании показан игроку, а не только посчитан симуляцией',
  ).toMatch(DAILY_TOTAL)

  // Метрика самой линии: редактор обязан показывать её порожний пробег в
  // процентах — это главная строка среза. Ищем долю рядом с открытой линией, а
  // не любое число: «два плеча» и «шесть тонн» метрикой не являются.
  const editorText = await editor.innerText()
  expect(editorText, 'в редакторе открыта именно эта линия').toContain(LINE_NAME)
  expect(editorText, 'редактор показывает порожний пробег кольца').toMatch(
    /\d+\s*%/,
  )

  /*
   * ПРОВЕРКА СТЫКА, А НЕ ФОРМУЛЫ, и стоит она последней намеренно: это самое
   * глубокое утверждение файла, и падать оно должно тогда, когда всё видимое уже
   * проверено, — иначе одна оборванная ниточка внутри симуляции прячет отчёт обо
   * всём остальном.
   *
   * Выручку в суточное окно обязан класть тот, кто её начисляет, — фаза прибытия
   * через creditRevenue (шапка функции в sim/economy/operating.ts прямо это и
   * описывает). Прибавить рубли к money, забыв про dailyRevenue, — ошибка
   * бесшумная: деньги на счету правильные, а показанная игроку прибыль врёт, и
   * врёт в одну сторону — партия выглядит убыточной всегда. Юнит-тест ни одной
   * из сторон стыка её не видит: каждая сторона по отдельности верна. Видно её
   * только отсюда.
   */
  expect(
    totals.revenue,
    'доставленный груз попадает в суточную выручку, а не только на счёт',
  ).toBeGreaterThan(0)

  expect(errors, 'за весь прогон консоль осталась чистой').toEqual([])
})
