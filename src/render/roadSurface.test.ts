import { describe, expect, it } from 'vitest'

import { EDGES } from '../data/roads'
import { palette } from './palette'
import {
  MIN_SURFACE_STEPS,
  QUALITY_BEST,
  QUALITY_FADE,
  QUALITY_WORST,
  SHOULDER_WOBBLE_NEW,
  SHOULDER_WOBBLE_WORN,
  SURFACE_STEP_KM,
  mixHex,
  relativeLuminance,
  roadWear,
  shoulderProfile,
  shoulderWobble,
  surfaceSteps,
  surfaceTone,
} from './roadSurface'

/**
 * Покрытие дорог: то, что можно проверить числом, проверяется числом.
 *
 * ГЛАВНОЕ, ЧТО ЗДЕСЬ ОХРАНЯЕТСЯ, — не красота, а ИНВАРИАНТ «МАШИНА ЕДЕТ ПО
 * ДОРОГЕ». Кромка ленты гуляет, ось остаётся прямой, и сцеп обязан оставаться на
 * асфальте при любом качестве покрытия и любом сиде. Соблазн разогнать разброс
 * ради выразительности будет возникать снова, поэтому предел записан проверкой,
 * а не только комментарием.
 */

/** Полуширины лент по классам — те же числа, что в ROAD_STYLE у RoadMesh. */
const ROAD_HALF_KM = { федеральная: 3.4 / 2, региональная: 2.3 / 2, местная: 1.4 / 2 }

describe('разбиение ленты на участки', () => {
  it('длина участка держится около целевой', () => {
    for (const km of [110, 185, 265, 410]) {
      const steps = surfaceSteps(km)
      const actual = km / steps
      expect(
        Math.abs(actual - SURFACE_STEP_KM),
        `ребро ${km} км режется на ${steps} участков по ${actual.toFixed(1)} км`,
      ).toBeLessThan(SURFACE_STEP_KM / 2)
    }
  })

  it('у самого короткого ребра участков всё равно не меньше трёх', () => {
    expect(surfaceSteps(1)).toBe(MIN_SURFACE_STEPS)
    expect(surfaceSteps(0)).toBe(MIN_SURFACE_STEPS)
    // Битые данные не должны валить рендер всей сети.
    expect(surfaceSteps(Number.NaN)).toBe(MIN_SURFACE_STEPS)
    expect(surfaceSteps(-100)).toBe(MIN_SURFACE_STEPS)
  })

  it('вся дорожная сеть карты остаётся в тысячах четырёхугольников', () => {
    const quads = EDGES.reduce((sum, edge) => sum + surfaceSteps(edge.km), 0)

    /*
     * ПОРЯДОК ВЕЛИЧИНЫ ВАЖНЕЕ ТОЧНОГО ЧИСЛА: он и есть довод, что дробление
     * ленты ничего не стоит.
     *
     * Потолок поднят с тысячи до пяти вместе с картой: на карте округа было 18
     * рёбер и около семисот четырёхугольников, на карте страны рёбер сто и
     * четырёхугольников три тысячи с небольшим. Пять тысяч — это по-прежнему
     * меньше, чем застройка одного крупного города в CityMesh, и вся сеть
     * по-прежнему уходит одним instancedMesh.
     *
     * Проверка остаётся осмысленной: она ловит случай, когда шаг дробления
     * задан слишком мелко и сеть разрастается на порядок.
     */
    expect(quads).toBeLessThan(5000)
  })
})

describe('изношенность', () => {
  it('шкала натянута на диапазон настоящих дорог', () => {
    expect(roadWear(QUALITY_BEST)).toBe(0)
    expect(roadWear(QUALITY_WORST)).toBe(1)
    // За краями — упор, а не отрицательные значения и не больше единицы.
    expect(roadWear(1)).toBe(0)
    expect(roadWear(0)).toBe(1)
  })

  it('ФАКТИЧЕСКИЕ ДОРОГИ КАРТЫ ЗАНИМАЮТ ЗАМЕТНУЮ ЧАСТЬ ШКАЛЫ, а не полоску у края', () => {
    /*
     * Ради этого шкала и натянута. Считай мы изношенность прямо как (1 −
     * quality), все дороги карты (0.5 .. 0.88) уместились бы в 38% шкалы,
     * прижатых к её светлому концу, и разница между лучшей и худшей округлялась
     * бы до одного деления цвета. Проверка ловит именно вырождение: если
     * перебалансировка таблицы сожмёт дороги в точку, качество перестанет быть
     * видно, и узнать об этом надо здесь, а не на снимке.
     */
    const wear = EDGES.map((edge) => roadWear(edge.quality))
    expect(Math.max(...wear) - Math.min(...wear)).toBeGreaterThan(0.5)
  })
})

describe('дыхание кромки', () => {
  it('чем хуже покрытие, тем сильнее гуляет ширина', () => {
    expect(shoulderWobble(QUALITY_BEST)).toBeCloseTo(SHOULDER_WOBBLE_NEW)
    expect(shoulderWobble(QUALITY_WORST)).toBeCloseTo(
      SHOULDER_WOBBLE_NEW + SHOULDER_WOBBLE_WORN,
    )
    expect(shoulderWobble(0.5)).toBeGreaterThan(shoulderWobble(0.9))
  })

  it('идеальное покрытие всё равно не отчерчено по линейке', () => {
    // Ноль здесь означал бы чертёж вместо асфальта — см. SHOULDER_WOBBLE_NEW.
    expect(shoulderWobble(1)).toBeGreaterThan(0)
  })

  it('рисунок кромки привязан к ребру, а не к порядку вызовов', () => {
    const first = shoulderProfile('moscow-tula', 20, 0.87)
    const second = shoulderProfile('moscow-tula', 20, 0.87)
    expect(second.left).toEqual(first.left)
    expect(second.right).toEqual(first.right)

    const other = shoulderProfile('moscow-tver', 20, 0.87)
    expect(other.left).not.toEqual(first.left)
  })

  it('левая и правая кромки живут независимо', () => {
    const profile = shoulderProfile('moscow-smolensk', 30, 0.88)
    expect(profile.left).not.toEqual(profile.right)
    // Не сдвиг одной последовательности: иначе лента ехала бы вбок, а не дышала.
    expect(profile.left.slice(1)).not.toEqual(profile.right.slice(0, -1))
  })

  it('множитель не выходит за объявленный разброс ни при каком сиде', () => {
    for (const edge of EDGES) {
      const amplitude = shoulderWobble(edge.quality)
      const profile = shoulderProfile(edge.id, surfaceSteps(edge.km) + 1, edge.quality)

      for (const value of [...profile.left, ...profile.right]) {
        expect(value, `${edge.id}: множитель полуширины`).toBeGreaterThanOrEqual(
          1 - amplitude - 1e-9,
        )
        expect(value).toBeLessThanOrEqual(1 + amplitude + 1e-9)
      }
    }
  })

  it('кромка меняется плавно, а не дребезжит от узла к узлу', () => {
    for (const edge of EDGES) {
      const amplitude = shoulderWobble(edge.quality)
      const profile = shoulderProfile(edge.id, surfaceSteps(edge.km) + 1, edge.quality)

      for (const side of [profile.left, profile.right]) {
        for (let i = 1; i < side.length; i++) {
          const step = Math.abs(side[i] - side[i - 1])
          // Полный размах — 2·amplitude. Соседние узлы обязаны отличаться
          // заметно меньше: именно это отличает дорогу от помех.
          expect(step, `${edge.id}: шаг кромки между узлами`).toBeLessThan(
            amplitude,
          )
        }
      }
    }
  })

  it('МАШИНА ОСТАЁТСЯ НА АСФАЛЬТЕ: кромка не уходит под сцеп больше чем на треть километра', () => {
    /**
     * Полуширина сцепа — BODY.width / 2 из VehicleMesh (2.4 / 2). Число
     * переписано сюда сознательно и с оговоркой: импортировать VehicleMesh
     * нельзя (он тянет Three, а тест идёт в чистом Node), а вопрос слишком
     * важен, чтобы остаться без проверки вовсе. Разъедется — будет видно на
     * снимке: фура поедет по полю.
     */
    const rigHalfKm = 1.2

    /**
     * Сколько сцепу позволено выступать за кромку, км.
     *
     * Не ноль намеренно: у региональной дороги полотно уже сцепа ИЗНАЧАЛЬНО
     * (полуширина 1.15 против 1.2), то есть фура шире двухполоски и без всякого
     * дыхания кромки. Проверяется поэтому не «сцеп внутри асфальта», а «дыхание
     * кромки не добавляет к этому больше трети километра» — на изометрии это
     * меньше половины пикселя.
     */
    const allowanceKm = 0.34

    for (const edge of EDGES) {
      const half = ROAD_HALF_KM[edge.class]
      const profile = shoulderProfile(edge.id, surfaceSteps(edge.km) + 1, edge.quality)
      const narrowest = Math.min(...profile.left, ...profile.right) * half

      expect(
        rigHalfKm - narrowest,
        `${edge.id} (${edge.class}, качество ${edge.quality}): вылет сцепа за кромку`,
      ).toBeLessThanOrEqual(allowanceKm)
    }
  })
})

describe('тон покрытия', () => {
  it('идеальное покрытие оставляет цвет класса нетронутым', () => {
    expect(surfaceTone(palette.roadFederal, QUALITY_BEST)).toBe(palette.roadFederal)
  })

  it('чем хуже покрытие, тем ближе дорога к цвету поля', () => {
    const good = relativeLuminance(surfaceTone(palette.roadFederal, 0.88))
    const bad = relativeLuminance(surfaceTone(palette.roadFederal, 0.5))
    const dead = relativeLuminance(surfaceTone(palette.roadFederal, 0))

    expect(good).toBeGreaterThan(bad)
    expect(bad).toBeGreaterThan(dead)
  })

  it('РАЗНИЦА КАЧЕСТВА ВИДНА, а не теряется в округлении цвета', () => {
    /*
     * Ради этого всё и делалось: лучшая и худшая региональные дороги карты
     * обязаны отличаться на глаз, а не на одно деление байта. Четверть по
     * относительной яркости — величина, которую видно, когда две такие дороги
     * сходятся в одном городе.
     */
    const regional = EDGES.filter((edge) => edge.class === 'региональная')
    const tones = regional.map((edge) =>
      relativeLuminance(surfaceTone(palette.roadRegional, edge.quality)),
    )
    expect(Math.max(...tones) / Math.min(...tones)).toBeGreaterThan(1.25)
  })

  it('но не сливается с полем даже при нулевом качестве', () => {
    const dead = relativeLuminance(surfaceTone(palette.roadLocal, 0))
    const terrain = relativeLuminance(palette.terrain)
    expect(dead, 'самая убитая дорога всё ещё видна на рельефе').toBeGreaterThan(
      terrain * 1.15,
    )
    // И до конца пути к рельефу она не доходит по построению.
    expect(QUALITY_FADE).toBeLessThan(1)
    expect(QUALITY_WORST).toBeGreaterThan(0)
  })

  it('ЛЕСТНИЦА КЛАССОВ НЕ ЛОМАЕТСЯ ОБ КАЧЕСТВО на реальных данных карты', () => {
    /*
     * Самая тёмная федеральная дорога карты обязана остаться светлее самой
     * светлой региональной: класс — первичный признак, качество — вторичный, и
     * их лестницы не должны пересекаться. Проверка идёт по ФАКТИЧЕСКИМ рёбрам, а
     * не по придуманным крайностям: перебалансировка таблицы дорог обязана
     * ронять этот тест, если она сломает читаемость классов.
     */
    const tone = (edgeClass: 'федеральная' | 'региональная') =>
      EDGES.filter((edge) => edge.class === edgeClass).map((edge) =>
        relativeLuminance(
          surfaceTone(
            edgeClass === 'федеральная' ? palette.roadFederal : palette.roadRegional,
            edge.quality,
          ),
        ),
      )

    const federal = tone('федеральная')
    const regional = tone('региональная')
    expect(federal.length).toBeGreaterThan(0)
    expect(regional.length).toBeGreaterThan(0)

    expect(Math.min(...federal)).toBeGreaterThan(Math.max(...regional))
  })
})

describe('цветовая арифметика', () => {
  it('смешение с нулём и единицей отдаёт концы без округлений', () => {
    expect(mixHex(palette.roadFederal, palette.terrain, 0)).toBe(palette.roadFederal)
    expect(mixHex(palette.roadFederal, palette.terrain, 1)).toBe(palette.terrain)
  })

  it('доля зажимается, а мусор не роняет рендер', () => {
    expect(mixHex(palette.accent, palette.terrain, -5)).toBe(palette.accent)
    expect(mixHex(palette.accent, palette.terrain, 5)).toBe(palette.terrain)
    expect(mixHex('не цвет', palette.terrain, 0)).toBe('#000000')
  })

  it('линейка яркости расставляет палитру в понятном порядке', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0)
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1)
    expect(relativeLuminance(palette.roadFederal)).toBeGreaterThan(
      relativeLuminance(palette.roadRegional),
    )
    expect(relativeLuminance(palette.roadRegional)).toBeGreaterThan(
      relativeLuminance(palette.roadLocal),
    )
    expect(relativeLuminance(palette.roadLocal)).toBeGreaterThan(
      relativeLuminance(palette.terrain),
    )
  })
})

describe('ПОРЯДОК ВНИМАНИЯ НА КАРТЕ', () => {
  /*
   * Вся карта построена на одной лестнице: акцент → своя линия → полотно →
   * чужая линия → рельеф. Пока она живёт в комментариях трёх файлов, любая
   * правка палитры может её молча перевернуть — и заметить это можно будет
   * только глазом на снимке, то есть случайно. Здесь она записана числом.
   *
   * Тона своей и чужой линии переписаны сюда из LineMesh по той же причине, что
   * и полуширина сцепа выше: компонент тянет Three и в Node не грузится. Обе
   * стороны берут значения из ОДНОЙ палитры, поэтому разъехаться они могут
   * только вместе с осознанной правкой LineMesh — а она обязана прийти сюда.
   */
  const ownLine = palette.buildingHigh
  const rivalLine = palette.buildingLow

  it('своё кольцо ярче чужого', () => {
    expect(relativeLuminance(ownLine)).toBeGreaterThan(
      relativeLuminance(rivalLine) * 2,
    )
  })

  it('своё кольцо видно поверх полотна, по которому оно идёт', () => {
    const best = surfaceTone(palette.roadFederal, 1)
    expect(relativeLuminance(ownLine)).toBeGreaterThan(relativeLuminance(best))
  })

  it('чужое кольцо видно на рельефе, но темнее полотна', () => {
    expect(relativeLuminance(rivalLine)).toBeGreaterThan(
      relativeLuminance(palette.terrain) * 2,
    )
    expect(relativeLuminance(rivalLine)).toBeLessThan(
      relativeLuminance(palette.roadFederal),
    )
  })

  it('ВЫШЕ ВСЕГО — АКЦЕНТ, и с заметным отрывом', () => {
    expect(relativeLuminance(palette.accent)).toBeGreaterThan(
      relativeLuminance(ownLine) * 2,
    )
  })

  it('невыбранная своя линия больше не спорит с акцентом за внимание', () => {
    /*
     * До этого среза невыбранные свои линии рисовались palette.textDim и на
     * ближнем плане читались почти белыми: на снимке терминала они были вторым
     * по яркости телом кадра после оранжевой рампы и перебивали её. Проверка
     * держит найденный порядок: своя линия ближе к застройке, чем к тексту
     * интерфейса.
     */
    expect(relativeLuminance(ownLine)).toBeLessThan(
      relativeLuminance(palette.textDim),
    )
  })
})
