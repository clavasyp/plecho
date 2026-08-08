import { describe, expect, it } from 'vitest'
import { CITIES } from '../../data/cities'
import { EDGES, EDGES_BY_ID } from '../../data/roads'
import { cityId, edgeId } from '../types'
import type { Edge, EdgeId, RoadClass } from '../types'
import { buildGraph, findEdge, hasCity, neighbors } from './graph'

/**
 * Проверки структуры смежности.
 *
 * Граф — производная от таблицы рёбер, и главный класс ошибок здесь —
 * несимметричность: ребро попало в список одного конца и не попало в список
 * другого. Такая ошибка не падает, а превращается в дорогу с односторонним
 * движением, которой нет в данных, — и всплывает уже в маршрутах.
 */

const GRAPH = buildGraph(EDGES_BY_ID)

const MOSCOW = cityId('moscow')
const TULA = cityId('tula')
const OREL = cityId('orel')
const SMOLENSK = cityId('smolensk')
/** Заведомо отсутствующий город — проверка поведения на опечатке. */
const NOWHERE = cityId('atlantida')

/** Ребро для искусственных графов: класс и качество задаются явно. */
function makeEdge(
  from: string,
  to: string,
  km: number,
  roadClass: RoadClass = 'региональная',
  quality = 0.7,
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

/** Таблица рёбер в том виде, в каком её хранит GameState. */
function tableOf(edges: Edge[]): Record<EdgeId, Edge> {
  return Object.fromEntries(edges.map((edge) => [edge.id, edge])) as Record<
    EdgeId,
    Edge
  >
}

describe('buildGraph', () => {
  it('знает все города, у которых есть дороги', () => {
    // В данных ЦФО изолированных городов нет — значит, в графе обязаны быть
    // все десять. Если появится город без единой дороги, тест это покажет.
    for (const city of CITIES) {
      expect(hasCity(GRAPH, city.id), city.name).toBe(true)
    }
  })

  it('не знает город, которого нет в данных', () => {
    expect(hasCity(GRAPH, NOWHERE)).toBe(false)
  })

  it('каждое ребро попало ровно в два списка смежности', () => {
    // Сумма степеней связного неориентированного графа — удвоенное число
    // рёбер. Расхождение означает потерянное или задвоенное ребро.
    let total = 0
    for (const city of CITIES) total += neighbors(GRAPH, city.id).length
    expect(total).toBe(EDGES.length * 2)
  })

  it('каждое ребро данных видно с обоих концов и это тот же объект', () => {
    for (const edge of EDGES) {
      expect(findEdge(GRAPH, edge.from, edge.to), edge.id).toBe(edge)
      expect(findEdge(GRAPH, edge.to, edge.from), edge.id).toBe(edge)
    }
  })

  it('смежность симметрична', () => {
    for (const city of CITIES) {
      for (const neighbor of neighbors(GRAPH, city.id)) {
        const back = neighbors(GRAPH, neighbor.cityId).filter(
          (n) => n.cityId === city.id,
        )
        expect(back.length, `${city.id} — ${neighbor.cityId}`).toBe(1)
        expect(back[0].edge).toBe(neighbor.edge)
      }
    }
  })

  it('сосед — это другой конец того самого ребра', () => {
    for (const city of CITIES) {
      for (const { cityId: other, edge } of neighbors(GRAPH, city.id)) {
        const ends = [edge.from, edge.to]
        expect(ends, edge.id).toContain(city.id)
        expect(ends, edge.id).toContain(other)
        expect(other).not.toBe(city.id)
      }
    }
  })

  it('петля не делает город собственным соседом', () => {
    // Ребро из города в себя — ошибка данных. Граф обязан её проглотить, а не
    // размножить: город-собственный-сосед потом всплывает машиной, которая
    // «едет» из Тулы в Тулу.
    const graph = buildGraph(
      tableOf([makeEdge('tula', 'tula', 10), makeEdge('tula', 'orel', 183)]),
    )
    expect(neighbors(graph, TULA).map((n) => n.cityId)).toEqual([OREL])
    expect(findEdge(graph, TULA, TULA)).toBeUndefined()
  })

  it('пустая таблица даёт пустой граф, а не падение', () => {
    const graph = buildGraph({})
    expect(hasCity(graph, MOSCOW)).toBe(false)
    expect(neighbors(graph, MOSCOW)).toEqual([])
    expect(findEdge(graph, MOSCOW, TULA)).toBeUndefined()
  })
})

describe('neighbors', () => {
  it('у Москвы соседи — только города, с которыми есть дорога', () => {
    const around = neighbors(GRAPH, MOSCOW).map((n) => n.cityId)
    expect(around).toContain(TULA)
    // М-2 «Крым» идёт в Орёл через Тулу, отдельного радиуса Москва — Орёл в
    // данных нет и быть не должно — см. шапку roads.ts.
    expect(around).not.toContain(OREL)
    expect(new Set(around).size).toBe(around.length)
  })

  it('у неизвестного города соседей нет', () => {
    expect(neighbors(GRAPH, NOWHERE)).toEqual([])
  })
})

describe('findEdge', () => {
  it('порядок аргументов не важен', () => {
    expect(findEdge(GRAPH, MOSCOW, TULA)).toBe(findEdge(GRAPH, TULA, MOSCOW))
    expect(findEdge(GRAPH, MOSCOW, TULA)?.km).toBe(185)
  })

  it('без прямой дороги — undefined', () => {
    // Москва и Орёл связаны через Тулу, но не напрямую.
    expect(findEdge(GRAPH, MOSCOW, OREL)).toBeUndefined()
    // Смоленск и Тула — тем более: между ними половина округа.
    expect(findEdge(GRAPH, SMOLENSK, TULA)).toBeUndefined()
  })

  it('город в себя — undefined: петель в графе нет', () => {
    expect(findEdge(GRAPH, MOSCOW, MOSCOW)).toBeUndefined()
  })

  it('неизвестный город — undefined, а не исключение', () => {
    expect(findEdge(GRAPH, NOWHERE, MOSCOW)).toBeUndefined()
    expect(findEdge(GRAPH, MOSCOW, NOWHERE)).toBeUndefined()
  })
})
