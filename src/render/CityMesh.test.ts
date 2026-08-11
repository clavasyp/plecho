/**
 * Силуэт города: детерминизм, зависимость от профиля и ночные окна.
 *
 * ЧТО ИМЕННО ЗДЕСЬ ПРОВЕРЯЕТСЯ И ПОЧЕМУ ЮНИТ-ТЕСТОМ. Форма города — чистая
 * функция от идентификатора, населения и профиля, и все три обещания файла
 * («один и тот же город выглядит одинаково», «профиль виден глазом», «ночью
 * горят окна») формулируются числами. Скриншот на такие вопросы отвечает
 * плохо: он показывает, что что-то нарисовано, но не отличает «Тверь вытянута,
 * потому что транзитная» от «Тверь вытянута, потому что так лёг бросок».
 *
 * ЧИСЛА НЕ ВПИСАНЫ РУКАМИ. Ни одно ожидание не содержит посчитанной когда-то
 * величины: проверяются ОТНОШЕНИЯ между городами и инварианты формы. Иначе
 * первая же перебалансировка населения в data/cities.ts уронила бы тест, в
 * котором не поменялось ни одного правила.
 */

import { describe, expect, it } from 'vitest'

import { CITIES_BY_ID } from '../data/cities'
import { dateFromTick } from '../sim/time'
import { TICKS_PER_DAY, TICKS_PER_HOUR, cityId } from '../sim/types'
import type { City, CityProfile, CityStatic } from '../sim/types'
import { blocksOf, cityForm, cityPadReach, windowGlow } from './CityMesh'
import { layers } from './layers'
import { atmosphereInto, createAtmosphere } from './sky'

// ─── Подручное ─────────────────────────────────────────────────────────────

/**
 * City из CityStatic.
 *
 * Силуэту нужны ровно id, population и profile; остальные поля City — состояние
 * снабжения, к форме отношения не имеющее. Собирается заглушкой, а не через
 * createInitialState, чтобы тест не зависел от того, чем именно начинается
 * партия.
 */
function asCity(base: CityStatic, patch: Partial<CityStatic> = {}): City {
  return {
    ...base,
    ...patch,
    demand: {},
    supplied: 0,
    unrest: 0,
  } as unknown as City
}

const CITY = (id: string): City => asCity(CITIES_BY_ID[cityId(id)])

/** Полный силуэт: форма плюс расставленные здания и окна. */
function silhouette(city: City) {
  const form = cityForm(city)
  return { form, blocks: blocksOf(form) }
}

/** Один и тот же условный город, у которого меняется только профиль. */
function synthetic(profile: CityProfile): ReturnType<typeof silhouette> {
  return silhouette(
    asCity(CITIES_BY_ID[cityId('tula')], { profile, population: 400_000 }),
  )
}

const PROFILES: CityProfile[] = [
  'столица',
  'промышленный',
  'аграрный',
  'транзитный',
  'ресурсный',
]

// ─── Детерминизм ───────────────────────────────────────────────────────────

describe('силуэт детерминирован', () => {
  it.each(Object.keys(CITIES_BY_ID))(
    '%s даёт побитово тот же силуэт при повторном вызове',
    (id) => {
      const first = silhouette(CITY(id))
      const second = silhouette(CITY(id))

      expect(second.blocks.buildings).toEqual(first.blocks.buildings)
      expect(second.blocks.windows).toEqual(first.blocks.windows)
      expect(second.form.radiusX).toBe(first.form.radiusX)
      expect(second.form.radiusZ).toBe(first.form.radiusZ)
      expect(second.form.grid).toBe(first.form.grid)
    },
  )

  it('силуэт не зависит от того, какие города посчитаны до него', () => {
    // Порядок обхода реестра городов задаётся объектом состояния и однажды
    // изменится — например, когда карта вырастет за пределы ЦФО. Сид от ключа
    // существует ровно затем, чтобы это ничего не значило.
    const alone = silhouette(CITY('orel'))

    silhouette(CITY('moscow'))
    silhouette(CITY('tver'))
    const after = silhouette(CITY('orel'))

    expect(after.blocks.buildings).toEqual(alone.blocks.buildings)
  })

  it('разные города — разные силуэты', () => {
    // Иначе «детерминированность» была бы достигнута константой.
    const orel = silhouette(CITY('orel'))
    const kaluga = silhouette(CITY('kaluga'))

    expect(kaluga.blocks.buildings).not.toEqual(orel.blocks.buildings)
    expect(kaluga.form.grid).not.toBe(orel.form.grid)
  })
})

// ─── Профиль ───────────────────────────────────────────────────────────────

describe('профиль меняет форму, а не только размер', () => {
  it('при равном населении каждый профиль даёт свой силуэт', () => {
    const shapes = PROFILES.map((profile) => synthetic(profile))

    for (let a = 0; a < shapes.length; a++) {
      for (let b = a + 1; b < shapes.length; b++) {
        expect(
          shapes[a].blocks.buildings,
          `${PROFILES[a]} и ${PROFILES[b]}`,
        ).not.toEqual(shapes[b].blocks.buildings)
      }
    }
  })

  it('столица — свеча, аграрный — блин: отношение высоты к радиусу', () => {
    const capital = synthetic('столица')
    const rural = synthetic('аграрный')

    const slenderness = (s: ReturnType<typeof silhouette>) =>
      s.blocks.top / s.form.radius

    // Не «Москва выше Орла» — это дало бы и одно население. Именно ПРОПОРЦИЯ:
    // при равном числе жителей столичный силуэт вытянут вверх, аграрный расплылся.
    expect(slenderness(capital)).toBeGreaterThan(slenderness(rural) * 1.5)
    expect(rural.form.radius).toBeGreaterThan(capital.form.radius)
  })

  it('у столицы есть высотное ядро: группа башен в середине пятна', () => {
    const capital = synthetic('столица')
    const industrial = synthetic('промышленный')

    /** Здания, доходящие до трёх четвертей верха города. */
    const crown = (s: ReturnType<typeof silhouette>) =>
      s.blocks.buildings.filter((b) => b.height > s.blocks.top * 0.75)

    // ГРУППА, а не одиночка: у профиля без ядра верх города — единственная
    // доминанта, у столицы это кластер. Ровно это отличает свечу от иглы.
    expect(crown(capital).length).toBeGreaterThanOrEqual(3)
    expect(crown(industrial).length).toBeLessThan(crown(capital).length)

    // И весь кластер стоит в середине пятна, а не разбросан по окраинам.
    for (const tower of crown(capital)) {
      expect(Math.hypot(tower.x, tower.z)).toBeLessThan(
        capital.form.radius * 0.5,
      )
    }

    // Башня — вертикаль: её след на земле меньше среднего по городу.
    const area = (b: { width: number; depth: number }) => b.width * b.depth
    const mean = (values: number[]) =>
      values.reduce((sum, v) => sum + v, 0) / values.length

    expect(mean(crown(capital).map(area))).toBeLessThan(
      mean(capital.blocks.buildings.map(area)),
    )
    expect(capital.blocks.top).toBeGreaterThan(capital.form.peak)
  })

  it('транзитный вытянут вдоль своей оси, столица — почти круглая', () => {
    const transit = synthetic('транзитный')
    const capital = synthetic('столица')

    const elongation = (s: ReturnType<typeof silhouette>) =>
      Math.max(s.form.radiusX, s.form.radiusZ) /
      Math.min(s.form.radiusX, s.form.radiusZ)

    expect(elongation(transit)).toBeGreaterThan(1.6)
    expect(elongation(capital)).toBeLessThan(1.4)
  })

  it('склады транзитного города — пластины, а не кубики', () => {
    const plan = (s: ReturnType<typeof silhouette>) => {
      const ratios = s.blocks.buildings.map((b) =>
        Math.max(b.width, b.depth) / Math.min(b.width, b.depth),
      )
      return ratios.reduce((sum, r) => sum + r, 0) / ratios.length
    }

    expect(plan(synthetic('транзитный'))).toBeGreaterThan(
      plan(synthetic('столица')),
    )
  })

  it('аграрный застроен реже промышленного при том же населении', () => {
    expect(synthetic('аграрный').form.count).toBeLessThan(
      synthetic('промышленный').form.count,
    )
  })

  it('профиль не отменяет иерархию по населению', () => {
    // Аграрный миллионник обязан остаться крупнее промышленного райцентра:
    // размер города — главное сообщение карты, профиль его только окрашивает.
    const big = silhouette(
      asCity(CITIES_BY_ID[cityId('orel')], {
        profile: 'аграрный',
        population: 2_000_000,
      }),
    )
    const small = silhouette(
      asCity(CITIES_BY_ID[cityId('kaluga')], {
        profile: 'промышленный',
        population: 200_000,
      }),
    )

    expect(big.form.radius).toBeGreaterThan(small.form.radius)
    expect(big.form.count).toBeGreaterThan(small.form.count)
    expect(big.blocks.top).toBeGreaterThan(small.blocks.top)
  })

  it('на настоящей карте Москва крупнее и выше всех', () => {
    const capital = silhouette(CITY('moscow'))
    for (const id of Object.keys(CITIES_BY_ID)) {
      if (id === 'moscow') continue
      const other = silhouette(CITY(id))
      expect(capital.form.radius, id).toBeGreaterThan(other.form.radius)
      expect(capital.blocks.top, id).toBeGreaterThan(other.blocks.top)
    }
  })

  it('неизвестный профиль не роняет генерацию', () => {
    // Испорченное сохранение — не повод остаться без карты.
    const broken = asCity(CITIES_BY_ID[cityId('tula')], {
      profile: 'вымышленный' as CityProfile,
    })
    const result = silhouette(broken)
    expect(result.blocks.buildings.length).toBeGreaterThan(0)
  })
})

// ─── Геометрия пятна ───────────────────────────────────────────────────────

describe('застройка помещается на своей земле', () => {
  it.each(Object.keys(CITIES_BY_ID))(
    '%s: все здания внутри выноса площадки',
    (id) => {
      const city = CITY(id)
      const { blocks } = silhouette(city)
      const reach = cityPadReach(city)

      for (const building of blocks.buildings) {
        expect(Math.hypot(building.x, building.z)).toBeLessThanOrEqual(reach)
      }
    },
  )

  it.each(Object.keys(CITIES_BY_ID))(
    '%s: все здания внутри ЭЛЛИПСА площадки, а не только внутри её выноса',
    (id) => {
      const city = CITY(id)
      const { form, blocks } = silhouette(city)
      const cos = Math.cos(form.grid)
      const sin = Math.sin(form.grid)

      for (const building of blocks.buildings) {
        // Обратный поворот в оси уличной сетки — те же, в которых нарезана
        // площадка. Ошибись buildPads знаком поворота, и половина застройки
        // окажется на голом рельефе; круговая проверка выше этого не увидела бы.
        const localX = building.x * cos + building.z * sin
        const localZ = -building.x * sin + building.z * cos
        const inside =
          (localX / form.radiusX) ** 2 + (localZ / form.radiusZ) ** 2

        expect(inside, JSON.stringify(building)).toBeLessThanOrEqual(1 + 1e-9)
      }
    },
  )

  it('вынос площадки считается по большей полуоси', () => {
    // Это ровно то число, по которому IndustryMesh отодвигает заводы. Если оно
    // окажется меньше фактического пятна, завод сядет в застройку.
    for (const id of Object.keys(CITIES_BY_ID)) {
      const city = CITY(id)
      const form = cityForm(city)
      expect(cityPadReach(city)).toBeGreaterThanOrEqual(
        Math.max(form.radiusX, form.radiusZ),
      )
    }
  })
})

// ─── Окна ──────────────────────────────────────────────────────────────────

/**
 * Дом, на грани которого висит окно, — или undefined, если окно висит в воздухе.
 *
 * Связь «окно → дом» в данных не хранится: она не нужна ни отрисовке, ни
 * симуляции. Здесь она восстанавливается обратным поворотом в оси каждого дома,
 * и именно поэтому проверка настоящая — если генератор ошибётся в знаке поворота
 * или в половине габарита, ни один дом не найдётся.
 */
function hostOf(blocks: ReturnType<typeof silhouette>['blocks'], index: number) {
  const light = blocks.windows[index]

  return blocks.buildings.find((building) => {
    const dx = light.x - building.x
    const dz = light.z - building.z
    const cos = Math.cos(building.yaw)
    const sin = Math.sin(building.yaw)
    const localX = dx * cos - dz * sin
    const localZ = dx * sin + dz * cos

    const onX =
      Math.abs(Math.abs(localX) - building.width / 2) < 1e-9 &&
      Math.abs(localZ) <= building.depth * 0.35
    const onZ =
      Math.abs(Math.abs(localZ) - building.depth / 2) < 1e-9 &&
      Math.abs(localX) <= building.width * 0.35
    const inside =
      light.y > layers.buildingBase &&
      light.y < layers.buildingBase + building.height

    return (onX || onZ) && inside
  })
}

describe('ночные окна', () => {
  it('окна есть, и их не больше трёх на дом', () => {
    const { blocks } = silhouette(CITY('moscow'))
    expect(blocks.windows.length).toBeGreaterThan(0)
    expect(blocks.windows.length).toBeLessThanOrEqual(
      blocks.buildings.length * 3,
    )
  })

  it.each(['moscow', 'orel'])(
    '%s: каждое окно лежит на грани своего дома, а не висит в воздухе',
    (id) => {
      const { blocks } = silhouette(CITY(id))
      expect(blocks.windows.length).toBeGreaterThan(0)

      for (let i = 0; i < blocks.windows.length; i++) {
        expect(hostOf(blocks, i), JSON.stringify(blocks.windows[i])).toBeDefined()
      }
    },
  )

  it.each(Object.keys(CITIES_BY_ID))(
    '%s: низкая застройка остаётся тёмной — светится ядро',
    (id) => {
      const { blocks } = silhouette(CITY(id))

      const lit = new Set<number>()
      for (let i = 0; i < blocks.windows.length; i++) {
        const host = hostOf(blocks, i)
        if (host !== undefined) lit.add(blocks.buildings.indexOf(host))
      }

      // Часть домов обязана остаться без единого окна, и это должны быть
      // НИЗКИЕ дома: ночной силуэт повторяет дневной, а не заливает город целиком.
      expect(lit.size).toBeGreaterThan(0)
      expect(lit.size).toBeLessThan(blocks.buildings.length)

      const heights = blocks.buildings.map((b) => b.height)
      const litHeights = [...lit].map((i) => heights[i])
      expect(Math.min(...litHeights)).toBeGreaterThan(Math.min(...heights))
    },
  )

  it('окна одинаковы между вызовами — свет не перескакивает по фасадам', () => {
    expect(silhouette(CITY('tver')).blocks.windows).toEqual(
      silhouette(CITY('tver')).blocks.windows,
    )
  })
})

describe('яркость окон как функция дневного света', () => {
  it('день гасит, ночь зажигает, между ними монотонно', () => {
    expect(windowGlow(1)).toBe(0)
    expect(windowGlow(0)).toBeGreaterThan(0)

    let previous = Infinity
    for (let daylight = 0; daylight <= 1.0001; daylight += 0.05) {
      const glow = windowGlow(daylight)
      expect(glow).toBeLessThanOrEqual(previous)
      previous = glow
    }
  })

  it('никогда не выходит за непрозрачность, даже на мусорном входе', () => {
    const peak = windowGlow(0)
    for (const daylight of [-5, -0.001, 0, 0.5, 1, 1.001, 12]) {
      expect(windowGlow(daylight)).toBeGreaterThanOrEqual(0)
      expect(windowGlow(daylight)).toBeLessThanOrEqual(peak)
    }
    // NaN гасит окна, а не зажигает: просочившийся в непрозрачность NaN оставил
    // бы город светящимся навсегда, и починить это было бы нечем.
    expect(windowGlow(Number.NaN)).toBe(0)
  })

  it('окна не перекричат акцент: они всегда полупрозрачны', () => {
    // Стилевой замок держится не цветом, а площадью и силой. Если окно когда-то
    // станет полностью непрозрачным, ночная карта превратится в россыпь огней,
    // на которой не найти машину.
    expect(windowGlow(0)).toBeLessThan(1)
  })
})

/**
 * Сквозная проверка цепочки «время → небо → окна».
 *
 * Юнит-тест выше знает только про долю света и ничего — про сутки. Здесь она
 * берётся оттуда же, откуда её берёт сцена: из sky.ts. Именно эта склейка и
 * отвечает на вопрос «а зажгутся ли окна вечером», и именно её сломала бы
 * попытка завести в CityMesh собственные сумерки.
 */
describe('окна над картой зажигаются вечером и гаснут утром', () => {
  const START_YEAR = 1994

  /** Тик заданного часа заданных суток партии. */
  const at = (day: number, hour: number): number =>
    day * TICKS_PER_DAY + hour * TICKS_PER_HOUR

  /** 1 января — зима, 1 июля — лето (181 день от начала невисокосного года). */
  const WINTER_DAY = 0
  const SUMMER_DAY = 181

  const glowAt = (day: number, hour: number): number =>
    windowGlow(
      atmosphereInto(createAtmosphere(), at(day, hour), START_YEAR).daylight,
    )

  it('выбранные сутки действительно зимние и летние', () => {
    // Опора для всего остального в блоке: поедет календарь — и тесты ниже начнут
    // проверять не то, что написано в их названиях.
    expect(dateFromTick(at(WINTER_DAY, 0), START_YEAR).season).toBe('зима')
    expect(dateFromTick(at(SUMMER_DAY, 0), START_YEAR).season).toBe('лето')
  })

  it('полночь — горят, полдень — погашены, в любой сезон', () => {
    for (const day of [WINTER_DAY, SUMMER_DAY]) {
      expect(glowAt(day, 0), String(day)).toBeGreaterThan(0.5 * windowGlow(0))
      expect(glowAt(day, 12), String(day)).toBe(0)
    }
  })

  it('зимний вечер горит дольше летнего — сезон приходит сам', () => {
    // Шесть вечера: в ЦФО в январе уже темно, в июле ещё светло. Это и есть
    // главная выгода от общей атмосферы вместо собственных сумерек.
    expect(glowAt(WINTER_DAY, 18)).toBeGreaterThan(glowAt(SUMMER_DAY, 18))
    // И утром так же: в семь утра зимой ещё сумерки, летом уже день.
    expect(glowAt(WINTER_DAY, 7)).toBeGreaterThan(glowAt(SUMMER_DAY, 7))
  })

  it('вечер разгорается, утро гаснет — плавно и монотонно', () => {
    const evening = [13, 15, 16, 17, 18, 20].map((h) => glowAt(WINTER_DAY, h))
    for (let i = 1; i < evening.length; i++) {
      expect(evening[i], String(i)).toBeGreaterThanOrEqual(evening[i - 1])
    }
    expect(evening[0]).toBe(0)
    expect(evening[evening.length - 1]).toBeGreaterThan(0.5 * windowGlow(0))

    const morning = [4, 6, 7, 8, 9, 11].map((h) => glowAt(WINTER_DAY, h))
    for (let i = 1; i < morning.length; i++) {
      expect(morning[i], String(i)).toBeLessThanOrEqual(morning[i - 1])
    }
    expect(morning[0]).toBeGreaterThan(0.5 * windowGlow(0))
    expect(morning[morning.length - 1]).toBe(0)
  })

  it('дробный тик даёт промежуточное значение, а не ступеньку', () => {
    // Рендер интерполирует между тиками; без дробной части сумерки шли бы
    // скачками по пятнадцать минут.
    const dusk = at(WINTER_DAY, 16)
    const a = windowGlow(
      atmosphereInto(createAtmosphere(), dusk, START_YEAR).daylight,
    )
    const b = windowGlow(
      atmosphereInto(createAtmosphere(), dusk + 0.5, START_YEAR).daylight,
    )
    const c = windowGlow(
      atmosphereInto(createAtmosphere(), dusk + 1, START_YEAR).daylight,
    )
    expect(b).toBeGreaterThan(a)
    expect(b).toBeLessThan(c)
  })
})
