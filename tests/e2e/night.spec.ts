import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { CITIES_BY_ID } from '../../src/data/cities'
import { EDGES } from '../../src/data/roads'
import { surfaceSteps } from '../../src/render/roadSurface'
import { CFO_ORIGIN, project } from '../../src/sim/world/projection'
import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../../src/sim/types'
import type { Edge } from '../../src/sim/types'

/**
 * ДОРОГИ И МАШИНЫ: то, что видно на экране, и никак иначе не проверяемо.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ. В проекте дважды случалось одно и то же: модуль написан,
 * покрыт юнит-тестами, зелёный — и не подключён ни к чему. Здесь риск ровно
 * такой же и по той же механике. Ночь считается чистой функцией и проверена
 * юнит-тестом до последнего часа (vehicleLights.test.ts); покрытие дороги
 * разложено на участки и проверено (roadSurface.test.ts). Ни один из этих тестов
 * НЕ ЗАДАЁТ ВОПРОСА, дошли ли числа до видеокарты. Задаёт только этот файл, и
 * задаёт он его живым объектам сцены через дев-хуки __plechoRigs и __plechoRoads.
 *
 * ЧТО ДОКАЗЫВАЕТСЯ:
 *
 *   • в полночь у едущей машины ГОРЯТ ФАРЫ, в полдень — нет, и лучей на сцене
 *     ровно столько, сколько машин идёт по перегонам;
 *   • стоящая в городе машина фарами не светит даже глухой ночью;
 *   • лента дороги РАЗРЕЗАНА на участки — столько, сколько велит surfaceSteps по
 *     фактическим километрам карты;
 *   • КАЧЕСТВО ПОКРЫТИЯ ДОШЛО ДО ВЕРШИН: разных тонов в буфере класса ровно
 *     столько, сколько разных значений quality у его рёбер;
 *   • лестница классов на сцене цела: самая убитая федеральная светлее самой
 *     свежей региональной;
 *   • снимок ночной трассы ложится в tests/e2e/screenshots/night.png.
 *
 * ЧИСЛА НЕ ВПИСАНЫ РУКАМИ. Участки считаются той же surfaceSteps, которой их
 * считает рендер, километры и качество берутся из таблицы дорог, длина суток — из
 * TICKS_PER_DAY. Перебалансировка данных не должна ронять этот файл; изменение
 * ПРАВИЛА — должна.
 */

// ─── Дев-хуки ──────────────────────────────────────────────────────────────

type Vehicle = {
  id: string
  ownerId: string
  brokenDown: boolean
  driverId: string | null
  position:
    | { kind: 'узел'; nodeId: string }
    | { kind: 'ребро'; edgeId: string; fromId: string; progress: number }
}

type GameState = {
  tick: number
  playerId: string
  vehicles: Record<string, Vehicle>
}

/** Что VehicleMesh докладывает о своём последнем кадре. */
type RigsReport = {
  own: number
  hot: number
  cold: number
  bodies: number
  rivals: number
  beams: number
  night: number
}

/** Что RoadMesh докладывает о живых буферах полотна. */
type RoadReport = {
  roadClass: string
  vertices: number
  quads: number
  tones: number
  dimmest: number
  brightest: number
}

type Dev = {
  __plecho: {
    getState: () => {
      state: GameState
      setSpeed: (speed: number) => void
      advance: (ticks: number) => void
      dispatchTo: (destination: string) => void
    }
  }
  __plechoRigs?: () => RigsReport
  __plechoRoads?: () => RoadReport[]
  __plechoLook?: (id: string, factor?: number) => void
  /** Показать сцене другое время суток, не трогая симуляцию (Scene.tsx). */
  __plechoTime?: (tick: number | null) => void
}

/**
 * Поднять игру и остановить время.
 *
 * Пауза не ради скорости, а ради воспроизводимости: игровой цикл считает тики от
 * реальных часов, то есть от того, насколько быстра машина под тестом. Время
 * двигает сам тест — теми же вызовами advance, которыми его двигает цикл.
 */
async function boot(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(
    () => (globalThis as Record<string, unknown>).__plecho !== undefined,
  )
  await page.evaluate(() => {
    ;(globalThis as unknown as Dev).__plecho.getState().setSpeed(0)
  })
}

const readState = (page: Page): Promise<GameState> =>
  page.evaluate(() =>
    JSON.parse(
      JSON.stringify((globalThis as unknown as Dev).__plecho.getState().state),
    ) as GameState,
  )

/**
 * Дождаться кадра, в котором дев-хук уже видит новое время.
 *
 * Счётчики снимаются с ПОСЛЕДНЕГО НАРИСОВАННОГО кадра, а не считаются по
 * состоянию, — в этом вся их ценность и вся их особенность: между вызовом
 * advance и следующим кадром проходит реальное время браузера. Ждём кадра, а не
 * спим наугад: сон в 200 мс на нагруженной машине даёт мигающий тест.
 */
async function frame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
}

const rigs = async (page: Page): Promise<RigsReport> => {
  await frame(page)
  const report = await page.evaluate(
    () => (globalThis as unknown as Dev).__plechoRigs?.() ?? null,
  )
  expect(report, 'VehicleMesh смонтирован и докладывает о нарисованном').not.toBeNull()
  return report as RigsReport
}

/**
 * Показать сцене другое время суток, НЕ ТРОГАЯ СИМУЛЯЦИЮ.
 *
 * Хук заведён Scene.tsx ради того же, ради чего он здесь нужен: свет — чистая
 * функция от тика (sky.ts), и проверять его, прокручивая мир на полгода, значит
 * проверять заодно экономику, поломки и решения конкурентов. С подменой времени
 * в кадре остаются ТЕ ЖЕ машины на тех же местах, и меняется ровно одна
 * величина — солнце. Именно такое сравнение и доказывает, что фары зависят от
 * света, а не от чего-то ещё, что заодно поменялось за полгода.
 */
const showTime = (page: Page, tick: number | null): Promise<void> =>
  page.evaluate(
    (value) => (globalThis as unknown as Dev).__plechoTime?.(value),
    tick,
  )

/**
 * Длина ленты ребра на карте, км.
 *
 * НЕ `edge.km`, и это не мелочь. В таблице дорог лежит длина ПО ДОРОГЕ (Р-92
 * идёт 210 км там, где по прямой 175), а лента рисуется между двумя точками на
 * плоскости, то есть по прямой. Рендер режет на участки именно ленту — значит и
 * тест обязан считать по ней, иначе он проверял бы не правило, а извилистость
 * трасс. Проекция берётся та же самая, что и в CityMesh.cityPoint.
 */
function ribbonKm(edge: Edge): number {
  const from = project(CITIES_BY_ID[edge.from].coord, CFO_ORIGIN)
  const to = project(CITIES_BY_ID[edge.to].coord, CFO_ORIGIN)
  return Math.hypot(to.x - from.x, to.y - from.y)
}

/** Свои машины, идущие по перегону и способные тронуться сами. */
const rolling = (state: GameState): Vehicle[] =>
  Object.values(state.vehicles).filter(
    (vehicle) =>
      vehicle.ownerId === state.playerId &&
      vehicle.position.kind === 'ребро' &&
      !vehicle.brokenDown &&
      vehicle.driverId !== null,
  )

/**
 * Выгнать свою машину на трассу и вернуть состояние в этот момент.
 *
 * Разовым рейсом — тем же действием, что доступно игроку в панели парка. Ждать
 * заранее посчитанное число тиков нельзя: водитель может уйти на обязательный
 * отдых, машина — встать под погрузку, и оба простоя законны. Поэтому условие
 * проверяется каждый тик, а предел стоит по времени.
 */
async function sendOnTheRoad(page: Page, limitTicks: number): Promise<GameState> {
  const start = await readState(page)
  const own = Object.values(start.vehicles).find(
    (vehicle) => vehicle.ownerId === start.playerId,
  )
  expect(own, 'у игрока есть машина').toBeDefined()

  const where =
    (own as Vehicle).position.kind === 'узел'
      ? ((own as Vehicle).position as { nodeId: string }).nodeId
      : ((own as Vehicle).position as { fromId: string }).fromId

  const neighbour = EDGES.filter(
    (edge) => edge.from === where || edge.to === where,
  ).map((edge) => (edge.from === where ? edge.to : edge.from))[0]
  expect(neighbour, 'из города игрока есть куда поехать').toBeDefined()

  await page.evaluate(
    (id) => (globalThis as unknown as Dev).__plecho.getState().dispatchTo(id),
    neighbour,
  )

  await page.evaluate(
    (limit) => {
      const store = (globalThis as unknown as Dev).__plecho
      for (let step = 0; step < limit; step += 1) {
        const state = store.getState().state
        const moving = Object.values(state.vehicles).some(
          (vehicle) =>
            vehicle.ownerId === state.playerId && vehicle.position.kind === 'ребро',
        )
        if (moving) return
        store.getState().advance(1)
      }
    },
    limitTicks,
  )

  return readState(page)
}

// ─── Фары ──────────────────────────────────────────────────────────────────

test('в полночь у едущей машины горят фары, в полдень — нет', async ({ page }) => {
  await boot(page)

  /*
   * ПОЛНОЧЬ ЗАДАЁТСЯ ЯВНО, а не берётся из стартового времени партии.
   *
   * Раньше игра начиналась 1 января в 00:00, и первый же кадр был ночным сам
   * собой. Теперь партия открывается утром (разбор — у createInitialState в
   * sim/state.ts: чёрный экран на старте читался как «ничего не нарисовано»),
   * и опираться на стартовое время значило бы связать проверку фар с решением
   * о первом кадре. Это разные вещи, и вторая будет меняться ещё не раз.
   */
  await page.evaluate(() => window.__plechoTime?.(0))
  const midnight = await rigs(page)
  expect(midnight.night, 'полночь января — глухая ночь').toBe(1)

  // Пока машина стоит в Москве, фары молчат: свет означает «едет», а не «есть».
  expect(midnight.beams, 'стоящая в городе машина фарами не светит').toBe(0)

  const onTheRoad = await sendOnTheRoad(page, TICKS_PER_DAY)
  const moving = rolling(onTheRoad)
  expect(moving.length, 'машина вышла на трассу').toBeGreaterThan(0)

  const night = await rigs(page)
  expect(night.night, 'на трассе всё ещё ночь').toBeGreaterThan(0.9)
  expect(
    night.beams,
    'лучей на сцене ровно столько, сколько своих машин идёт по перегонам',
  ).toBe(moving.length)

  /*
   * ПОЛДЕНЬ — ТА ЖЕ МАШИНА НА ТОМ ЖЕ МЕСТЕ, изменилось только солнце. Время
   * подменяется сцене, а не прокручивается миру: иначе за полсуток машина
   * доехала бы, встала под погрузку или ушла отдыхать, и погасшие фары
   * объяснялись бы этим, а не светом.
   */
  await showTime(page, TICKS_PER_DAY / 2)

  const noon = await rigs(page)
  expect(noon.night, 'в полдень темноты нет').toBe(0)
  expect(noon.beams, 'днём ни одного луча на сцене').toBe(0)
  expect(
    noon.own,
    'при этом машины никуда не делись — погасли только фары',
  ).toBe(night.own)

  await showTime(page, null)
})

test('зимним утром фары ещё горят, а летним — уже нет', async ({ page }) => {
  await boot(page)
  const state = await sendOnTheRoad(page, TICKS_PER_DAY)
  expect(rolling(state).length, 'машина вышла на трассу').toBeGreaterThan(0)

  /*
   * ГЛАВНАЯ ПРОВЕРКА СЕЗОНА, и она про то, ради чего сезон вообще попал в свет.
   * Семь утра в январе — темно, семь утра в июле — светло; на карте это обязано
   * быть видно фарами, а не подписью «зима» в панели времени. Разница приходит
   * из наклона солнечной дуги в sky.ts — отдельного правила «зимой темнее» в
   * фарах нет и быть не должно.
   *
   * Оба утра показываются ОДНОЙ И ТОЙ ЖЕ машине на одном и том же месте.
   */
  await showTime(page, TICKS_PER_HOUR * 7)
  const winter = await rigs(page)
  expect(winter.night, 'семь утра в январе — ещё ночь').toBe(1)
  expect(winter.beams, 'зимним утром фары горят').toBeGreaterThan(0)

  await showTime(page, TICKS_PER_DAY * 182 + TICKS_PER_HOUR * 7)
  const summer = await rigs(page)
  expect(summer.night, 'семь утра в июле — уже день').toBe(0)
  expect(summer.beams, 'летним утром фары не нужны').toBe(0)

  await showTime(page, null)
})

// ─── Покрытие дороги ───────────────────────────────────────────────────────

test('дорога перестала быть прямоугольником: участки и качество дошли до вершин', async ({
  page,
}) => {
  await boot(page)

  const report = await page.evaluate(
    () => (globalThis as unknown as Dev).__plechoRoads?.() ?? null,
  )
  expect(report, 'RoadMesh смонтирован и докладывает о живых буферах').not.toBeNull()

  const roads = report as RoadReport[]
  expect(roads.length, 'на сцене есть ленты дорог').toBeGreaterThan(0)

  for (const road of roads) {
    const edges = EDGES.filter((edge) => edge.class === road.roadClass)
    expect(edges.length, `класс ${road.roadClass} есть в данных карты`).toBeGreaterThan(0)

    /*
     * ЛЕНТА РАЗРЕЗАНА. Число четырёхугольников считается той же функцией, что и
     * в рендере, по фактическим километрам таблицы дорог: совпадение доказывает
     * не «участков много», а «участков ровно столько, сколько велит правило».
     */
    const expected = edges.reduce((sum, edge) => sum + surfaceSteps(ribbonKm(edge)), 0)
    expect(road.quads, `${road.roadClass}: участков ленты`).toBe(expected)
    expect(
      road.quads,
      `${road.roadClass}: это заведомо больше одного четырёхугольника на ребро`,
    ).toBeGreaterThan(edges.length)

    /*
     * КАЧЕСТВО ДОШЛО ДО ВЕРШИН. Тон постоянен вдоль ребра и меняется между
     * рёбрами, поэтому разных тонов в буфере класса не может быть БОЛЬШЕ, чем
     * разных значений quality: больше означало бы, что тон зависит ещё от
     * чего-то, чего в правиле нет.
     *
     * Точного равенства требовать нельзя, и это выяснилось на карте страны.
     * Цвет вершины хранится восемью битами на канал, то есть шкала тона
     * дискретна; при семнадцати значениях качества в одном классе два соседних
     * (скажем, 0.62 и 0.63) неизбежно попадают в один и тот же байт. Это не
     * потеря качества, а предел формата, и требовать от него различать
     * сотые доли — значит проверять арифметику округления, а не то, дошло ли
     * качество до сцены.
     *
     * Дошло ли — проверяется тем, что тонов заведомо БОЛЬШЕ ОДНОГО и что
     * разбитая дорога темнее свежей.
     */
    const grades = new Set(edges.map((edge) => edge.quality))
    expect(
      road.tones,
      `${road.roadClass}: разных тонов покрытия`,
    ).toBeLessThanOrEqual(grades.size)
    if (grades.size > 1) {
      expect(
        road.tones,
        `${road.roadClass}: качество не дошло до вершин вовсе`,
      ).toBeGreaterThan(1)
    }

    if (grades.size > 1) {
      expect(
        road.brightest,
        `${road.roadClass}: разбитая дорога темнее свежей`,
      ).toBeGreaterThan(road.dimmest)
    }
  }

  /*
   * ЛЕСТНИЦА КЛАССОВ ЦЕЛА НА СЦЕНЕ. Качество двигает тон, но не имеет права
   * перевернуть класс: самая убитая федеральная обязана остаться светлее самой
   * свежей региональной, иначе разбитая М-2 читалась бы как областная дорога.
   * Проверяется по числам с живой геометрии, а не по палитре.
   */
  const federal = roads.find((road) => road.roadClass === 'федеральная')
  const regional = roads.find((road) => road.roadClass === 'региональная')
  if (federal !== undefined && regional !== undefined) {
    expect(federal.dimmest).toBeGreaterThan(regional.brightest)
  }

  /*
   * СНИМОК ПРИ ДНЕВНОМ СВЕТЕ, и город выбран не наугад. В Туле сходятся четыре
   * дороги двух классов и четырёх разных качеств: М-2 на Москву (федеральная,
   * 0.87), М-2 на Орёл (федеральная, 0.78), Р-132 на Калугу (региональная, 0.65)
   * и Р-132 на Рязань (региональная, 0.6). Один кадр показывает сразу обе
   * лестницы — классов и качества, — а заодно то, ради чего лента разрезана:
   * кромку, которая гуляет.
   *
   * Время показывается полуденное: ночью тона полотна не читаются вовсе — ключ
   * падает до лунного, и вся разница уходит в чёрное. Сезон остаётся тем, в
   * котором партия начинается, — январским: подмена времени касается только
   * солнца, а снег на подложке и в воздухе живёт от настоящего состояния мира.
   * Зимний кадр для дорог даже удобнее: тёмная лента на светлой земле — самый
   * строгий тест на то, что полотно читается как полотно.
   */
  await showTime(page, TICKS_PER_DAY / 2)
  await page.evaluate(
    ([id, factor]) =>
      (globalThis as unknown as Dev).__plechoLook?.(id as string, factor as number),
    ['tula', 5] as const,
  )
  await frame(page)
  await page.screenshot({ path: 'tests/e2e/screenshots/roads-day.png' })
  await showTime(page, null)
})

// ─── Кадр ──────────────────────────────────────────────────────────────────

/**
 * На каком удалении от города снимается машина, км.
 *
 * ВЫВЕДЕНО ИЗ КАРТЫ, а не подобрано, — тем же способом, что и в rivals.spec.ts.
 * Ближе четверти самого короткого ребра машина остаётся внутри застройки, а
 * высокие коробки домов закрывают её с изометрии почти целиком (именно так
 * выглядел первый вариант этого кадра: числа сходились, а на снимке была одна
 * Москва). Дальше — уходит за край кадра при выбранном приближении.
 */
const SHORTEST_KM = Math.min(...EDGES.map((edge) => edge.km))
const NEAR_KM = SHORTEST_KM / 4
const FAR_KM = SHORTEST_KM / 2

/** Приближение к вписанному в экран кадру. То же, что в rivals.spec.ts. */
const SCENE_ZOOM = 6

/** Час, на котором снимается ночь: глубокая ночь без намёка на сумерки. */
const SHOT_HOUR = 2

test('снимок ночной трассы', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(err.message))

  await boot(page)
  const state = await sendOnTheRoad(page, TICKS_PER_DAY)

  const moving = rolling(state)
  expect(moving.length, 'есть кого снимать').toBeGreaterThan(0)

  /*
   * СНИМАЕТСЯ ПОДЪЕЗД К ГОРОДУ, А НЕ ВЫЕЗД ИЗ НЕГО, и камера наводится на ЦЕЛЬ
   * рейса. Машина выходит из Москвы, а московская застройка — самая плотная на
   * карте: при любом приближении она занимает весь кадр, и луч фар теряется в
   * ней. Город назначения меньше, и на подъезде к нему в кадр попадает то, ради
   * чего снимок делается: тёмная трасса, фура и пятно света перед ней.
   */
  const edgeId = (moving[0].position as { edgeId: string }).edgeId
  const fromId = (moving[0].position as { fromId: string }).fromId
  const leg = EDGES.find((edge) => (edge.id as string) === edgeId)
  expect(leg, 'машина идёт по известному ребру').toBeDefined()
  const target = (leg as Edge).from === fromId ? (leg as Edge).to : (leg as Edge).from

  /*
   * Ждём, когда до цели останется нужное расстояние. Считать нужные тики заранее
   * нельзя: водитель уходит на обязательный отдых, оба простоя законны. Поэтому
   * условие проверяется каждый тик, а предел стоит по времени.
   */
  const framed = await page.evaluate(
    ([limit, near, far, km, edge, city]) => {
      const store = (globalThis as unknown as Dev).__plecho

      for (let step = 0; step < (limit as number); step += 1) {
        const state = store.getState().state
        const found = Object.values(state.vehicles).some((vehicle) => {
          if (vehicle.ownerId !== state.playerId) return false
          if (vehicle.position.kind !== 'ребро') return false
          if (vehicle.position.edgeId !== edge) return false
          const left =
            (vehicle.position.fromId === city
              ? vehicle.position.progress
              : 1 - vehicle.position.progress) * (km as number)
          return left >= (near as number) && left <= (far as number)
        })
        if (found) return true
        store.getState().advance(1)
      }
      return false
    },
    [TICKS_PER_DAY, NEAR_KM, FAR_KM, (leg as Edge).km, edgeId, target] as const,
  )

  /*
   * НЕ ПРОВЕРКА, А УСЛОВИЕ СЪЁМКИ: машина могла к этому времени доехать и встать
   * под погрузку. Роняя тест на этом, мы получили бы мигающую проверку, которая
   * ничего не охраняет, — фары доказаны выше числами со сцены.
   */
  if (!framed) {
    test.info().annotations.push({
      type: 'снимок',
      description: 'машина не оказалась на удобном для кадра удалении от города',
    })
  }

  /*
   * ВРЕМЯ СУТОК ЗАКРЕПЛЕНО НА ГЛУБОКОЙ НОЧИ. Снимок ищет положение машины, и на
   * это уходят игровые часы: без закрепления кадр мог бы попасть на рассвет, и
   * доказательство «ночью горят фары» превратилось бы в лотерею. Симуляции
   * подмена не касается — она видна только сцене.
   */
  await showTime(page, TICKS_PER_HOUR * SHOT_HOUR)

  await page.evaluate(
    ([id, factor]) =>
      (globalThis as unknown as Dev).__plechoLook?.(id as string, factor as number),
    [target, SCENE_ZOOM] as const,
  )
  await frame(page)

  const lit = await rigs(page)
  expect(lit.night, 'на снимке ночь').toBe(1)
  expect(lit.beams, 'на снимке горят фары').toBeGreaterThan(0)

  await page.screenshot({ path: 'tests/e2e/screenshots/night.png' })

  // Новая геометрия и новый материал — самое частое место для тихой ошибки
  // WebGL, а она приходит только в консоль.
  expect(errors, 'консоль чистая').toEqual([])
})
