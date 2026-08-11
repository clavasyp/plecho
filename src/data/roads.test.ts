import { describe, expect, it } from 'vitest'
import { CITIES_BY_ID } from './cities'
import { EDGES, EDGES_BY_ID } from './roads'

/**
 * Проверки графа дорог.
 *
 * Данные набиты вручную, а значит опечатка в них — вопрос времени: лишний ноль
 * в километрах, ребро в несуществующий город, случайный дубль пары. Половина
 * этих ошибок не падает, а тихо портит экономику, поэтому граф проверяется не
 * глазами, а тестом.
 */

/** Пары городов ребра в каноническом порядке — для сравнения без направления. */
const unordered = (a: string, b: string) => [a, b].sort().join('|')

describe('граф дорог', () => {
  it('в графе есть рёбра — тест не проходит вхолостую', () => {
    expect(EDGES.length).toBeGreaterThan(0)
  })

  it('идентификаторы уникальны', () => {
    const ids = EDGES.map((edge) => edge.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('EDGES_BY_ID совпадает с EDGES', () => {
    expect(Object.keys(EDGES_BY_ID).length).toBe(EDGES.length)
    for (const edge of EDGES) {
      expect(EDGES_BY_ID[edge.id]).toBe(edge)
    }
  })

  it('оба конца ребра — существующие города', () => {
    for (const edge of EDGES) {
      expect(CITIES_BY_ID[edge.from], `${edge.id}: from`).toBeDefined()
      expect(CITIES_BY_ID[edge.to], `${edge.id}: to`).toBeDefined()
    }
  })

  it('ребро не замкнуто само на себя', () => {
    for (const edge of EDGES) {
      expect(edge.from, edge.id).not.toBe(edge.to)
    }
  })

  it('пара городов встречается один раз в любом порядке', () => {
    // Ребро ненаправленное: 'moscow-tula' и 'tula-moscow' — одна и та же
    // дорога, и второй экземпляр не удвоил бы связь, а сломал бы поиск пути.
    const pairs = EDGES.map((edge) => unordered(edge.from, edge.to))
    expect(new Set(pairs).size).toBe(pairs.length)
  })

  it('километры положительные и правдоподобные для карты страны', () => {
    /*
     * Нижняя граница отсекает опечатку вроде 18 вместо 180. Она же теперь
     * держит ГЛАВНЫЙ ИНВАРИАНТ БАЛАНСА: порог короткого плеча у ЗИЛа — 78 км
     * (разбор в шапке data/operating.ts), и ребро короче него сделало бы кольцо
     * с порожним возвратом выгодным. Девяносто — это порог с запасом в 15%.
     *
     * Верхняя выросла с 800 до 1500 вместе с картой: на карте округа 800 км
     * означало поездку сквозь него, на карте страны столько же — это Вологда —
     * Архангельск, обычное северное плечо. Полторы тысячи отсекают лишний ноль,
     * но оставляют место кольской рокаде Мурманск — Архангельск (1290 км),
     * самому длинному ребру карты.
     */
    for (const edge of EDGES) {
      expect(edge.km, edge.id).toBeGreaterThanOrEqual(90)
      expect(edge.km, edge.id).toBeLessThanOrEqual(1500)
    }
  })

  it('качество лежит в [0, 1]', () => {
    for (const edge of EDGES) {
      expect(edge.quality, edge.id).toBeGreaterThanOrEqual(0)
      expect(edge.quality, edge.id).toBeLessThanOrEqual(1)
    }
  })

  it('федеральные дороги качественнее региональных', () => {
    // Класс задаёт базовую скорость, качество её уточняет. Если разброс
    // качества перекроет разницу классов, различие между М-трассой и глухой
    // двухполоской в игре исчезнет.
    const worstFederal = Math.min(
      ...EDGES.filter((e) => e.class === 'федеральная').map((e) => e.quality),
    )
    const bestRegional = Math.max(
      ...EDGES.filter((e) => e.class === 'региональная').map((e) => e.quality),
    )
    expect(worstFederal).toBeGreaterThan(bestRegional)
  })

  it('у трассы указано обозначение', () => {
    for (const edge of EDGES) {
      expect(edge.route.length, edge.id).toBeGreaterThan(0)
    }
  })

  it('граф связный — из Москвы достижимы все города', () => {
    const neighbours = new Map<string, string[]>()
    for (const edge of EDGES) {
      if (!neighbours.has(edge.from)) neighbours.set(edge.from, [])
      if (!neighbours.has(edge.to)) neighbours.set(edge.to, [])
      neighbours.get(edge.from)!.push(edge.to)
      neighbours.get(edge.to)!.push(edge.from)
    }

    const visited = new Set<string>(['moscow'])
    const queue: string[] = ['moscow']
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const next of neighbours.get(current) ?? []) {
        if (!visited.has(next)) {
          visited.add(next)
          queue.push(next)
        }
      }
    }

    const unreachable = Object.keys(CITIES_BY_ID).filter(
      (id) => !visited.has(id),
    )
    expect(unreachable).toEqual([])
  })

  it('у каждого города минимум два ребра', () => {
    // Город с одним ребром — тупик: машина заезжает и выезжает тем же путём,
    // объезда при заторе нет, и линия через него не строится.
    const degree = new Map<string, number>()
    for (const id of Object.keys(CITIES_BY_ID)) degree.set(id, 0)
    for (const edge of EDGES) {
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
      degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
    }

    const dangling = [...degree.entries()].filter(([, count]) => count < 2)
    expect(dangling).toEqual([])
  })

  it('граф не выродился в звезду из Москвы', () => {
    // Радиальная схема ЦФО реальна, но если рокад нет вовсе, то любой рейс
    // идёт через столицу и весь выбор маршрута в игре пропадает.
    const throughMoscow = EDGES.filter(
      (edge) => edge.from === 'moscow' || edge.to === 'moscow',
    ).length
    expect(throughMoscow).toBeLessThan(EDGES.length / 2)
  })
})
