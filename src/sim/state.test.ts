import { describe, expect, it } from 'vitest'
import { CITIES } from '../data/cities'
import { INDUSTRIES } from '../data/industries'
import { BASE_POSTS } from '../data/infrastructure'
import { DRIVER_WAGE_PER_DAY } from '../data/operating'
import { postsAt } from './logistics/service'
import { RECIPES, RECIPE_BY_INDUSTRY } from '../data/recipes'
import { EDGES } from '../data/roads'
import { costPerKm, TRAILER_PRICE, VEHICLE_CLASSES } from '../data/vehicles'
import { DELIVERY_REFERENCE_KM } from './economy/finance'
import { wageFor } from './logistics/driver'
import { cargoFor } from './logistics/trailer'
import {
  createInitialState,
  createVehicle,
  createZil,
  HOME_CITY,
  PLAYER_ID,
  RESPEC_RESERVE,
  START_MONEY,
  START_YEAR,
  STARTER_CAPACITY_TONS,
  STARTER_CLASS,
  STARTER_CLASS_ID,
  STARTER_DRIVER_SKILL,
  STARTER_FUEL_PER_100KM,
  STARTER_TRAILER,
} from './state'
import { dateFromTick } from './time'
import { cityId, companyId, vehicleId } from './types'

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

  it('партия начинается 1 января 1994 года утром', () => {
    /*
     * УТРО, А НЕ ПОЛНОЧЬ, и это решение видно на первом же экране.
     *
     * Ноль означал первое января в 00:00 — зимнюю полночь, самый тёмный кадр из
     * возможных. Пока света суток не было, это ничего не значило; с ним игра
     * стала открываться чёрным экраном, на котором из всей карты читаются
     * только подписи городов. Девять утра — зимний рассвет с длинными тенями,
     * тот самый кадр, ради которого свет суток и делался.
     */
    const state = createInitialState(1)
    expect(state.startYear).toBe(START_YEAR)
    expect(dateFromTick(state.tick, state.startYear)).toMatchObject({
      year: 1994,
      month: 1,
      day: 1,
      hour: 9,
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

  it('компания начинает без линий, без построек, без итогов и не банкротом', () => {
    const state = createInitialState(1)
    const player = state.companies[state.playerId]

    // Первую сеть проектирует игрок. Готовое кольцо на старте отобрало бы у
    // него ровно то решение, ради которого срез 3 и сделан.
    expect(player.lines).toEqual({})

    /*
     * НИ ОДНОЙ ПОСТРОЙКИ, и это условие, на котором держится весь срез 5. Пустой
     * список означает ровно BASE_POSTS постов в каждом городе — один, — то есть
     * вторая машина на том же заводе встаёт в очередь немедленно. Подарённый
     * терминал отложил бы это открытие до той поры, когда у игрока двадцать
     * машин и разбираться уже поздно.
     */
    expect(player.buildings).toEqual({})
    expect(postsAt(state, HOME_CITY, state.playerId)).toBe(BASE_POSTS)

    // Суточный итог ещё не подводился — первые сутки не прошли. Ноль здесь
    // означает «данных нет», а не «сработали в ноль».
    expect(player.dailyRevenue).toBe(0)
    expect(player.dailyCosts).toBe(0)

    expect(player.bankrupt).toBe(false)
    expect(player.daysInDebt).toBe(0)
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
    // Парк ИГРОКА, а не весь мир: с среза 6 у ворот стоят ещё три грузовика
    // конкурентов (COMPETITORS в state.ts), и они к этой проверке отношения
    // не имеют.
    const vehicles = Object.values(state.vehicles).filter(
      (vehicle) => vehicle.ownerId === state.playerId,
    )
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

  it('все характеристики машины взяты из справочника техники', () => {
    const truck = Object.values(createInitialState(1).vehicles)[0]

    /*
     * ГЛАВНАЯ ПРОВЕРКА СТАРТОВОЙ МАШИНЫ В СРЕЗЕ 4. Числа не выписаны здесь
     * руками нарочно: справочник — единственное место, где класс проверен на
     * главный инвариант игры, и стартовая машина обязана быть ровно тем, что в
     * нём записано. Разъедься эти два описания, и партия начиналась бы техникой,
     * которой в игре нет: инвариант считался бы для одной машины, а ездила бы
     * другая, и ни один тест баланса этого бы не заметил.
     */
    expect(truck.classId).toBe(STARTER_CLASS_ID)
    expect(truck.capacity).toBe(STARTER_CLASS.capacity)
    expect(truck.cruiseKmh).toBe(STARTER_CLASS.cruiseKmh)
    expect(truck.fuelPer100Km).toBe(STARTER_CLASS.fuelPer100Km)
    expect(STARTER_CAPACITY_TONS).toBe(STARTER_CLASS.capacity)
  })

  it('машина новая: без износа, без просроченного ТО и не сломана', () => {
    const truck = Object.values(createInitialState(1).vehicles)[0]

    // Партия начинается с исправной техники. Ненулевой износ на старте означал
    // бы наказание за то, чего игрок ещё не делал.
    expect(truck.wear).toBe(0)
    expect(truck.kmSinceService).toBe(0)
    expect(truck.brokenDown).toBe(false)
  })

  it('на машине стоит тент — единственный прицеп, на котором есть игра', () => {
    const truck = Object.values(createInitialState(1).vehicles)[0]
    expect(truck.trailer).toBe(STARTER_TRAILER)
    // Прицеп обязан подходить машине: полуприцеп на бортовой ЗИЛ не повесить.
    expect(STARTER_CLASS.trailers).toContain(STARTER_TRAILER)

    /*
     * Смысл выбора проверяется, а не декларируется. Кольцо с двумя гружёными
     * плечами требует ВЕЗТИ РАЗНОЕ в разные стороны, то есть прицеп обязан
     * брать больше одного груза. Второй доступный ЗИЛу прицеп (зерновоз) возит
     * ровно один — с ним обратное плечо порожнее всегда, и главная механика
     * игры недостижима с первого дня.
     */
    expect(cargoFor(STARTER_TRAILER).length).toBeGreaterThan(1)

    const alternatives = STARTER_CLASS.trailers.filter(
      (trailer) => trailer !== STARTER_TRAILER,
    )
    for (const trailer of alternatives) {
      expect(cargoFor(trailer).length, trailer).toBeLessThanOrEqual(
        cargoFor(STARTER_TRAILER).length,
      )
    }
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

  it('машина не назначена ни на какую линию', () => {
    const truck = Object.values(createInitialState(1).vehicles)[0]
    // Линий на старте нет вовсе, и назначенная машина указывала бы на
    // несуществующую — диспетчеризация молча пропускала бы её каждый тик.
    expect(truck.lineId).toBeNull()
    expect(truck.stopIndex).toBe(0)
  })

  it('машина свободна: ни поста под ней, ни очереди перед ней', () => {
    const truck = Object.values(createInitialState(1).vehicles)[0]

    /*
     * ОБА НУЛЯ ЗНАЧИМЫ, И ПО-РАЗНОМУ. serviceTicksLeft читается всей игрой как
     * «машина свободна»: ненулевое значение остановило бы и диспетчеризацию
     * (line.ts), и погрузку (loading.ts), то есть партия начиналась бы с
     * грузовика, который несколько часов стоит под чужой погрузкой и не
     * подаёт признаков жизни. queuedTicks — это главное число панели узких мест,
     * и ненулевое на старте показало бы игроку пробку, которой он не создавал.
     */
    expect(truck.serviceTicksLeft).toBe(0)
    expect(truck.queuedTicks).toBe(0)
  })

  it('расход топлива — паспортные тридцать литров ЗИЛ-130', () => {
    const truck = Object.values(createInitialState(1).vehicles)[0]

    // Ноль здесь означал бы машину, которая ездит даром: порожний пробег
    // перестал бы что-либо стоить, и главная механика среза исчезла бы, не
    // уронив ни одного теста.
    expect(truck.fuelPer100Km).toBe(STARTER_FUEL_PER_100KM)
    expect(truck.fuelPer100Km).toBeGreaterThan(0)
    // Диапазон грузового карбюраторного двигателя тех лет: ниже двадцати
    // литров он не опускался, выше сорока не поднимался даже с прицепом.
    expect(truck.fuelPer100Km).toBeGreaterThanOrEqual(20)
    expect(truck.fuelPer100Km).toBeLessThanOrEqual(40)
  })
})

describe('createInitialState: стартовый водитель', () => {
  it('водитель ровно один и он сидит за стартовой машиной', () => {
    const state = createInitialState(1)
    const player = state.companies[state.playerId]
    const drivers = Object.values(player.drivers)
    const truck = Object.values(state.vehicles)[0]

    // Один, а не два: водитель — постоянный расход, и человек в резерве
    // проедал бы капитал, ничего не давая.
    expect(drivers).toHaveLength(1)

    // Связь двусторонняя и на старте обязана быть сведена: машина без водителя
    // не едет вовсе, а водитель без машины получает зарплату ни за что.
    const driver = drivers[0]
    expect(truck.driverId).toBe(driver.id)
    expect(driver.vehicleId).toBe(truck.id)
    expect(driver.employerId).toBe(player.id)
    for (const [key, person] of Object.entries(player.drivers)) {
      expect(person.id).toBe(key)
    }
  })

  it('навык средний, допусков нет, отдохнул', () => {
    const driver = Object.values(
      createInitialState(1).companies[PLAYER_ID].drivers,
    )[0]

    // Ровно середина шкалы: на ней расход топлива равен паспортному, и весь
    // баланс срезов 2–3, посчитанный по паспорту, переносится без поправок.
    expect(driver.skill).toBe(STARTER_DRIVER_SKILL)
    expect(driver.skill).toBe(0.5)

    // Без допусков: из трёх цепочек мира открыта ровно одна, зерновая. Две
    // другие видны на карте и не работают — это и есть первая цель партии.
    expect(driver.licenses).toEqual([])

    // Партия начинается утром, а не в конце смены.
    expect(driver.fatigue).toBe(0)
    expect(driver.hoursOnDuty).toBe(0)
  })

  it('ставка считается той же формулой, что и при найме', () => {
    const driver = Object.values(
      createInitialState(1).companies[PLAYER_ID].drivers,
    )[0]

    // Две зарплатные формулы в игре — верный способ получить своего водителя
    // дешевле точно такого же нанятого, и первый же наём выглядел бы
    // несправедливо дорогим.
    expect(driver.wagePerDay).toBe(wageFor(driver.skill, driver.licenses))
    // Базовая ставка из данных — это ставка НОВИЧКА: надбавка за навык есть у
    // всех, включая своего.
    expect(driver.wagePerDay).toBeGreaterThan(DRIVER_WAGE_PER_DAY)
    expect(wageFor(0, [])).toBe(DRIVER_WAGE_PER_DAY)
  })
})

describe('createZil: одна сборка машины на всю игру', () => {
  const OWNER = companyId('someone')
  const WHERE = cityId('tula')

  it('купленная машина ничем не отличается от стартовой, кроме водителя', () => {
    const starter = Object.values(createInitialState(1).vehicles)[0]
    const bought = createZil(vehicleId('zil-2'), starter.ownerId, WHERE)

    // Сравниваем всё, кроме того, что и обязано отличаться. Две сборки машины
    // в двух местах однажды разойдутся в поле, которое ничего не роняет, —
    // например, в расходе топлива, и купленная машина станет выгоднее
    // стартовой без единой красной строчки в прогоне.
    //
    // Водитель в список сравнения не входит: за стартовую машину сажают сразу,
    // за купленную — отдельным решением игрока.
    const shape = (v: typeof starter) => ({
      ...v,
      id: '',
      position: null,
      driverId: null,
    })
    expect(shape(bought)).toEqual(shape(starter))
  })

  it('createVehicle собирает любой класс справочника и только его', () => {
    for (const vehicleClass of VEHICLE_CLASSES) {
      const truck = createVehicle(
        vehicleId(`v-${vehicleClass.id}`),
        OWNER,
        WHERE,
        vehicleClass.id,
      )

      expect(truck.classId).toBe(vehicleClass.id)
      expect(truck.capacity).toBe(vehicleClass.capacity)
      expect(truck.cruiseKmh).toBe(vehicleClass.cruiseKmh)
      expect(truck.fuelPer100Km).toBe(vehicleClass.fuelPer100Km)

      // Купленный тягач приезжает голым: ни прицепа, ни водителя. Машина в
      // этой игре собирается из трёх решений, покупка — только первое.
      expect(truck.trailer).toBeNull()
      expect(truck.driverId).toBeNull()

      // И свободным: купленная машина не наследует ничьей очереди.
      expect(truck.serviceTicksLeft).toBe(0)
      expect(truck.queuedTicks).toBe(0)
    }

    // Неизвестный класс падает громко. Молчаливое умолчание дало бы машину с
    // нулевым расходом топлива — то есть машину, которая возит бесплатно, и
    // такой дефект выглядит как «странный баланс», а не как ошибка.
    expect(() => createVehicle(vehicleId('v-x'), OWNER, WHERE, 'нет')).toThrow()
  })

  it('машина рождается стоящей в указанном городе, порожней и без линии', () => {
    const truck = createZil(vehicleId('zil-7'), OWNER, WHERE)

    expect(truck.id).toBe('zil-7')
    expect(truck.ownerId).toBe(OWNER)
    expect(truck.position).toEqual({ kind: 'узел', nodeId: WHERE })
    expect(truck.route).toEqual([])
    expect(truck.cargo).toBeNull()
    expect(truck.lineId).toBeNull()
    expect(truck.odometer).toBe(0)
    expect(truck.loadedKm).toBe(0)
    expect(truck.emptyKm).toBe(0)
  })

  it('две машины не делят ни одного объекта', () => {
    const first = createZil(vehicleId('zil-2'), OWNER, WHERE)
    const second = createZil(vehicleId('zil-3'), OWNER, WHERE)

    // Общий массив маршрута означал бы, что отправленная машина тянет за собой
    // весь парк. Дефект тихий: обе машины «просто едут одинаково».
    expect(first.route).not.toBe(second.route)
    expect(first.position).not.toBe(second.position)
  })
})

describe('createInitialState: стартовый капитал', () => {
  /**
   * Переменные расходы стартовой машины на километр: топливо плюс обслуживание.
   * Спрашиваются у справочника (costPerKm), а не складываются здесь заново:
   * ставка обслуживания переехала в класс, и вторая копия формулы разъехалась
   * бы с ней при первой же перебалансировке.
   */
  const perKm = costPerKm(STARTER_CLASS)

  /** Самый дешёвый прицеп, какой вообще есть в игре. */
  const CHEAPEST_TRAILER = Math.min(...Object.values(TRAILER_PRICE))

  it('второй РАБОТАЮЩЕЙ машины на старте не купить', () => {
    const state = createInitialState(1)
    const money = state.companies[state.playerId].money

    expect(money).toBe(START_MONEY)

    /*
     * Правило среза 3 звучало «капитала меньше, чем стоит ЗИЛ». В срезе 4 оно
     * изменилось по форме и уцелело по сути: тягач сам по себе груза не берёт и
     * с места не трогается, поэтому мерой стала цена РАБОТАЮЩЕЙ машины —
     * тягач плюс хоть какой-нибудь прицеп. Её капитал не покрывает, и первое
     * решение игры («расширяться или сначала научиться возить») по-прежнему
     * принимает игрок, а не стартовый баланс.
     */
    expect(money).toBeLessThan(STARTER_CLASS.price + CHEAPEST_TRAILER)

    // Но и не настолько мало, чтобы копить вслепую: вторая машина должна быть
    // видимой целью, а не мечтой.
    expect(money).toBeGreaterThan(STARTER_CLASS.price / 2)
  })

  it('хватает на смену специализации: прицеп можно купить сразу', () => {
    const money = createInitialState(1).companies[PLAYER_ID].money

    /*
     * Вторая роль капитала, появившаяся в срезе 4. Игрок, начавший с тентом и
     * решивший, что ошибся, обязан иметь возможность купить другой прицеп —
     * иначе первое же решение партии необратимо, а необратимое решение,
     * принятое до того, как игрок понял правила, это не решение, а ловушка.
     */
    for (const trailer of STARTER_CLASS.trailers) {
      expect(money, trailer).toBeGreaterThanOrEqual(TRAILER_PRICE[trailer])
    }

    // И запас на прицеп — именно ЗАПАС, а не весь капитал: на работу тоже
    // должно остаться.
    // После смены специализации игрок обязан остаться на плаву, но роскоши
    // на второй такой манёвр ему не положено: капитал зажат ценовым окном
    // (см. START_MONEY), и требовать двойного запаса значило бы разрешить
    // покупку второй машины на старте.
    const left = money - RESPEC_RESERVE
    expect(left).toBeGreaterThan(0)
    expect(left / DRIVER_WAGE_PER_DAY).toBeGreaterThan(5)
  })

  it('денег хватает на несколько суток работы', () => {
    const state = createInitialState(1)
    const money = state.companies[state.playerId].money

    // Мера снизу — круг «туда и обратно» на опорном плече тарифа (200 км в
    // каждую сторону, см. DELIVERY_REFERENCE_KM). Партия обязана пережить
    // несколько таких кругов даже при нулевой выручке: игрок не может
    // разориться раньше, чем понял правила.
    const referenceRing = 2 * DELIVERY_REFERENCE_KM * perKm
    expect(money).toBeGreaterThan(referenceRing * 2)

    // Мера сверху по той же шкале: капитал не должен покрывать бесконечное
    // катание. Десяти кругов без единой доставки быть не должно.
    expect(money).toBeLessThan(referenceRing * 10)
  })

  it('простой тоже проедает капитал, но медленно', () => {
    const state = createInitialState(1)
    const player = state.companies[state.playerId]
    const money = player.money

    // Машина в гараже стоит зарплату своего водителя в сутки — настоящую, со
    // всеми надбавками, а не базовую ставку из данных. Две недели — нижняя
    // граница: игрок должен успеть разобраться в интерфейсе, ничего не возя.
    const payroll = Object.values(player.drivers).reduce(
      (sum, driver) => sum + driver.wagePerDay,
      0,
    )
    const idleDays = money / payroll
    expect(idleDays).toBeGreaterThan(14)
    // И верхняя: пересидеть партию в гараже нельзя, месяцем простоя капитал
    // кончается.
    expect(idleDays).toBeLessThan(60)
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
