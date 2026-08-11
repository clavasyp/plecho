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
  'peterburg',
  'novgorod',
  'pskov',
  'petrozavodsk',
  'vologda',
  'cherepovets',
  'arkhangelsk',
  'murmansk',
  'nizhny',
  'kazan',
  'izhevsk',
  'ulyanovsk',
  'tolyatti',
  'samara',
  'penza',
  'saratov',
  'volgograd',
  'ekaterinburg',
  'chelyabinsk',
  'ufa',
  'perm',
  'magnitogorsk',
  'tagil',
  'orenburg',
  'kurgan',
  'voronezh',
  'lipetsk',
  'oskol',
  'kursk',
  'belgorod',
  'tambov',
  'rostov',
  'krasnodar',
  'stavropol',
  'tyumen',
  'tobolsk',
  'surgut',
  'omsk',
  'novosibirsk',
  'tomsk',
  'kemerovo',
  'novokuznetsk',
  'barnaul',
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

  it('координаты лежат в границах охваченной части России', () => {
    /*
     * Рамка выросла вместе с картой: от Краснодара (45.0) до Мурманска (69.0)
     * по широте и от Пскова (28.3) до Кемерова (86.1) по долготе. Смысл
     * проверки прежний — она ловит промах в знаке и перепутанные местами
     * широту с долготой: 37.6 широты в России уже не бывает нигде.
     */
    for (const city of CITIES) {
      expect(city.coord.lat, city.name).toBeGreaterThanOrEqual(43)
      expect(city.coord.lat, city.name).toBeLessThanOrEqual(70)
      expect(city.coord.lon, city.name).toBeGreaterThanOrEqual(27)
      expect(city.coord.lon, city.name).toBeLessThanOrEqual(88)
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

  it('Москва крупнейшая, но уже не единственная', () => {
    const moscow = CITIES_BY_ID[cityId('moscow')]
    const others = CITIES.filter((city) => city !== moscow)
    for (const city of others) {
      expect(moscow.population, city.name).toBeGreaterThan(city.population)
    }

    /*
     * ОТРЫВ СОКРАТИЛСЯ, И ЭТО ГЛАВНОЕ, ЧТО СДЕЛАЛА КАРТА СТРАНЫ.
     *
     * На карте округа Москва была больше следующего города в 24 раза, и это
     * означало мир с ОДНИМ потребителем: каждое кольцо обязано было кончаться в
     * столице и возвращаться оттуда порожняком через всю карту. С Петербургом
     * отрыв стал 2.35 раза, а по СПРОСУ — всего 1.5, потому что спрос считается
     * от корня населения.
     *
     * Проверка теперь двусторонняя: Москва обязана остаться крупнейшей (иначе
     * перепутали население), но отрыв обязан быть меньше пятикратного — иначе
     * второй город потерялся, и мир снова выродился в один сток.
     */
    const largestOther = Math.max(...others.map((city) => city.population))
    expect(moscow.population).toBeGreaterThan(largestOther)
    expect(moscow.population).toBeLessThan(largestOther * 5)
  })

  it('население правдоподобно для города на карте страны', () => {
    /*
     * Верхняя граница поднялась с миллиона до семи вместе с картой: на карте
     * округа миллионников, кроме Москвы, не было вовсе, а на карте страны их
     * пять — Петербург, Новосибирск, Екатеринбург, Казань, Нижний Новгород.
     * Нижняя осталась прежней: город меньше ста тысяч — это уже не узел
     * федеральной сети, а посёлок, и в графе ему делать нечего.
     */
    for (const city of CITIES) {
      if (city.profile === 'столица') continue
      expect(city.population, city.name).toBeGreaterThan(100_000)
      expect(city.population, city.name).toBeLessThan(7_000_000)
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
