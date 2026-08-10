import { describe, expect, it } from 'vitest'
import { RECIPE_BY_INDUSTRY } from '../data/recipes'
import { VEHICLE_CLASS_BY_ID } from '../data/vehicles'
import { runCommands } from './ai/commands'
import { needsService, repairVehicle, serviceVehicle } from './logistics/wear'
import {
  COMPETITORS,
  createInitialState,
  PLAYER_ID,
  starterDriverIdOf,
  starterVehicleIdOf,
  START_MONEY,
  STARTER_VEHICLE_ID,
} from './state'
import { THINKING_LIMIT, tick, tickMany } from './tick'
import { TICKS_PER_DAY, cityId, industryId, lineId } from './types'
import type {
  CargoType,
  CityId,
  Command,
  Company,
  CompanyId,
  GameState,
  Industry,
  IndustryId,
  Line,
  LineId,
  Stop,
  Vehicle,
  VehicleId,
} from './types'

/**
 * СРЕЗ 6, ИНТЕГРАЦИЯ: конкуренты внутри тика.
 *
 * Файл проверяет не эвристику конкурента (её тесты живут рядом с ней, в
 * sim/ai/scripted.test.ts) и не законность отдельных команд (sim/ai/commands.test.ts),
 * а четыре утверждения, которые видны ТОЛЬКО на целом тике и целом прогоне:
 *
 *   1. Стартовые условия у всех одинаковые. Игрок не побеждает из-за форы,
 *      конкурент — из-за читерства.
 *   2. Команды разбираются В НАЧАЛЕ тика — до диспетчеризации и до движения.
 *      Это не косметика порядка: конкурент принимает решение раз в игровые
 *      сутки, поэтому решение, опоздавшее на тик, опаздывает на сутки.
 *   3. Конкурент РЕАЛЬНО МЕШАЕТ. Главное утверждение всего среза: если та же
 *      линия игрока приносит столько же рядом с чужим парком, сколько в пустом
 *      мире, то конкурента в игре нет — есть анимация на карте.
 *   4. Мир с конкурентами живёт шестьдесят суток и не вырождается ни в одну из
 *      двух крайностей — ни «все умерли», ни «кто-то растёт бесконечно».
 *
 * Отдельно проверяется граница сети: очередь команд переживает сохранение и
 * загрузку. Ответ модели попадает именно туда, и партия, записанная с
 * непринятыми командами, обязана продолжаться один в один.
 */

const MOSCOW = cityId('moscow')
const TULA = cityId('tula')
const SMOLENSK = cityId('smolensk')

/** Сутки в тиках — 96. Экономика живёт сутками, тик для неё слишком мелок. */
const DAY = TICKS_PER_DAY

/** Сид фиксирован: прогоны обязаны совпадать между запусками. */
const SEED = 20260810

const RING: LineId = lineId('ring')

// ─── Фикстуры ──────────────────────────────────────────────────────────────

function stop(nodeId: CityId, unload: CargoType[], load: CargoType[]): Stop {
  return { nodeId, unload, load }
}

function copyStops(stops: readonly Stop[]): Stop[] {
  return stops.map((it) => ({
    nodeId: it.nodeId,
    unload: [...it.unload],
    load: [...it.load],
  }))
}

/** Парк компании. */
function fleetOf(state: GameState, owner: CompanyId): Vehicle[] {
  return Object.values(state.vehicles).filter((v) => v.ownerId === owner)
}

/** Оставить в мире только перечисленные компании вместе с их парком. */
function keepOnly(state: GameState, owners: readonly CompanyId[]): GameState {
  const keep = new Set(owners)
  return {
    ...state,
    companies: Object.fromEntries(
      Object.entries(state.companies).filter(([id]) => keep.has(id as CompanyId)),
    ) as Record<CompanyId, Company>,
    vehicles: Object.fromEntries(
      Object.entries(state.vehicles).filter(([, vehicle]) =>
        keep.has(vehicle.ownerId),
      ),
    ) as Record<VehicleId, Vehicle>,
  }
}

/** Поставить компании кольцо и завести на него её стартовую машину. */
function onRing(
  state: GameState,
  owner: CompanyId,
  stops: readonly Stop[],
  truckId: VehicleId,
): GameState {
  const company = state.companies[owner]
  const line: Line = {
    id: RING,
    name: 'Кольцо',
    stops: copyStops(stops),
    assignedVehicles: [truckId],
  }

  return {
    ...state,
    companies: {
      ...state.companies,
      [owner]: { ...company, lines: { [RING]: line } },
    },
    vehicles: {
      ...state.vehicles,
      [truckId]: { ...state.vehicles[truckId], lineId: RING, stopIndex: 0 },
    },
  }
}

/** Компании с деньгами по потребности теста. */
function withMoney(state: GameState, owner: CompanyId, money: number): GameState {
  const company = state.companies[owner]
  return {
    ...state,
    companies: { ...state.companies, [owner]: { ...company, money } },
  }
}

/** Положить компании команды в очередь. */
function queued(
  state: GameState,
  owner: CompanyId,
  commands: Command[],
): GameState {
  const company = state.companies[owner]
  return {
    ...state,
    companies: {
      ...state.companies,
      [owner]: { ...company, pendingCommands: commands },
    },
  }
}

// ─── Инварианты прогона ────────────────────────────────────────────────────

/**
 * Тик, на котором конкуренты принимают решение, — последний тик игровых суток.
 *
 * Выводится из TICKS_PER_DAY, а не переписывается числом: правило живёт в
 * sim/tick.ts (isDecisionTick), и вторая копия константы разъехалась бы с ним
 * при первой же правке ритма.
 */
const isDecisionTick = (t: number): boolean => t % DAY === DAY - 1

/**
 * Что обязано быть верно ПОСЛЕ ЛЮБОГО тика, у ЛЮБОЙ компании.
 *
 * Возвращает список нарушений, а не бросает: проверка зовётся каждый тик
 * длинного прогона, и накопить их в массив дешевле, чем упасть на первом и
 * гадать, что было до него.
 *
 * Отрицательный склад и груз сверх кузова — самые опасные поломки экономики: они
 * не падают, а тихо рождают тонны из ниоткуда. Очередь команд проверяется по той
 * же причине, но у неё правило тоньше, см. ниже.
 */
function violations(state: GameState): string[] {
  const bad: string[] = []
  const check = (ok: boolean, message: string): void => {
    if (!ok) bad.push(`тик ${state.tick}: ${message}`)
  }

  for (const company of Object.values(state.companies)) {
    check(Number.isFinite(company.money), `счёт ${company.id} = ${company.money}`)
    check(
      Number.isFinite(company.dailyRevenue) && company.dailyRevenue >= 0,
      `суточная выручка ${company.id} = ${company.dailyRevenue}`,
    )
    check(
      Number.isFinite(company.dailyCosts) && company.dailyCosts >= 0,
      `суточные расходы ${company.id} = ${company.dailyCosts}`,
    )

    /*
     * ОЧЕРЕДЬ ЖИВЁТ РОВНО ОДИН ТИК, И ЭТО ПРОВЕРЯЕТСЯ ЗДЕСЬ.
     *
     * Решение кладётся в неё в КОНЦЕ тика (фаза решений) и разбирается в
     * НАЧАЛЕ следующего (фаза команд). Значит непустой очередь бывает ровно на
     * границе суток — и больше нигде. Копящаяся очередь означала бы, что фаза
     * команд не отработала: отброшенное предложение возвращалось бы каждый тик
     * до конца партии, а список рос бы до тех пор, пока не съел бы кадр.
     */
    if (!isDecisionTick(state.tick)) {
      check(
        company.pendingCommands.length === 0,
        `очередь ${company.id} не разобрана: ${company.pendingCommands.length}`,
      )
    }

    // Лента ограничена — иначе сохранение пухнет на ровном месте.
    check(
      company.thinking.length <= THINKING_LIMIT,
      `лента ${company.id} = ${company.thinking.length}`,
    )
  }

  for (const industry of Object.values(state.world.industries)) {
    for (const [cargo, tons] of Object.entries(industry.stock)) {
      check(
        Number.isFinite(tons) && (tons as number) >= 0,
        `склад ${industry.id} по «${cargo}» = ${tons}`,
      )
    }
  }

  for (const vehicle of Object.values(state.vehicles)) {
    check(
      state.companies[vehicle.ownerId] !== undefined,
      `машина ${vehicle.id} без хозяина (${vehicle.ownerId})`,
    )
    if (vehicle.cargo !== null) {
      check(
        vehicle.cargo.tons <= vehicle.capacity + 1e-9,
        `перегруз ${vehicle.id}: ${vehicle.cargo.tons} т при ${vehicle.capacity}`,
      )
    }
    check(
      Math.abs(vehicle.loadedKm + vehicle.emptyKm - vehicle.odometer) < 1e-6,
      `пробег ${vehicle.id} не сходится`,
    )
  }

  return bad
}

/** Прогон с проверкой инвариантов на каждом тике. */
function runDays(
  state: GameState,
  days: number,
): { end: GameState; broken: string[] } {
  let current = state
  const broken: string[] = []

  for (let i = 0; i < DAY * days; i++) {
    current = tick(current)
    // Копим только первую партию: дальше они повторяются каждый тик и заваливают
    // вывод.
    if (broken.length === 0) broken.push(...violations(current))
  }

  return { end: current, broken }
}

/**
 * Прогон с ХОЗЯЙСКИМ ОТНОШЕНИЕМ К ТЕХНИКЕ: поломка чинится, ТО проводится.
 *
 * Тот же приём и по той же причине, что в tick.invariant.test.ts. Поломка — это
 * бросок ГПСЧ, и на длинном прогоне она сдвигает результат сильнее, чем то, что
 * тест меряет: одна авария на первый день и одна на тридцатый дают совершенно
 * разные деньги при совершенно одинаковой экономике кольца. Чинятся машины ВСЕХ
 * компаний одинаково — иначе преимущество получил бы тот, за кем присматривают.
 */
function runTended(state: GameState, days: number): GameState {
  let next = state

  for (let i = 0; i < days * DAY; i++) {
    next = tick(next)
    for (const id of Object.keys(next.vehicles) as VehicleId[]) {
      if (next.vehicles[id].brokenDown) next = repairVehicle(next, id)
      if (needsService(next.vehicles[id])) next = serviceVehicle(next, id)
    }
  }

  return next
}

// ─── Начальный мир ─────────────────────────────────────────────────────────

describe('начальное состояние с конкурентами', () => {
  const state = createInitialState(SEED)

  it('конкуренты заведены, у каждого свой характер, игрок остался человеком', () => {
    const rivals = Object.values(state.companies).filter(
      (company) => company.id !== state.playerId,
    )
    expect(rivals).toHaveLength(COMPETITORS.length)

    // Характеры не повторяются: два одинаковых конкурента — это один конкурент
    // с удвоенным парком, и реиграбельности от него ноль.
    const characters = rivals.map((company) => company.personality)
    expect(new Set(characters).size).toBe(rivals.length)

    for (const rival of rivals) {
      expect(rival.personality, rival.id).not.toBeNull()
      // Скрипт, а не модель: симуляция обязана быть полной без сети. Модель
      // подключает слой приложения и сам же отвечает за запасной путь.
      expect(rival.controller, rival.id).toBe('скрипт')
    }

    const player = state.companies[state.playerId]
    expect(player.controller).toBe('человек')
    // У игрока характера нет: он и есть тот, кто решает.
    expect(player.personality).toBeNull()
  })

  it('стартовые условия у всех одинаковые до последнего числа', () => {
    /*
     * ГЛАВНОЕ ТРЕБОВАНИЕ СРЕЗА, ПРОВЕРЕННОЕ ЧИСЛАМИ: игрок не побеждает из-за
     * форы, конкурент — из-за читерства. Сравнивается ВСЁ, кроме того, что и
     * обязано отличаться, — имени конторы, идентификаторов, характера и того,
     * кто за компанию решает.
     */
    const shape = (company: Company) => ({
      money: company.money,
      lines: company.lines,
      buildings: company.buildings,
      pendingCommands: company.pendingCommands,
      thinking: company.thinking,
      dailyRevenue: company.dailyRevenue,
      dailyCosts: company.dailyCosts,
      bankrupt: company.bankrupt,
      daysInDebt: company.daysInDebt,
      staff: Object.values(company.drivers).length,
    })

    const player = shape(state.companies[state.playerId])
    expect(player.money).toBe(START_MONEY)

    for (const spec of COMPETITORS) {
      expect(shape(state.companies[spec.id]), spec.id).toEqual(player)
    }
  })

  it('у каждой компании ровно один ЗИЛ у ворот и ровно один водитель', () => {
    const owners = [PLAYER_ID, ...COMPETITORS.map((spec) => spec.id)]
    const reference = state.vehicles[STARTER_VEHICLE_ID]
    const referenceDriver = Object.values(state.companies[PLAYER_ID].drivers)[0]

    for (const owner of owners) {
      const fleet = fleetOf(state, owner)
      expect(fleet, owner).toHaveLength(1)

      const truck = fleet[0]
      // Машина у всех одна и та же: класс, прицеп, грузоподъёмность, расход,
      // город. Разойдись хоть одно поле — и «одинаковые условия» перестали бы
      // быть правдой, не уронив ни одного другого теста.
      expect(truck.classId, owner).toBe(reference.classId)
      expect(truck.trailer, owner).toBe(reference.trailer)
      expect(truck.capacity, owner).toBe(reference.capacity)
      expect(truck.fuelPer100Km, owner).toBe(reference.fuelPer100Km)
      expect(truck.position, owner).toEqual(reference.position)
      expect(truck.wear, owner).toBe(0)

      const drivers = Object.values(state.companies[owner].drivers)
      expect(drivers, owner).toHaveLength(1)
      // Навык и ставка тоже общие: более экономичный водитель — это фора, а
      // более дорогой — наказание, и ни того, ни другого никто не выбирал.
      expect(drivers[0].skill, owner).toBe(referenceDriver.skill)
      expect(drivers[0].licenses, owner).toEqual(referenceDriver.licenses)
      expect(drivers[0].wagePerDay, owner).toBe(referenceDriver.wagePerDay)
      // Связь машины и водителя сведена с обеих сторон: иначе конкурент
      // начинает партию с грузовиком, который не трогается с места.
      expect(truck.driverId, owner).toBe(drivers[0].id)
      expect(drivers[0].vehicleId, owner).toBe(truck.id)
    }
  })

  it('идентификаторы конкурентов не сталкиваются с чужими', () => {
    for (const spec of COMPETITORS) {
      expect(starterVehicleIdOf(spec.id)).not.toBe(STARTER_VEHICLE_ID)
      expect(state.vehicles[starterVehicleIdOf(spec.id)]).toBeDefined()
      expect(
        state.companies[spec.id].drivers[starterDriverIdOf(spec.id)],
      ).toBeDefined()
    }

    // Ключи совпадают с идентификаторами внутри объектов: иначе поиск по ключу
    // и поиск по полю дадут разные ответы.
    for (const [key, company] of Object.entries(state.companies)) {
      expect(company.id).toBe(key)
    }
    for (const [key, vehicle] of Object.entries(state.vehicles)) {
      expect(vehicle.id).toBe(key)
    }
  })

  it('мир с конкурентами детерминирован и переживает сериализацию', () => {
    const a = createInitialState(SEED)
    const b = createInitialState(SEED)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.parse(JSON.stringify(a))).toEqual(a)

    // Порядок ключей задан явно: игрок первый. От него зависит, кому достанется
    // партия при дележе одного склада — разбор в createInitialState.
    expect(Object.keys(a.companies)[0]).toBe(PLAYER_ID)
  })
})

// ─── Порядок фаз ───────────────────────────────────────────────────────────

describe('команды применяются в начале тика, до движения', () => {
  /** Зерновое кольцо Орёл — Тула: оба плеча гружёные, допусков не требует. */
  const GRAIN_RING: Stop[] = [
    stop(cityId('orel'), ['мука'], ['зерно']),
    stop(TULA, ['зерно'], ['мука']),
  ]

  /** Мир, где у игрока есть кольцо, но машина на него ещё не поставлена. */
  function parked(): GameState {
    const base = keepOnly(createInitialState(SEED), [PLAYER_ID])
    const company = base.companies[PLAYER_ID]
    const line: Line = {
      id: RING,
      name: 'Кольцо',
      stops: copyStops(GRAIN_RING),
      assignedVehicles: [],
    }
    return {
      ...base,
      companies: {
        ...base.companies,
        [PLAYER_ID]: { ...company, lines: { [RING]: line } },
      },
    }
  }

  it('назначение на линию из очереди срабатывает и машина едет тем же тиком', () => {
    const before = parked()

    // Контроль: без команды машина стоит. Иначе проверка ниже доказывала бы не
    // порядок фаз, а то, что машина ездит сама.
    const idle = tick(before)
    expect(idle.vehicles[STARTER_VEHICLE_ID].lineId).toBeNull()
    expect(idle.vehicles[STARTER_VEHICLE_ID].odometer).toBe(0)

    const after = tick(
      queued(before, PLAYER_ID, [
        { kind: 'назначить-машину', vehicleId: STARTER_VEHICLE_ID, lineId: RING },
      ]),
    )

    const truck = after.vehicles[STARTER_VEHICLE_ID]
    expect(truck.lineId).toBe(RING)
    /*
     * ВОТ РАДИ ЭТОЙ СТРОЧКИ ФАЗА И СТОИТ ПЕРВОЙ. Машина не просто получила
     * линию — она успела получить маршрут в диспетчеризации и проехать по нему в
     * движении, всё в ОДНОМ тике. Поставь фазу команд в конец, и назначение
     * подействовало бы только на следующем тике; а поскольку следующее решение
     * конкурент принимает лишь завтра, опоздание в один тик превратилось бы в
     * опоздание на сутки — и вся его игра шла бы на день позади игрока.
     */
    expect(truck.odometer).toBeGreaterThan(0)
    // Очередь разобрана: команда — разовое предложение, а не намерение.
    expect(after.companies[PLAYER_ID].pendingCommands).toEqual([])
  })

  it('покупка из очереди приезжает в парк в том же тике', () => {
    const price = VEHICLE_CLASS_BY_ID['kamaz-5320'].price
    const rich = withMoney(parked(), PLAYER_ID, price * 2)

    const after = tick(
      queued(rich, PLAYER_ID, [{ kind: 'купить-машину', classId: 'kamaz-5320' }]),
    )

    expect(fleetOf(after, PLAYER_ID)).toHaveLength(2)

    // Цена списана. Сравнение идёт с ТЕМ ЖЕ миром без команды, а не с исходным
    // счётом: за тик компания успевает заплатить ещё и зарплату, и вычитать её
    // здесь руками значило бы завести вторую копию формулы расходов.
    const idle = tick(rich)
    expect(after.companies[PLAYER_ID].money).toBeCloseTo(
      idle.companies[PLAYER_ID].money - price,
      6,
    )
  })

  it('незаконная команда отбрасывается, а очередь всё равно чистится', () => {
    // Денег на КамАЗ у игрока нет — команда обязана быть отброшена. Но остаться
    // в очереди она не имеет права: иначе она отбрасывалась бы каждый тик до
    // конца партии, а очередь модели копилась бы без предела.
    const before = parked()
    const after = tick(
      queued(before, PLAYER_ID, [{ kind: 'купить-машину', classId: 'kamaz-5320' }]),
    )

    expect(fleetOf(after, PLAYER_ID)).toHaveLength(1)
    expect(after.companies[PLAYER_ID].money).toBe(
      tick(before).companies[PLAYER_ID].money,
    )
    expect(after.companies[PLAYER_ID].pendingCommands).toEqual([])
  })

  it('фаза команд сама по себе никого не двигает', () => {
    // Прямой вызов фазы делает ровно свою работу и ни грамма чужой: назначение
    // произошло, движение — нет. Так и должно быть, иначе фаза перестала бы
    // быть переставляемой и порядок в tick.ts потерял бы смысл.
    const state = queued(parked(), PLAYER_ID, [
      { kind: 'назначить-машину', vehicleId: STARTER_VEHICLE_ID, lineId: RING },
    ])

    const byPhase = runCommands(state)
    expect(byPhase.vehicles[STARTER_VEHICLE_ID].lineId).toBe(RING)
    expect(byPhase.vehicles[STARTER_VEHICLE_ID].odometer).toBe(0)
  })
})

// ─── Ритм решений ──────────────────────────────────────────────────────────

describe('конкурент думает раз в игровые сутки', () => {
  const rival = COMPETITORS[0].id

  it('первая мысль появляется на последнем тике первых суток', () => {
    const state = createInitialState(SEED)

    const eve = tickMany(state, DAY - 1)
    expect(eve.companies[rival].thinking).toHaveLength(1)
    expect(eve.companies[rival].thinking[0].tick).toBe(DAY - 1)
    // Записанное скриптом обязано быть помечено как скриптовое: тихая подмена
    // модели обесценила бы всю ленту.
    expect(eve.companies[rival].thinking[0].fromModel).toBe(false)

    // И следующая появляется ровно через сутки, а не каждый тик: иначе на
    // ускорении ×5 лента набирала бы двадцать записей в секунду.
    expect(tickMany(eve, DAY).companies[rival].thinking).toHaveLength(2)
  })

  it('за десять суток мыслей десять, и очередь нигде не копится', () => {
    const { end, broken } = runDays(createInitialState(SEED), 10)
    expect(broken).toEqual([])
    expect(end.companies[rival].thinking).toHaveLength(10)
  })

  it('лента не растёт бесконечно: вытесняется старое', () => {
    // Прогон длиннее ленты — иначе проверка холостая.
    const days = THINKING_LIMIT + 5
    const feed = runDays(createInitialState(SEED), days).end.companies[rival].thinking

    expect(feed).toHaveLength(THINKING_LIMIT)
    // Вытесняется СТАРОЕ: свежая мысль объясняет то, что происходит на карте
    // сейчас, и терять её ради истории нельзя.
    expect(feed[feed.length - 1].tick).toBe(days * DAY - 1)
    expect(feed[0].tick).toBeGreaterThan(0)
  })

  it('за игрока никто не думает и не ходит', () => {
    const { end } = runDays(createInitialState(SEED), 5)
    expect(end.companies[PLAYER_ID].thinking).toEqual([])
    // Ни одной линии не появилось само собой: игрок — это тот, кто решает сам.
    expect(end.companies[PLAYER_ID].lines).toEqual({})
  })
})

// ─── Конкурент мешает ──────────────────────────────────────────────────────

describe('конкурент реально мешает: та же линия приносит меньше', () => {
  /*
   * ГЛАВНОЕ УТВЕРЖДЕНИЕ СРЕЗА, И ПРОВЕРЯЕТСЯ ОНО НА РУЧНОМ КОНКУРЕНТЕ.
   *
   * Скриптовый здесь не годится нарочно: тест обязан измерять СТОЛКНОВЕНИЕ ДВУХ
   * ПАРКОВ в конечном мире, а не удачу эвристики в выборе кольца. Конкурент
   * собран зеркально игроку — та же машина, тот же водитель, то же кольцо, — и
   * единственная разница между двумя прогонами это его присутствие.
   *
   * ЧЕМ ИМЕННО ОН МЕШАЕТ. Не очередью на постах: посты считаются по компаниям
   * (postsAt в logistics/service.ts), и чужие машины в очередь игрока не встают —
   * упрощение сделано нарочно, иначе конкурент запирал бы завод наглухо, а
   * расшить это было бы нечем. Мешает он тем, что МИР КОНЕЧЕН. Мукомольный
   * выдаёт ровно столько муки, сколько успел смолоть из привезённого зерна, и
   * каждая тонна, увезённая чужой машиной, — это тонна, которой не досталось
   * игроку.
   *
   * ПОЧЕМУ МИР УЧЕБНЫЙ. Карта и километры настоящие (Москва — Смоленск по М-1,
   * 395 км), а два предприятия расставлены тестом — ровно тот же приём и по той
   * же причине, что в tick.invariant.test.ts: пары «завод плюс ненасыщаемый
   * потребитель в одном плече» на настоящей карте нет, потому что единственный
   * ненасыщаемый потребитель — Москва, а предприятий в ней нет ни одного. На
   * кольце к малому городу упирается не в конкурента, а в аппетит города:
   * Орлу нужно 0.46 тонны муки в сутки, и второй перевозчик там ничего не меняет,
   * потому что там нечего делить и одному.
   *
   * ПОЧЕМУ СОРОК СУТОК, А НЕ ДВАДЦАТЬ. На складе мельницы лежит суточный выпуск,
   * и первые недели обе машины разбирают ЗАПАС, а не текущую выработку: на
   * двадцати сутках прогоны сходятся до рубля. Дефицит начинается там, где запас
   * кончился, и меряется он только на длинной дистанции.
   */
  const DAYS = 40
  const RIVAL = COMPETITORS[0].id

  /** Кольцо с двумя гружёными плечами: зерно туда, мука обратно. */
  const RING_STOPS: Stop[] = [
    stop(MOSCOW, ['мука'], ['зерно']),
    stop(SMOLENSK, ['зерно'], ['мука']),
  ]

  /**
   * Два предприятия учебного мира.
   *
   * Запасы выведены из рецептов, а не вписаны числами: перебалансировка выпуска
   * обязана двигать их сама.
   */
  function trainingIndustries(): Record<IndustryId, Industry> {
    const elevator = RECIPE_BY_INDUSTRY['элеватор']
    const mill = RECIPE_BY_INDUSTRY['мукомольный']

    const list: Industry[] = [
      {
        id: industryId('moscow-elevator'),
        type: 'элеватор',
        cityId: MOSCOW,
        stock: { [elevator.output]: elevator.dailyRate },
        utilization: 0,
        idleTicks: 0,
      },
      {
        id: industryId('smolensk-mill'),
        type: 'мукомольный',
        cityId: SMOLENSK,
        stock: {
          [mill.output]: mill.dailyRate,
          [mill.inputs[0].type]: mill.dailyRate * mill.inputs[0].perUnit,
        },
        utilization: 0,
        idleTicks: 0,
      },
    ]

    return Object.fromEntries(list.map((it) => [it.id, it])) as Record<
      IndustryId,
      Industry
    >
  }

  function world(owners: readonly CompanyId[]): GameState {
    const base = keepOnly(createInitialState(SEED), owners)
    let next: GameState = {
      ...base,
      world: { ...base.world, industries: trainingIndustries() },
    }
    for (const owner of owners) {
      next = onRing(
        next,
        owner,
        RING_STOPS,
        owner === PLAYER_ID ? STARTER_VEHICLE_ID : starterVehicleIdOf(owner),
      )
    }
    return next
  }

  const solo = runTended(world([PLAYER_ID]), DAYS)
  const shared = runTended(world([PLAYER_ID, RIVAL]), DAYS)

  const soloTruck = solo.vehicles[STARTER_VEHICLE_ID]
  const sharedTruck = shared.vehicles[STARTER_VEHICLE_ID]
  const rivalTruck = shared.vehicles[starterVehicleIdOf(RIVAL)]

  it('кольцо кормит: в пустом мире игрок в плюсе', () => {
    // Без этого проверка ниже сравнивала бы два убытка, и «приносит меньше»
    // означало бы «тонет быстрее». Мерять конкуренцию надо на работающей сети.
    expect(solo.companies[PLAYER_ID].money).toBeGreaterThan(START_MONEY)
    expect(solo.companies[PLAYER_ID].bankrupt).toBe(false)
  })

  it('конкурент действительно работал, а не стоял в гараже', () => {
    expect(rivalTruck.odometer).toBeGreaterThan(0)
    expect(rivalTruck.loadedKm).toBeGreaterThan(0)
  })

  it('машина игрока ездила одинаково: разница не в километрах', () => {
    /*
     * Пробег в обоих прогонах совпадает с точностью до процента — расписание у
     * машины своё, чужие посты её не задерживают. Значит разница в деньгах ниже
     * это РАЗНИЦА В ВЫРУЧКЕ, а не в расходах: без этой проверки тест доказывал
     * бы лишь то, что рядом с конкурентом машина стала меньше кататься.
     */
    expect(sharedTruck.odometer).toBeGreaterThan(soloTruck.odometer * 0.95)
    expect(sharedTruck.odometer).toBeLessThan(soloTruck.odometer * 1.05)
  })

  it('рядом с конкурентом та же линия приносит МЕНЬШЕ', () => {
    const soloProfit = solo.companies[PLAYER_ID].money - START_MONEY
    const sharedProfit = shared.companies[PLAYER_ID].money - START_MONEY

    // ЭТО И ЕСТЬ КОНКУРЕНЦИЯ, ВЫРАЖЕННАЯ В РУБЛЯХ. Кольцо, расходы, машина и
    // водитель совпадают; отличается только то, что часть муки увёз чужой.
    expect(sharedProfit).toBeLessThan(soloProfit)

    // И разница не в копейках, иначе конкурент был бы декорацией: он забирает
    // не меньше четверти заработка.
    expect(soloProfit - sharedProfit).toBeGreaterThan(soloProfit * 0.25)
  })

  it('делят они именно выработку завода', () => {
    const mill = industryId('smolensk-mill')
    // Прямая улика: в одиночку игрок не успевает вывезти всё, что смолол завод,
    // и мука на складе остаётся. Вдвоём склад выметается почти дочиста — вот эти
    // тонны у игрока и отняли.
    const alone = solo.world.industries[mill].stock['мука'] ?? 0
    const together = shared.world.industries[mill].stock['мука'] ?? 0
    expect(together).toBeLessThan(alone)
  })
})

// ─── Сохранение вместе с очередями ─────────────────────────────────────────

describe('сохранение и загрузка вместе с очередями команд', () => {
  const RIVAL = COMPETITORS[0].id

  /** Партия, у которой в очереди лежат непринятые команды конкурента. */
  function withQueue(): GameState {
    const base = tickMany(createInitialState(SEED), DAY * 2)

    return queued(base, RIVAL, [
      { kind: 'нанять-водителя' },
      // Заведомо незаконная: города нет на карте. Она обязана пережить
      // сохранение и быть отброшенной ПОСЛЕ загрузки, а не потеряться по дороге —
      // иначе партия из сейва пошла бы иначе, чем незагруженная.
      { kind: 'построить', cityId: cityId('атлантида'), type: 'хаб' },
    ])
  }

  it('очередь и лента рассуждений попадают в JSON и возвращаются целыми', () => {
    const middle = withQueue()
    const loaded = JSON.parse(JSON.stringify(middle)) as GameState

    expect(loaded).not.toBe(middle)
    expect(loaded).toEqual(middle)

    const rival = loaded.companies[RIVAL]
    expect(rival.pendingCommands).toHaveLength(2)
    expect(rival.personality).toBe(COMPETITORS[0].personality)
    expect(rival.thinking.length).toBeGreaterThan(0)
    expect(rival.thinking[0].text.length).toBeGreaterThan(0)
  })

  it('загруженная партия продолжается тик в тик так же, как незагруженная', () => {
    const middle = withQueue()
    const loaded = JSON.parse(JSON.stringify(middle)) as GameState

    // Сохранение в игре — это ровно JSON.stringify состояния. Значит партия с
    // ЗАПИСАННЫМИ КОМАНДАМИ обязана воспроизводиться один в один: иначе баг
    // «после загрузки конкурент повёл себя иначе» не воспроизводится ничем.
    expect(JSON.stringify(tickMany(loaded, DAY))).toBe(
      JSON.stringify(tickMany(middle, DAY)),
    )
  })

  it('очередь разбирается на ПЕРВОМ же тике после загрузки', () => {
    const loaded = JSON.parse(JSON.stringify(withQueue())) as GameState

    const before = Object.keys(loaded.companies[RIVAL].drivers).length
    const after = tick(loaded)

    // Законная команда сработала...
    expect(Object.keys(after.companies[RIVAL].drivers).length).toBe(before + 1)
    // ...а незаконная просто исчезла, не оставив следа ни в мире, ни в очереди.
    expect(after.world.cities[cityId('атлантида')]).toBeUndefined()
    expect(after.companies[RIVAL].pendingCommands).toEqual([])
  })
})

// ─── Главный прогон ────────────────────────────────────────────────────────

describe('шестьдесят игровых суток с тремя скриптовыми конкурентами', () => {
  /*
   * ГЛАВНЫЙ ПРОГОН СРЕЗА. Настоящий мир, настоящие три конкурента, никакого
   * вмешательства снаружи: 5760 тиков, четыре компании, ни одной подпорки.
   * Проверяются не отдельные правила, а то, что мир с конкурентами ЖИВЁТ — не
   * вырождается ни в кладбище, ни в бесконечный рост, и не встаёт.
   *
   * ИГРОК В ЭТОМ ПРОГОНЕ БЕЗДЕЙСТВУЕТ, и его судьба к утверждениям ниже не
   * относится: компания, которая шестьдесят суток платит зарплату и не возит
   * ничего, обязана разориться — правило заложено ещё в срезе 3 (стартовый
   * капитал меряется сутками простоя, см. START_MONEY). Здесь важны конкуренты:
   * у них есть машина, водитель и голова, и разоряться им положено от плохих
   * решений, а не от того, что мир не даёт работать.
   */
  const DAYS = 60
  const run = runDays(createInitialState(SEED), DAYS)
  const rivals = COMPETITORS.map((spec) => run.end.companies[spec.id])

  /** Короткая сводка по компании — она же текст падения, если тест покраснеет. */
  const summary = (company: Company): string => {
    const fleet = fleetOf(run.end, company.id)
    const km = fleet.reduce((sum, v) => sum + v.odometer, 0)
    return [
      company.id,
      `деньги ${Math.round(company.money)}`,
      `банкрот ${company.bankrupt}`,
      `линий ${Object.keys(company.lines).length}`,
      `парк ${fleet.length}`,
      `пробег ${Math.round(km)} км`,
    ].join(', ')
  }

  it('состояние остаётся исправным весь прогон', () => {
    expect(run.broken).toEqual([])
    expect(run.end.tick).toBe(DAY * DAYS)
  })

  it('конкуренты действительно играли: сеть, парк и пробег', () => {
    for (const rival of rivals) {
      // Построил хоть одно кольцо — без сети остальное бессмысленно.
      expect(Object.keys(rival.lines).length, summary(rival)).toBeGreaterThan(0)

      const fleet = fleetOf(run.end, rival.id)
      expect(fleet.length, summary(rival)).toBeGreaterThan(0)

      // Машины ездят: конкурент, чей парк за два месяца не сдвинулся, — это
      // декорация на карте, а не соперник.
      const km = fleet.reduce((sum, v) => sum + v.odometer, 0)
      expect(km, summary(rival)).toBeGreaterThan(0)
    }
  })

  it('никто не разорился на ровном месте', () => {
    // Разорение не запрещено: плохая сеть обязана убивать. Запрещено разорение
    // ВСЕХ СРАЗУ — это уже не проигрыш трёх стратегий, а мир, в котором нельзя
    // работать.
    const alive = rivals.filter((rival) => !rival.bankrupt)
    expect(alive.length, rivals.map(summary).join(' | ')).toBe(rivals.length)
  })

  it('никто не растёт бесконечно', () => {
    for (const rival of rivals) {
      /*
       * Потолок нарочно щедрый: он ловит не «слишком успешного» конкурента, а
       * ПЕЧАТНЫЙ СТАНОК — команду, приносящую деньги из ниоткуда, или кольцо,
       * оплаченное дважды. Двадцать стартовых капиталов за два месяца на
       * стартовом парке физически недостижимы.
       */
      expect(rival.money, summary(rival)).toBeLessThan(START_MONEY * 20)
      // И парк не размножается: покупка стоит денег, а денег конечное число.
      expect(fleetOf(run.end, rival.id).length, summary(rival)).toBeLessThan(20)
    }
  })

  /**
   * ЧТО ЗНАЧИТ «МИР НЕ ВСТАЛ» НА САМОМ ДЕЛЕ.
   *
   * Первая версия этого теста требовала, чтобы работало хоть одно предприятие
   * и чтобы хоть у одного города был ненулевой склад. Оба утверждения
   * оказались неверными — не потому, что игра сломана, а потому, что они
   * меряли не то. Разбор занял отдельный заход и стоит того, чтобы его
   * записать.
   *
   * Замер на 25 сутках: ВСЕ десять предприятий стоят с полными складами
   * готовой продукции (зерно 180/180, кругляк 150/150, нефть 240/240,
   * топливо 195/195). Выглядит как мёртвый мир. На деле это ровно то
   * поведение, ради которого срез 2 и делался: предприятие задыхается, если
   * его продукцию не вывозят. Три конкурента обслуживают ОДНУ цепочку из
   * шести, остальные пять никто не трогает — и они честно встают.
   *
   * Города же пусты по обратной причине: поставки съедаются в тот же тик.
   * Москва потребляет 66 тонн топлива в сутки, а три ЗИЛа на кольце длиной
   * 1320 км привозят около восьми. Мгновенный остаток склада при таком
   * соотношении всегда ноль, сколько бы ни возили.
   *
   * Мир не встал — он НЕДООБСЛУЖЕН, и это правильное состояние для трёх
   * маленьких грузовиков на десять предприятий. Поэтому тест меряет теперь
   * не остатки, а РАБОТУ: обслуживаемая цепочка жива, конкуренты возят
   * гружёными и зарабатывают.
   */
  it('мир не встал: обслуживаемая цепочка жива, а не забита', () => {
    const industries = Object.values(run.end.world.industries)

    // Простой обслуживаемых предприятий на порядок меньше, чем брошенных.
    // Это и есть «мир живой»: разница между тем, куда ездят, и тем, куда нет.
    const idle = industries.map((it) => it.idleTicks).sort((a, b) => a - b)
    expect(idle[0], 'самое загруженное предприятие работало недавно').toBeLessThan(
      idle[idle.length - 1] / 10,
    )
  })

  it('конкуренты возят гружёными, а не катаются порожняком', () => {
    const rivals = Object.values(run.end.companies).filter(
      (c) => c.controller !== 'человек',
    )

    for (const rival of rivals) {
      const fleet = Object.values(run.end.vehicles).filter(
        (v) => v.ownerId === rival.id,
      )
      const loaded = fleet.reduce((sum, v) => sum + v.loadedKm, 0)
      const empty = fleet.reduce((sum, v) => sum + v.emptyKm, 0)

      expect(loaded, `${rival.name} возил груз`).toBeGreaterThan(0)
      // И порожний пробег у него не больше гружёного: кольцо построено
      // осмысленно, а не «съездил туда, вернулся пустым».
      expect(empty, `${rival.name}: порожний пробег`).toBeLessThan(loaded * 1.5)
    }
  })

  it('прогон детерминирован: два запуска дают один JSON', () => {
    expect(JSON.stringify(tickMany(createInitialState(SEED), DAY * DAYS))).toBe(
      JSON.stringify(run.end),
    )
  })
})
