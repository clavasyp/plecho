import { describe, expect, it } from 'vitest'
import { CITIES } from '../data/cities'
import { INDUSTRIES } from '../data/industries'
import { RECIPES, RECIPE_BY_INDUSTRY } from '../data/recipes'
import { EDGES } from '../data/roads'
import { createInitialState, START_MONEY, START_YEAR } from './state'
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
    expect(player.money).toBe(START_MONEY)
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
})

describe('createInitialState: города как состояние, а не как справочник', () => {
  it('город приходит из данных с пустым складом и без истории снабжения', () => {
    const { world } = createInitialState(1)

    for (const city of Object.values(world.cities)) {
      // Ничего не привезли — значит на складе пусто. Начать партию с запасом
      // значило бы дать игроку фору, которой он не заработал, и первые сутки
      // мир жил бы без него.
      expect(city.stock).toEqual({})
      expect(city.suppliedDays).toBe(0)
      // Население переезжает из CityStatic как есть: разброс появится от
      // снабжения, а не от расстановки.
      expect(city.population).toBe(
        CITIES.find((source) => source.id === city.id)!.population,
      )
    }
  })
})

describe('createInitialState: предприятия', () => {
  it('все предприятия из данных на месте и стоят в существующих городах', () => {
    const { world } = createInitialState(1)

    expect(Object.keys(world.industries).sort()).toEqual(
      INDUSTRIES.map((industry) => industry.id).sort(),
    )
    for (const [key, industry] of Object.entries(world.industries)) {
      expect(industry.id).toBe(key)
      // Предприятие в несуществующем городе копило бы продукцию, к которой
      // невозможно подать машину, — цепочка рвалась бы вдали от причины.
      expect(world.cities[industry.cityId]).toBeDefined()
    }
  })

  it('склад предприятия приходит из данных как есть', () => {
    const { world } = createInitialState(1)

    for (const industry of Object.values(world.industries)) {
      const source = INDUSTRIES.find((it) => it.id === industry.id)!
      // Склад предприятия описывает САМ МИР — заводы работали и до 1994 года.
      // Величины обоснованы в data/industries.ts, и переписывать их в
      // состоянии значило бы держать баланс в двух местах.
      expect(industry.stock).toEqual(source.stock)
      expect(industry.utilization).toBe(source.utilization)
      expect(industry.idleTicks).toBe(source.idleTicks)
    }
  })

  it('на старте мире есть что везти: у каждого предприятия лежит продукция', () => {
    const { world } = createInitialState(1)

    for (const industry of Object.values(world.industries)) {
      const output = RECIPE_BY_INDUSTRY[industry.type].output
      // Иначе первая машина стоит у ворот и ждёт, пока накопится первая тонна:
      // партия начиналась бы с ожидания, а не с решения.
      expect(industry.stock[output] ?? 0, industry.id).toBeGreaterThan(0)
    }
  })

  it('счётчики работы на старте нулевые', () => {
    const { world } = createInitialState(1)

    for (const industry of Object.values(world.industries)) {
      // Загрузка описывает ПОСЛЕДНИЙ отработанный тик, а его ещё не было.
      // Простой с нуля: мир не предъявляет игроку время до начала партии.
      expect(industry.utilization, industry.id).toBe(0)
      expect(industry.idleTicks, industry.id).toBe(0)
    }
  })

  it('у каждого типа предприятия из рецептов есть хотя бы одно в мире', () => {
    const { world } = createInitialState(1)
    const present = new Set(
      Object.values(world.industries).map((industry) => industry.type),
    )

    // Рецепт без предприятия — мёртвая цепочка: правило есть, применить не к
    // чему. Такое расхождение данных о рецептах и данных о размещении заметно
    // только на прогоне, поэтому проверяется здесь.
    for (const recipe of RECIPES) {
      expect(present.has(recipe.industryType), recipe.industryType).toBe(true)
    }
  })

  it('цепочки замкнуты: сырьё для каждой переработки кто-то производит', () => {
    const { world } = createInitialState(1)
    const industries = Object.values(world.industries)

    const produced = new Set(
      industries.map((industry) => RECIPE_BY_INDUSTRY[industry.type].output),
    )

    for (const industry of industries) {
      for (const input of RECIPE_BY_INDUSTRY[industry.type].inputs) {
        // Переработка без источника сырья на карте стоит вечно, и игрок не
        // может ничего с этим сделать. Это не сложность, а сломанный мир.
        expect(produced.has(input.type), `${industry.type} ← ${input.type}`).toBe(
          true,
        )
      }
    }
  })
})

describe('createInitialState: стартовая машина', () => {
  it('единственный ЗИЛ стоит в Москве без задания и без груза', () => {
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

  it('грузоподъёмность — паспортные 6 тонн ЗИЛ-130', () => {
    const truck = Object.values(createInitialState(1).vehicles)[0]
    expect(truck.capacity).toBe(6)
  })

  it('машина порожняя, счётчики пробега обнулены', () => {
    const truck = Object.values(createInitialState(1).vehicles)[0]
    // Стартового груза нет: первая выручка обязана быть заработана рейсом.
    expect(truck.cargo).toBeNull()
    expect(truck.loadedKm).toBe(0)
    expect(truck.emptyKm).toBe(0)
    // Разность одометра и суммы счётчиков — это «сколько проехали с последней
    // погрузки»; фаза прибытия считает по ней плечо доставки. На нулевом тике
    // она обязана быть нулём, иначе первый же рейс оплатится не за то плечо.
    expect(truck.loadedKm + truck.emptyKm).toBe(truck.odometer)
  })
})

describe('createInitialState: стартовый капитал', () => {
  it('денег примерно на один гружёный рейс, но не на вторую машину', () => {
    const state = createInitialState(1)
    const money = state.companies[state.playerId].money
    const truck = Object.values(state.vehicles)[0]

    expect(money).toBe(START_MONEY)
    expect(money).toBeGreaterThan(0)

    // Порядок величины привязан к грузоподъёмности и ставке за тонну: баланс
    // должен читаться игроком как «один рейс», иначе связь между работой и
    // деньгами не видна с первого дня. Ставка зерна — 900 руб/т на опорном
    // плече, поправку на расстояние здесь намеренно не учитываем: проверяется
    // порядок величины, а не точная выручка.
    const oneLoadOfGrain = truck.capacity * 900
    expect(money).toBeGreaterThan(oneLoadOfGrain * 0.5)
    expect(money).toBeLessThan(oneLoadOfGrain * 3)

    // Подержанный ЗИЛ в том же счёте стоит порядка 15 000. Второй машины на
    // старте не купить — первое решение в игре принимает игрок, а не баланс.
    expect(money).toBeLessThan(15_000)
  })
})

describe('createInitialState: состояние ничем не делится', () => {
  it('города и дороги не общие ни со справочником, ни с соседней партией', () => {
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

  it('склад города — свой объект у каждой партии', () => {
    const first = createInitialState(1)
    const second = createInitialState(1)

    first.world.cities[CITIES[0].id].stock['мука'] = 100

    expect(second.world.cities[CITIES[0].id].stock).toEqual({})
  })

  it('склад предприятия — свой объект у каждой партии', () => {
    const first = createInitialState(1)
    const second = createInitialState(1)

    const reference = INDUSTRIES[0]
    const id = reference.id
    const untouched = { ...reference.stock }

    // Спред верхнего уровня оставил бы обеим партиям ОДИН объект stock, и
    // тонна зерна из одной игры появилась бы в другой. Дефект тихий: состояние
    // выглядит правильным, пока не запустишь два прогона подряд.
    first.world.industries[id].stock['зерно'] = 500
    first.world.industries[id].utilization = 1
    first.world.industries[id].idleTicks = 42

    expect(second.world.industries[id].stock).toEqual(untouched)
    expect(second.world.industries[id].utilization).toBe(0)
    expect(second.world.industries[id].idleTicks).toBe(0)
    expect(reference.stock).toEqual(untouched)
  })
})
