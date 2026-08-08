import { describe, expect, it } from 'vitest'
import { CITIES } from '../../data/cities'
import { EDGES, EDGES_BY_ID } from '../../data/roads'
import { cityId, edgeId } from '../types'
import type { CityId, Edge, EdgeId, RoadClass } from '../types'
import { buildGraph, findEdge } from './graph'
import { clearRouteCache, findRoute, routeCost } from './pathfind'
import { edgeTravelHours } from './speed'

/**
 * Скорости двух эталонных машин.
 *
 * Все проверки маршрутов гоняются от лица магистрального тягача, а ЗИЛ нужен
 * там, где важно, что маршрут ЗАВИСИТ от машины: его потолок 70 км/ч ниже
 * разрешённых на федеральной трассе 90, поэтому выигрыш от объезда по
 * магистрали он получить не может.
 */
const MAGISTRAL_KMH = 90
const ZIL_KMH = 70

/** Потолки по классам — переписаны здесь намеренно, см. рассуждение ниже. */
const CLASS_LIMIT_KMH: Record<RoadClass, number> = {
  'федеральная': 90,
  'региональная': 70,
  'местная': 50,
}

/**
 * Проверки поиска пути на реальном графе ЦФО.
 *
 * Главное здесь — не «нашёлся ли путь», а «тот ли путь нашёлся». Дейкстра по
 * километрам и Дейкстра по времени возвращают разные маршруты на одних и тех
 * же данных, обе выглядят правдоподобно, и подмена одной другой не падает
 * никогда — она просто делает всю логистику в игре медленнее, чем должна быть.
 * Поэтому маршруты сверяются с полным перебором: он тупой, но независимый.
 */

const GRAPH = buildGraph(EDGES_BY_ID)

const MOSCOW = cityId('moscow')
const TULA = cityId('tula')
const OREL = cityId('orel')
const KALUGA = cityId('kaluga')
const RYAZAN = cityId('ryazan')
const SMOLENSK = cityId('smolensk')
const BRYANSK = cityId('bryansk')
const NOWHERE = cityId('atlantida')

const ALL_CITIES: CityId[] = CITIES.map((city) => city.id)

// ─── Независимый перебор ───────────────────────────────────────────────────
// Всё ниже считается прямо по EDGES, без graph.ts и pathfind.ts. Тест,
// пользующийся проверяемым кодом как линейкой, проверяет только сам себя.

const ADJACENCY = new Map<CityId, CityId[]>()
for (const edge of EDGES) {
  if (!ADJACENCY.has(edge.from)) ADJACENCY.set(edge.from, [])
  if (!ADJACENCY.has(edge.to)) ADJACENCY.set(edge.to, [])
  ADJACENCY.get(edge.from)!.push(edge.to)
  ADJACENCY.get(edge.to)!.push(edge.from)
}

function edgeBetween(a: CityId, b: CityId): Edge {
  const edge = EDGES.find(
    (e) => (e.from === a && e.to === b) || (e.from === b && e.to === a),
  )
  if (edge === undefined) throw new Error(`нет ребра ${a} — ${b}`)
  return edge
}

/** Километры маршрута — по данным, без учёта скоростей. */
function pathKm(path: readonly CityId[]): number {
  let km = 0
  for (let i = 1; i < path.length; i++) {
    km += edgeBetween(path[i - 1], path[i]).km
  }
  return km
}

/**
 * Часы маршрута — формула переписана здесь заново, а не взята из world/speed.
 *
 * Это принципиально: линейка, собранная из проверяемого кода, меряет только
 * саму себя. Если формулу скорости однажды поправят «оптимизацией», тест
 * обязан это заметить, а не переехать вместе с ней.
 */
function pathHours(path: readonly CityId[], cruiseKmh: number): number {
  let hours = 0
  for (let i = 1; i < path.length; i++) {
    const edge = edgeBetween(path[i - 1], path[i])
    const speed = Math.min(cruiseKmh, CLASS_LIMIT_KMH[edge.class]) * edge.quality
    hours += edge.km / speed
  }
  return hours
}

/**
 * Все простые пути между городами.
 *
 * Десять узлов и восемнадцать рёбер — перебор считается мгновенно и даёт
 * заведомо верный ответ, с которым можно сверять Дейкстру.
 */
function allPaths(from: CityId, to: CityId): CityId[][] {
  const found: CityId[][] = []
  const path: CityId[] = [from]
  const visited = new Set<CityId>([from])

  const walk = (city: CityId): void => {
    if (city === to) {
      found.push([...path])
      return
    }
    for (const next of ADJACENCY.get(city) ?? []) {
      if (visited.has(next)) continue
      visited.add(next)
      path.push(next)
      walk(next)
      path.pop()
      visited.delete(next)
    }
  }

  walk(from)
  return found
}

/** Путь с минимальной суммой по заданной мере. */
function bestPath(
  from: CityId,
  to: CityId,
  measure: (path: readonly CityId[]) => number,
): CityId[] {
  const paths = allPaths(from, to)
  return paths.reduce((best, path) =>
    measure(path) < measure(best) ? path : best,
  )
}

/** Пары городов в обе стороны — для проверок «на всём графе». */
function allPairs(): [CityId, CityId][] {
  const pairs: [CityId, CityId][] = []
  for (const a of ALL_CITIES) {
    for (const b of ALL_CITIES) {
      if (a !== b) pairs.push([a, b])
    }
  }
  return pairs
}

/** Ребро для искусственных графов. */
function makeEdge(
  from: string,
  to: string,
  km: number,
  roadClass: RoadClass = 'федеральная',
  quality = 1,
): Edge {
  return {
    id: edgeId(`${from}-${to}`),
    from: cityId(from),
    to: cityId(to),
    km,
    class: roadClass,
    route: 'тестовая',
    quality,
  }
}

function tableOf(edges: Edge[]): Record<EdgeId, Edge> {
  return Object.fromEntries(edges.map((edge) => [edge.id, edge])) as Record<
    EdgeId,
    Edge
  >
}

// ─── Тесты ─────────────────────────────────────────────────────────────────

describe('edgeTravelHours', () => {
  it('время растёт при падении качества при той же длине', () => {
    // Два ребра одинаковой длины: одно по М-2 (0.87), другое по Р-132 (0.6).
    const good = edgeTravelHours(edgeBetween(MOSCOW, TULA), MAGISTRAL_KMH)
    const bad = edgeTravelHours(edgeBetween(TULA, RYAZAN), MAGISTRAL_KMH)
    expect(edgeBetween(MOSCOW, TULA).km).toBe(edgeBetween(TULA, RYAZAN).km)
    expect(bad).toBeGreaterThan(good)
  })

  it('Москва — Тула укладывается примерно в два с половиной часа', () => {
    // 185 км по М-2 при 90 × 0.87 = 78.3 км/ч. Порядок величины важен сам по
    // себе: если рейс внутри округа считается сутками, где-то потеряны единицы.
    expect(edgeTravelHours(edgeBetween(MOSCOW, TULA), MAGISTRAL_KMH)).toBeCloseTo(2.363, 2)
  })

  it('непроезжая дорога стоит бесконечности', () => {
    const washedOut = makeEdge('a', 'b', 100, 'региональная', 0)
    expect(edgeTravelHours(washedOut, MAGISTRAL_KMH)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('findRoute', () => {
  it('путь из города в себя — один элемент', () => {
    expect(findRoute(GRAPH, MOSCOW, MOSCOW, MAGISTRAL_KMH)).toEqual([MOSCOW])
    expect(routeCost(GRAPH, [MOSCOW], MAGISTRAL_KMH)).toBe(0)
  })

  it('путь между соседями — два элемента', () => {
    expect(findRoute(GRAPH, MOSCOW, TULA, MAGISTRAL_KMH)).toEqual([MOSCOW, TULA])
    expect(findRoute(GRAPH, TULA, MOSCOW, MAGISTRAL_KMH)).toEqual([TULA, MOSCOW])
  })

  it('Смоленск → Рязань идёт через промежуточные города', () => {
    const route = findRoute(GRAPH, SMOLENSK, RYAZAN, MAGISTRAL_KMH)
    expect(route).not.toBeNull()
    expect(route!.length).toBeGreaterThan(2)
    expect(route![0]).toBe(SMOLENSK)
    expect(route![route!.length - 1]).toBe(RYAZAN)

    // Каждая соседняя пара маршрута обязана быть связана настоящим ребром:
    // маршрут, «перепрыгивающий» город, — самая дорогая из возможных ошибок,
    // потому что машина по нему поедет как ни в чём не бывало.
    for (let i = 1; i < route!.length; i++) {
      expect(
        findEdge(GRAPH, route![i - 1], route![i]),
        `${route![i - 1]} — ${route![i]}`,
      ).toBeDefined()
    }

    // Через Москву: радиальная схема ЦФО в чистом виде — южная рокада через
    // Брянск и Орёл вдвое дольше по времени.
    expect(route).toEqual([SMOLENSK, MOSCOW, RYAZAN])
  })

  it('города в маршруте не повторяются', () => {
    for (const [from, to] of allPairs()) {
      const route = findRoute(GRAPH, from, to, MAGISTRAL_KMH)!
      expect(new Set(route).size, `${from} → ${to}`).toBe(route.length)
    }
  })

  it('маршрут оптимален по времени — сверка с полным перебором', () => {
    for (const [from, to] of allPairs()) {
      const route = findRoute(GRAPH, from, to, MAGISTRAL_KMH)!
      const brute = bestPath(from, to, (path) => pathHours(path, MAGISTRAL_KMH))
      expect(routeCost(GRAPH, route, MAGISTRAL_KMH), `${from} → ${to}`).toBeCloseTo(
        pathHours(brute, MAGISTRAL_KMH),
        9,
      )
    }
  })

  it('маршрут симметричен: обратный путь — тот же, задом наперёд', () => {
    // Веса рёбер не зависят от направления, поэтому расхождение здесь означало
    // бы, что в поиск затесалась асимметрия — например, потерянное ребро в
    // одном из списков смежности.
    for (const [from, to] of allPairs()) {
      const there = findRoute(GRAPH, from, to, MAGISTRAL_KMH)!
      const back = findRoute(GRAPH, to, from, MAGISTRAL_KMH)!
      expect(routeCost(GRAPH, back, MAGISTRAL_KMH), `${from} → ${to}`).toBeCloseTo(
        routeCost(GRAPH, there, MAGISTRAL_KMH),
        9,
      )
    }
  })
})

describe('время против километров', () => {
  it('маршрут по времени нигде не хуже маршрута по километрам', () => {
    for (const [from, to] of allPairs()) {
      const byTime = findRoute(GRAPH, from, to, MAGISTRAL_KMH)!
      const byKm = bestPath(from, to, pathKm)
      // Допуск на арифметику с плавающей точкой: сравниваются суммы дробей.
      expect(routeCost(GRAPH, byTime, MAGISTRAL_KMH), `${from} → ${to}`).toBeLessThanOrEqual(
        pathHours(byKm, MAGISTRAL_KMH) + 1e-9,
      )
    }
  })

  it('учёт качества реально меняет выбор хотя бы на одной паре', () => {
    // Если бы вес совпадал с километрами, этот список был бы пуст — и тест
    // ловил бы подмену времени расстоянием.
    const differing = allPairs().filter(([from, to]) => {
      const byTime = findRoute(GRAPH, from, to, MAGISTRAL_KMH)!
      return pathKm(byTime) > pathKm(bestPath(from, to, pathKm)) + 1e-9
    })
    expect(differing.length).toBeGreaterThan(0)
  })

  it('ЗИЛ на том же плече едет НАПРЯМУЮ — маршрут зависит от машины', () => {
    // Обратная сторона предыдущего теста и причина, по которой крейсерская
    // скорость входит в сигнатуру поиска.
    //
    // Объезд через Тулу выигрывает только за счёт М-2, где разрешено 90. ЗИЛ
    // с потолком 70 этой скорости взять не может: он платит за лишние 83 км,
    // не получая взамен ничего. Для него прямая Р-92 быстрее.
    //
    // Раньше поиск считал скорость по классу дороги, не глядя на машину, и
    // отправлял ЗИЛ в объезд — на 19 минут медленнее. Ошибка была тихой:
    // машина просто «почему-то долго едет».
    const zilRoute = findRoute(GRAPH, KALUGA, OREL, ZIL_KMH)
    expect(zilRoute).toEqual([KALUGA, OREL])

    const detour = [KALUGA, TULA, OREL]
    expect(routeCost(GRAPH, zilRoute!, ZIL_KMH)).toBeLessThan(
      routeCost(GRAPH, detour, ZIL_KMH),
    )

    // И тот же объезд для тягача — наоборот, выигрышный. Одни данные, один
    // граф, разный ответ.
    expect(routeCost(GRAPH, detour, MAGISTRAL_KMH)).toBeLessThan(
      routeCost(GRAPH, [KALUGA, OREL], MAGISTRAL_KMH),
    )
  })

  it('кэш не путает машины: разная крейсерская — разные ответы', () => {
    // Ключ кэша обязан включать скорость. Если бы не включал, первый же
    // спросивший занял бы ячейку своим маршрутом, а второй получил бы чужой.
    clearRouteCache()
    const zilFirst = findRoute(GRAPH, KALUGA, OREL, ZIL_KMH)
    const tractorAfter = findRoute(GRAPH, KALUGA, OREL, MAGISTRAL_KMH)
    expect(zilFirst).toEqual([KALUGA, OREL])
    expect(tractorAfter).toEqual([KALUGA, TULA, OREL])

    // И в обратном порядке — на случай, если ячейку займёт тягач.
    clearRouteCache()
    const tractorFirst = findRoute(GRAPH, KALUGA, OREL, MAGISTRAL_KMH)
    const zilAfter = findRoute(GRAPH, KALUGA, OREL, ZIL_KMH)
    expect(tractorFirst).toEqual([KALUGA, TULA, OREL])
    expect(zilAfter).toEqual([KALUGA, OREL])
  })

  it('Калуга → Орёл едет в объезд через Тулу, а не напрямую по Р-92', () => {
    // Тот самый случай, ради которого вес считается в часах. Прямая Р-92 —
    // 210 км глухой двухполоски (качество 0.55, то есть 38.5 км/ч), объезд
    // через Тулу — 293 км, но по Р-132 и М-2.
    const route = findRoute(GRAPH, KALUGA, OREL, MAGISTRAL_KMH)
    expect(route).toEqual([KALUGA, TULA, OREL])

    const direct = [KALUGA, OREL]
    expect(pathKm(route!)).toBeGreaterThan(pathKm(direct))
    expect(routeCost(GRAPH, route!, MAGISTRAL_KMH)).toBeLessThan(routeCost(GRAPH, direct, MAGISTRAL_KMH))

    // Порядок выигрыша: около получаса на плече в пять часов.
    expect(routeCost(GRAPH, direct, MAGISTRAL_KMH) - routeCost(GRAPH, route!, MAGISTRAL_KMH)).toBeGreaterThan(
      0.3,
    )
  })
})

describe('routeCost', () => {
  it('пустой и одногородний маршрут стоят ноль', () => {
    expect(routeCost(GRAPH, [], MAGISTRAL_KMH)).toBe(0)
    expect(routeCost(GRAPH, [MOSCOW], MAGISTRAL_KMH)).toBe(0)
  })

  it('стоимость складывается из рёбер', () => {
    const route = [SMOLENSK, MOSCOW, RYAZAN]
    expect(routeCost(GRAPH, route, MAGISTRAL_KMH)).toBeCloseTo(
      edgeTravelHours(edgeBetween(SMOLENSK, MOSCOW), MAGISTRAL_KMH) +
        edgeTravelHours(edgeBetween(MOSCOW, RYAZAN), MAGISTRAL_KMH),
      9,
    )
  })

  it('разрыв в маршруте стоит бесконечности, а не падения', () => {
    // Между Москвой и Орлом прямой дороги нет: такой «маршрут» обязан
    // проиграть любому целому в сравнении, а не уронить тик.
    expect(routeCost(GRAPH, [MOSCOW, OREL], MAGISTRAL_KMH)).toBe(Number.POSITIVE_INFINITY)
    expect(routeCost(GRAPH, [MOSCOW, NOWHERE], MAGISTRAL_KMH)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('недостижимость', () => {
  /** Две несвязанные компоненты: московская пара и брянская пара. */
  const SPLIT = buildGraph(
    tableOf([
      makeEdge('moscow', 'tula', 185),
      makeEdge('bryansk', 'orel', 131),
    ]),
  )

  it('город из другой компоненты недостижим', () => {
    expect(findRoute(SPLIT, MOSCOW, BRYANSK, MAGISTRAL_KMH)).toBeNull()
    expect(findRoute(SPLIT, OREL, TULA, MAGISTRAL_KMH)).toBeNull()
  })

  it('внутри своей компоненты путь по-прежнему находится', () => {
    expect(findRoute(SPLIT, MOSCOW, TULA, MAGISTRAL_KMH)).toEqual([MOSCOW, TULA])
    expect(findRoute(SPLIT, BRYANSK, OREL, MAGISTRAL_KMH)).toEqual([BRYANSK, OREL])
  })

  it('неизвестный город даёт null, а не пустой маршрут', () => {
    expect(findRoute(GRAPH, MOSCOW, NOWHERE, MAGISTRAL_KMH)).toBeNull()
    expect(findRoute(GRAPH, NOWHERE, MOSCOW, MAGISTRAL_KMH)).toBeNull()
    // В том числе «сам в себя»: правдоподобный [id] на опечатке спрятал бы
    // ошибку до самого движения машины.
    expect(findRoute(GRAPH, NOWHERE, NOWHERE, MAGISTRAL_KMH)).toBeNull()
  })

  it('дорога с нулевым качеством не считается дорогой', () => {
    const blocked = buildGraph(
      tableOf([makeEdge('moscow', 'tula', 185, 'федеральная', 0)]),
    )
    expect(findRoute(blocked, MOSCOW, TULA, MAGISTRAL_KMH)).toBeNull()
  })
})

describe('кэш маршрутов', () => {
  it('кэш возвращает то же, что и расчёт без кэша', () => {
    for (const [from, to] of allPairs()) {
      clearRouteCache()
      const cold = findRoute(GRAPH, from, to, MAGISTRAL_KMH)
      const warm = findRoute(GRAPH, from, to, MAGISTRAL_KMH)
      expect(warm, `${from} → ${to}`).toEqual(cold)

      clearRouteCache()
      expect(findRoute(GRAPH, from, to, MAGISTRAL_KMH), `${from} → ${to}`).toEqual(cold)
    }
  })

  it('отсутствие пути кэшируется наравне с найденным', () => {
    clearRouteCache()
    const split = buildGraph(
      tableOf([
        makeEdge('moscow', 'tula', 185),
        makeEdge('bryansk', 'orel', 131),
      ]),
    )
    expect(findRoute(split, MOSCOW, BRYANSK, MAGISTRAL_KMH)).toBeNull()
    expect(findRoute(split, MOSCOW, BRYANSK, MAGISTRAL_KMH)).toBeNull()
  })

  it('наружу отдаётся копия: испорченный маршрут не портит кэш', () => {
    // Машина выкусывает города из своего маршрута по мере движения. Если бы
    // findRoute отдавал сам массив из кэша, первая же машина объела бы его, а
    // следующая получила бы огрызок как готовый план поездки.
    clearRouteCache()
    const first = findRoute(GRAPH, SMOLENSK, RYAZAN, MAGISTRAL_KMH)!
    const expected = [...first]
    first.shift()
    first.push(MOSCOW)

    const second = findRoute(GRAPH, SMOLENSK, RYAZAN, MAGISTRAL_KMH)!
    expect(second).toEqual(expected)
    expect(second).not.toBe(first)
  })

  it('правка веса на месте требует явного сброса — за этим он и нужен', () => {
    // Прямая дорога быстрее объезда, пока её качество не упало.
    const direct = makeEdge('moscow', 'tula', 200)
    const graph = buildGraph(
      tableOf([
        direct,
        makeEdge('moscow', 'kaluga', 120),
        makeEdge('kaluga', 'tula', 120),
      ]),
    )

    clearRouteCache()
    expect(findRoute(graph, MOSCOW, TULA, MAGISTRAL_KMH)).toEqual([MOSCOW, TULA])

    // Сезонное ограничение, ремонт, размыв — качество меняется у того же
    // объекта Edge, граф остаётся прежним, и кэш об этом знать не может.
    direct.quality = 0.3
    expect(findRoute(graph, MOSCOW, TULA, MAGISTRAL_KMH)).toEqual([MOSCOW, TULA])

    clearRouteCache()
    expect(findRoute(graph, MOSCOW, TULA, MAGISTRAL_KMH)).toEqual([MOSCOW, KALUGA, TULA])
  })
})
