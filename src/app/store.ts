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
import { setRoute } from '../sim/logistics/vehicle'
import { createInitialState } from '../sim/state'
import { tick } from '../sim/tick'
import type { CityId, EdgeId, GameSpeed, GameState } from '../sim/types'
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
   * Отправить машину игрока в город.
   *
   * Пока машина одна и линий ещё нет, это единственный способ отдать команду —
   * и заодно единственное место, где поиск пути встречается с симуляцией.
   * В срезе 4 отсюда вырастет назначение на линию.
   */
  dispatchTo: (destination: CityId) => void
}

const initialState = createInitialState(WORLD_SEED)

export const useGameStore = create<GameStore>((set) => ({
  state: initialState,
  // До первого тика интерполировать нечего, поэтому оба снимка — один объект.
  prev: initialState,
  speed: 1,

  setSpeed: (speed) => set({ speed }),

  dispatchTo: (destination) =>
    set((store) => {
      const state = store.state
      const vehicle = Object.values(state.vehicles).find(
        (v) => v.ownerId === state.playerId,
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
