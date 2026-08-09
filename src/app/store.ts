/**
 * Хранилище состояния игры.
 *
 * Zustand здесь — тонкая оболочка над чистой симуляцией: он держит ссылку на
 * последний снимок состояния и раздаёт её компонентам. Игровой логики в сторе
 * нет и быть не должно — всё, что решает, как устроен мир, живёт в src/sim и
 * тестируется без React.
 *
 * Снимка два. `state` — то, что вернул последний тик, `prev` — то, что было
 * тиком раньше. Тик редкий (15 игровых минут, около пяти раз в секунду на ×1),
 * кадр частый, поэтому рендер рисует не `state`, а интерполяцию `prev → state`
 * по `clock.alpha`. Без второго снимка машины дёргались бы рывками несколько
 * раз в секунду, и никакое сглаживание в шейдере это не спасло бы.
 */

import { create } from 'zustand'
import { ZIL_PRICE } from '../data/operating'
import { setRoute } from '../sim/logistics/vehicle'
import { createInitialState, createZil, HOME_CITY } from '../sim/state'
import { tick } from '../sim/tick'
import { lineId as toLineId, vehicleId as toVehicleId } from '../sim/types'
import type {
  CityId,
  Company,
  EdgeId,
  GameSpeed,
  GameState,
  Line,
  LineId,
  Stop,
  Vehicle,
  VehicleId,
} from '../sim/types'
import { buildGraph } from '../sim/world/graph'
import { findRoute } from '../sim/world/pathfind'

/**
 * Сид мира. Зафиксирован константой, а не взят из времени запуска: пока идёт
 * разработка, каждый прогон должен показывать один и тот же мир — иначе
 * «машина проскочила Тверь» не воспроизводится ни в тесте, ни у соседа.
 * Выбор сида игроком появится вместе с экраном новой партии.
 */
export const WORLD_SEED = 20260808

export type GameStore = {
  /** Текущее состояние симуляции. */
  state: GameState
  /** Состояние на предыдущем тике — только для интерполяции в рендере. */
  prev: GameState
  /** Ноль — пауза. Влияет лишь на число тиков за кадр, не на логику. */
  speed: GameSpeed
  setSpeed: (speed: GameSpeed) => void
  /** Продвинуть симуляцию на N тиков. Вызывается из игрового цикла. */
  advance: (ticks: number) => void
  /**
   * Отправить свободную машину игрока в город разовым рейсом.
   *
   * Разовые рейсы никуда не делись вместе с появлением линий: ими удобно
   * перегнать машину к началу будущего кольца и попробовать плечо руками до
   * того, как строить под него сеть.
   *
   * Команда достаётся машине БЕЗ ЛИНИИ. Машине на линии её выдавать
   * бессмысленно — фаза диспетчеризации следующего же тика перепишет маршрут
   * своим, и игрок увидел бы, что кнопка «отправить» просто не работает, без
   * малейшего намёка почему. Снимите машину с линии, и она снова слушается.
   */
  dispatchTo: (destination: CityId) => void

  /**
   * Завести линию. Возвращает идентификатор — по нему на неё ставят машины.
   *
   * Линию из одной остановки создать можно, и это не недосмотр: игрок собирает
   * кольцо по одной остановке, и запрещать промежуточное состояние значило бы
   * требовать заполнить форму целиком, прежде чем показать результат.
   * Неработающей такая линия становится сама собой — ездить между одной
   * остановкой и ей же некуда.
   */
  createLine: (name: string, stops: Stop[]) => LineId

  /** Переписать остановки существующей линии. Машины остаются на ней. */
  updateLine: (id: LineId, stops: Stop[]) => void

  /** Убрать линию. Её машины остаются в парке и встают без задания. */
  deleteLine: (id: LineId) => void

  /** Поставить машину на линию или снять с неё (lineId = null). */
  assignVehicle: (vehicleId: VehicleId, lineId: LineId | null) => void

  /** Купить ЗИЛ в домашнем городе. Не хватает денег — ничего не происходит. */
  buyVehicle: () => void
}

const initialState = createInitialState(WORLD_SEED)

export const useGameStore = create<GameStore>((set, get) => ({
  state: initialState,
  // До первого тика интерполировать нечего, поэтому оба снимка — один объект.
  prev: initialState,
  speed: 1,

  setSpeed: (speed) => set({ speed }),

  dispatchTo: (destination) =>
    set((store) => {
      const state = store.state
      const vehicle = Object.values(state.vehicles).find(
        (v) => v.ownerId === state.playerId && v.lineId === null,
      )
      if (vehicle === undefined) return store

      // Откуда считать путь: из города, если машина стоит, и из того города,
      // КУДА она едет, если она уже на ребре. Развернуть фуру посреди трассы
      // нельзя — она доедет до ближайшего узла и только там свернёт.
      const origin =
        vehicle.position.kind === 'узел'
          ? vehicle.position.nodeId
          : otherEndOf(state, vehicle.position.edgeId, vehicle.position.fromId)

      if (origin === null) return store

      const route = findRoute(
        buildGraph(state.world.edges),
        origin,
        destination,
        vehicle.cruiseKmh,
      )
      if (route === null) return store

      return {
        ...store,
        state: {
          ...state,
          vehicles: {
            ...state.vehicles,
            [vehicle.id]: setRoute(vehicle, route),
          },
        },
      }
    }),

  createLine: (name, stops) => {
    const state = get().state
    const owner = state.companies[state.playerId]
    // Идентификатор считается ДО set: сигнатура обязана его вернуть, иначе
    // поставить машину на только что созданную линию будет нечем.
    const id = nextLineId(owner.lines)

    set((store) => {
      const line: Line = {
        id,
        name,
        stops: copyStops(stops),
        assignedVehicles: [],
      }
      return withPlayer(store, (company) => ({
        ...company,
        lines: { ...company.lines, [id]: line },
      }))
    })

    return id
  },

  updateLine: (id, stops) =>
    set((store) => {
      const company = store.state.companies[store.state.playerId]
      const line = company.lines[id]
      if (line === undefined) return store

      const next = copyStops(stops)

      // Остановок стало меньше — индекс машины может смотреть за конец списка.
      // Такая машина не «поедет к остановке номер семь», её просто некуда
      // диспетчеризовать, и молча оставить битый индекс в сохранении нельзя.
      const vehicles = mapVehicles(store.state.vehicles, (vehicle) =>
        vehicle.lineId === id && vehicle.stopIndex >= next.length
          ? { ...vehicle, stopIndex: 0, route: [] }
          : vehicle,
      )

      return withPlayer(
        { ...store, state: { ...store.state, vehicles } },
        (target) => ({
          ...target,
          lines: { ...target.lines, [id]: { ...line, stops: next } },
        }),
      )
    }),

  deleteLine: (id) =>
    set((store) => {
      const company = store.state.companies[store.state.playerId]
      if (company.lines[id] === undefined) return store

      // Машины удалённой линии остаются в парке и встают без задания. Удалять
      // их вместе с линией было бы катастрофой в один клик; оставлять на
      // несуществующей линии — тихой поломкой диспетчеризации.
      const vehicles = mapVehicles(store.state.vehicles, (vehicle) =>
        vehicle.lineId === id ? detached(vehicle) : vehicle,
      )

      const lines = { ...company.lines }
      delete lines[id]

      return withPlayer(
        { ...store, state: { ...store.state, vehicles } },
        (target) => ({ ...target, lines }),
      )
    }),

  assignVehicle: (vehicleId, lineId) =>
    set((store) => {
      const state = store.state
      const vehicle = state.vehicles[vehicleId]
      if (vehicle === undefined) return store
      if (vehicle.ownerId !== state.playerId) return store

      const company = state.companies[state.playerId]
      if (lineId !== null && company.lines[lineId] === undefined) return store
      if (vehicle.lineId === lineId) return store

      /*
       * Связь двусторонняя: машина помнит линию, линия помнит машины. Держать
       * её в одном месте было бы честнее, но интерфейсу нужны оба направления —
       * «на какой линии эта машина» в карточке машины и «сколько машин на
       * линии» в списке линий, — а обход всего парка ради второго вопроса на
       * каждый кадр рендера того не стоит. Раз копий две, обновлять их обязано
       * одно место, и это оно.
       */
      const lines: Record<LineId, Line> = { ...company.lines }

      if (vehicle.lineId !== null) {
        const previous = lines[vehicle.lineId]
        if (previous !== undefined) {
          lines[previous.id] = {
            ...previous,
            assignedVehicles: previous.assignedVehicles.filter(
              (id) => id !== vehicleId,
            ),
          }
        }
      }

      if (lineId !== null) {
        const target = lines[lineId]
        lines[lineId] = {
          ...target,
          assignedVehicles: target.assignedVehicles.includes(vehicleId)
            ? target.assignedVehicles
            : [...target.assignedVehicles, vehicleId],
        }
      }

      // Маршрут стирается в обе стороны. Поставили на линию — диспетчеризация
      // выдаст свой на ближайшем же тике, и остатки прежнего задания только
      // увели бы машину не туда. Сняли с линии — машина доедет до ближайшего
      // узла и встанет, ожидая команды: продолжать кольцо, с которого её
      // только что сняли, она не должна.
      const vehicles = {
        ...state.vehicles,
        [vehicleId]:
          lineId === null
            ? detached(vehicle)
            : { ...vehicle, lineId, stopIndex: 0, route: [] },
      }

      return withPlayer(
        { ...store, state: { ...state, vehicles } },
        (target) => ({ ...target, lines }),
      )
    }),

  buyVehicle: () =>
    set((store) => {
      const state = store.state
      const company = state.companies[state.playerId]

      // Покупка в кредит — механика среза 6, а не «ну ладно, уйдём в минус».
      // Молчаливый отказ здесь правильнее исключения: кнопка в интерфейсе
      // недоступна ровно по этому же условию, и до сюда доходит только гонка
      // между кликом и уходящими на топливо деньгами.
      if (company.money < ZIL_PRICE) return store

      const id = nextVehicleId(state.vehicles)
      const truck = createZil(id, company.id, HOME_CITY)

      return withPlayer(
        {
          ...store,
          state: { ...state, vehicles: { ...state.vehicles, [id]: truck } },
        },
        (target) => ({ ...target, money: target.money - ZIL_PRICE }),
      )
    }),

  advance: (ticks) =>
    set((store) => {
      // Кадр без тика — норма, а не исключение: тик длиннее кадра. Возвращаем
      // тот же объект, чтобы zustand не будил подписчиков впустую.
      if (ticks < 1) return store

      let prev = store.state
      let state = store.state
      for (let i = 0; i < ticks; i++) {
        prev = state
        state = tick(state)
      }

      // prev — ровно один тик до state, даже когда за кадр их прошло несколько:
      // интерполяции нужен последний отрезок пути, а не начало всей пачки.
      return { prev, state }
    }),
}))

// ─── Правка состояния из интерфейса ────────────────────────────────────────
//
// Все действия ниже меняют GameState в обход тика, и это единственное место в
// проекте, где так можно. Правило то же, что и в симуляции: НИКАКОЙ МУТАЦИИ.
// Состояние пересобирается новыми объектами до самого изменённого поля, потому
// что рендер сравнивает снимки по ссылке, а сохранение — это JSON того самого
// объекта, который сейчас в сторе.

/**
 * Заменить компанию игрока и вернуть новый стор.
 *
 * Обёртка существует затем, чтобы четыре действия не переписывали одну и ту же
 * лесенку `store → state → companies → player` каждое по-своему. Пропущенный
 * уровень копирования в такой лесенке — самый дорогой из тихих дефектов:
 * состояние выглядит правильным, а рендер перестаёт замечать изменения.
 */
function withPlayer(
  store: GameStore,
  patch: (company: Company) => Company,
): GameStore {
  const state = store.state
  const company = state.companies[state.playerId]
  if (company === undefined) return store

  return {
    ...store,
    state: {
      ...state,
      companies: { ...state.companies, [state.playerId]: patch(company) },
    },
  }
}

/** Парк, прогнанный через преобразование. Неизменённые машины — по ссылке. */
function mapVehicles(
  vehicles: Record<VehicleId, Vehicle>,
  patch: (vehicle: Vehicle) => Vehicle,
): Record<VehicleId, Vehicle> {
  const next: Record<VehicleId, Vehicle> = {}
  for (const id of Object.keys(vehicles) as VehicleId[]) {
    next[id] = patch(vehicles[id])
  }
  return next
}

/** Машина, снятая с линии: стоит и ждёт команды. Груз остаётся в кузове. */
function detached(vehicle: Vehicle): Vehicle {
  return { ...vehicle, lineId: null, stopIndex: 0, route: [] }
}

/**
 * Глубокая копия остановок.
 *
 * Массивы грузов копируются поимённо, а не спредом верхнего уровня. Остановки
 * приходят из формы интерфейса, которая продолжает жить своей жизнью после
 * нажатия «сохранить»: общий массив означал бы, что следующая правка формы
 * задним числом меняет уже работающую линию.
 */
function copyStops(stops: readonly Stop[]): Stop[] {
  return stops.map((stop) => ({
    nodeId: stop.nodeId,
    unload: [...stop.unload],
    load: [...stop.load],
  }))
}

/**
 * Следующий свободный номер в семействе идентификаторов вида «line-3».
 *
 * Считается МАКСИМУМ, а не количество. Количество после удаления линии выдало
 * бы номер, который уже занят: удалили «line-2» из трёх, и следующая линия
 * получила бы «line-3» — то есть чужой идентификатор, вместе с чужими машинами
 * в assignedVehicles.
 */
function nextNumber(keys: readonly string[], prefix: string): number {
  let max = 0
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue
    const suffix = Number(key.slice(prefix.length))
    if (Number.isInteger(suffix) && suffix > max) max = suffix
  }
  return max + 1
}

function nextLineId(lines: Record<LineId, Line>): LineId {
  return toLineId(`line-${nextNumber(Object.keys(lines), 'line-')}`)
}

/**
 * Идентификатор новой машины.
 *
 * Продолжает нумерацию стартового «zil-1» (см. STARTER_VEHICLE_ID в
 * sim/state.ts). Числовых идентификаторов не заводим сознательно: порядок
 * обхода машин значим в фазе прибытия, а ключи, похожие на целые числа,
 * движок поднимает наверх и сортирует численно — разбор в шапке
 * sim/logistics/loading.ts.
 */
function nextVehicleId(vehicles: Record<VehicleId, Vehicle>): VehicleId {
  return toVehicleId(`zil-${nextNumber(Object.keys(vehicles), 'zil-')}`)
}

/** Дальний конец ребра относительно того, откуда выехали. */
function otherEndOf(
  state: GameState,
  edgeId: EdgeId,
  fromId: CityId,
): CityId | null {
  const edge = state.world.edges[edgeId]
  if (edge === undefined) return null
  return edge.from === fromId ? edge.to : edge.from
}

/**
 * Доступ к состоянию из консоли и из e2e — только в режиме разработки.
 *
 * Нужен, чтобы тест мог проверять симуляцию напрямую («машина доехала?»), а не
 * угадывать её состояние по пикселям. В продакшен-сборке ветка вырезается
 * целиком: import.meta.env.DEV — константа на этапе сборки, и минификатор
 * выбрасывает мёртвый код вместе с ссылкой на стор.
 */
if (import.meta.env.DEV) {
  ;(globalThis as unknown as { __plecho?: unknown }).__plecho = useGameStore
}
