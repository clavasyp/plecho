/**
 * Силуэты предприятий: узнаваемость типа, целость площадки, детерминизм места.
 *
 * ГЛАВНОЕ ОБЕЩАНИЕ ФАЙЛА IndustryMesh — «завод читается по силуэту без подписи».
 * Обещание это выглядит вкусовым, но проверяемая его часть вполне числовая:
 * набор примитивов каждого типа обязан ОТЛИЧАТЬСЯ от остальных пяти по
 * нескольким независимым признакам сразу. Если два типа сошлись по всем — на
 * экране они будут одинаковыми кляксами, и никакая подгонка тона этого не
 * исправит. Именно так до этого среза выглядели лесозаготовка и нефтебаза.
 *
 * Второе, что проверяется здесь, — граница с CityMesh. Радиус городского пятна
 * раньше был ПЕРЕПИСАН в IndustryMesh, теперь спрашивается у CityMesh, и тест
 * следит, чтобы завод стоял ЗА застройкой при любом профиле города.
 */

import { describe, expect, it } from 'vitest'

import { CITIES_BY_ID } from '../data/cities'
import { createInitialState } from '../sim/state'
import type { GameState, IndustryType } from '../sim/types'
import { cityPadReach, cityPoint } from './CityMesh'
import { SITES, buildLayout } from './IndustryMesh'
import type { Part, Site } from './IndustryMesh'

// ─── Подручное ─────────────────────────────────────────────────────────────

const TYPES = Object.keys(SITES) as IndustryType[]

/** Состав промышленности в том виде, в каком его отдаёт селектор компонента. */
function rosterOf(state: GameState): Record<string, string> {
  const roster: Record<string, string> = {}
  for (const industry of Object.values(state.world.industries)) {
    roster[industry.id] = `${industry.type}@${industry.cityId}`
  }
  return roster
}

/** Габарит детали в осях площадки: по X, по Z и вверх от земли. */
function extentOf(part: Part): {
  x: [number, number]
  z: [number, number]
  top: number
} {
  if (part.kind === 'коробка') {
    const base = part.base ?? 0
    return {
      x: [part.x - part.width / 2, part.x + part.width / 2],
      z: [part.z - part.depth / 2, part.z + part.depth / 2],
      top: base + part.height,
    }
  }

  if (part.kind === 'цилиндр' && part.lying === true) {
    // Лежащий резервуар: ось вдоль X, длина уехала в поле height, поперёк и
    // вверх — диаметр.
    return {
      x: [part.x - part.height / 2, part.x + part.height / 2],
      z: [part.z - part.radius, part.z + part.radius],
      top: part.radius * 2,
    }
  }

  return {
    x: [part.x - part.radius, part.x + part.radius],
    z: [part.z - part.radius, part.z + part.radius],
    top: part.height,
  }
}

/** Тело вращения — то, у чего есть радиус: цилиндр или конус. */
type RoundPart = Extract<Part, { radius: number }>

const isRound = (part: Part): part is RoundPart => part.kind !== 'коробка'

/**
 * Числовой портрет силуэта — то, чем один тип отличается от другого на экране.
 *
 * Признаки подобраны независимыми: высота, дробность, доля круглых тел, наличие
 * ЛЕЖАЩИХ тел, наличие сужающихся, толщина самого толстого тела вращения и
 * пропорция пятна в плане. Совпадение по одному-двум признакам нормально —
 * заводы всё же соседи по палитре и по масштабу; совпадение по всем означает,
 * что игрок их не различит.
 */
function signature(site: Site): number[] {
  const round = site.parts.filter(isRound)
  return [
    site.parts.reduce((top, part) => Math.max(top, extentOf(part).top), 0),
    site.parts.length,
    round.length,
    site.parts.filter((p) => p.kind === 'цилиндр' && p.lying === true).length,
    site.parts.filter((p) => p.kind === 'конус').length,
    round.reduce((max, part) => Math.max(max, part.radius), 0),
    site.length / site.width,
  ]
}

/** Насколько два признака различимы: счётные — точно, непрерывные — на десятую. */
function differs(a: number, b: number): boolean {
  if (Number.isInteger(a) && Number.isInteger(b)) return a !== b
  return Math.abs(a - b) > Math.max(Math.abs(a), Math.abs(b)) * 0.1
}

// ─── Форма ─────────────────────────────────────────────────────────────────

describe('силуэт описан для каждого типа', () => {
  it('шесть типов промышленности — шесть площадок', () => {
    expect(TYPES.length).toBe(6)
    for (const type of TYPES) {
      expect(SITES[type].parts.length, type).toBeGreaterThan(2)
      expect(SITES[type].length, type).toBeGreaterThan(0)
      expect(SITES[type].width, type).toBeGreaterThan(0)
    }
  })

  it.each(TYPES)('%s: ни одна деталь не вылезает за площадку', (type) => {
    const site = SITES[type]
    // Ограда рисуется ровно по краю плиты, и деталь, вышедшая за габарит,
    // торчит СКВОЗЬ ограду — дефект, который на ближнем зуме видно сразу.
    for (const part of site.parts) {
      const extent = extentOf(part)
      expect(extent.x[0], JSON.stringify(part)).toBeGreaterThanOrEqual(
        -site.length / 2,
      )
      expect(extent.x[1], JSON.stringify(part)).toBeLessThanOrEqual(
        site.length / 2,
      )
      expect(extent.z[0], JSON.stringify(part)).toBeGreaterThanOrEqual(
        -site.width / 2,
      )
      expect(extent.z[1], JSON.stringify(part)).toBeLessThanOrEqual(
        site.width / 2,
      )
    }
  })

  it.each(TYPES)('%s: поднятая деталь на чём-то стоит', (type) => {
    // Галерея элеватора, перемычка мукомольного и балка крана висят над землёй.
    // Каждая обязана опираться на тело, доходящее до её низа, иначе она парит.
    for (const part of SITES[type].parts) {
      if (part.kind !== 'коробка') continue
      const base = part.base ?? 0
      if (base === 0) continue

      const support = SITES[type].parts.some((other) => {
        if (other === part) return false
        const extent = extentOf(other)
        const overlapX =
          extent.x[0] < part.x + part.width / 2 &&
          extent.x[1] > part.x - part.width / 2
        const overlapZ =
          extent.z[0] < part.z + part.depth / 2 &&
          extent.z[1] > part.z - part.depth / 2
        return overlapX && overlapZ && extent.top >= base - 1e-9
      })

      expect(support, `${type}: поднятая деталь без опоры`).toBe(true)
    }
  })
})

describe('типы различимы силуэтом', () => {
  it('портреты всех шести типов попарно различны', () => {
    const seen = new Map<string, IndustryType>()
    for (const type of TYPES) {
      const key = signature(SITES[type]).join('|')
      expect(seen.get(key), `${type} совпал с ${seen.get(key)}`).toBeUndefined()
      seen.set(key, type)
    }
  })

  it('любая пара типов расходится минимум по двум признакам', () => {
    for (let a = 0; a < TYPES.length; a++) {
      for (let b = a + 1; b < TYPES.length; b++) {
        const left = signature(SITES[TYPES[a]])
        const right = signature(SITES[TYPES[b]])
        const apart = left.filter((value, i) => differs(value, right[i])).length

        // Один признак — это совпадение, которое переживёт туман и мелкий зум.
        // Два независимых — уже разные объекты на экране.
        expect(apart, `${TYPES[a]} и ${TYPES[b]}`).toBeGreaterThanOrEqual(2)
      }
    }
  })

  it('ЦБК — самая высокая труба на карте', () => {
    const top = (type: IndustryType) => signature(SITES[type])[0]
    for (const type of TYPES) {
      if (type === 'ЦБК') continue
      expect(top('ЦБК'), type).toBeGreaterThan(top(type))
    }
  })

  it('лесозаготовка — сплошные ящики, нефтебаза — сплошные цилиндры', () => {
    // Ровно та пара, которая до этого среза читалась одинаково.
    expect(SITES['лесозаготовка'].parts.every((p) => !isRound(p))).toBe(true)

    const oil = SITES['нефтебаза'].parts
    expect(oil.filter(isRound).length).toBeGreaterThan(oil.length / 2)
    expect(
      oil.filter((p) => p.kind === 'цилиндр' && p.lying === true).length,
    ).toBeGreaterThanOrEqual(4)

    // И по высоте они больше не равны: над штабелями стоит козловой кран.
    expect(signature(SITES['лесозаготовка'])[0]).toBeGreaterThan(
      signature(SITES['нефтебаза'])[0],
    )
  })

  it('у НПЗ рядом стоят самое широкое и самое тонкое тела вращения', () => {
    const round = SITES['НПЗ'].parts.filter(isRound)
    const widest = round.reduce((a, b) => (a.radius > b.radius ? a : b))
    const thinnest = round.reduce((a, b) => (a.radius < b.radius ? a : b))

    expect(widest.radius / thinnest.radius).toBeGreaterThan(3)
    // «Рядом» — буквально: контраст работает, только когда оба в одном кадре.
    expect(Math.hypot(widest.x - thinnest.x, widest.z - thinnest.z)).toBeLessThan(
      SITES['НПЗ'].length / 2,
    )
  })

  it('элеватор — длинный ряд банок, мукомольный — квадратное пятно', () => {
    const silos = (type: IndustryType) =>
      SITES[type].parts.filter((p) => p.kind === 'цилиндр' && p.lying !== true)

    expect(silos('элеватор').length).toBeGreaterThanOrEqual(6)
    expect(silos('мукомольный').length).toBe(2)

    const plan = (type: IndustryType) => SITES[type].length / SITES[type].width
    expect(plan('элеватор')).toBeGreaterThan(plan('мукомольный') * 1.3)
  })

  it('банки элеватора накрыты галереей во всю длину ряда', () => {
    const silos = SITES['элеватор'].parts.filter(
      (p) => p.kind === 'цилиндр' && p.lying !== true,
    )
    const span =
      Math.max(...silos.map((s) => s.x)) - Math.min(...silos.map((s) => s.x))

    const gallery = SITES['элеватор'].parts.find(
      (p) => p.kind === 'коробка' && (p.base ?? 0) > 0,
    )
    expect(gallery).toBeDefined()
    if (gallery === undefined || gallery.kind !== 'коробка') return
    expect(gallery.width).toBeGreaterThanOrEqual(span)
  })
})

// ─── Расстановка ───────────────────────────────────────────────────────────

describe('место предприятия', () => {
  const state = createInitialState(20260808)
  const roster = rosterOf(state)

  it('расстановка детерминирована между сессиями', () => {
    const twin = createInitialState(20260808)
    const first = buildLayout(roster, state.world)
    const second = buildLayout(rosterOf(twin), twin.world)

    expect(second.sites).toEqual(first.sites)
    expect(second.boxes.matrices).toEqual(first.boxes.matrices)
    expect(second.cylinders.matrices).toEqual(first.cylinders.matrices)
    expect(second.cones.matrices).toEqual(first.cones.matrices)
  })

  it('промышленность собрана ровно в три группы примитивов', () => {
    // Число вызовов отрисовки не должно расти ни с числом заводов, ни с числом
    // деталей в силуэте. Усиление силуэтов стоит инстансов, а не групп.
    const layout = buildLayout(roster, state.world)
    expect(layout.sites.length).toBeGreaterThan(0)
    expect(
      layout.boxes.matrices.length +
        layout.cylinders.matrices.length +
        layout.cones.matrices.length,
    ).toBeGreaterThan(layout.sites.length)
    expect(layout.boxes.matrices.length).toBe(layout.boxes.slots.length)
    expect(layout.cylinders.matrices.length).toBe(layout.cylinders.slots.length)
    expect(layout.cones.matrices.length).toBe(layout.cones.slots.length)
  })

  it('каждый завод стоит ЗА городской застройкой, а не в ней', () => {
    // Ровно тот инвариант, который сломался бы, останься в файле переписанная
    // формула радиуса города: профиль двигает пятно на десятки процентов.
    const layout = buildLayout(roster, state.world)

    const yards = new Map<number, { x: number; z: number }>()
    layout.boxes.slots.forEach((slot, index) => {
      if (slot.role !== 'площадка') return
      const matrix = layout.boxes.matrices[index]
      yards.set(slot.owner, {
        x: matrix.elements[12],
        z: matrix.elements[14],
      })
    })

    expect(yards.size).toBe(layout.sites.length)

    layout.sites.forEach((id, owner) => {
      const industry = state.world.industries[id]
      const city = state.world.cities[industry.cityId]
      const at = cityPoint(city)
      const yard = yards.get(owner)
      expect(yard, id).toBeDefined()
      if (yard === undefined) return

      const distance = Math.hypot(yard.x - at.x, yard.z - at.z)
      expect(distance, `${id} у ${city.name}`).toBeGreaterThan(
        cityPadReach(city),
      )
    })
  })

  it('две площадки одного города не накладываются друг на друга', () => {
    const layout = buildLayout(roster, state.world)

    const yards: { owner: number; x: number; z: number; reach: number }[] = []
    layout.boxes.slots.forEach((slot, index) => {
      if (slot.role !== 'площадка') return
      const matrix = layout.boxes.matrices[index]
      // Полудиагональ площадки — из масштаба плиты: elements[0] и [10] хранят
      // длину и ширину, домноженные на поворот, поэтому берём длину столбцов.
      const lengthX = Math.hypot(
        matrix.elements[0],
        matrix.elements[1],
        matrix.elements[2],
      )
      const lengthZ = Math.hypot(
        matrix.elements[8],
        matrix.elements[9],
        matrix.elements[10],
      )
      yards.push({
        owner: slot.owner,
        x: matrix.elements[12],
        z: matrix.elements[14],
        reach: Math.hypot(lengthX, lengthZ) / 2,
      })
    })

    for (let a = 0; a < yards.length; a++) {
      for (let b = a + 1; b < yards.length; b++) {
        const left = yards[a]
        const right = yards[b]
        const cityA = state.world.industries[layout.sites[left.owner]].cityId
        const cityB = state.world.industries[layout.sites[right.owner]].cityId
        if (cityA !== cityB) continue

        const gap = Math.hypot(left.x - right.x, left.z - right.z)
        expect(
          gap,
          `${layout.sites[left.owner]} и ${layout.sites[right.owner]}`,
        ).toBeGreaterThan(left.reach + right.reach)
      }
    }
  })

  it('все города промышленности известны', () => {
    // Предприятие в неизвестном городе рендер молча пропускает; тест следит,
    // чтобы этот предохранитель не срабатывал на настоящих данных.
    const layout = buildLayout(roster, state.world)
    expect(layout.sites.length).toBe(Object.keys(roster).length)
    for (const id of layout.sites) {
      const industry = state.world.industries[id]
      expect(CITIES_BY_ID[industry.cityId], id).toBeDefined()
    }
  })
})
