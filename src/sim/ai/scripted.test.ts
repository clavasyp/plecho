import { describe, expect, it } from 'vitest'
import { BUILDING_SPEC } from '../../data/infrastructure'
import { DRIVER_WAGE_PER_DAY } from '../../data/operating'
import { RECIPE_BY_INDUSTRY } from '../../data/recipes'
import { TRAILER_PRICE, VEHICLE_CLASSES } from '../../data/vehicles'
import { CARGO_LICENSE } from '../logistics/driver'
import { MIN_LINE_STOPS } from '../logistics/line'
import { TRAILER_TYPES, canCarry } from '../logistics/trailer'
import { SERVICE_INTERVAL_KM } from '../logistics/wear'
import {
  PLAYER_ID,
  STARTER_VEHICLE_ID,
  createInitialState,
  createVehicle,
} from '../state'
import {
  companyId as toCompanyId,
  driverId as toDriverId,
  lineId as toLineId,
  vehicleId as toVehicleId,
} from '../types'
import type {
  CargoType,
  CityId,
  Command,
  Company,
  CompanyId,
  CompetitorPersonality,
  Driver,
  DriverId,
  DriverLicense,
  GameState,
  Line,
  LineId,
  Stop,
  TrailerType,
  Vehicle,
  VehicleId,
} from '../types'
import { isLegal } from './commands'
import {
  LICENCE_RESERVE,
  MAX_FLEET_PER_LINE,
  QUEUE_PATIENCE_TICKS,
  RESERVE_DAYS,
  RESERVE_DAYS_BASE,
  scriptedCommands,
  scriptedThought,
  sinkPerDay,
} from './scripted'

/**
 * Скриптовый конкурент проверяется по требованиям среза, и первые два —
 * содержательные, а не технические.
 *
 *   КОЛЬЦО С ДВУМЯ ГРУЖЁНЫМИ ПЛЕЧАМИ. Это главная механика игры. Конкурент,
 *   который её не понимает, не соперник, а декорация: он ездил бы наполовину
 *   порожняком и разорился бы сам, без всякого участия игрока.
 *
 *   ПОКУПКА ТОЛЬКО ПРИ ДЕНЬГАХ И ПРИ РАБОТЕ. Скупающий технику впрок разоряется
 *   так же тихо и так же быстро.
 *
 * Отдельная группа проверяет то, что дороже всего обошлось на прогонах и чего
 * не видно из формул: конкурент не везёт груз туда, где его не съедят, и не
 * оставляет сломанную машину на кольце. Оба дефекта банкротили контору за сорок
 * суток, и оба выглядели как «почему-то нет выручки при идеальных метриках».
 *
 * Числа в тесте не пишутся руками: пороги берутся из тех же констант, по
 * которым живёт сама эвристика.
 */

/**
 * Сид мира. Любой — мир на старте от сида не зависит (разброс начинается с
 * первого тика), но записать его явно дешевле, чем объяснять это в каждом тесте.
 */
const SEED = 20260808

const RIVAL: CompanyId = toCompanyId('rival')

/**
 * Заведомо достаточные деньги: полный парк самой дорогой техники с прицепами,
 * хаб и запас наличности сверху. Выводится из справочников, а не пишется
 * миллионом: подорожает техника — порог поедет за ней.
 */
const RICH =
  (Math.max(...VEHICLE_CLASSES.map((vc) => vc.price)) +
    Math.max(...Object.values(TRAILER_PRICE))) *
    MAX_FLEET_PER_LINE +
  BUILDING_SPEC.хаб.price +
  DRIVER_WAGE_PER_DAY * RESERVE_DAYS_BASE * 2 * MAX_FLEET_PER_LINE

/** Самый дешёвый класс справочника — по нему считается порог «денег нет». */
const CHEAPEST = VEHICLE_CLASSES.reduce((a, b) => (b.price < a.price ? b : a))

/** Все допуски мира: с ними водитель возьмёт любой груз. */
const ALL_LICENSES: DriverLicense[] = Object.values(CARGO_LICENSE).filter(
  (license): license is DriverLicense => license !== undefined,
)

// ─── Фикстуры ──────────────────────────────────────────────────────────────

function makeCompany(
  id: CompanyId,
  personality: CompetitorPersonality | null,
  money: number,
): Company {
  return {
    id,
    name: `ТОО «${id}»`,
    money,
    controller: 'скрипт',
    lines: {},
    drivers: {},
    buildings: {},
    personality,
    pendingCommands: [],
    thinking: [],
    dailyRevenue: 0,
    dailyCosts: 0,
    bankrupt: false,
    daysInDebt: 0,
  }
}

function withCompany(state: GameState, company: Company): GameState {
  return {
    ...state,
    companies: { ...state.companies, [company.id]: company },
  }
}

function companyOf(state: GameState, id: CompanyId): Company {
  const company = state.companies[id]
  if (company === undefined) throw new Error(`нет компании ${id}`)
  return company
}

/** Мир со свежим конкурентом заданного характера. */
function worldWithRival(
  personality: CompetitorPersonality,
  money: number = RICH,
): GameState {
  return withCompany(
    createInitialState(SEED),
    makeCompany(RIVAL, personality, money),
  )
}

/** Завести компании линию — так же, как это сделала бы фаза команд. */
function addLine(
  state: GameState,
  companyId: CompanyId,
  name: string,
  stops: readonly Stop[],
): { state: GameState; lineId: LineId } {
  const company = companyOf(state, companyId)
  const id = toLineId(
    `${companyId}-line-${Object.keys(company.lines).length + 1}`,
  )

  const line: Line = {
    id,
    name,
    stops: copyStops(stops),
    assignedVehicles: [],
  }

  return {
    state: withCompany(state, {
      ...company,
      lines: { ...company.lines, [id]: line },
    }),
    lineId: id,
  }
}

/** Добавить компании машину в город. Прицеп и водитель — по желанию. */
function addVehicle(
  state: GameState,
  companyId: CompanyId,
  at: CityId,
  options: {
    id?: string
    classId?: string
    trailer?: TrailerType | null
    driverId?: DriverId | null
    lineId?: LineId | null
    queuedTicks?: number
    kmSinceService?: number
    brokenDown?: boolean
  } = {},
): GameState {
  const classId = options.classId ?? CHEAPEST.id
  const id: VehicleId = toVehicleId(
    options.id ??
      `${companyId}-${classId}-${Object.keys(state.vehicles).length + 1}`,
  )

  const vehicle: Vehicle = {
    ...createVehicle(id, companyId, at, classId, options.trailer ?? null),
    driverId: options.driverId ?? null,
    lineId: options.lineId ?? null,
    queuedTicks: options.queuedTicks ?? 0,
    kmSinceService: options.kmSinceService ?? 0,
    brokenDown: options.brokenDown ?? false,
  }

  return { ...state, vehicles: { ...state.vehicles, [id]: vehicle } }
}

/** Добавить компании водителя. Допуски задаются явно — найм тут ни при чём. */
function addDriver(
  state: GameState,
  companyId: CompanyId,
  options: {
    id?: string
    licenses?: DriverLicense[]
    vehicleId?: VehicleId | null
  } = {},
): GameState {
  const company = companyOf(state, companyId)
  const id: DriverId = toDriverId(
    options.id ?? `${companyId}-drv-${Object.keys(company.drivers).length + 1}`,
  )

  const driver: Driver = {
    id,
    name: `Водитель ${id}`,
    employerId: companyId,
    vehicleId: options.vehicleId ?? null,
    skill: 0.5,
    licenses: options.licenses ?? ALL_LICENSES,
    fatigue: 0,
    hoursOnDuty: 0,
    wagePerDay: DRIVER_WAGE_PER_DAY,
    loyalty: 0.5,
  }

  return withCompany(state, {
    ...company,
    drivers: { ...company.drivers, [id]: driver },
  })
}

function copyStops(stops: readonly Stop[]): Stop[] {
  return stops.map((stop) => ({
    nodeId: stop.nodeId,
    unload: [...stop.unload],
    load: [...stop.load],
  }))
}

/** Единственная команда решения — с проверкой, что она именно такая. */
function onlyCommand(commands: readonly Command[]): Command {
  expect(commands).toHaveLength(1)
  return commands[0]
}

function createdLine(commands: readonly Command[]): {
  name: string
  stops: Stop[]
} {
  const command = onlyCommand(commands)
  if (command.kind !== 'создать-линию') {
    throw new Error(`ожидалась «создать-линию», пришла «${command.kind}»`)
  }
  return { name: command.name, stops: command.stops }
}

/**
 * Сколько плеч кольца машина проходит гружёной.
 *
 * Кольцо проходится ДВАЖДЫ: первый круг набирает груз, второй считает. Машина
 * ходит по кольцу бесконечно, и «первое» плечо ничем не отличается от прочих —
 * считать с пустого кузова значило бы приписать кольцу лишний порожний прогон,
 * которого в работе нет.
 *
 * Кузов ОДИН (Vehicle.cargo в types.ts), поэтому и модель здесь однокузовная:
 * пока в машине лежит груз, новый она не берёт.
 */
function loadedLegs(stops: readonly Stop[]): number {
  let cargo: CargoType | null = null
  let loaded = 0

  for (let round = 0; round < 2; round++) {
    for (const stop of stops) {
      if (cargo !== null && stop.unload.includes(cargo)) cargo = null
      if (cargo === null && stop.load.length > 0) cargo = stop.load[0]
      if (round === 1 && cargo !== null) loaded++
    }
  }

  return loaded
}

/** Кузов, которым берутся все грузы этих остановок. */
function trailerFor(stops: readonly Stop[]): TrailerType {
  const cargoes: CargoType[] = []
  for (const stop of stops) {
    for (const cargo of stop.load) {
      if (!cargoes.includes(cargo)) cargoes.push(cargo)
    }
  }

  const found = TRAILER_TYPES.find((trailer) =>
    cargoes.every((cargo) => canCarry(trailer, cargo)),
  )
  if (found === undefined) throw new Error('нет кузова под грузы кольца')
  return found
}

/** Кольцо, которое конкурент строит в нетронутом мире. */
function firstPlan(personality: CompetitorPersonality = 'агрессивный'): {
  name: string
  stops: Stop[]
} {
  return createdLine(scriptedCommands(worldWithRival(personality), RIVAL))
}

/**
 * Готовая контора: линия, водитель со всеми допусками и одна машина под кузов
 * кольца. Дальше тесты доводят её до нужного положения.
 */
function readyCompany(
  personality: CompetitorPersonality,
  money: number = RICH,
  vehicle: Parameters<typeof addVehicle>[3] = {},
): { state: GameState; lineId: LineId; stops: Stop[] } {
  const plan = firstPlan()
  const base = withCompany(
    createInitialState(SEED),
    makeCompany(RIVAL, personality, money),
  )

  const { state: withLine, lineId } = addLine(base, RIVAL, plan.name, plan.stops)
  // Связь водителя и машины ДВУСТОРОННЯЯ, как в сторе и в фазе команд: машина
  // помнит, кто за рулём, водитель — за какой машиной закреплён.
  const withDriver = addDriver(withLine, RIVAL, {
    id: 'rival-drv-1',
    vehicleId: toVehicleId('rival-truck-1'),
  })

  const state = addVehicle(withDriver, RIVAL, plan.stops[0].nodeId, {
    id: 'rival-truck-1',
    trailer: trailerFor(plan.stops),
    driverId: toDriverId('rival-drv-1'),
    lineId,
    ...vehicle,
  })

  return { state, lineId, stops: plan.stops }
}

/**
 * Мир, в котором игрок уже работает на своём кольце и по нему реально ездит.
 *
 * Нужен трём тестам сразу: агрессивный лезет в эти города, осторожный их
 * обходит, имитатор копирует линию — а копирует он только ту, на которой стоят
 * машины (задержка выражена условием, а не таймером).
 */
function worldWithPlayerLine(): {
  state: GameState
  stops: Stop[]
  cities: CityId[]
} {
  // Кольцо игрока берётся то же, какое построил бы нейтральный конкурент, —
  // то есть самое выгодное в мире. Так тест не зависит от географии данных.
  const plan = firstPlan('осторожный')

  /*
   * ОСТАНОВКИ РАЗВЁРНУТЫ, И ЭТО НЕ КОСМЕТИКА. Кольцо остаётся тем же самым, но
   * проходится в другую сторону, а значит ОТЛИЧАЕТСЯ от того, которое конкурент
   * построил бы сам (свои кольца он всегда строит «источник → переработка →
   * сбыт»). Без разворота проверить имитатора нельзя: его копия совпадала бы с
   * его же собственным замыслом, и тест подтверждал бы копирование там, где его
   * нет.
   */
  const stops = [...plan.stops].reverse()

  const empty = createInitialState(SEED)
  const { state, lineId } = addLine(empty, PLAYER_ID, 'Кольцо игрока', stops)

  // Машина игрока СТОИТ НА ЛИНИИ: именно это имитатор и считает признаком
  // работающего маршрута.
  const player = companyOf(state, PLAYER_ID)
  const withVehicle: GameState = {
    ...state,
    vehicles: {
      ...state.vehicles,
      [STARTER_VEHICLE_ID]: { ...state.vehicles[STARTER_VEHICLE_ID], lineId },
    },
    companies: {
      ...state.companies,
      [PLAYER_ID]: {
        ...player,
        lines: {
          ...player.lines,
          [lineId]: {
            ...player.lines[lineId],
            assignedVehicles: [STARTER_VEHICLE_ID],
          },
        },
      },
    },
  }

  return {
    state: withVehicle,
    stops,
    cities: stops.map((stop) => stop.nodeId),
  }
}

/** Мир с конкурентом заданного характера рядом с работающим игроком. */
function besidePlayer(personality: CompetitorPersonality): GameState {
  return withCompany(
    worldWithPlayerLine().state,
    makeCompany(RIVAL, personality, RICH),
  )
}

/** Заморозить состояние насквозь — любая мутация станет исключением. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return Object.freeze(value)
}

const PERSONALITIES: CompetitorPersonality[] = [
  'агрессивный',
  'осторожный',
  'нишевый',
  'имитатор',
]

// ─── Кольцо ────────────────────────────────────────────────────────────────

describe('скриптовый конкурент строит кольцо', () => {
  it('первое решение — линия, и в ней ровно два гружёных плеча', () => {
    const { stops } = firstPlan('осторожный')

    expect(stops.length).toBeGreaterThanOrEqual(MIN_LINE_STOPS)

    const loaded = loadedLegs(stops)
    expect(loaded).toBe(2)
    // Гружёных плеч больше, чем порожних: кольцо с ОДНИМ гружёным плечом
    // убыточно по главному инварианту игры, и строить его конкурент не вправе.
    expect(loaded).toBeGreaterThan(stops.length - loaded)
  })

  it('кольцо стоит на настоящей цепочке: сырьё туда, продукция обратно', () => {
    const state = worldWithRival('осторожный')
    const { stops } = createdLine(scriptedCommands(state, RIVAL))

    const [source, works] = stops
    const raw = source.load[0]
    const product = works.load[0]

    const industriesIn = (cityId: CityId) =>
      Object.values(state.world.industries).filter((i) => i.cityId === cityId)

    // Сырьё действительно выпускают в первом городе…
    expect(
      industriesIn(source.nodeId).some(
        (i) => RECIPE_BY_INDUSTRY[i.type]?.output === raw,
      ),
    ).toBe(true)

    // …а во втором его перерабатывают ровно в тот груз, который поедет дальше.
    expect(
      industriesIn(works.nodeId).some((i) => {
        const recipe = RECIPE_BY_INDUSTRY[i.type]
        return (
          recipe !== undefined &&
          recipe.output === product &&
          recipe.inputs.some((input) => input.type === raw)
        )
      }),
    ).toBe(true)

    // И оба груза везёт ОДНА машина: иначе кольцо распадается на два рейса.
    expect(
      TRAILER_TYPES.some(
        (trailer) => canCarry(trailer, raw) && canCarry(trailer, product),
      ),
    ).toBe(true)
  })

  it('предприятия кольца стоят в разных городах — иначе машина не нужна', () => {
    const { stops } = firstPlan('агрессивный')
    expect(stops[0].nodeId).not.toBe(stops[1].nodeId)
  })

  it('не везёт туда, где груз не съедают', () => {
    /*
     * САМЫЙ ДОРОГОЙ ДЕФЕКТ ПЕРВОГО ПРОГОНА. Кольцо «Орёл ↔ Тула» выглядит
     * идеальным: оба плеча гружёные, порожнего пробега ноль. Но муку в Орле
     * съедают 0.46 тонны в сутки, а машина привозит шесть за оборот — через два
     * рейса город полон, кузов занят неразгружаемым грузом, и сеть встаёт
     * навсегда при безупречных метриках.
     *
     * Поэтому порог — не «спрос больше нуля», а «спрос больше кузова»: точка
     * выгрузки обязана съедать хотя бы то, что привозит одна ходка самой мелкой
     * машины справочника.
     */
    const state = worldWithRival('осторожный')
    const { stops } = createdLine(scriptedCommands(state, RIVAL))

    for (const stop of stops) {
      for (const cargo of stop.unload) {
        expect(
          sinkPerDay(state, stop.nodeId, cargo),
          `${stop.nodeId} не съедает ${cargo}`,
        ).toBeGreaterThanOrEqual(CHEAPEST.capacity)
      }
    }
  })
})

// ─── Деньги и работа ───────────────────────────────────────────────────────

describe('скриптовый конкурент не покупает машины зря', () => {
  it('без линии не покупает даже с полным счётом', () => {
    const commands = scriptedCommands(worldWithRival('агрессивный', RICH), RIVAL)

    expect(commands.map((c) => c.kind)).not.toContain('купить-машину')
    // Первым делом заводится кольцо: работа появляется раньше техники.
    expect(onlyCommand(commands).kind).toBe('создать-линию')
  })

  it('с линией, но без денег не покупает', () => {
    const plan = firstPlan()
    // Денег ровно на самый дешёвый тягач — то есть не хватает ни на прицеп, ни
    // на запас наличности. Значит покупки быть не должно.
    const poor = withCompany(
      createInitialState(SEED),
      makeCompany(RIVAL, 'агрессивный', CHEAPEST.price),
    )
    const withDriver = addDriver(poor, RIVAL, { id: 'rival-drv-1' })
    const { state } = addLine(withDriver, RIVAL, plan.name, plan.stops)

    expect(scriptedCommands(state, RIVAL).map((c) => c.kind)).not.toContain(
      'купить-машину',
    )
  })

  it('с линией, деньгами и допуском — покупает', () => {
    const plan = firstPlan()
    const rich = worldWithRival('агрессивный', RICH)
    const withDriver = addDriver(rich, RIVAL, { id: 'rival-drv-1' })
    const { state } = addLine(withDriver, RIVAL, plan.name, plan.stops)

    expect(onlyCommand(scriptedCommands(state, RIVAL)).kind).toBe(
      'купить-машину',
    )
  })

  it('не берёт машину под груз, который некому везти', () => {
    // Тот же мир, но водитель без допусков: цистерна поедет порожней, а платить
    // за неё придётся полностью.
    const plan = firstPlan()
    const rich = worldWithRival('агрессивный', RICH)
    const withDriver = addDriver(rich, RIVAL, {
      id: 'rival-drv-1',
      licenses: [],
    })
    const { state } = addLine(withDriver, RIVAL, plan.name, plan.stops)

    const kinds = scriptedCommands(state, RIVAL).map((c) => c.kind)
    // Груз кольца требует допуска — проверяем, что тест не выродился.
    const needs = plan.stops
      .flatMap((stop) => stop.load)
      .some((cargo) => CARGO_LICENSE[cargo] !== undefined)
    expect(needs).toBe(true)

    expect(kinds).not.toContain('купить-машину')
  })

  it('не докупает технику, пока своя стоит без водителя', () => {
    const plan = firstPlan()
    const rich = worldWithRival('агрессивный', RICH)
    const withDriver = addDriver(rich, RIVAL, { id: 'rival-drv-1' })
    const { state: withLine, lineId } = addLine(
      withDriver,
      RIVAL,
      plan.name,
      plan.stops,
    )

    // Две машины: одна укомплектована, вторая стоит без человека.
    const one = addVehicle(withLine, RIVAL, plan.stops[0].nodeId, {
      id: 'rival-truck-1',
      trailer: trailerFor(plan.stops),
      driverId: toDriverId('rival-drv-1'),
      lineId,
    })
    const state = addVehicle(one, RIVAL, plan.stops[0].nodeId, {
      id: 'rival-truck-2',
      trailer: trailerFor(plan.stops),
      lineId,
    })

    const kinds = scriptedCommands(state, RIVAL).map((c) => c.kind)
    expect(kinds).not.toContain('купить-машину')
    expect(kinds).toContain('нанять-водителя')
  })

  it('банкрот не распоряжается ничем', () => {
    const state = worldWithRival('агрессивный', RICH)
    const broke = withCompany(state, {
      ...companyOf(state, RIVAL),
      bankrupt: true,
    })

    expect(scriptedCommands(broke, RIVAL)).toEqual([])
    expect(scriptedThought(broke, RIVAL).length).toBeGreaterThan(0)
  })

  it('не пополняет очередь, пока прежние распоряжения не разобраны', () => {
    const state = worldWithRival('агрессивный', RICH)
    const busy = withCompany(state, {
      ...companyOf(state, RIVAL),
      pendingCommands: [{ kind: 'нанять-водителя' }],
    })

    expect(scriptedCommands(busy, RIVAL)).toEqual([])
  })
})

// ─── Комплектование, поломка, терминал ─────────────────────────────────────

describe('скриптовый конкурент доводит кольцо до работы', () => {
  it('сажает водителя за машину и выводит её на линию', () => {
    const plan = firstPlan()
    const rich = worldWithRival('агрессивный', RICH)
    const withDriver = addDriver(rich, RIVAL, { id: 'rival-drv-1' })
    const { state: withLine, lineId } = addLine(
      withDriver,
      RIVAL,
      plan.name,
      plan.stops,
    )
    const state = addVehicle(withLine, RIVAL, plan.stops[0].nodeId, {
      id: 'rival-truck-1',
      trailer: trailerFor(plan.stops),
    })

    const commands = scriptedCommands(state, RIVAL)
    const kinds = commands.map((c) => c.kind)

    expect(kinds).toContain('посадить-водителя')
    expect(kinds).toContain('назначить-машину')

    const assign = commands.find((c) => c.kind === 'назначить-машину')
    if (assign?.kind !== 'назначить-машину') throw new Error('нет назначения')
    expect(assign.lineId).toBe(lineId)
  })

  it('сажает водителя С ДОПУСКОМ, если такой есть', () => {
    const plan = firstPlan()
    const rich = worldWithRival('осторожный', RICH)
    const noLicense = addDriver(rich, RIVAL, {
      id: 'rival-drv-plain',
      licenses: [],
    })
    const licensed = addDriver(noLicense, RIVAL, { id: 'rival-drv-licensed' })

    const { state: withLine, lineId } = addLine(
      licensed,
      RIVAL,
      plan.name,
      plan.stops,
    )
    const state = addVehicle(withLine, RIVAL, plan.stops[0].nodeId, {
      id: 'rival-truck-1',
      trailer: trailerFor(plan.stops),
      lineId,
    })

    const seat = scriptedCommands(state, RIVAL).find(
      (c) => c.kind === 'посадить-водителя',
    )
    if (seat?.kind !== 'посадить-водителя') throw new Error('никого не посадили')

    const driver = companyOf(state, RIVAL).drivers[seat.driverId]
    for (const cargo of plan.stops.flatMap((stop) => stop.load)) {
      const need = CARGO_LICENSE[cargo]
      if (need !== undefined) expect(driver.licenses).toContain(need)
    }
  })

  it('чинит сломанную машину — она держит всё кольцо', () => {
    const { state, stops } = readyCompany('агрессивный', RICH, {
      brokenDown: true,
    })

    const commands = scriptedCommands(state, RIVAL)
    const fix = commands.find((c) => c.kind === 'починить')
    if (fix?.kind !== 'починить') throw new Error('машину не починили')

    expect(fix.vehicleId).toBe(toVehicleId('rival-truck-1'))

    /*
     * Машина ОСТАЁТСЯ на линии, и это изменение против первой версии.
     *
     * Раньше команды ремонта в контракте не было, конкурент умел только
     * списывать, и первая же поломка убивала его навсегда: замер ревизии —
     * все трое ломались на 50–60-е сутки и дальше платили зарплату до
     * банкротства. Теперь он чинит, а снимать с линии и возвращать одним
     * пакетом нельзя: каждая команда проверяется на законность отдельно, и
     * «вернуть на ту же линию» законно лишь после того, как её сняли.
     */
    expect(commands.map((c) => c.kind)).not.toContain('назначить-машину')
    expect(stops.length).toBeGreaterThanOrEqual(MIN_LINE_STOPS)
  })

  it('ставит терминал там, где его машины стоят в очереди', () => {
    const { state, stops } = readyCompany('агрессивный', RICH, {
      // Ровно порог терпения: меньше — разовая очередь, за неё терминал не берут.
      queuedTicks: QUEUE_PATIENCE_TICKS,
    })

    const command = scriptedCommands(state, RIVAL).find(
      (c) => c.kind === 'построить',
    )
    if (command?.kind !== 'построить') throw new Error('терминал не заказан')

    expect(command.type).toBe('терминал')
    expect(command.cityId).toBe(stops[0].nodeId)
  })

  it('без очереди терминал не строит', () => {
    const { state } = readyCompany('агрессивный', RICH, {
      queuedTicks: QUEUE_PATIENCE_TICKS - 1,
    })

    expect(scriptedCommands(state, RIVAL).map((c) => c.kind)).not.toContain(
      'построить',
    )
  })

  it('загоняет на ТО машину, перехаживающую регламент', () => {
    const { state } = readyCompany('агрессивный', RICH, {
      kmSinceService: SERVICE_INTERVAL_KM,
    })

    expect(scriptedCommands(state, RIVAL)[0].kind).toBe('обслужить')
  })

  it('отпускает лишнего водителя, когда работы на всех нет', () => {
    const { state } = readyCompany('осторожный', 0)
    // Денег нет, машина одна и укомплектована — второй человек в резерве это
    // чистый расход.
    const withSpare = addDriver(state, RIVAL, { id: 'rival-drv-2' })

    const command = onlyCommand(scriptedCommands(withSpare, RIVAL))
    expect(command.kind).toBe('уволить-водителя')
    if (command.kind !== 'уволить-водителя') return
    expect(command.driverId).toBe(toDriverId('rival-drv-2'))
  })

  it('держит в резерве не больше одного человека при поиске допуска', () => {
    // Ищем допуск: своих людей нет вовсе, значит наём — но ровно один.
    const plan = firstPlan()
    const rich = worldWithRival('осторожный', RICH)
    const { state } = addLine(rich, RIVAL, plan.name, plan.stops)

    expect(onlyCommand(scriptedCommands(state, RIVAL)).kind).toBe(
      'нанять-водителя',
    )

    // Взяли человека без допуска — с ним кольцо не поедет, отпускаем и ищем
    // следующего. Держать больше LICENCE_RESERVE конкурент не станет.
    const useless = addDriver(state, RIVAL, {
      id: 'rival-drv-1',
      licenses: [],
    })
    expect(LICENCE_RESERVE).toBe(1)
    expect(onlyCommand(scriptedCommands(useless, RIVAL)).kind).toBe(
      'уволить-водителя',
    )
  })
})

// ─── Характеры ─────────────────────────────────────────────────────────────

describe('характер меняет решение на одном и том же мире', () => {
  /** Города, которые кольцо ЗАНИМАЕТ: источник и переработка. Сбыт общий. */
  const claimed = (stops: readonly Stop[]) =>
    stops.slice(0, 2).map((stop) => stop.nodeId)

  it('агрессивный идёт в города игрока, осторожный их обходит', () => {
    const player = new Set(worldWithPlayerLine().cities)

    const aggressive = createdLine(
      scriptedCommands(besidePlayer('агрессивный'), RIVAL),
    )
    const careful = createdLine(
      scriptedCommands(besidePlayer('осторожный'), RIVAL),
    )

    expect(claimed(aggressive.stops).some((city) => player.has(city))).toBe(true)
    expect(claimed(careful.stops).some((city) => player.has(city))).toBe(false)
  })

  it('имитатор повторяет линию игрока остановка в остановку', () => {
    const world = worldWithPlayerLine()
    const copy = createdLine(scriptedCommands(besidePlayer('имитатор'), RIVAL))

    expect(copy.stops.map((stop) => stop.nodeId)).toEqual(
      world.stops.map((stop) => stop.nodeId),
    )
  })

  it('имитатор не копирует линию, по которой ещё никто не ездит', () => {
    const world = worldWithPlayerLine()

    // Снимаем машину игрока с линии: маршрут начерчен, но не обкатан.
    const idle: GameState = {
      ...world.state,
      vehicles: {
        ...world.state.vehicles,
        [STARTER_VEHICLE_ID]: {
          ...world.state.vehicles[STARTER_VEHICLE_ID],
          lineId: null,
        },
      },
    }

    const own = createdLine(
      scriptedCommands(
        withCompany(idle, makeCompany(RIVAL, 'имитатор', RICH)),
        RIVAL,
      ),
    )

    expect(own.stops.map((stop) => stop.nodeId)).not.toEqual(
      world.stops.map((stop) => stop.nodeId),
    )
  })

  it('нишевый держится одного груза и не меняет его от достатка', () => {
    const poor = withCompany(
      createInitialState(SEED),
      makeCompany(RIVAL, 'нишевый', CHEAPEST.price),
    )
    const rich = withCompany(
      createInitialState(SEED),
      makeCompany(RIVAL, 'нишевый', RICH),
    )

    expect(createdLine(scriptedCommands(rich, RIVAL)).stops).toEqual(
      createdLine(scriptedCommands(poor, RIVAL)).stops,
    )
  })

  it('четыре характера дают не одно решение на четверых', () => {
    const decisions = PERSONALITIES.map((personality) =>
      JSON.stringify(scriptedCommands(besidePlayer(personality), RIVAL)),
    )

    expect(new Set(decisions).size).toBeGreaterThan(1)
  })

  it('осторожный держит запас больше агрессивного — и потому тратит позже', () => {
    // Разница характеров выражена запасом наличности, и порядок величин
    // проверяется прямо на константах: иначе «осторожный» остался бы словом.
    expect(RESERVE_DAYS.осторожный).toBeGreaterThan(RESERVE_DAYS.агрессивный)

    const plan = firstPlan()
    // Денег хватает на машину с прицепом и на недельный запас, но не на две
    // недели: агрессивный купит, осторожный воздержится.
    const money =
      CHEAPEST.price +
      TRAILER_PRICE[trailerFor(plan.stops)] +
      DRIVER_WAGE_PER_DAY * RESERVE_DAYS_BASE

    const forPersonality = (personality: CompetitorPersonality) => {
      const base = withCompany(
        createInitialState(SEED),
        makeCompany(RIVAL, personality, money),
      )
      const withDriver = addDriver(base, RIVAL, { id: 'rival-drv-1' })
      const { state } = addLine(withDriver, RIVAL, plan.name, plan.stops)
      return scriptedCommands(state, RIVAL).map((c) => c.kind)
    }

    expect(forPersonality('агрессивный')).toContain('купить-машину')
    expect(forPersonality('осторожный')).not.toContain('купить-машину')
  })
})

// ─── Детерминизм ───────────────────────────────────────────────────────────

describe('детерминизм', () => {
  it.each(PERSONALITIES)('%s: одно состояние — одно решение', (personality) => {
    const state = besidePlayer(personality)

    expect(scriptedCommands(state, RIVAL)).toEqual(
      scriptedCommands(state, RIVAL),
    )
    expect(scriptedThought(state, RIVAL)).toBe(scriptedThought(state, RIVAL))
  })

  it.each(PERSONALITIES)(
    '%s: состояние из сохранения решает так же',
    (personality) => {
      const state = besidePlayer(personality)
      // Сохранение — это JSON состояния и ничего больше (см. шапку types.ts).
      const loaded: GameState = JSON.parse(JSON.stringify(state))

      expect(scriptedCommands(loaded, RIVAL)).toEqual(
        scriptedCommands(state, RIVAL),
      )
      expect(scriptedThought(loaded, RIVAL)).toBe(scriptedThought(state, RIVAL))
    },
  )
})

// ─── Законность ────────────────────────────────────────────────────────────

describe('конкурент не выдаёт незаконных команд', () => {
  /** Набор положений, в которых конкурент принимает разные решения. */
  function scenarios(personality: CompetitorPersonality): GameState[] {
    const plan = firstPlan()
    const trailer = trailerFor(plan.stops)
    const city = plan.stops[0].nodeId

    const fresh = worldWithRival(personality, RICH)
    const { state: withLine, lineId } = addLine(
      addDriver(fresh, RIVAL, { id: 'rival-drv-1' }),
      RIVAL,
      plan.name,
      plan.stops,
    )

    return [
      // Пусто: только кольцо в замысле.
      fresh,
      // Линия есть, парка нет.
      withLine,
      // Машина без прицепа и без человека.
      addVehicle(withLine, RIVAL, city, { id: 'rival-bare' }),
      // Машина готова, водитель в резерве.
      addVehicle(withLine, RIVAL, city, { id: 'rival-ready', trailer }),
      // Работающая машина: очередь и просроченное ТО разом.
      addVehicle(withLine, RIVAL, city, {
        id: 'rival-working',
        trailer,
        driverId: toDriverId('rival-drv-1'),
        lineId,
        queuedTicks: QUEUE_PATIENCE_TICKS,
        kmSinceService: SERVICE_INTERVAL_KM,
      }),
      // Сломанная машина на линии.
      addVehicle(withLine, RIVAL, city, {
        id: 'rival-broken',
        trailer,
        driverId: toDriverId('rival-drv-1'),
        lineId,
        brokenDown: true,
      }),
      // Лишний человек без работы.
      addDriver(withLine, RIVAL, { id: 'rival-drv-2', licenses: [] }),
      // Рядом с игроком.
      besidePlayer(personality),
      // Без денег.
      worldWithRival(personality, 0),
    ]
  }

  it.each(PERSONALITIES)('%s: все команды проходят isLegal', (personality) => {
    for (const state of scenarios(personality)) {
      for (const command of scriptedCommands(state, RIVAL)) {
        expect(
          isLegal(state, RIVAL, command),
          `${personality}: ${JSON.stringify(command)}`,
        ).toBe(true)
      }
    }
  })
})

// ─── Чистота ───────────────────────────────────────────────────────────────

describe('решение не трогает вход', () => {
  it('замороженное состояние переживает и команды, и фразу', () => {
    const state = deepFreeze(besidePlayer('агрессивный'))

    expect(() => scriptedCommands(state, RIVAL)).not.toThrow()
    expect(() => scriptedThought(state, RIVAL)).not.toThrow()
  })

  it('состояние не меняется ни в одном поле', () => {
    const { state } = readyCompany('агрессивный', RICH)

    const before = JSON.stringify(state)
    scriptedCommands(state, RIVAL)
    scriptedThought(state, RIVAL)

    expect(JSON.stringify(state)).toBe(before)
  })

  it('остановки команды — копия, а не общий массив с планом', () => {
    const state = worldWithRival('осторожный', RICH)

    const first = createdLine(scriptedCommands(state, RIVAL))
    const before = first.stops[0].load.length
    // Груз заведомо не с этого кольца: списки грузов у остановок короткие, и
    // подмена своим же грузом ничего бы не доказала.
    const alien: CargoType = first.stops[0].load.includes('зерно')
      ? 'кругляк'
      : 'зерно'
    first.stops[0].load.push(alien)

    const second = createdLine(scriptedCommands(state, RIVAL))
    expect(second.stops[0].load).not.toContain(alien)
    expect(second.stops[0].load).toHaveLength(before)
  })
})

// ─── Лента ─────────────────────────────────────────────────────────────────

describe('фраза для ленты', () => {
  it('объясняет ровно то решение, которое ушло в команды', () => {
    const rich = worldWithRival('агрессивный', RICH)
    const plan = createdLine(scriptedCommands(rich, RIVAL))

    // Пока строится кольцо — фраза про кольцо и его города.
    const opening = scriptedThought(rich, RIVAL)
    expect(opening).toContain(plan.name.split(' — ')[0])

    // Как только линия есть, решение меняется, и фраза меняется вместе с ним.
    const { state } = addLine(rich, RIVAL, plan.name, plan.stops)
    expect(scriptedThought(state, RIVAL)).not.toBe(opening)
  })

  it('у компании без дела фраза всё равно есть', () => {
    expect(scriptedThought(worldWithRival('осторожный', 0), RIVAL).length,
    ).toBeGreaterThan(0)
  })
})

// ─── Вторая линия ──────────────────────────────────────────────────────────

/**
 * КОРНЕВОЙ ЗАМОК ФАЙЛА, снятый после разбора игрового года.
 *
 * Три счётчика — потребность в росте, «некомплект» и «сколько уже работает» —
 * считали парк ВСЕЙ КОНТОРЫ, а сравнивали его с целью ОДНОГО кольца. Пока линия
 * была одна, разницы не было; со второй контора запиралась намертво. Замер на
 * нишевом за 343 суток с двумя линиями: вторая не получила НИ ОДНОЙ машины,
 * простояв пустой при 524 032 рублях на счету, а пустых решений было 305 из 365.
 *
 * Проверка идёт через ПУБЛИЧНОЕ поведение — какие команды выдаёт конкурент, — а
 * не через внутренние счётчики: они и разъехались когда-то именно потому, что
 * их никто не спрашивал снаружи.
 */
describe('контора занимается второй линией, а не только первой', () => {
  it('машина первой линии не мешает укомплектовать вторую', () => {
    const base = withCompany(
      createInitialState(SEED),
      makeCompany(RIVAL, 'агрессивный', RICH),
    )

    const first = addLine(base, RIVAL, 'Первая', firstPlan().stops)
    // Первая линия собрана: машина с кузовом и человеком за рулём.
    const staffed = addDriver(
      addVehicle(first.state, RIVAL, firstPlan().stops[0].nodeId, {
        id: 'rival-on-line',
        trailer: trailerFor(firstPlan().stops),
        driverId: toDriverId('rival-drv-1'),
        lineId: first.lineId,
      }),
      RIVAL,
      { id: 'rival-drv-1', vehicleId: toVehicleId('rival-on-line') },
    )

    const commands = scriptedCommands(staffed, RIVAL)

    /*
     * Контора обязана ЧТО-ТО делать: строить вторую линию, покупать под неё
     * машину, нанимать человека. Пустой ход при полном кошельке и свободном
     * потолке линий — это и есть тот самый замок.
     */
    expect(commands.length).toBeGreaterThan(0)
  })

  it('при свободном потолке берётся НОВОЕ кольцо, а не то, что уже построено', () => {
    const base = withCompany(
      createInitialState(SEED),
      makeCompany(RIVAL, 'агрессивный', RICH),
    )

    const plan = firstPlan()
    const first = addLine(base, RIVAL, plan.name, plan.stops)
    const staffed = addDriver(
      addVehicle(first.state, RIVAL, plan.stops[0].nodeId, {
        id: 'rival-on-line',
        trailer: trailerFor(plan.stops),
        driverId: toDriverId('rival-drv-1'),
        lineId: first.lineId,
      }),
      RIVAL,
      { id: 'rival-drv-1', vehicleId: toVehicleId('rival-on-line') },
    )

    /*
     * Прежний поиск не спрашивал, построена ли линия, и каждый раз возвращал
     * контору к её же кольцу: агрессивный 306 решенческих дней подряд получал
     * обратно «Брянск — Рязань» и за год выдал «создать-линию» РОВНО ОДИН РАЗ
     * при потолке в три. Обещание из шапки MAX_LINES код не выполнял.
     */
    const created = scriptedCommands(staffed, RIVAL).find(
      (command) => command.kind === 'создать-линию',
    )

    if (created !== undefined && created.kind === 'создать-линию') {
      expect(created.stops.map((s) => s.nodeId)).not.toEqual(
        plan.stops.map((s) => s.nodeId),
      )
    }
  })
})
