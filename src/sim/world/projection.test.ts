import { describe, expect, it } from 'vitest'
import type { LatLon } from '../types'
import {
  CFO_ORIGIN,
  EARTH_RADIUS_KM,
  distanceKm,
  project,
  projectAll,
} from './projection'

/**
 * Реальные координаты географических центров — те же, по которым считают
 * справочники расстояний. Нужны, чтобы сверять гаверсинус с внешним числом,
 * а не с самим собой.
 */
const MOSCOW: LatLon = { lat: 55.7558, lon: 37.6173 }
const TULA: LatLon = { lat: 54.1961, lon: 37.6182 }
const SMOLENSK: LatLon = { lat: 54.7818, lon: 32.0401 }
const VLADIMIR: LatLon = { lat: 56.129, lon: 40.4056 }

/** Длина градуса широты, км — из тех же констант, что и в проекции. */
const KM_PER_DEGREE = (Math.PI / 180) * EARTH_RADIUS_KM

/** Евклидово расстояние на игровой плоскости. */
function planarDistanceKm(a: LatLon, b: LatLon, origin: LatLon): number {
  const pa = project(a, origin)
  const pb = project(b, origin)
  return Math.hypot(pb.x - pa.x, pb.y - pa.y)
}

describe('project', () => {
  it('точка отсчёта проецируется ровно в начало координат', () => {
    expect(project(CFO_ORIGIN, CFO_ORIGIN)).toEqual({ x: 0, y: 0 })
  })

  it('север даёт положительный y, восток — положительный x', () => {
    const northEast = project(
      { lat: CFO_ORIGIN.lat + 1, lon: CFO_ORIGIN.lon + 1 },
      CFO_ORIGIN,
    )
    expect(northEast.x).toBeGreaterThan(0)
    expect(northEast.y).toBeGreaterThan(0)

    // И симметрично: юго-запад обязан уйти в минус по обеим осям, иначе где-то
    // потерян знак и карта окажется зеркальной.
    const southWest = project(
      { lat: CFO_ORIGIN.lat - 1, lon: CFO_ORIGIN.lon - 1 },
      CFO_ORIGIN,
    )
    expect(southWest.x).toBeLessThan(0)
    expect(southWest.y).toBeLessThan(0)
  })

  it('градус широты — примерно 111 км', () => {
    const { y } = project(
      { lat: CFO_ORIGIN.lat + 1, lon: CFO_ORIGIN.lon },
      CFO_ORIGIN,
    )
    expect(y).toBeGreaterThan(110.5)
    expect(y).toBeLessThan(111.5)
  })

  it('градус долготы на широте 55° — примерно 64 км', () => {
    expect(CFO_ORIGIN.lat).toBe(55) // проверка держится на этом
    const { x } = project(
      { lat: CFO_ORIGIN.lat, lon: CFO_ORIGIN.lon + 1 },
      CFO_ORIGIN,
    )
    // 111.19 * cos(55°) ≈ 63.8
    expect(x).toBeGreaterThan(63)
    expect(x).toBeLessThan(65)
    expect(x).toBeCloseTo(KM_PER_DEGREE * Math.cos((55 * Math.PI) / 180), 6)
  })

  it('сдвиг по широте не даёт сдвига по долготе и наоборот', () => {
    const north = project({ lat: 56, lon: 37 }, CFO_ORIGIN)
    expect(north.x).toBe(0)

    const east = project({ lat: 55, lon: 38 }, CFO_ORIGIN)
    expect(east.y).toBe(0)
  })

  it('масштаб постоянный: два градуса дают ровно вдвое больше одного', () => {
    // Линейность — то, ради чего масштаб заморожен на широте отсчёта. Если
    // она сломается, поедут интерполяция машин по ребру и геометрия дорог.
    const one = project({ lat: 56, lon: 38 }, CFO_ORIGIN)
    const two = project({ lat: 57, lon: 39 }, CFO_ORIGIN)
    expect(two.x).toBeCloseTo(one.x * 2, 9)
    expect(two.y).toBeCloseTo(one.y * 2, 9)
  })

  it('точка отсчёта смещает всю картину, не меняя формы', () => {
    const other: LatLon = { lat: 55, lon: 40 }
    const a = project(MOSCOW, CFO_ORIGIN)
    const b = project(TULA, CFO_ORIGIN)
    const aShifted = project(MOSCOW, other)
    const bShifted = project(TULA, other)
    expect(aShifted.x - bShifted.x).toBeCloseTo(a.x - b.x, 9)
    expect(aShifted.y - bShifted.y).toBeCloseTo(a.y - b.y, 9)
  })

  it('Москва севернее и почти на той же долготе, что Тула', () => {
    const moscow = project(MOSCOW, CFO_ORIGIN)
    const tula = project(TULA, CFO_ORIGIN)
    expect(moscow.y).toBeGreaterThan(tula.y)
    expect(Math.abs(moscow.x - tula.x)).toBeLessThan(1)
  })
})

describe('projectAll', () => {
  it('сохраняет порядок и совпадает с поштучным вызовом', () => {
    const coords = [MOSCOW, TULA, SMOLENSK, VLADIMIR]
    expect(projectAll(coords, CFO_ORIGIN)).toEqual(
      coords.map((c) => project(c, CFO_ORIGIN)),
    )
  })

  it('пустой список даёт пустой результат', () => {
    expect(projectAll([], CFO_ORIGIN)).toEqual([])
  })
})

describe('distanceKm', () => {
  it('Москва — Тула по прямой примерно 173 км', () => {
    // Справочники дают 173.4 км по воздуху против 182–183 км по трассе.
    // Разница «дорога длиннее прямой» — то, ради чего эта функция и нужна.
    const d = distanceKm(MOSCOW, TULA)
    expect(d).toBeGreaterThan(163)
    expect(d).toBeLessThan(183)
    expect(d).toBeCloseTo(173.4, 0)
  })

  it('совпадающие точки дают ноль', () => {
    expect(distanceKm(MOSCOW, MOSCOW)).toBe(0)
    expect(distanceKm(CFO_ORIGIN, { ...CFO_ORIGIN })).toBe(0)
  })

  it('симметричен', () => {
    // Бит-в-бит равенства не требуем — важно, что порядок аргументов не несёт
    // смысла.
    expect(distanceKm(MOSCOW, TULA)).toBeCloseTo(distanceKm(TULA, MOSCOW), 9)
    expect(distanceKm(SMOLENSK, VLADIMIR)).toBeCloseTo(
      distanceKm(VLADIMIR, SMOLENSK),
      9,
    )
  })

  it('неравенство треугольника: через третий город не короче', () => {
    const direct = distanceKm(SMOLENSK, VLADIMIR)
    const viaMoscow = distanceKm(SMOLENSK, MOSCOW) + distanceKm(MOSCOW, VLADIMIR)
    expect(viaMoscow).toBeGreaterThanOrEqual(direct)
  })

  it('противоположные точки дают половину окружности без NaN', () => {
    // Ровно тот случай, ради которого в формуле стоит зажим до единицы:
    // подкоренное выражение вылезает за 1 на единицы последнего разряда.
    const antipodal = distanceKm({ lat: 10, lon: 20 }, { lat: -10, lon: -160 })
    expect(Number.isFinite(antipodal)).toBe(true)
    expect(antipodal).toBeCloseTo(Math.PI * EARTH_RADIUS_KM, 3)
  })

  it('градус широты на экваторе и на 55-й параллели одинаков', () => {
    // Свойство меридиана как большого круга — заодно проверка, что широта и
    // долгота не перепутаны местами в формуле.
    expect(distanceKm({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(
      distanceKm({ lat: 55, lon: 37 }, { lat: 56, lon: 37 }),
      9,
    )
  })
})

describe('согласованность проекции и сферы', () => {
  it('на масштабе ЦФО плоскость расходится со сферой меньше чем на 2%', () => {
    // Это и есть бюджет искажения, ради которого выбрана equirectangular.
    // Смоленск — Владимир: самая широкая по долготе пара игрового региона,
    // то есть худший случай. Расхождение около 1.1%.
    for (const [a, b] of [
      [MOSCOW, TULA],
      [MOSCOW, SMOLENSK],
      [SMOLENSK, VLADIMIR],
    ] as const) {
      const sphere = distanceKm(a, b)
      const plane = planarDistanceKm(a, b, CFO_ORIGIN)
      expect(Math.abs(plane - sphere) / sphere).toBeLessThan(0.02)
    }
  })
})

describe('CFO_ORIGIN', () => {
  it('лежит внутри ЦФО и близко к центру игровых городов', () => {
    expect(CFO_ORIGIN.lat).toBeGreaterThan(52)
    expect(CFO_ORIGIN.lat).toBeLessThan(58)
    expect(CFO_ORIGIN.lon).toBeGreaterThan(31)
    expect(CFO_ORIGIN.lon).toBeLessThan(41)
  })

  it('все города региона укладываются в ±400 км от отсчёта', () => {
    // Косвенно фиксирует масштаб сцены: карта — квадрат порядка 800×800 км,
    // под такой размер настраиваются камера и дальность отсечения.
    for (const city of [MOSCOW, TULA, SMOLENSK, VLADIMIR]) {
      const p = project(city, CFO_ORIGIN)
      expect(Math.abs(p.x)).toBeLessThan(400)
      expect(Math.abs(p.y)).toBeLessThan(400)
    }
  })
})
