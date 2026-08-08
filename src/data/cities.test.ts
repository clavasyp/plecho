import { describe, expect, it } from 'vitest'
import { CITIES, CITIES_BY_ID } from './cities'
import { cityId } from '../sim/types'
import type { CityProfile } from '../sim/types'

/**
 * Проверки на данные, а не на код.
 *
 * Города — статика, набитая руками, и ошибка здесь молчаливая: опечатка в
 * идентификаторе не сломает сборку, а тихо отвяжет ребро дороги от узла;
 * лишний ноль в населении перекосит весь спрос. Поэтому здесь проверяются
 * не столько инварианты типов (их держит компилятор), сколько правдоподобие
 * самих чисел.
 */

/** Зафиксировано на уровне проекта: рёбра дорог ссылаются ровно на эти ключи. */
const EXPECTED_IDS = [
  'moscow',
  'tula',
  'ryazan',
  'kaluga',
  'tver',
  'vladimir',
  'yaroslavl',
  'smolensk',
  'bryansk',
  'orel',
]

const PROFILES: CityProfile[] = [
  'столица',
  'промышленный',
  'аграрный',
  'транзитный',
  'ресурсный',
]

describe('города ЦФО', () => {
  it('идентификаторы уникальны', () => {
    const ids = CITIES.map((city) => city.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('состав списка совпадает с зафиксированным набором идентификаторов', () => {
    // Порядок в файле — авторский, поэтому сравниваем множества, а не массивы.
    expect(new Set(CITIES.map((city) => city.id))).toEqual(new Set(EXPECTED_IDS))
  })

  it('координаты лежат в границах ЦФО', () => {
    for (const city of CITIES) {
      // Промах в знаке или перепутанные местами широта с долготой вылезают
      // именно здесь: 37.6 широты — это уже не Россия.
      expect(city.coord.lat, city.name).toBeGreaterThanOrEqual(50)
      expect(city.coord.lat, city.name).toBeLessThanOrEqual(60)
      expect(city.coord.lon, city.name).toBeGreaterThanOrEqual(30)
      expect(city.coord.lon, city.name).toBeLessThanOrEqual(45)
    }
  })

  it('никакие два города не стоят в одной точке', () => {
    // Ловит копипасту координат — самую вероятную ошибку при ручном наборе.
    const points = CITIES.map((city) => `${city.coord.lat},${city.coord.lon}`)
    expect(new Set(points).size).toBe(points.length)
  })

  it('население положительное и целое', () => {
    for (const city of CITIES) {
      expect(city.population, city.name).toBeGreaterThan(0)
      expect(Number.isInteger(city.population), city.name).toBe(true)
    }
  })

  it('Москва крупнейшая и с большим отрывом', () => {
    const moscow = CITIES_BY_ID[cityId('moscow')]
    const others = CITIES.filter((city) => city !== moscow)
    for (const city of others) {
      expect(moscow.population, city.name).toBeGreaterThan(city.population)
    }
    // Отрыв на порядок — это факт про ЦФО, а не случайность выборки.
    // Если проверка упадёт, значит население перепутали, а не Москва усохла.
    const largestOther = Math.max(...others.map((city) => city.population))
    expect(moscow.population).toBeGreaterThan(largestOther * 10)
  })

  it('население правдоподобно для областного центра', () => {
    for (const city of CITIES) {
      if (city.profile === 'столица') continue
      // Все девять — областные центры: меньше 100 тысяч не бывает,
      // больше миллиона в ЦФО, кроме Москвы, тоже нет.
      expect(city.population, city.name).toBeGreaterThan(100_000)
      expect(city.population, city.name).toBeLessThan(1_000_000)
    }
  })

  it('у каждого города непустое имя и допустимый профиль', () => {
    for (const city of CITIES) {
      expect(city.name.length, city.id).toBeGreaterThan(0)
      expect(PROFILES, city.name).toContain(city.profile)
    }
  })

  it('столица ровно одна', () => {
    const capitals = CITIES.filter((city) => city.profile === 'столица')
    expect(capitals.map((city) => city.id)).toEqual(['moscow'])
  })

  it('CITIES_BY_ID согласован с CITIES', () => {
    expect(Object.keys(CITIES_BY_ID)).toHaveLength(CITIES.length)
    for (const city of CITIES) {
      // Именно тот же объект, а не копия: расхождение представлений о городе
      // между списком и словарём — источник неотлаживаемых багов.
      expect(CITIES_BY_ID[city.id]).toBe(city)
    }
  })
})
