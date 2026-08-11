/**
 * ГЛАВНАЯ ПЕТЛЯ ИГРЫ, ЗАМКНУТАЯ НАСТОЯЩИМ ТИКОМ.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ. Вся игра держится на одном обещании
 * (economy/consumption.ts): наладил снабжение — город вырос — спрос вырос —
 * прежних машин уже не хватает. Обещание проверялось до сих пор ПОШТУЧНО:
 * consumption.test.ts подсовывает городу полный склад и убеждается, что
 * счётчик suppliedDays растёт, а население прибавляет. Это верная проверка
 * ФОРМУЛЫ и никакая — проверка ИГРЫ, потому что склад в ней берётся из воздуха.
 *
 * Замер, ради которого файл и написан, звучал так: за игровой год ни один город
 * мира не вырос ни разу, а максимум suppliedDays по всем 53 городам составил
 * 0.00. То есть формула работала, а петля была разомкнута: мир, в котором
 * снабдить город физически невозможно, ведёт себя точно так же, как мир, в
 * котором рост не запрограммирован вовсе, — и ни один зелёный тест этого не
 * замечал.
 *
 * ЧТО ИМЕННО ЛОВИТ ЭТОТ ТЕСТ. Он не проверяет ни одну формулу по отдельности.
 * Он утверждает, что СУЩЕСТВУЕТ ХОТЯ БЫ ОДИН СПОСОБ пройти петлю целиком —
 * средствами, доступными игроку, за время, которое игрок готов потратить:
 *
 *   линии → парк → люди с допусками → рейсы → склад города → 21 сутки подряд
 *   без единого срыва → рост населения.
 *
 * Порвись любое звено — недостаточная пропускная способность узла, нехватка
 * сырья у источника, потеря массы при переделе, потолок городского склада,
 * режим труда водителя, — и тест краснеет. Это единственная проверка проекта,
 * которая ловит РАЗОМКНУТУЮ ПЕТЛЮ, а не сломанную функцию.
 *
 * ПОЧЕМУ ИЖЕВСК. Порог требует, чтобы ВСЕ ТРИ потребительских груза
 * (CONSUMER_CARGO) закрывались в КАЖДОМ тике 21 суток подряд. Значит городу
 * нужны три работающих кольца сразу, и чем они короче, тем меньше способов
 * сорвать серию. Ижевск — единственный город карты, который держит у себя все
 * три источника сырья (элеватор, лесозаготовку и нефтебазу), поэтому все три
 * кольца у него получаются ДВУХОСТАНОВОЧНЫМИ: сырьё туда, продукция обратно,
 * порожнего плеча нет вовсе. Город выбран не как «удобный», а как ЕДИНСТВЕННЫЙ
 * подходящий — если петля не замыкается здесь, она не замыкается нигде.
 *
 * ЧЕГО ЭТОТ ТЕСТ НЕ УТВЕРЖДАЕТ. Что так поступит игрок, что это выгодно и что
 * это единственный путь. Он утверждает достижимость, и только её: капитал
 * выдаётся с заведомым запасом, техника чинится и обслуживается по регламенту.
 * Иначе тест мерил бы выживание конторы (это делают tick.invariant и
 * tick.rivals), а измерять надо петлю.
 *
 * ВСЕ ЧИСЛА НИЖЕ ВЫВЕДЕНЫ ИЗ ДАННЫХ И КОНСТАНТ. Кольца берутся из выдачи
 * планировщика (ringPlans) по СМЫСЛОВОМУ фильтру — «две остановки, сдаёт этот
 * груз в Ижевск, максимальная прибыль в час», — а не по строковому ключу:
 * ключи вида «izhevsk-kazan-izhevsk-зерно» поедут при первой же правке
 * справочника предприятий, и тест начнёт молча проверять не то. Парк считается
 * из грузоподъёмности класса, потери массы при переделе и режима труда, число
 * машин на линию — из MAX_FLEET_PER_LINE, порог — из GROWTH_THRESHOLD_DAYS.
 * Руками здесь написаны только запасы прочности (FLEET_MARGIN, RAMP_UP_DAYS,
 * CAPITAL_MARGIN), и каждый объяснён на месте.
 *
 * ЧТО ЗАМЕР ПОКАЗАЛ НА НЫНЕШНИХ ДАННЫХ (сид 7): четыре линии, 17 КамАЗов, три
 * терминала; порог взят на 28.8-е сутки, после 7.4-х серия не рвалась ни разу и
 * доросла до 52.2 суток, население 611 000 → 617 027 (+0.99%) за 60 суток.
 * Сеть при этом ПРИБЫЛЬНА: закупка стоила 1.30 млн, а счёт за 60 суток вырос с
 * 12.99 до 13.43 млн — то есть работа принесла 1.73 млн сверх потраченного на
 * парк. Петля замыкается не на дотационной сети, а на такой, которую игроку
 * выгодно построить, — и это, а не сам факт роста, делает её механикой.
 *
 * МИР ПРОГОНЯЕТСЯ ЦЕЛИКОМ, ВМЕСТЕ С КОНКУРЕНТАМИ. Убрать их было бы соблазнительно
 * — прогон стал бы быстрее и тише, — но тогда тест проверял бы стерильный мир, а
 * петля обязана замыкаться в том, который игра показывает игроку.
 */

import { describe, expect, it } from 'vitest'
import { BUILDING_SPEC, TONS_PER_POST_HOUR } from '../data/infrastructure'
import { CONSUMER_CARGO, RECIPES } from '../data/recipes'
import { TRAILER_PRICE, VEHICLE_CLASS_BY_ID } from '../data/vehicles'
import { MAX_COMMANDS_PER_TICK } from './ai/commands'
import { MAX_FLEET_PER_LINE, SHIFT_STRETCH, ringPlans } from './ai/scripted'
import type { ScriptedPlan } from './ai/scripted'
import {
  GROWTH_THRESHOLD_DAYS,
  demandPerDay,
  demandPerTick,
} from './economy/consumption'
import { CARGO_LICENSE, wageFor } from './logistics/driver'
import { MIN_LINE_STOPS } from './logistics/line'
import { needsService } from './logistics/wear'
import { PLAYER_ID, createInitialState } from './state'
import { tick } from './tick'
import { TICKS_PER_DAY, cityId } from './types'
import type {
  CargoType,
  CityId,
  Command,
  DriverId,
  DriverLicense,
  GameState,
  LineId,
  VehicleId,
} from './types'

// ─── Условия замера ────────────────────────────────────────────────────────

/**
 * Город, на котором меряется петля.
 *
 * Разбор выбора — в шапке файла: единственный город карты со всеми тремя
 * источниками сырья, то есть единственный, у которого все три потребительских
 * груза закрываются кольцом без порожнего плеча.
 */
const IZHEVSK: CityId = cityId('izhevsk')

/** Сид фиксирован: прогон обязан совпадать между запусками. */
const SEED = 7

/**
 * Горизонт прогона, суток.
 *
 * Шестьдесят — это порог (21) плюс разгон плюс месяц наблюдения за ростом.
 * Меньше нельзя: население прибавляет процент в РАСЧЁТНЫЙ МЕСЯЦ, и на коротком
 * горизонте прирост тонул бы в последних знаках. Больше незачем — петля либо
 * замкнулась, либо нет, а каждые лишние сутки это 96 тиков полного мира.
 */
const RUN_DAYS = 60

/**
 * Сколько суток отводится на разгон, прежде чем счётчик обязан начать копиться.
 *
 * ДЕВЯТЬ, И ЭТО ИЗМЕРЕННАЯ ВЕЛИЧИНА, А НЕ КРУГЛОЕ ЧИСЛО. Разгон складывается из
 * трёх задержек, и ни одну из них убрать нельзя — они и есть игра:
 *
 *   ПЕРЕГОН. Машина рождается в Москве (HOME_CITY в state.ts) и идёт к кольцу
 *   своим ходом: до Ижевска 1230 км, то есть двое суток при режиме труда.
 *   РАССТАНОВКА. Купленный разом парк выходит из одной точки и на линию
 *   выпускается по одному — выдержка интервала (departureGapKm в line.ts)
 *   растаскивает колонну, и последняя машина встаёт в оборот заметно позже
 *   первой.
 *   НАПОЛНЕНИЕ СКЛАДА. Первая ходка закрывает несколько часов потребления, а не
 *   сутки: серия начинает копиться только когда запас города перестаёт
 *   опускаться до нуля между рейсами.
 *
 * Замер на нынешних данных: последний обрыв серии — 7.35-е сутки, порог взят на
 * 28.82-е. Девять суток оставляют около полутора суток зазора — достаточно,
 * чтобы тест не падал от последнего знака, и мало, чтобы он проглядел заметно
 * подорожавший разгон.
 */
const RAMP_UP_DAYS = 9

/**
 * Крайний срок взятия порога, суток.
 *
 * Выводится из самого порога, а не пишется числом: сдвинется
 * GROWTH_THRESHOLD_DAYS — вместе с ним обязан сдвинуться и срок, иначе тест
 * начнёт требовать невозможного, не сказав об этом ни слова.
 */
const DEADLINE_DAYS = GROWTH_THRESHOLD_DAYS + RAMP_UP_DAYS

/**
 * Во сколько раз подача превышает спрос города.
 *
 * ВДВОЕ, И ЭТО НЕ ПЕРЕСТРАХОВКА, А ПРЯМОЕ СЛЕДСТВИЕ ФОРМЫ ПОРОГА. Счётчик
 * снабжения рвётся от ОДНОГО тика недостачи и обнуляется целиком — значит сеть,
 * рассчитанная «впритык», обязана сорваться: рейс сдвигается поломкой,
 * обязательным отдыхом водителя, очередью на посту, весенним ограничением. Запас
 * держится не средним довозом, а тем, что городской склад никогда не опустеет
 * ниже суточного расхода.
 *
 * ВТОРАЯ ПОЛОВИНА ЗАПАСА УХОДИТ НА ЧЕСТНУЮ НЕТОЧНОСТЬ РАСЧЁТА ПАРКА (fleetFor):
 * оборот там считается по ПАСПОРТНОЙ скорости класса, а по карте КамАЗ идёт в
 * среднем 50 км/ч из своих 80 — дорога и её качество режут скорость (speedKmh в
 * world/speed.ts). Считать плечи по настоящей скорости значило бы завести здесь
 * второй маршрутизатор; проще признать, что расчётный парк оптимистичен вполовину,
 * и заложить это в запас.
 *
 * Двойной запас при этом не бесплатен и не является читерством: он оплачен
 * вдвое большим парком, вдвое большей зарплатой и топливом, и всё это уходит из
 * кассы компании в том же прогоне — которая, к слову, всё равно осталась в плюсе.
 */
const FLEET_MARGIN = 2

/**
 * Во сколько раз стартовый капитал превышает стоимость всей закупки.
 *
 * Вдесятеро. Тест меряет ПЕТЛЮ, а не выживание конторы: разорись компания на
 * сороковые сутки, тест покраснел бы, ничего не сказав про рост города.
 * Живучесть проверяется в других файлах и другими средствами (tick.invariant,
 * tick.rivals), и дублировать её здесь значит получить тест, который падает по
 * двум разным причинам с одним и тем же сообщением.
 */
const CAPITAL_MARGIN = 10

// ─── Мелкие помощники ──────────────────────────────────────────────────────

/**
 * Значение или громкая ошибка.
 *
 * Отсутствие кольца, класса техники или рецепта — это не «тест не прошёл», а
 * рассыпавшаяся фикстура: мир изменился так, что мерить стало нечего. Такое
 * обязано падать с внятным текстом на месте, а не превращаться в undefined,
 * который всплывёт через пять тысяч тиков как NaN в населении.
 */
function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`фикстура рассыпалась: ${what}`)
  }
  return value
}

/** Машины компании игрока. */
function playerFleet(state: GameState): VehicleId[] {
  return (Object.keys(state.vehicles) as VehicleId[]).filter(
    (id) => state.vehicles[id].ownerId === PLAYER_ID,
  )
}

/** Водители компании игрока. */
function playerDrivers(state: GameState): DriverId[] {
  return Object.keys(state.companies[PLAYER_ID].drivers) as DriverId[]
}

/** Что появилось в списке после партии команд. */
function added<T extends string>(before: readonly T[], after: readonly T[]): T[] {
  const known = new Set<T>(before)
  return after.filter((id) => !known.has(id))
}

/**
 * Отдать компании игрока пачку команд и провернуть РОВНО ОДИН настоящий тик.
 *
 * Единственная дверь в состояние, которой пользуется весь этот файл после
 * стартовой выдачи денег. Команды кладутся в pendingCommands — туда же, куда их
 * кладёт интерфейс и куда приходит ответ модели, — и разбираются фазой команд
 * внутри тика, со всеми её проверками законности. Незаконная команда будет
 * молча отброшена ровно так же, как у игрока: тест не имеет права на путь в
 * состояние, которого у игрока нет.
 *
 * Пачка обрезается по MAX_COMMANDS_PER_TICK, потому что ровно столько разберёт
 * фаза команд; остальное она выбросит, и делать вид, будто команда отдана, было
 * бы самообманом.
 */
function step(state: GameState, commands: readonly Command[]): GameState {
  const player = state.companies[PLAYER_ID]
  return tick({
    ...state,
    companies: {
      ...state.companies,
      [PLAYER_ID]: {
        ...player,
        pendingCommands: commands.slice(0, MAX_COMMANDS_PER_TICK),
      },
    },
  })
}

/** Отдать длинный список команд, растянув его на столько тиков, сколько нужно. */
function stepAll(state: GameState, commands: readonly Command[]): GameState {
  let next = state
  for (let i = 0; i < commands.length; i += MAX_COMMANDS_PER_TICK) {
    next = step(next, commands.slice(i, i + MAX_COMMANDS_PER_TICK))
  }
  return next
}

// ─── Выбор колец ───────────────────────────────────────────────────────────

/**
 * Кольцо, которое сдаёт этот груз в Ижевск, — лучшее из двухостановочных.
 *
 * ФИЛЬТР СМЫСЛОВОЙ, А НЕ ПО КЛЮЧУ, и это требование к тесту, а не вкус. План
 * узнаётся по трём свойствам: остановок ровно минимум (MIN_LINE_STOPS —
 * двухостановочное кольцо, у которого сбыт совпал с источником и порожнего
 * плеча нет вовсе), одна из остановок стоит в Ижевске и выгружает там нужный
 * груз, а из подошедших берётся самое прибыльное. Ключ плана в фильтр не входит
 * НИ ОДНОЙ БУКВОЙ: он собирается из идентификаторов предприятий и городов
 * (см. ringPlans) и меняется при любой правке справочника — тест, привязанный к
 * нему, однажды начнёт проверять другое кольцо и не сообщит об этом.
 */
function ringFeeding(state: GameState, cargo: CargoType): ScriptedPlan {
  const feeding = ringPlans(state)
    .filter(
      (plan) =>
        plan.stops.length === MIN_LINE_STOPS &&
        plan.stops.some(
          (stop) => stop.nodeId === IZHEVSK && stop.unload.includes(cargo),
        ),
    )
    .sort((a, b) => b.profitPerHour - a.profitPerHour)

  return required(feeding[0], `нет двухостановочного кольца с «${cargo}» в Ижевск`)
}

/**
 * Во сколько раз переработка теряет массу на этом кольце.
 *
 * Берётся из рецепта, а не из плана: плану эта величина не нужна и он её не
 * хранит. Из тонны кругляка выходит меньше тонны пиломатериалов, и обратное
 * плечо кольца везёт РОВНО ТО, что вышло, — значит парк, посчитанный по полному
 * кузову, оказался бы завышен в perUnit раз.
 */
function perUnitOf(plan: ScriptedPlan): number {
  const recipe = required(
    RECIPES.find((it) => it.output === plan.product),
    `нет рецепта на «${plan.product}»`,
  )
  const input = required(
    recipe.inputs.find((it) => it.type === plan.raw),
    `рецепт «${plan.product}» не ест «${plan.raw}»`,
  )
  return input.perUnit
}

/**
 * Сколько машин нужно кольцу, чтобы город не голодал НИ В ОДНОМ ТИКЕ.
 *
 * Считается по обороту, а не подбирается прогонами, и все три слагаемых времени
 * оборота — настоящие правила игры, а не оценки:
 *
 *   ДОРОГА     — длина кольца, делённая на крейсерскую скорость класса. Это
 *                ВЕРХНЯЯ оценка: настоящая скорость зависит от класса дороги и
 *                её качества и на карте выходит ниже. Поправка живёт не здесь, а
 *                в FLEET_MARGIN — разбор там.
 *   РЕЖИМ ТРУДА — SHIFT_STRETCH: девять часов за рулём стоят двадцати часов
 *                календаря, потому что водителю положен отдых. Забудь этот
 *                множитель — и парк выйдет вдвое меньше нужного, а серия
 *                оборвётся на первой же неделе.
 *   ПОСТЫ      — тонны, прошедшие через рампы за оборот, делённые на
 *                TONS_PER_POST_HOUR. Кольцо с двумя гружёными плечами держит пост
 *                на КАЖДОЙ остановке дважды: выгрузка и погрузка.
 *
 * Результат округляется ВВЕРХ и умножается на FLEET_MARGIN: недовоз рвёт серию
 * целиком, перевоз всего лишь наполняет склад города.
 */
function fleetFor(
  plan: ScriptedPlan,
  cargo: CargoType,
  population: number,
): number {
  const vc = required(
    VEHICLE_CLASS_BY_ID[plan.classId],
    `нет класса «${plan.classId}» в справочнике`,
  )

  /** Тонн продукции, которые кольцо увозит из завода за один оборот. */
  const productPerCycle = vc.capacity / perUnitOf(plan)
  /** Тонн через рампы за оборот: обе остановки, выгрузка плюс погрузка. */
  const handledPerCycle = 2 * (vc.capacity + productPerCycle)

  const cycleHours =
    (plan.ringKm / vc.cruiseKmh) * SHIFT_STRETCH +
    handledPerCycle / TONS_PER_POST_HOUR

  const tonsPerDay = (productPerCycle * 24) / cycleHours

  return Math.ceil((demandPerDay(population, cargo) * FLEET_MARGIN) / tonsPerDay)
}

// ─── Сборка сети командами игрока ──────────────────────────────────────────

/** Одна ЛИНИЯ со всем, что о ней нужно знать сборке. */
type Ring = {
  cargo: CargoType
  plan: ScriptedPlan
  fleet: number
  /**
   * Имя линии — оно же способ найти её в состоянии после создания.
   *
   * Идентификатор линии выдаёт симуляция (freeLineId в ai/commands.ts), и
   * предсказывать его по формату ключа значило бы завести вторую копию правила
   * нумерации. Имя же назначаем мы сами, поэтому оно и служит ключом поиска. В
   * него входит груз (колец «Ижевск — Пермь» два: лесное и нефтяное) и номер
   * линии внутри кольца.
   */
  name: string
}

/**
 * Сеть, которой снабжается город: по линии на каждые MAX_FLEET_PER_LINE машин.
 *
 * ПАРК ОДНОГО КОЛЬЦА РАЗБИТ НА НЕСКОЛЬКО ЛИНИЙ, И ЭТО РЕШАЮЩЕЕ РЕШЕНИЕ ВСЕГО
 * ФАЙЛА — без него тест не проходит.
 *
 * Причина в выдержке интервала (departureGapKm в logistics/line.ts). Машины
 * покупаются в одном городе и выходят на линию из одной точки, поэтому
 * диспетчер выпускает их ПО ОЧЕРЕДИ, растаскивая колонну по кольцу; очередь
 * общая на линию, и на длинном перегоне из Москвы она растягивается на сутки.
 * Замер: при одной линии на кольцо порог брался на 30.2-е сутки, при разбивке —
 * на 28.8-е, и разница целиком в том, КОГДА последняя машина встала в оборот.
 *
 * Число машин на линию берётся у планировщика (MAX_FLEET_PER_LINE): он держит
 * ровно этот потолок и обосновывает его пропускной способностью узла с
 * терминалом. Второе число здесь было бы вторым мнением об одном и том же.
 *
 * КОЛЬЦА ВЫВОДЯТСЯ В ПОРЯДКЕ ГОЛОДА — самый прожорливый груз первым. Сборка
 * занимает тики, и линия, собранная последней, позже всех начнёт возить; отдать
 * это место топливу (36 т/сут против 11 у муки) значит отложить начало серии на
 * самом узком грузе. Порядок считается по demandPerDay, а не выписывается
 * списком: нормы потребления в data/recipes.ts однажды поменяются.
 */
function ringsFor(state: GameState): Ring[] {
  const population = state.world.cities[IZHEVSK].population

  const hungriestFirst = [...CONSUMER_CARGO].sort(
    (a, b) => demandPerDay(population, b) - demandPerDay(population, a),
  )

  const rings: Ring[] = []
  for (const cargo of hungriestFirst) {
    const plan = ringFeeding(state, cargo)
    const total = fleetFor(plan, cargo, population)
    const lines = Math.ceil(total / MAX_FLEET_PER_LINE)

    for (let index = 0; index < lines; index++) {
      // Остаток раскладывается по первым линиям, а не сваливается в последнюю:
      // норма интервала — длина кольца, делённая на число машин НА НЕЙ, и линия
      // из двух машин держала бы каждую вдвое дольше, чем линия из четырёх.
      const fleet = Math.floor(total / lines) + (index < total % lines ? 1 : 0)
      rings.push({
        cargo,
        plan,
        fleet,
        name: `${plan.name} · ${cargo} #${index + 1}`,
      })
    }
  }

  return rings
}

/**
 * Деньги. ЕДИНСТВЕННАЯ ПРАВКА СОСТОЯНИЯ РУКАМИ, КРОМЕ ДОПУСКОВ.
 *
 * Команды пополнить счёт в контракте нет и быть не должно: деньги в этой игре
 * зарабатываются, а не назначаются. Но капитал — это УСЛОВИЕ ЗАМЕРА, а не его
 * предмет: тест меряет, замыкается ли петля, и разорившаяся на тридцатые сутки
 * контора ответила бы на совсем другой вопрос. Поэтому счёт выставляется прямо,
 * один раз, до первого тика.
 */
function withCapital(state: GameState, money: number): GameState {
  const player = state.companies[PLAYER_ID]
  return {
    ...state,
    companies: { ...state.companies, [PLAYER_ID]: { ...player, money } },
  }
}

/**
 * Допуски нанятому водителю. ВТОРАЯ И ПОСЛЕДНЯЯ ПРАВКА СОСТОЯНИЯ РУКАМИ.
 *
 * Команды «выучить водителя» в контракте тоже нет, и это не пробел, а замысел:
 * допуск (ДОПОГ под наливные, длинномер под кругляк) не покупается, его ищут
 * перебором кандидатов на рынке труда — вероятность зашита в hireDriver. Играть
 * в эту лотерею внутри теста нельзя: число наймов до нужного допуска зависит от
 * сида, и тест мерил бы везение, а не петлю.
 *
 * Ставка пересчитывается ТОЙ ЖЕ функцией, что и при найме (wageFor), поэтому
 * компания платит за допуск полную цену. Подарить допуск бесплатно значило бы
 * занизить расходы прогона и получить кассу, которой в игре не бывает.
 */
function licensed(
  state: GameState,
  ids: readonly DriverId[],
  licenses: readonly DriverLicense[],
): GameState {
  const player = state.companies[PLAYER_ID]
  const drivers = { ...player.drivers }

  for (const id of ids) {
    const driver = drivers[id]
    drivers[id] = {
      ...driver,
      licenses: [...licenses],
      wagePerDay: wageFor(driver.skill, licenses),
    }
  }

  return {
    ...state,
    companies: { ...state.companies, [PLAYER_ID]: { ...player, drivers } },
  }
}

/** Допуски, без которых кольцо не поедет. Выводятся из грузов, а не из знания. */
function licensesFor(plan: ScriptedPlan): DriverLicense[] {
  const needed: DriverLicense[] = []
  for (const cargo of plan.cargoes) {
    const license = CARGO_LICENSE[cargo]
    if (license === undefined) continue
    if (!needed.includes(license)) needed.push(license)
  }
  return needed
}

/**
 * Терминалы во всех городах сети.
 *
 * БЕЗ НИХ ЗАМЕР МЕРИЛ БЫ ОЧЕРЕДЬ, А НЕ ПЕТЛЮ. Постов у компании в городе ровно
 * один (BASE_POSTS), то есть 15 тонн в час — 360 в сутки. Три кольца прогоняют
 * через Ижевск около трёхсот тонн в сутки, и на такой загрузке очередь растёт
 * лавинообразно: машины стоят у рампы, серия рвётся, а причина не имеет никакого
 * отношения к тому, что тест проверяет. Терминал добавляет три поста и снимает
 * вопрос целиком.
 *
 * Строится во ВСЕХ городах колец, а не только в узком месте: правило «где узко»
 * пришлось бы вычислять, и вычисление разъехалось бы с миром при первой правке
 * данных. Лишний терминал стоит денег и содержания — и то и другое честно уходит
 * из кассы в том же прогоне.
 */
function terminalCommands(rings: readonly Ring[]): Command[] {
  const cities: CityId[] = []
  for (const ring of rings) {
    for (const stop of ring.plan.stops) {
      if (!cities.includes(stop.nodeId)) cities.push(stop.nodeId)
    }
  }
  return cities.map((city) => ({
    kind: 'построить',
    cityId: city,
    type: 'терминал',
  }))
}

/**
 * Собрать сеть ТОЛЬКО КОМАНДАМИ ИГРОКА.
 *
 * Порядок фаз — тот же, в котором собирает машину игрок (COMMANDS_PER_VEHICLE в
 * ai/commands.ts): линия, тягач, кузов, человек, посадка, назначение. Каждая
 * фаза заканчивается тиком, потому что идентификаторы купленного и нанятого
 * выдаёт САМА СИМУЛЯЦИЯ и узнать их можно только из состояния — предсказывать
 * их по формату ключа значило бы завести вторую копию правила нумерации.
 */
function buildNetwork(state: GameState, rings: readonly Ring[]): GameState {
  let next = state

  // Терминалы и линии — одной пачкой: ни то, ни другое не зависит от чужих
  // идентификаторов.
  next = stepAll(next, [
    ...terminalCommands(rings),
    ...rings.map(
      (ring): Command => ({
        kind: 'создать-линию',
        name: ring.name,
        stops: ring.plan.stops.map((stop) => ({
          nodeId: stop.nodeId,
          unload: [...stop.unload],
          load: [...stop.load],
        })),
      }),
    ),
  ])

  const lines = next.companies[PLAYER_ID].lines
  const lineByName = new Map<string, LineId>()
  for (const id of Object.keys(lines) as LineId[]) {
    lineByName.set(lines[id].name, id)
  }

  for (const ring of rings) {
    const lineId = required(
      lineByName.get(ring.name),
      `линия «${ring.name}» не создана`,
    )

    // Тягачи. Свои узнаются разностью парка до и после — формат ключа машины
    // остаётся делом симуляции.
    const beforeFleet = playerFleet(next)
    next = stepAll(
      next,
      Array.from(
        { length: ring.fleet },
        (): Command => ({ kind: 'купить-машину', classId: ring.plan.classId }),
      ),
    )
    const trucks = added(beforeFleet, playerFleet(next))

    // Кузов под ОБА груза кольца — его выбрал планировщик, а не тест.
    next = stepAll(
      next,
      trucks.map(
        (vehicleId): Command => ({
          kind: 'купить-прицеп',
          vehicleId,
          trailer: ring.plan.trailer,
        }),
      ),
    )

    // Люди. Тем же способом: кто пришёл — видно по разности штата.
    const beforeStaff = playerDrivers(next)
    next = stepAll(
      next,
      Array.from({ length: ring.fleet }, (): Command => ({ kind: 'нанять-водителя' })),
    )
    const hired = added(beforeStaff, playerDrivers(next))

    next = licensed(next, hired, licensesFor(ring.plan))

    // Посадка и назначение — оба действия бесплатны, поэтому идут вместе.
    next = stepAll(next, [
      ...hired.map(
        (driverId, index): Command => ({
          kind: 'посадить-водителя',
          driverId,
          vehicleId: trucks[index],
        }),
      ),
      ...trucks.map(
        (vehicleId): Command => ({ kind: 'назначить-машину', vehicleId, lineId }),
      ),
    ])
  }

  return next
}

// ─── Прогон ────────────────────────────────────────────────────────────────

/**
 * Уход за техникой — командами, а не правкой состояния.
 *
 * Поломка и просроченное ТО — это бросок ГПСЧ и счётчик пробега, то есть шум,
 * который на длинном прогоне двигает результат сильнее, чем то, что тест меряет.
 * Игроку доступны обе команды («починить», «обслужить»), и хозяйское отношение к
 * парку — нормальная игра, а не поблажка. Тот же приём и по той же причине — в
 * tick.rivals.test.ts.
 *
 * Список сознательно не обрезается: обрежет фаза команд, а до следующего тика
 * невлезшее доживёт — счётчик пробега и флаг поломки никуда не денутся.
 */
function careCommands(state: GameState): Command[] {
  const commands: Command[] = []

  for (const vehicleId of playerFleet(state)) {
    const vehicle = state.vehicles[vehicleId]
    if (vehicle.brokenDown) {
      commands.push({ kind: 'починить', vehicleId })
      continue
    }
    if (needsService(vehicle)) commands.push({ kind: 'обслужить', vehicleId })
  }

  return commands
}

/** Что прогон рассказал про город. */
type Trace = {
  end: GameState
  /** Сутки, на которых счётчик ПРЕВЫСИЛ порог. Бесконечность — не превысил. */
  thresholdDay: number
  /** Наибольшее значение счётчика за прогон, суток. */
  bestStreak: number
  /** Сколько раз серия обрывалась. */
  breaks: number
  /** Первые обрывы с разбором: на каком грузе и на каких сутках. */
  firstBreaks: string[]
}

/**
 * Шестьдесят суток настоящим тиком, с уходом за парком и записью диагностики.
 *
 * ОБРЫВ СЕРИИ ЗАПИСЫВАЕТСЯ ВМЕСТЕ С ВИНОВНИКОМ, и ради этого прогон вообще
 * что-то пишет. Красный тест обязан отвечать на вопрос «почему», а не «нет»:
 * счётчик suppliedDays обнуляется одинаково от любой недостачи, и без разбора по
 * грузам сообщение о падении не отличало бы нехватку топлива от нехватки муки.
 * Виновник опознаётся по пустому складу на конец тика: город съедает не больше,
 * чем лежит, поэтому именно у сорвавшего серию груза остаток уходит в ноль.
 */
function run(state: GameState, days: number): Trace {
  let next = state
  let thresholdDay = Number.POSITIVE_INFINITY
  let bestStreak = 0
  let breaks = 0
  const firstBreaks: string[] = []

  let before = next.world.cities[IZHEVSK]

  for (let t = 0; t < days * TICKS_PER_DAY; t++) {
    next = step(next, careCommands(next))

    const city = next.world.cities[IZHEVSK]
    const day = (t + 1) / TICKS_PER_DAY

    bestStreak = Math.max(bestStreak, city.suppliedDays)
    if (city.suppliedDays > GROWTH_THRESHOLD_DAYS) {
      thresholdDay = Math.min(thresholdDay, day)
    }

    const broke = city.suppliedDays === 0 && before.suppliedDays > 0
    breaks += broke ? 1 : 0
    if (broke && firstBreaks.length < 5) {
      const culprits = CONSUMER_CARGO.filter(
        (cargo) => (city.stock[cargo] ?? 0) <= 0,
      )
      const cover = CONSUMER_CARGO.map((cargo) => {
        const tons = before.stock[cargo] ?? 0
        const perDay = demandPerDay(before.population, cargo)
        const perTick = demandPerTick(before.population, cargo)
        return `${cargo} ${tons.toFixed(2)} т (${(tons / perDay).toFixed(2)} сут, тик просит ${perTick.toFixed(3)} т)`
      }).join('; ')

      firstBreaks.push(
        `сутки ${day.toFixed(2)}: серия ${before.suppliedDays.toFixed(2)} сут оборвалась на «${culprits.join(', ')}»; ` +
          `запас на начало тика — ${cover}`,
      )
    }

    before = city
  }

  return { end: next, thresholdDay, bestStreak, breaks, firstBreaks }
}

// ─── Утверждение ───────────────────────────────────────────────────────────

describe('главная петля: снабжение растит город', () => {
  it(`Ижевск берёт порог снабжения и растёт за ${RUN_DAYS} суток`, () => {
    const start = createInitialState(SEED)
    const rings = ringsFor(start)

    /*
     * Капитал — вся закупка, помноженная на запас. Считается ПО СПИСКУ, а не
     * назначается круглым числом: подорожает КамАЗ или прицеп — капитал вырастет
     * сам, и тест не начнёт падать по причине, к петле отношения не имеющей.
     */
    const purchase = rings.reduce((sum, ring) => {
      const price = required(
        VEHICLE_CLASS_BY_ID[ring.plan.classId],
        `нет класса «${ring.plan.classId}»`,
      ).price
      const trailer = required(
        TRAILER_PRICE[ring.plan.trailer],
        `нет цены кузова «${ring.plan.trailer}»`,
      )
      return sum + ring.fleet * (price + trailer)
    }, terminalCommands(rings).length * BUILDING_SPEC.терминал.price)

    const ready = buildNetwork(
      withCapital(start, purchase * CAPITAL_MARGIN),
      rings,
    )

    const startPopulation = start.world.cities[IZHEVSK].population
    const trace = run(ready, RUN_DAYS)

    const city = trace.end.world.cities[IZHEVSK]
    const player = trace.end.companies[PLAYER_ID]

    /*
     * ВСЯ ДИАГНОСТИКА СОБИРАЕТСЯ В ОДНУ СТРОКУ И КЛАДЁТСЯ В ОБА УТВЕРЖДЕНИЯ.
     * Прогон стоит пяти тысяч тиков, и повторять его ради выяснения причины —
     * непозволительная роскошь: всё, что нужно для разбора, обязано лежать в
     * сообщении первого же падения.
     */
    const report = [
      `сеть: ${rings.map((ring) => `${ring.cargo} — ${ring.plan.name}, ${ring.plan.ringKm.toFixed(0)} км, ${ring.fleet} маш.`).join(' | ')}`,
      `порог ${GROWTH_THRESHOLD_DAYS} сут взят на ${trace.thresholdDay.toFixed(2)}-е сутки (крайний срок ${DEADLINE_DAYS})`,
      `максимум счётчика ${trace.bestStreak.toFixed(2)} сут, обрывов ${trace.breaks}`,
      `население ${startPopulation.toFixed(0)} → ${city.population.toFixed(0)} (${(((city.population - startPopulation) / startPopulation) * 100).toFixed(3)}%)`,
      `касса ${purchase * CAPITAL_MARGIN} → ${player.money.toFixed(0)}, парк ${playerFleet(trace.end).length} маш., банкрот: ${player.bankrupt}`,
      ...trace.firstBreaks,
    ].join('\n')

    // Порог взят вовремя. Бесконечность в счётчике означает «не взят вовсе» и
    // проваливает это же утверждение — отдельной проверки на null не нужно.
    expect(trace.thresholdDay, report).toBeLessThanOrEqual(DEADLINE_DAYS)

    // И петля замкнулась: город, которому хватило порога, вырос.
    expect(city.population, report).toBeGreaterThan(startPopulation)
  })
})
