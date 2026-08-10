import { describe, expect, it } from 'vitest'

import { CONSUMER_CARGO, RECIPE_BY_INDUSTRY } from '../data/recipes'
import { distanceCost } from '../sim/economy/operating'
import { MIN_LINE_STOPS } from '../sim/logistics/line'
import { createInitialState, STARTER_VEHICLE_ID } from '../sim/state'
import { cityId, lineId } from '../sim/types'
import type { CargoType, CityId, GameState, Line, Stop } from '../sim/types'
import { buildGraph } from '../sim/world/graph'
import { shortestKm } from '../sim/world/pathfind'
import {
  CARGO_ORDER,
  describeRing,
  loadSlots,
  loaderAt,
  unloadSlots,
  unloaderAt,
} from './lineDraft'

/**
 * Проверка подсказки о порожнем плече — главного, что делает этот срез.
 *
 * НИ ОДНОГО ПОСЧИТАННОГО ВРУЧНУЮ ЧИСЛА. Расстояния спрашиваются у shortestKm,
 * деньги — у distanceCost, названия грузов — у RECIPES. Прошлый срез уронил
 * тринадцать тестов, в которых не менялось ни одного правила, ровно потому, что
 * в них были вписаны числа из данных: перебалансировка ставок обязана оставлять
 * эти тесты зелёными, а ломать их должна только смена ПРАВИЛ.
 */

const OREL = cityId('orel')
const TULA = cityId('tula')
const MOSCOW = cityId('moscow')

/** Что производит мукомольный и из чего — берётся из рецепта, а не из головы. */
const MILL = RECIPE_BY_INDUSTRY['мукомольный']
const ELEVATOR = RECIPE_BY_INDUSTRY['элеватор']

function state(): GameState {
  return createInitialState(1)
}

function line(stops: Stop[]): Line {
  return { id: lineId('line-1'), name: 'проверочная', stops, assignedVehicles: [] }
}

function stop(
  nodeId: CityId,
  unload: CargoType[] = [],
  load: CargoType[] = [],
): Stop {
  return { nodeId, unload, load }
}

function ring(game: GameState, stops: Stop[], withVehicle = true) {
  return describeRing(
    line(stops),
    game.world.cities,
    game.world.industries,
    game.world.edges,
    withVehicle ? game.vehicles[STARTER_VEHICLE_ID] : null,
  )
}

/** Кратчайшее расстояние — той же функцией, которой его считает симуляция. */
function km(game: GameState, from: CityId, to: CityId): number {
  return shortestKm(buildGraph(game.world.edges), from, to)
}

describe('что в городе можно грузить и выгружать', () => {
  it('грузится только готовая продукция местного предприятия', () => {
    const game = state()
    const industries = game.world.industries

    // В Туле мукомольный: отдаёт свой выход и не отдаёт привезённое сырьё.
    expect(loaderAt(industries, TULA, MILL.output)).toBe('мукомольный')
    expect(loaderAt(industries, TULA, MILL.inputs[0].type)).toBeNull()

    // В Орле элеватор — источник зерна той же цепочки.
    expect(loaderAt(industries, OREL, ELEVATOR.output)).toBe('элеватор')
  })

  it('выгрузка — это вход предприятия или потребление города', () => {
    const game = state()
    const industries = game.world.industries

    expect(unloaderAt(industries, TULA, MILL.inputs[0].type)).toBe('мукомольный')

    // В Москве предприятий нет вовсе — она чистый спрос (см. data/industries.ts),
    // поэтому принимает ровно потребительские грузы и ничего сверх них.
    for (const cargo of CARGO_ORDER) {
      const expected = CONSUMER_CARGO.includes(cargo) ? 'город' : null
      expect(unloaderAt(industries, MOSCOW, cargo)).toBe(expected)
    }
  })

  it('список переключателей не содержит бессмысленных строк', () => {
    const game = state()
    const industries = game.world.industries

    const slots = loadSlots(industries, stop(TULA))
    // Ровно один осмысленный вариант — выход мукомольного. Шесть строк, из
    // которых пять пустых, — это угадайка, а не выбор.
    expect(slots.map((slot) => slot.cargo)).toEqual([MILL.output])
    expect(slots[0].who).toBe('мукомольный')
    expect(slots[0].chosen).toBe(false)

    expect(
      unloadSlots(industries, stop(TULA)).map((slot) => slot.cargo),
    ).toContain(MILL.inputs[0].type)
  })

  it('отмеченный, но невозможный здесь груз остаётся в списке', () => {
    const game = state()
    // Мука в Москве: предприятий в столице нет вовсе и не будет — она чистый
    // потребитель (см. data/industries.ts), поэтому город годится под этот
    // случай навсегда. Игрок муку всё же отметил — например, переставив
    // остановку из другого города. Молча вычистить чужое решение нельзя,
    // спрятать неотличимо от рабочего — тем более.
    //
    // Раньше здесь стоял Смоленск; в нём появился второй мукомольный, и
    // проверка стала бессмысленной, ничего при этом не сломав по существу.
    const slots = loadSlots(
      game.world.industries,
      stop(MOSCOW, [], [MILL.output]),
    )
    const flour = slots.find((slot) => slot.cargo === MILL.output)

    expect(flour).toBeDefined()
    expect(flour?.chosen).toBe(true)
    expect(flour?.who).toBeNull()
  })
})

describe('разбор кольца', () => {
  it('линия короче минимума не имеет плеч и говорит об этом', () => {
    const game = state()
    const report = ring(game, [stop(OREL, [], [ELEVATOR.output])])

    expect(report.legs).toEqual([])
    expect(report.warnings.length).toBe(1)
    // Порог берётся у симуляции, а не вписан двойкой ни здесь, ни в подсказке.
    expect(report.warnings[0]).toContain(String(MIN_LINE_STOPS))
  })

  it('обратное плечо без загрузки объявляется порожним и стоит денег', () => {
    const game = state()

    // Классическая ошибка новичка: зерно из Орла на мукомольный в Туле и назад
    // пустым. Ровно то кольцо, на котором посчитана сходимость в data/operating.
    const report = ring(game, [
      stop(OREL, [], [ELEVATOR.output]),
      stop(TULA, [ELEVATOR.output], []),
    ])

    expect(report.legs.map((leg) => leg.cargo)).toEqual([ELEVATOR.output, null])

    const back = km(game, TULA, OREL)
    expect(report.emptyKm).toBeCloseTo(back)
    expect(report.totalKm).toBeCloseTo(km(game, OREL, TULA) + back)
    // Плечи одинаковой длины — половина круга впустую.
    expect(report.emptyShare).toBeCloseTo(0.5)

    // Деньги считает та же функция, которой их списывает фаза расходов.
    const zil = game.vehicles[STARTER_VEHICLE_ID]
    expect(report.emptyCost).toBeCloseTo(distanceCost(zil, back))

    // Причина названа прямо: игрок не указал, что грузить в Туле.
    expect(report.legs[1].reason).toContain('Тула')
  })

  it('обратная загрузка убирает порожний пробег', () => {
    const game = state()

    // То же кольцо, но обратно едет мука: комбинат отдаёт продукцию, Орёл её
    // потребляет как город. Ни одного порожнего плеча.
    const report = ring(game, [
      stop(OREL, [MILL.output], [ELEVATOR.output]),
      stop(TULA, [ELEVATOR.output], [MILL.output]),
    ])

    expect(report.legs.map((leg) => leg.cargo)).toEqual([
      ELEVATOR.output,
      MILL.output,
    ])
    expect(report.emptyKm).toBe(0)
    expect(report.emptyShare).toBe(0)
    expect(report.emptyCost).toBe(0)
    expect(report.warnings).toEqual([])
  })

  it('показывается установившийся круг, а не разгонный', () => {
    const game = state()

    // Груз перекладывается через ЗАМЫКАЮЩЕЕ плечо: муку берут в Туле, а сдают в
    // Орле — то есть на первой остановке следующего круга. На первом круге
    // машина выходит из Орла порожней, дальше — никогда, и показывать надо
    // именно это.
    const report = ring(game, [
      stop(TULA, [ELEVATOR.output], [MILL.output]),
      stop(OREL, [MILL.output], [ELEVATOR.output]),
    ])

    expect(report.legs.map((leg) => leg.cargo)).toEqual([
      MILL.output,
      ELEVATOR.output,
    ])
    expect(report.emptyKm).toBe(0)
  })

  it('груз, который негде сдать, опознаётся как катание по кругу', () => {
    const game = state()

    // Муку грузят, но ни на одной остановке не выгружают. Плечи числятся
    // гружёными, выручки нет ни рубля — из отчёта такую линию не отличить от
    // работающей, поэтому её ловит редактор.
    const report = ring(game, [
      stop(TULA, [], [MILL.output]),
      stop(OREL, [], []),
    ])

    expect(report.emptyKm).toBe(0)
    expect(report.warnings).toContain('груз едет по кругу — его нигде не выгружают')
  })

  it('замыкающее плечо считается наравне с остальными', () => {
    const game = state()

    const report = ring(game, [stop(MOSCOW), stop(TULA), stop(OREL)])

    // Три остановки — три плеча, последнее возвращает машину в Москву.
    expect(report.legs.length).toBe(3)
    expect(report.legs[2].to).toBe(game.world.cities[MOSCOW].name)
    // Ничего не грузят нигде — весь круг порожний, и он весь в счёт.
    expect(report.emptyKm).toBeCloseTo(report.totalKm)
    expect(report.emptyShare).toBe(1)
  })

  it('кольцо через всю цепочку: гружёными идут два плеча из трёх', () => {
    const game = state()
    const pulp = RECIPE_BY_INDUSTRY['ЦБК']

    // Владимир → Рязань → Москва: лесозаготовка отдаёт кругляк, ЦБК меняет его
    // на пиломатериалы, Москва их съедает. Обратно из Москвы везти нечего —
    // предприятий в ней нет вовсе, и идеального кольца в этом мире не бывает.
    // Ровно это кольцо проверяет сквозной тест среза (tests/e2e/lines.spec.ts),
    // и редактор обязан показывать ту же картину, что покажет игра.
    const report = ring(game, [
      stop(cityId('vladimir'), [], [pulp.inputs[0].type]),
      stop(cityId('ryazan'), [pulp.inputs[0].type], [pulp.output]),
      stop(MOSCOW, [pulp.output], []),
    ])

    expect(report.legs.map((leg) => leg.cargo)).toEqual([
      pulp.inputs[0].type,
      pulp.output,
      null,
    ])
    expect(report.emptyKm).toBeCloseTo(km(game, MOSCOW, cityId('vladimir')))
    expect(report.legs[2].reason).toContain(game.world.cities[MOSCOW].name)
  })

  it('недостижимая остановка пропускается — как это делает диспетчер', () => {
    const game = state()
    const nowhere = cityId('нигде')

    // Одно порванное плечо не должно убивать линию: машина едет к ближайшей
    // достижимой следующей остановке. Порядок объезда общий с картой и отчётом
    // (ringOrder), поэтому редактор обязан показать ровно то же кольцо.
    const report = ring(game, [
      stop(OREL, [], [ELEVATOR.output]),
      stop(nowhere),
      stop(TULA, [ELEVATOR.output], []),
    ])

    // Два плеча вместо трёх, и оба принадлежат достижимым остановкам.
    expect(report.legs.map((leg) => leg.fromIndex)).toEqual([0, 2])
    expect(report.totalKm).toBeCloseTo(
      km(game, OREL, TULA) + km(game, TULA, OREL),
    )
    expect(report.warnings.some((text) => text.includes(nowhere))).toBe(true)
  })

  it('без машины в парке километры остаются, а рубли — нет', () => {
    const game = state()
    const report = ring(game, [stop(MOSCOW), stop(TULA)], false)

    expect(report.emptyKm).toBeGreaterThan(0)
    expect(report.emptyCost).toBeNull()
  })

  it('разбор ничего не меняет во входных данных', () => {
    const game = state()
    const stops = [
      stop(OREL, [], [ELEVATOR.output]),
      stop(TULA, [ELEVATOR.output], []),
    ]
    const before = JSON.stringify({ stops, world: game.world })

    ring(game, stops)

    expect(JSON.stringify({ stops, world: game.world })).toBe(before)
  })
})
