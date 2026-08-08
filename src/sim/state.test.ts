import { describe, expect, it } from 'vitest'
import { CITIES } from '../data/cities'
import { EDGES } from '../data/roads'
import { createInitialState, START_YEAR } from './state'
import { dateFromTick } from './time'

describe('createInitialState', () => {
  it('детерминирован: один сид — идентичный JSON', () => {
    const a = createInitialState(12345)
    const b = createInitialState(12345)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('сид влияет только на ГПСЧ, мир от него не зависит', () => {
    const a = createInitialState(1)
    const b = createInitialState(2)
    expect(a.rngState).not.toBe(b.rngState)
    expect(JSON.stringify(a.world)).toBe(JSON.stringify(b.world))
  })

  it('состояние переживает сериализацию без потерь', () => {
    const state = createInitialState(7)
    expect(JSON.parse(JSON.stringify(state))).toEqual(state)
  })

  it('партия начинается 1 января 1994 года в полночь', () => {
    const state = createInitialState(1)
    expect(state.tick).toBe(0)
    expect(state.startYear).toBe(START_YEAR)
    expect(dateFromTick(state.tick, state.startYear)).toMatchObject({
      year: 1994,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
    })
  })

  it('мир содержит все города и все дороги из данных', () => {
    const { world } = createInitialState(1)
    expect(Object.keys(world.cities).sort()).toEqual(
      CITIES.map((city) => city.id).sort(),
    )
    expect(Object.keys(world.edges).sort()).toEqual(
      EDGES.map((edge) => edge.id).sort(),
    )
    // Ключ записи обязан совпадать с идентификатором внутри объекта, иначе
    // поиск по ключу и поиск по полю дадут разные ответы.
    for (const [key, city] of Object.entries(world.cities)) {
      expect(city.id).toBe(key)
    }
    for (const [key, edge] of Object.entries(world.edges)) {
      expect(edge.id).toBe(key)
    }
  })

  it('каждое ребро соединяет существующие города', () => {
    const { world } = createInitialState(1)
    for (const edge of Object.values(world.edges)) {
      expect(world.cities[edge.from]).toBeDefined()
      expect(world.cities[edge.to]).toBeDefined()
    }
  })

  it('компания-игрока существует и ею управляет человек', () => {
    const state = createInitialState(1)
    const player = state.companies[state.playerId]
    expect(player).toBeDefined()
    expect(player.id).toBe(state.playerId)
    expect(player.controller).toBe('человек')
    expect(player.name.length).toBeGreaterThan(0)
    // Денег хватает на работу, но заведомо не на вторую машину — стартовый
    // баланс не должен принимать решения за игрока.
    expect(player.money).toBeGreaterThan(0)
  })

  it('единственная машина стоит в Москве без задания', () => {
    const state = createInitialState(1)
    const vehicles = Object.values(state.vehicles)
    expect(vehicles).toHaveLength(1)

    const truck = vehicles[0]
    expect(state.companies[truck.ownerId]).toBeDefined()
    expect(truck.ownerId).toBe(state.playerId)
    expect(truck.position.kind).toBe('узел')
    if (truck.position.kind === 'узел') {
      expect(truck.position.nodeId).toBe('moscow')
      expect(state.world.cities[truck.position.nodeId]).toBeDefined()
    }
    expect(truck.route).toEqual([])
    expect(truck.odometer).toBe(0)
    // Старый ЗИЛ: быстрее магистрального тягача он ехать не может.
    expect(truck.cruiseKmh).toBeGreaterThan(0)
    expect(truck.cruiseKmh).toBeLessThanOrEqual(90)
  })

  it('ключи машин и компаний совпадают с идентификаторами внутри', () => {
    const state = createInitialState(1)
    for (const [key, vehicle] of Object.entries(state.vehicles)) {
      expect(vehicle.id).toBe(key)
    }
    for (const [key, company] of Object.entries(state.companies)) {
      expect(company.id).toBe(key)
    }
  })

  it('состояние не делит объекты с модулем данных и с другими партиями', () => {
    const first = createInitialState(1)
    const second = createInitialState(1)

    const moscow = CITIES.find((city) => city.id === 'moscow')!
    const populationBefore = moscow.population

    first.world.cities[moscow.id].population = 1
    first.world.cities[moscow.id].coord.lat = 0
    first.world.edges[EDGES[0].id].quality = 0

    // Изменение партии не должно доставать ни до справочника, ни до соседней
    // партии: иначе рост города протечёт в следующую игру и в чужой тест.
    expect(moscow.population).toBe(populationBefore)
    expect(second.world.cities[moscow.id].population).toBe(populationBefore)
    expect(second.world.cities[moscow.id].coord.lat).toBe(moscow.coord.lat)
    expect(second.world.edges[EDGES[0].id].quality).toBe(EDGES[0].quality)
  })
})
