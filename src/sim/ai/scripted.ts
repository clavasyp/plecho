/**
 * Скриптовый конкурент: эвристика, которая играет ПО ПРАВИЛАМ ИГРОКА.
 *
 * У файла две роли, и вторая важнее первой.
 *
 *   СОПЕРНИК. На карте несколько компаний, и большинство из них ведёт этот
 *   файл. Модель дорога и медленна, а мир должен быть населён с первого тика.
 *
 *   ЗАПАСНОЙ ПУТЬ. Нет сети, нет ключа, кончился лимит, пришёл мусор вместо
 *   JSON — команды берутся здесь, и игрок не замечает подмены. Без этого вся
 *   затея с языковой моделью превращается в зависимость от чужого сервиса:
 *   упал Gemini — конкуренты замерли, экономика встала, партия сломалась.
 *   Поэтому скрипт обязан быть не заглушкой, а игроком.
 *
 * ЧЕМ ОН ЗАНИМАЕТСЯ. Ровно тем же, чем игрок: ищет пару предприятий, где выход
 * одного нужен другому, и замыкает их в КОЛЬЦО С ДВУМЯ ГРУЖЁНЫМИ ПЛЕЧАМИ —
 * туда сырьё, обратно готовая продукция. Это главная механика игры
 * (docs/КОНЦЕПТ.md §3–4), и конкурент, который её не понимает, — не соперник, а
 * декорация: он возил бы одно плечо гружёным, второе порожним и разорился бы сам
 * собой, без всякого участия игрока.
 *
 * ГДЕ СДАВАТЬ ПРОДУКЦИЮ — ВТОРОЙ ВОПРОС КОЛЬЦА, И ОН ЖЕ САМЫЙ ДОРОГОЙ. Кольцо
 * из двух остановок («источник ↔ переработка», продукция сдаётся в городе
 * источника) выглядит идеальным: гружёное целиком, порожнего пробега ноль. На
 * бумаге. В настоящем мире игры оно ЗАПИРАЕТ МАШИНУ НАСМЕРТЬ, и это стоит
 * разобрать, потому что ошибка совершенно не видна из формул.
 *
 *   Орёл отгружает 60 тонн зерна в сутки, тульская мельница принимает 50 — плечо
 *   «туда» кормит любой парк. Обратно едет мука, а ест её Орёл в количестве
 *   0.46 тонны в сутки (290 тысяч жителей × CONSUMPTION_PER_1K), при складе
 *   города на тридцать суток потребления — 14 тонн. Один КамАЗ привозит восемь
 *   тонн за оборот в семь часов. Через два оборота город полон, машина стоит с
 *   мукой, которую некому принять, и — поскольку кузов один — не может взять
 *   зерно. Дальше она катается по кольцу с неразгружаемым грузом: одометр
 *   растёт, порожний пробег в отчёте 1%, выручка 150 рублей в сутки при расходах
 *   в двадцать пять тысяч. Замеры первого прогона: банкротство на сороковые
 *   сутки при трёх характерах из трёх.
 *
 * Отсюда ГЛАВНОЕ ПРАВИЛО ПЛАНИРОВЩИКА: каждая точка выгрузки обязана съедать
 * столько, сколько машина туда привозит. Сток считается честно — потребление
 * города (demandPerDay) плюс потребность тамошних заводов в этом сырье, — и если
 * он меньше суточной подачи одной машины, кольцо отвергается целиком, каким бы
 * прибыльным оно ни выглядело.
 *
 * Практический вывод в этом мире один: продукцию берёт Москва (21 тонна муки,
 * 66 топлива, 29 пиломатериалов в сутки) и почти никто больше. Поэтому у кольца
 * появляется ТРЕТЬЯ остановка — сбытовая, — а вместе с ней и порожнее плечо
 * обратно к источнику. Ровно такое кольцо описано в docs/КОНЦЕПТ.md §4
 * («Москва → элеватор → мукомольный → Москва»), и третье плечо там гружёное
 * только потому, что в замысле по нему едут удобрения, которых в данных пока
 * нет. Два гружёных плеча из трёх — это и есть требование среза, а не
 * послабление: кольцо с ОДНИМ гружёным плечом по-прежнему убыточно и
 * планировщиком отвергается.
 *
 * Двухостановочная форма при этом НЕ ВЫБРОШЕНА: она остаётся лучшей, как только
 * город источника начинает съедать привозимое (город растёт от снабжения — см.
 * economy/consumption.ts). Выбор между формами делает не автор, а тот же расчёт
 * прибыли и стока.
 *
 * ЧЕГО ОН НЕ ДЕЛАЕТ — НЕ ТРОГАЕТ СОСТОЯНИЕ. Обе функции файла чистые и
 * возвращают ДАННЫЕ: список команд из перечисления Command и фразу для ленты.
 * Применяет команды фаза команд (sim/ai/commands.ts), проверяя каждую теми же
 * правилами, что и действия игрока. Разрешить скрипту править GameState
 * напрямую значило бы завести вторую дверь в симуляцию — и первая же
 * оптимизация конкурента прошла бы мимо всех проверок законности.
 *
 * ДЕТЕРМИНИЗМ. Ни Math.random, ни времени по часам, ни сети: решение —
 * функция от состояния и идентификатора компании. Один сейв даёт одни и те же
 * распоряжения при любом числе прогонов, иначе воспроизведение бага по
 * сохранению кончалось бы на первом же тике с конкурентом. Единственная
 * «случайность» — выбор ниши у нишевого характера, и та выведена из имени
 * компании отдельным потоком Rng.forKey, то есть тоже воспроизводима.
 *
 * ПОЧЕМУ РЕШЕНИЕ ОДНО, А ФУНКЦИИ ДВЕ. Контракт среза требует раздельных
 * scriptedCommands и scriptedThought, но фраза обязана описывать РОВНО ТО, что
 * уходит в команды: лента, рассказывающая не про то, что произошло, хуже, чем
 * отсутствие ленты. Поэтому обе функции — обёртки над одним decide(), и
 * разойтись они не могут по построению.
 */

import { BUILDING_SPEC, TONS_PER_POST_HOUR } from '../../data/infrastructure'
import { DRIVER_WAGE_PER_DAY } from '../../data/operating'
import { RECIPE_BY_INDUSTRY } from '../../data/recipes'
import {
  TRAILER_PRICE,
  VEHICLE_CLASSES,
  VEHICLE_CLASS_BY_ID,
  costPerKm,
} from '../../data/vehicles'
import { upkeepPerTick } from '../economy/buildings'
import { demandPerDay } from '../economy/consumption'
import { deliveryRevenue } from '../economy/finance'
import { CARGO_LICENSE, MAX_SHIFT_HOURS, REST_HOURS } from '../logistics/driver'
import { MIN_LINE_STOPS } from '../logistics/line'
import { canCarry, trailersFor } from '../logistics/trailer'
import { BREAKDOWN_MTBF_KM, needsService, serviceCost } from '../logistics/wear'
import { Rng } from '../rng'
import { dateFromTick } from '../time'
import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../types'
import type {
  BuildingType,
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
  Stop,
  TrailerType,
  Vehicle,
  VehicleClass,
  VehicleId,
} from '../types'
import { buildGraph } from '../world/graph'
import { shortestKm } from '../world/pathfind'
import { MAX_COMMANDS_PER_TICK, MAX_LINE_NAME_LENGTH } from './commands'

// ─── Характер ──────────────────────────────────────────────────────────────

/**
 * Характер компании без характера.
 *
 * Скриптовой компанией может оказаться и та, у которой personality не заполнен
 * (сейв прошлой версии, тестовая фикстура). Осторожный — единственный
 * безопасный выбор по умолчанию: он держит самый большой запас наличности и
 * заводит одну линию, то есть в худшем случае просто ничего не делает.
 */
export const DEFAULT_PERSONALITY: CompetitorPersonality = 'осторожный'

/**
 * Запас наличности, выраженный в СУТКАХ СОБСТВЕННЫХ РАСХОДОВ.
 *
 * Не в рублях и не в долях цены машины — по той же причине, по которой в сутках
 * считается стартовый капитал игрока (START_MONEY в sim/state.ts): рубль
 * ничего не говорит о том, сколько компания протянет, а «неделя расходов»
 * говорит. Конкурент с пятью водителями и терминалом обязан держать больше, чем
 * контора на одну машину, и это выходит само.
 *
 * Характер меняет ЗАПАС, а не силу: агрессивный живёт на половине недели и
 * потому раньше расширяется и чаще разоряется, осторожный держит две недели и
 * растёт медленно. Это и есть разница стратегий, выраженная одним числом.
 */
export const RESERVE_DAYS_BASE = 7

export const RESERVE_DAYS: Record<CompetitorPersonality, number> = {
  агрессивный: RESERVE_DAYS_BASE / 2,
  осторожный: RESERVE_DAYS_BASE * 2,
  нишевый: RESERVE_DAYS_BASE,
  имитатор: RESERVE_DAYS_BASE,
}

/**
 * Сколько линий характер готов вести одновременно.
 *
 * Потолок нужен не ради экономии, а ради узнаваемости поведения: конкурент,
 * который лезет во все шесть цепочек сразу, читается как шум, а не как
 * противник с намерением. Осторожный доводит до ума одно кольцо, нишевый держит
 * два по своей цепочке, агрессивный и имитатор расползаются по карте.
 */
export const MAX_LINES: Record<CompetitorPersonality, number> = {
  агрессивный: 3,
  осторожный: 1,
  нишевый: 2,
  имитатор: 3,
}

/**
 * Какую долю расчётной потребности кольца в машинах характер выкупает.
 *
 * Осторожный берёт половину: недогруженное кольцо возит меньше, зато машина не
 * стоит в очереди и не проедает зарплату впустую. Остальные комплектуют кольцо
 * целиком.
 */
export const FLEET_SHARE: Record<CompetitorPersonality, number> = {
  агрессивный: 1,
  осторожный: 0.5,
  нишевый: 1,
  имитатор: 1,
}

/**
 * Потолок парка на одну линию.
 *
 * Расчёт потребности (см. fleetForRing) на коротком плече даёт числа вроде
 * двенадцати машин — столько кольцо действительно прокормит по тоннажу, но
 * упрётся в посты раньше, чем в груз: базовый пост в узле ровно один
 * (BASE_POSTS в data/infrastructure.ts). Шесть — это парк, который узел с
 * терминалом (1 + 3 поста) ещё способен обслуживать без вечной очереди.
 */
export const MAX_FLEET_PER_LINE = 6

/**
 * Сколько конкурент терпит очередь, прежде чем строить терминал.
 *
 * Четыре часа простоя — это половина смены водителя (MAX_SHIFT_HOURS = 9),
 * потерянная на ожидании рампы. Меньше терпеть нельзя: разовая очередь бывает у
 * всех, и терминал за 90 000 в ответ на неё — это расход навсегда за случайность
 * (upkeepPerDay в data/infrastructure.ts). Больше — значит платить зарплату за
 * стояние дольше, чем стоит сам терминал.
 */
export const QUEUE_PATIENCE_TICKS = 4 * TICKS_PER_HOUR

/**
 * Во сколько раз час за рулём растягивается в календарное время.
 *
 * Выводится из режима труда и отдыха (driver.ts), а не пишется числом: цикл
 * «смена плюс отдых» длится MAX_SHIFT_HOURS + REST_HOURS часов, а едет машина
 * только MAX_SHIFT_HOURS из них. Значит девятичасовое плечо занимает двадцать
 * часов календаря, и всё, что считается «в сутки», обязано считаться по этому
 * растянутому времени.
 *
 * ЗАЧЕМ ЭТО В ЭКОНОМИКЕ, А НЕ ТОЛЬКО В РАСЧЁТЕ ПАРКА. Зарплата капает и на
 * стоянке (см. DRIVER_WAGE_PER_DAY в data/operating.ts). Посчитай оборот по
 * чистому ходовому времени — и водитель окажется вдвое дешевле, чем он есть,
 * причём тем сильнее, чем длиннее плечо. Кольцо Смоленск — Ярославль — Москва
 * при таком счёте выглядит вдвое прибыльнее настоящего.
 */
export const SHIFT_STRETCH = (MAX_SHIFT_HOURS + REST_HOURS) / MAX_SHIFT_HOURS

/**
 * Сколько человек конкурент держит в резерве, пока ищет допуск.
 *
 * Один. Допуск (ДОПОГ под наливные, длинномер под кругляк) на рынке труда
 * выпадает не всякому кандидату — вероятность зашита в наём (driver.ts), — а без
 * него две цепочки мира из трёх для компании закрыты. Значит искать приходится
 * перебором: нанял, посмотрел допуски, не подошёл — отпустил и взял следующего.
 * Резерв в одного человека делает этот перебор ограниченным по расходу
 * (одна ставка в сутки) и по времени (кандидат меняется вместе с номером тика).
 */
export const LICENCE_RESERVE = 1

// ─── План кольца ───────────────────────────────────────────────────────────

/**
 * Замысел конкурента: какое кольцо он строит и чем собирается его возить.
 *
 * Экспортируется ради тестов и интерфейса: «что этот конкурент задумал» —
 * вопрос, на который приятно уметь отвечать, не разбирая список команд.
 */
export type ScriptedPlan = {
  /** Устойчивый ключ плана: города кольца через дефис. Для разрыва ничьих. */
  key: string
  /** Имя будущей линии — оно же попадёт игроку в панель конкурентов. */
  name: string
  stops: Stop[]
  cities: CityId[]
  /**
   * Города, которые кольцо ЗАНИМАЕТ: источник и переработка.
   *
   * Отделены от сбытовой остановки намеренно, и от этого зависит вся разница
   * характеров. Соперничество идёт у ворот заводов — за груз на складе и за
   * посты под погрузкой; рынок сбыта общий, и «занять» Москву нельзя: спрос там
   * на порядок больше любого парка. Считай сбыт территорией — и осторожный
   * конкурент не нашёл бы ни одного свободного кольца во всём мире, потому что
   * продукцию все везут в одну и ту же столицу.
   */
  claimCities: CityId[]
  /** Грузы, которые кольцо возит. Нужны для допусков и для фразы. */
  cargoes: CargoType[]
  /** Кузов, в котором едут ОБА груза кольца. */
  trailer: TrailerType
  /** Класс машины, под который считалась экономика. */
  classId: string
  /** Длина кольца, км. */
  ringKm: number
  /** Прибыль кольца за час работы одной машины, рубли. */
  profitPerHour: number
  /** Сколько машин кольцо прокормит по тоннажу и по режиму труда. */
  fleetTarget: number
  /** Сырьё «туда» и продукция «обратно». У копии чужой линии не определены. */
  raw: CargoType | null
  product: CargoType | null
  /** Своё кольцо или скопированное у игрока. */
  origin: 'своё' | 'копия'
  /** В этих городах уже кто-то работает. */
  rival: boolean
}

type Step = { command: Command; thought: string }
type Decision = { commands: Command[]; thought: string }

// ─── Наружу ────────────────────────────────────────────────────────────────

/**
 * Что компания делает в этот момент. Пустой список — ничего не делает.
 *
 * Команды возвращаются, а не применяются: их проверит и применит фаза команд.
 * Незаконную сюда класть незачем — она будет молча отброшена, и конкурент
 * потеряет ход, — поэтому каждое условие ниже повторяет правило соответствующей
 * команды (деньги, год выпуска, совместимость прицепа, занятость места).
 */
export function scriptedCommands(
  state: GameState,
  companyId: CompanyId,
): Command[] {
  return decide(state, companyId).commands
}

/**
 * Короткая фраза для ленты рассуждений — про ТО ЖЕ решение, что в командах.
 *
 * Она попадает в Company.thinking вместо ответа модели (Thought.fromModel =
 * ложь), поэтому по стилю обязана быть неотличима: первое лицо, одно
 * соображение, никаких списков и цифр из отладки. Игрок не должен угадывать по
 * тексту, кто сейчас за конкурента — модель или скрипт.
 */
export function scriptedThought(
  state: GameState,
  companyId: CompanyId,
): string {
  return decide(state, companyId).thought
}

// ─── Решение целиком ───────────────────────────────────────────────────────

/**
 * Одно решение конкурента: команды и объяснение.
 *
 * ПОРЯДОК ПРОВЕРОК — ЭТО И ЕСТЬ СТРАТЕГИЯ, и он выбран так:
 *
 *   1. нет линии            → построить кольцо; без сети остальное бессмысленно
 *   2. машина просит ТО     → дешевле обслужить, чем чинить на обочине
 *   3. некомплект           → посадить водителя, вывести машину на линию (даром)
 *   4. нет кузова           → прицеп; тягач без него не берёт груз вовсе
 *   5. машина без человека  → нанять; она не тронется с места
 *   6. очередь на погрузке  → терминал; новые машины встанут в ту же очередь
 *   7. кольцу мало машин    → купить
 *
 * Шестое перед седьмым не по вкусу: покупать технику в узел, где уже стоит
 * очередь, — самый дорогой способ ничего не изменить. Сначала расшить, потом
 * докупать.
 *
 * ПЛАТНОЕ ДЕЙСТВИЕ ЗА РЕШЕНИЕ РОВНО ОДНО. Две покупки в одной пачке проверяются
 * на законность по одному и тому же остатку на счету, и вторая либо отберёт у
 * компании резерв, либо будет отброшена как незаконная — то есть ход всё равно
 * потерян. Бесплатных действий (посадить, назначить) в пачке может быть
 * сколько угодно: они ничего не стоят и друг другу не мешают.
 */
function decide(state: GameState, companyId: CompanyId): Decision {
  const company: Company | undefined = state.companies[companyId]
  if (company === undefined) return { commands: [], thought: '' }

  // Банкрот не распоряжается ничем: партия для него окончена, и расходов ему
  // больше не начисляют (freeze в economy/operating.ts).
  if (company.bankrupt) {
    return { commands: [], thought: 'Контора закрыта. Распоряжений больше нет.' }
  }

  /*
   * ОЧЕРЕДЬ КОМАНД НЕ ПОПОЛНЯЕТСЯ, ПОКА НЕ РАЗОБРАНА ПРЕЖНЯЯ. Скрипт зовут
   * каждый тик, а применяется очередь один раз; без этой проверки одно и то же
   * «купить машину» легло бы в очередь четырежды за час и разорило бы контору
   * на технике, которой некому управлять. Поле pendingCommands может
   * отсутствовать в сейве прошлой версии — тогда очередь пуста, а не падение.
   */
  const pending: Command[] = company.pendingCommands ?? []
  if (pending.length > 0) {
    return { commands: [], thought: 'Прошлые распоряжения ещё в работе — жду.' }
  }

  const personality = company.personality ?? DEFAULT_PERSONALITY
  const plan = choosePlan(state, company, personality)
  if (plan === null) {
    return {
      commands: [],
      thought: 'Связки с гружёным обратным плечом не вижу. Не лезу.',
    }
  }

  const line = findLine(company, plan)
  if (line === undefined) {
    return toDecision([
      {
        command: {
          kind: 'создать-линию',
          // Имя обрезается по тому же пределу, по которому его проверяет
          // законность (MAX_LINE_NAME_LENGTH): длинное имя не «некрасивое», а
          // НЕЗАКОННОЕ, то есть потерянный ход. Копия чужой линии с длинным
          // названием — самый вероятный способ в него упереться.
          name: plan.name.slice(0, MAX_LINE_NAME_LENGTH),
          stops: copyStops(plan.stops),
        },
        thought: openingThought(state, plan, personality),
      },
    ])
  }

  const reserve = cashReserve(company, personality)
  const all = ownVehicles(state, companyId)
  /*
   * СЛОМАННАЯ МАШИНА ВЫЧЁРКИВАЕТСЯ ИЗ ПАРКА ДЛЯ ВСЕХ ОСТАЛЬНЫХ РЕШЕНИЙ.
   * Починить её конкурент не может: команды ремонта в контракте нет вовсе
   * (см. Command в types.ts — «обслужить» это ТО, а не ремонт), а значит она
   * больше не машина, а обязательство. Считать её рабочей — значит не купить ей
   * замену и остаться с кольцом, по которому некому ездить.
   */
  const fleet = all.filter((vehicle) => !vehicle.brokenDown)

  // Списание и увольнение занимают ход целиком: каждое из них меняет расклад
  // настолько, что следующее решение честнее принять уже по новому состоянию.
  const writeOff = writeOffStep(company, all, line)
  if (writeOff !== null) return toDecision(writeOff)

  /*
   * СКОЛЬКО МАШИН НУЖНО И МОЖЕМ ЛИ МЫ ЕЩЁ ОДНУ — считается один раз и на два
   * решения сразу, потому что это ОДИН вопрос, заданный с двух сторон. Покупка
   * спрашивает «брать ли ещё машину», увольнение — «нужен ли ещё человек», и
   * ответ у них обязан быть общий. Разойдись они, и контора начнёт увольнять
   * водителя ровно за тик до покупки машины, под которую его же и нанимала.
   */
  const target = fleetTarget(plan, personality)
  const growth =
    fleet.length < target ? affordableClass(state, company, plan, reserve) : null

  /*
   * ЗАРАБАТЫВАЮЩАЯ МАШИНА — это кузов ПЛЮС человек с допуском. Не «машина есть»,
   * а «эта машина может взять груз кольца прямо сейчас».
   *
   * От этого различения зависит порог трат (floor), и оно единственное
   * исключение из правила резерва во всём файле. Резерв бережёт от РАСШИРЕНИЯ:
   * не бери третью машину, если нечем платить за две. Но пока ни одна машина не
   * способна заработать, беречь нечего — компания просто платит зарплату и ждёт
   * смерти, а расход, без которого не будет выручки, это не трата, а условие
   * работы.
   *
   * Замеры стартового конкурента (тент, 25 000, цистерна за 21 000):
   *   с резервом на кузов   — не хватало восьмисот рублей, вставал навсегда;
   *   с резервом на наём    — покупал цистерну и не мог нанять человека к ней,
   *                           потому что «на неделю зарплаты не осталось».
   * Оба раза контора умирала с исправным кольцом в списке линий и нетронутым
   * планом, и оба раза виноват был порог, придуманный для расширения.
   */
  const earning = fleet.some((vehicle) => {
    if (!plan.cargoes.some((cargo) => canCarry(vehicle.trailer, cargo))) {
      return false
    }
    const driver =
      vehicle.driverId === null ? undefined : company.drivers?.[vehicle.driverId]
    return driver !== undefined && licensedFor(driver, plan.cargoes)
  })
  const floor = earning ? reserve : 0

  /*
   * ПОДЪЁМНО ЛИ КОЛЬЦО ВООБЩЕ. Три способа выйти на него: своя машина уже под
   * этот груз, своей машине хватает денег на нужный кузов, или хватает на новую
   * машину целиком. Ни одного — значит план пока не про эту контору, и тратить
   * на него зарплату нанятого человека нельзя.
   */
  const trailerPrice = TRAILER_PRICE[plan.trailer]
  const fieldable =
    growth !== null ||
    fleet.some((vehicle) =>
      plan.cargoes.some((cargo) => canCarry(vehicle.trailer, cargo)),
    ) ||
    (trailerPrice !== undefined &&
      affordable(company, trailerPrice, floor) &&
      fleet.some((vehicle) =>
        VEHICLE_CLASS_BY_ID[vehicle.classId]?.trailers.includes(plan.trailer),
      ))

  const parting = fireStep(state, company, fleet, plan, growth !== null)
  if (parting !== null) return toDecision(parting)

  const paid =
    serviceStep(company, fleet, reserve) ??
    trailerStep(company, fleet, plan, floor) ??
    hireStep(state, company, fleet, plan, floor, fieldable) ??
    terminalStep(state, company, fleet, reserve) ??
    buyStep(company, fleet, plan, target, growth)

  const free = staffingSteps(state, company, fleet, plan, line, target)

  if (paid === null && free.length === 0) {
    // Две разные тишины, и путать их в ленте нельзя. Кольцо работает и денег на
    // рост пока нет — это одно; кольцо есть, а выйти на него не на что — совсем
    // другое, и игрок обязан видеть разницу.
    return {
      commands: [],
      thought: earning
        ? `Кольцо «${line.name}» укомплектовано. Коплю.`
        : `Кольцо «${line.name}» стоит: не на что выйти. Жду.`,
    }
  }

  return toDecision(paid === null ? free : [paid, ...free])
}

/**
 * Пачка шагов в решение: главным считается первый, он и объясняется.
 *
 * Список обрезается по MAX_COMMANDS_PER_TICK — тому же потолку, по которому
 * фаза команд отбрасывает хвост очереди. Обрезать здесь важнее, чем кажется:
 * отброшенное фазой уходит молча, и конкурент, приславший тринадцать команд,
 * потерял бы тринадцатую, не зная об этом. Раз потолок всё равно есть, лучше
 * решить самим, ЧТО именно не влезло, — а порядок шагов у нас как раз по
 * важности.
 */
function toDecision(steps: readonly Step[]): Decision {
  const kept = steps.slice(0, MAX_COMMANDS_PER_TICK)
  return {
    commands: kept.map((step) => step.command),
    thought: kept.length > 0 ? kept[0].thought : '',
  }
}

// ─── Выбор кольца ──────────────────────────────────────────────────────────

/**
 * Какое кольцо конкурент строит сейчас.
 *
 * НАЧАТОЕ ДОВОДИТСЯ ДО КОНЦА. Если у компании уже есть линия под один из
 * планов и парк на ней не собран, выбирается именно она — иначе конкурент
 * метался бы между кольцами при каждом изменении мира, оставляя за собой
 * недоукомплектованные линии и половину парка без задания. Новое кольцо
 * открывается, только когда прежнее собрано.
 */
function choosePlan(
  state: GameState,
  company: Company,
  personality: CompetitorPersonality,
): ScriptedPlan | null {
  const ranked = rankedPlans(state, company, personality)
  if (ranked.length === 0) return null

  const started = ranked.find((plan) => {
    const line = findLine(company, plan)
    if (line === undefined) return false
    return (
      vehiclesOnLine(state, company.id, line.id).length <
      fleetTarget(plan, personality)
    )
  })
  if (started !== undefined) return started

  // Потолок линий: сеть шире характера не растёт. Считаются СВОИ линии, а не
  // планы: линия, оставшаяся от прежнего замысла, тоже занимает место и тоже
  // стоит денег.
  const lines = Object.keys(company.lines ?? {}).length
  if (lines >= MAX_LINES[personality]) {
    // Место кончилось — работаем по тому кольцу, которое уже есть.
    return ranked.find((plan) => findLine(company, plan) !== undefined) ?? null
  }

  return ranked[0]
}

/**
 * Все осмысленные кольца мира, отсортированные ПОД ХАРАКТЕР.
 *
 * Сортировка лексикографическая по нескольким ключам, а не сумма с весами. Вес
 * пришлось бы подбирать, и подобранный однажды он молча перестал бы работать
 * при первой перебалансировке тарифа; ключи же выражают приоритет прямо:
 *
 *   1. ХАРАКТЕР. Агрессивный лезет туда, где работает игрок; осторожный обходит
 *      занятое стороной; нишевый признаёт только свой груз; имитатор берёт
 *      копию чужой линии.
 *   2. ЛЮДИ. Кольцо, на которое некого посадить (нет допуска ДОПОГ под топливо,
 *      нет длинномера под кругляк), уходит вниз — но не выбрасывается: допуск
 *      придёт со следующим наймом, а бросать из-за него целую цепочку значит
 *      навсегда отдать игроку две трети карты.
 *   3. ДЕНЬГИ. Прибыль кольца за час работы машины.
 *   4. ИМЯ. Разрыв ничьих, чтобы порядок не зависел от порядка ключей объекта.
 */
function rankedPlans(
  state: GameState,
  company: Company,
  personality: CompetitorPersonality,
): ScriptedPlan[] {
  const playerCities = citiesOf(state, state.playerId)
  const takenCities = new Set<CityId>()
  for (const id of Object.keys(state.companies) as CompanyId[]) {
    if (id === company.id) continue
    for (const city of citiesOf(state, id)) takenCities.add(city)
  }

  const rings = ringPlans(state)
  const copies = personality === 'имитатор' ? copyPlans(state, company) : []

  const plans = [...copies, ...rings].map((plan) => ({
    ...plan,
    rival: plan.claimCities.some((city) => takenCities.has(city)),
  }))
  if (plans.length === 0) return []

  const niche =
    personality === 'нишевый' ? nicheCargo(company.id, plans) : null

  const keyed = plans.map((plan) => ({
    plan,
    keys: [
      characterKey(plan, personality, playerCities, niche),
      staffed(company, plan) ? 0 : 1,
      -plan.profitPerHour,
    ],
  }))

  keyed.sort((a, b) => {
    for (let i = 0; i < a.keys.length; i++) {
      if (a.keys[i] !== b.keys[i]) return a.keys[i] - b.keys[i]
    }
    return a.plan.key < b.plan.key ? -1 : a.plan.key > b.plan.key ? 1 : 0
  })

  return keyed.map((item) => item.plan)
}

/** Первый ключ сортировки — тот самый, которым характер меняет стратегию. */
function characterKey(
  plan: ScriptedPlan,
  personality: CompetitorPersonality,
  playerCities: ReadonlySet<CityId>,
  niche: CargoType | null,
): number {
  switch (personality) {
    // Лезет в города, где уже работает игрок: отбирать груз у сильного
    // выгоднее, чем осваивать пустое направление, — если хватает наглости.
    case 'агрессивный':
      return plan.claimCities.some((city) => playerCities.has(city)) ? 0 : 1
    // Выбирает свободные направления: там некому перехватывать груз со складов
    // и не с кем делить посты.
    case 'осторожный':
      return plan.rival ? 1 : 0
    // Возит один груз и возит его лучше всех: один кузов на весь парк, один
    // допуск у водителей, взаимозаменяемые машины.
    case 'нишевый':
      return niche !== null && plan.product === niche ? 0 : 1
    // Копирует игрока. Своё кольцо — только если копировать ещё нечего.
    case 'имитатор':
      return plan.origin === 'копия' ? 0 : 1
  }
}

/**
 * Ниша — один груз на всю партию, выведенный ИЗ ИМЕНИ КОМПАНИИ.
 *
 * Отдельный поток Rng.forKey, а не общий rngState: выбор обязан быть
 * постоянным для этой компании и не должен зависеть ни от тика, ни от того,
 * сколько раз до этого дёрнули основной поток (см. разбор у hireDriver в
 * logistics/driver.ts). Иначе «нишевый» менял бы нишу каждый тик, то есть
 * перестал бы быть нишевым.
 */
function nicheCargo(
  companyId: CompanyId,
  plans: readonly ScriptedPlan[],
): CargoType | null {
  const products: CargoType[] = []
  for (const plan of plans) {
    if (plan.product === null) continue
    if (!products.includes(plan.product)) products.push(plan.product)
  }
  if (products.length === 0) return null

  // Сортировка — часть детерминизма: порядок предприятий в мире может
  // измениться от правки данных, а ниша компании меняться от этого не должна.
  products.sort()
  return Rng.forKey(`${companyId}/ниша`).pick(products)
}

/** Есть ли в штате люди с допусками под все грузы кольца. */
function staffed(company: Company, plan: ScriptedPlan): boolean {
  const drivers = Object.values(company.drivers ?? {})

  for (const cargo of plan.cargoes) {
    const license = CARGO_LICENSE[cargo]
    if (license === undefined) continue
    if (!drivers.some((driver) => driver.licenses.includes(license))) {
      return false
    }
  }
  return true
}

/**
 * Кольца мира: «источник → переработка → сбыт → источник».
 *
 * Источником считается ЛЮБОЕ предприятие, выпускающее нужное сырьё, а не только
 * то, у которого пустой вход: цепочка из трёх переделов замкнётся сама собой,
 * если такая появится в данных.
 *
 * Сбытовая остановка перебирается по ВСЕМ городам, включая сам город источника.
 * Совпали — кольцо схлопывается в две остановки и порожнего плеча в нём нет
 * вовсе; это лучшая из возможных форм, и она выигрывает сама, без всякого
 * предпочтения в коде, как только город источника способен съедать привозимое.
 * Разбор того, почему в нынешних данных выигрывает не она, — в шапке файла.
 *
 * Отвергается кольцо по трём причинам, и все три содержательные:
 *   • нет кузова под оба груза — тогда это не кольцо, а два разных рейса;
 *   • точка выгрузки не съедает то, что машина привозит, — кольцо запрёт машину;
 *   • оборот не окупает пробег — то есть нарушен главный инвариант игры.
 */
function ringPlans(state: GameState): ScriptedPlan[] {
  const graph = buildGraph(state.world.edges)
  const industries = Object.values(state.world.industries)
  const cityIds = Object.keys(state.world.cities) as CityId[]
  const plans: ScriptedPlan[] = []

  for (const works of industries) {
    const recipe = RECIPE_BY_INDUSTRY[works.type]
    if (recipe === undefined || recipe.inputs.length === 0) continue

    const product = recipe.output

    for (const input of recipe.inputs) {
      const raw = input.type
      const trailer = sharedTrailer(raw, product)
      // Нет кузова, берущего оба груза, — кольцо возможно только в одну
      // сторону, а это уже не кольцо. Такую пару конкурент не рассматривает.
      if (trailer === null) continue

      // Сколько сырья кольцо может увозить и сколько его примут на месте.
      const rawSink = sinkPerDay(state, works.cityId, raw)

      for (const source of industries) {
        const sourceRecipe = RECIPE_BY_INDUSTRY[source.type]
        if (sourceRecipe === undefined || sourceRecipe.output !== raw) continue
        // Предприятия в одном городе связаны транспортёром, а не машиной.
        if (source.cityId === works.cityId) continue

        const legRaw = shortestKm(graph, source.cityId, works.cityId)
        if (!Number.isFinite(legRaw) || legRaw <= 0) continue

        for (const sale of cityIds) {
          // Сдавать продукцию там же, где её взяли, бессмысленно: плечо нулевое,
          // выручки за него нет (deliveryRevenue не платит за нулевой путь).
          if (sale === works.cityId) continue

          const productSink = sinkPerDay(state, sale, product)
          if (!(productSink > 0)) continue

          const legProduct = shortestKm(graph, works.cityId, sale)
          if (!Number.isFinite(legProduct) || legProduct <= 0) continue

          // Порожнее плечо домой. Ноль — сбыт совпал с источником, и кольцо
          // получилось из двух остановок.
          const legHome =
            sale === source.cityId
              ? 0
              : shortestKm(graph, sale, source.cityId)
          if (!Number.isFinite(legHome)) continue

          const legs: Leg[] = [
            { cargo: raw, km: legRaw },
            { cargo: product, km: legProduct },
            { cargo: null, km: legHome },
          ]

          const vehicleClass = bestClassFor(state, trailer, legs)
          if (vehicleClass === null) continue

          const money = ringEconomy(vehicleClass, legs)
          /*
           * ОТСЕИВАЕТСЯ ПО ДОРОЖНОЙ МАРЖЕ, А ВЫБИРАЕТСЯ ПО ПОЛНОЙ ПРИБЫЛИ, и
           * это не полумера. Порог — главный инвариант игры (два гружёных плеча
           * окупают пробег, одно не окупает), и он записан через переменные
           * расходы; кольцо, не проходящее его, бессмысленно физически. Всё
           * остальное — зарплата, отдых, амортизация — решает не «можно ли
           * работать», а «что выгоднее», и потому живёт в сортировке.
           *
           * Разница видна сразу: по полной прибыли в нынешних данных проходят
           * ровно два кольца из всех, и характеры перестают что-либо значить —
           * агрессивному, осторожному и нишевому просто не из чего выбирать.
           * По дорожной марже проходит десяток, и стратегия снова становится
           * выбором, а не единственно возможным ходом.
           */
          if (!(money.marginPerCycle > 0)) continue

          // Сколько тонн одна машина подаёт в сутки на КАЖДУЮ точку выгрузки.
          const perVehicle = vehicleClass.capacity * money.cyclesPerDay
          // Точка, которая столько не съест, запрёт машину гружёной — разбор в
          // шапке файла. Отвергаем кольцо целиком: возить меньше нельзя, кузов
          // грузится целиком (Stop в types.ts не знает про тонны).
          if (perVehicle > rawSink || perVehicle > productSink) continue

          const flow = Math.min(
            sourceRecipe.dailyRate,
            rawSink,
            recipe.dailyRate,
            productSink,
          )

          const stops: Stop[] =
            legHome === 0
              ? [
                  // Две остановки: продукция сдаётся там же, где берут сырьё.
                  { nodeId: source.cityId, unload: [product], load: [raw] },
                  { nodeId: works.cityId, unload: [raw], load: [product] },
                ]
              : [
                  { nodeId: source.cityId, unload: [], load: [raw] },
                  { nodeId: works.cityId, unload: [raw], load: [product] },
                  { nodeId: sale, unload: [product], load: [] },
                ]

          plans.push({
            key: `${source.cityId}-${works.cityId}-${sale}-${raw}`,
            name: ringName(state, stops),
            stops,
            cities: stops.map((stop) => stop.nodeId),
            claimCities: [source.cityId, works.cityId],
            cargoes: [raw, product],
            trailer,
            classId: vehicleClass.id,
            ringKm: legRaw + legProduct + legHome,
            profitPerHour: money.profitPerHour,
            fleetTarget: fleetForRing(perVehicle, flow),
            raw,
            product,
            origin: 'своё',
            rival: false,
          })
        }
      }
    }
  }

  return plans
}

/**
 * Сколько тонн этого груза город способен принимать в сутки.
 *
 * Считается по ОБОИМ получателям сразу: жители (demandPerDay из
 * economy/consumption.ts — та же функция, по которой город и ест) и заводы,
 * которым груз нужен как сырьё (перечень входов из рецепта). Второе слагаемое в
 * нынешних данных отвечает за все сырьевые плечи, первое — за сбыт продукции.
 *
 * Собственная формула спроса здесь была бы худшим из возможных решений: она
 * разъехалась бы с потреблением при первой же правке норм, и конкурент возил бы
 * туда, где его давно не ждут.
 */
export function sinkPerDay(
  state: GameState,
  cityId: CityId,
  cargo: CargoType,
): number {
  let tons = 0

  const city = state.world.cities[cityId]
  if (city !== undefined) tons += demandPerDay(city.population, cargo)

  for (const industry of Object.values(state.world.industries)) {
    if (industry.cityId !== cityId) continue

    const recipe = RECIPE_BY_INDUSTRY[industry.type]
    if (recipe === undefined) continue

    for (const input of recipe.inputs) {
      if (input.type === cargo) tons += recipe.dailyRate * input.perUnit
    }
  }

  return tons
}

/** Имя линии: города через дефис, в порядке обхода. */
function ringName(state: GameState, stops: readonly Stop[]): string {
  return stops.map((stop) => cityName(state, stop.nodeId)).join(' — ')
}

/**
 * Копии линий игрока — для имитатора.
 *
 * ЗАДЕРЖКА ВЫРАЖЕНА НЕ ТАЙМЕРОМ, А УСЛОВИЕМ: копируется только линия, на
 * которой уже РАБОТАЮТ машины игрока. Пока игрок чертит кольцо в редакторе,
 * имитатор его не видит; как только по кольцу поехали — повторяет. Так
 * получается и естественное отставание на несколько суток, и содержательный
 * смысл: имитатор копирует то, что доказало работоспособность, а не всякий
 * набросок. Отдельного поля под «когда я это увидел» в types.ts нет, и заводить
 * его ради таймера значило бы тащить в сохранение состояние, выводимое из мира.
 */
function copyPlans(state: GameState, company: Company): ScriptedPlan[] {
  const player: Company | undefined = state.companies[state.playerId]
  if (player === undefined || player.id === company.id) return []

  const graph = buildGraph(state.world.edges)
  const plans: ScriptedPlan[] = []

  for (const line of Object.values(player.lines ?? {})) {
    if (line.stops.length < MIN_LINE_STOPS) continue

    const working = vehiclesOnLine(state, player.id, line.id)
    if (working.length === 0) continue

    const cargoes: CargoType[] = []
    for (const stop of line.stops) {
      for (const cargo of stop.load) {
        if (!cargoes.includes(cargo)) cargoes.push(cargo)
      }
    }
    // Линия, на которой ничего не грузят, — не маршрут, а перегон.
    if (cargoes.length === 0) continue

    const trailer = trailerForAll(cargoes)
    if (trailer === null) continue

    const ringKm = ringLength(graph, line.stops)
    if (!Number.isFinite(ringKm) || ringKm <= 0) continue

    // Экономика копии считается по СРЕДНЕМУ плечу: точный расчёт по каждому
    // плечу требовал бы знать, что именно едет на каждом из них, а этого нет
    // даже у самого игрока — грузы на остановках заданы списками. Гружёными
    // считаются два плеча: копируется рабочее кольцо, а не набросок.
    const legKm = ringKm / line.stops.length
    const legs: Leg[] = line.stops.map((_stop, index) => ({
      cargo: index < cargoes.length ? cargoes[index] : null,
      km: legKm,
    }))

    const vehicleClass = bestClassFor(state, trailer, legs)
    if (vehicleClass === null) continue

    const money = ringEconomy(vehicleClass, legs)
    if (!(money.marginPerCycle > 0)) continue

    plans.push({
      key: `копия-${line.id}`,
      name: `${line.name} (по-своему)`,
      stops: copyStops(line.stops),
      cities: line.stops.map((stop) => stop.nodeId),
      // Копия претендует на ВСЕ города чужой линии: имитатор и приходит за
      // чужим — тем и отличается от осторожного.
      claimCities: line.stops.map((stop) => stop.nodeId),
      cargoes,
      trailer,
      classId: vehicleClass.id,
      ringKm,
      profitPerHour: money.profitPerHour,
      // Парк тоже копируется: если игроку на этом кольце хватает трёх машин,
      // значит и здесь их примерно столько.
      fleetTarget: Math.min(working.length, MAX_FLEET_PER_LINE),
      raw: null,
      product: null,
      origin: 'копия',
      rival: false,
    })
  }

  return plans
}

// ─── Экономика кольца ──────────────────────────────────────────────────────

/** Плечо кольца: что везём и сколько километров. null — идём порожняком. */
type Leg = { cargo: CargoType | null; km: number }

type RingMoney = {
  /** КАЛЕНДАРНЫХ часов на оборот: дорога, обязательный отдых и посты. */
  cycleHours: number
  /** Оборотов в сутки. */
  cyclesPerDay: number
  /**
   * Выручка оборота минус ПЕРЕМЕННЫЕ дорожные расходы, рубли.
   *
   * ЭТО И ЕСТЬ ГЛАВНЫЙ ИНВАРИАНТ ИГРЫ, ЗАПИСАННЫЙ СО СТОРОНЫ КОНКУРЕНТА.
   * Инвариант из data/operating.ts сформулирован ровно так: кольцо с одним
   * гружёным плечом не окупает 2·L·c, с двумя — окупает, где c — переменные
   * расходы на километр. Ни зарплаты, ни амортизации в нём нет намеренно: это
   * постоянные статьи, они не зависят от того, гружён ты или порожняком.
   *
   * Поэтому именно по этому числу кольцо ОТСЕИВАЕТСЯ: отрицательное означает,
   * что рейс не окупает даже солярку, и никакая экономия на прочем его не
   * спасёт. А вот ВЫБИРАЕТСЯ кольцо по profitPerHour, где посчитано всё.
   */
  marginPerCycle: number
  /** Прибыль за календарный час со всеми статьями, рубли. */
  profitPerHour: number
}

/**
 * Сколько кольцо приносит в час.
 *
 * Считается ТЕМИ ЖЕ ФУНКЦИЯМИ, что и настоящая выручка (deliveryRevenue) и
 * настоящие расходы (costPerKm). Своя формула здесь была бы худшим из
 * возможных решений: конкурент оценивал бы мир по числам, которых в нём нет, и
 * первая же перебалансировка тарифа сделала бы его или дураком, или читером,
 * причём молча.
 *
 * ВРЕМЯ СЧИТАЕТСЯ КАЛЕНДАРНОЕ, А НЕ ХОДОВОЕ. Час за рулём стоит компании
 * SHIFT_STRETCH календарных часов, потому что водителю положен отдых, а
 * зарплата капает и на стоянке. Разница не косметическая: на плече в шестьсот
 * километров ходовой счёт занижает зарплату оборота вдвое.
 *
 * Зарплата входит в расчёт, хотя в главный инвариант она не входит: инвариант
 * записан через переменные расходы, а конкуренту нужно знать, останется ли
 * что-нибудь ПОСЛЕ постоянных статей. Кольцо, которое отбивает солярку, но не
 * отбивает водителя, — это не работа, а благотворительность.
 */
function ringEconomy(vc: VehicleClass, legs: readonly Leg[]): RingMoney {
  let km = 0
  let revenue = 0
  let loaded = 0

  for (const leg of legs) {
    if (!Number.isFinite(leg.km) || leg.km < 0) continue
    km += leg.km
    if (leg.cargo === null || leg.km === 0) continue

    loaded++
    revenue += deliveryRevenue(
      leg.cargo,
      vc.capacity,
      leg.km,
      vc.tariffPerTonKm,
      vc.handlingPerTon,
    )
  }

  // Каждое гружёное плечо занимает пост дважды: погрузка на одном конце и
  // выгрузка на другом. Ставка поста — в data/infrastructure.ts.
  const postHours = (2 * loaded * vc.capacity) / TONS_PER_POST_HOUR
  const cycleHours = (km / vc.cruiseKmh) * SHIFT_STRETCH + postHours
  if (!(cycleHours > 0)) {
    return {
      cycleHours: 0,
      cyclesPerDay: 0,
      marginPerCycle: 0,
      profitPerHour: 0,
    }
  }

  const road = km * costPerKm(vc)
  const fixed = km * writeOffPerKm(vc) + DRIVER_WAGE_PER_DAY * (cycleHours / 24)

  return {
    cycleHours,
    cyclesPerDay: 24 / cycleHours,
    marginPerCycle: revenue - road,
    profitPerHour: (revenue - road - fixed) / cycleHours,
  }
}

/**
 * Во что обходится километр СПИСАНИЕМ, рубли.
 *
 * Конкурент не умеет чинить сломанную машину: команды ремонта в контракте нет
 * (разбор — в шапке writeOffStep). Значит первая же поломка превращает машину в
 * убыток на всю её цену вместе с прицепом, а поломки приходят с пробегом —
 * BREAKDOWN_MTBF_KM в logistics/wear.ts. Отсюда и амортизация: цена комплекта,
 * делённая на средний пробег до поломки.
 *
 * ЭТО ОЦЕНКА СВЕРХУ ПО СРОКУ СЛУЖБЫ И СНИЗУ ПО РАСХОДУ: настоящий риск ещё выше,
 * потому что его умножают усталость водителя и плохая дорога (breakdownChance
 * там же). Замеры прогона на год дают средний пробег до поломки около двадцати
 * тысяч вместо шестидесяти. Брать в расчёт множители нельзя — они зависят от
 * того, кто поедет и по какой дороге, а план строится до найма; поэтому берётся
 * паспортная величина, и планировщик остаётся оптимистом ровно настолько,
 * насколько оптимистична сама паспортная надёжность.
 */
function writeOffPerKm(vc: VehicleClass): number {
  const trailer = Math.max(...Object.values(TRAILER_PRICE))
  return (vc.price + trailer) / BREAKDOWN_MTBF_KM
}

/**
 * Сколько машин прокормит кольцо.
 *
 * Поток груза делится на суточную подачу одной машины. Поток — это самое узкое
 * место кольца: выпуск источника, приём переработки, выпуск переработки и спрос
 * в точке сбыта, минимум из четырёх. Считать по одному лишь выпуску значило бы
 * поставить на кольцо парк, который привозит вчетверо больше, чем принимают.
 */
function fleetForRing(perVehicleTons: number, flowTons: number): number {
  if (!(perVehicleTons > 0)) return 1

  const needed = Math.ceil(flowTons / perVehicleTons)
  return Math.max(1, Math.min(MAX_FLEET_PER_LINE, needed))
}

/**
 * Класс машины, на котором кольцо приносит больше всего в час.
 *
 * Не самый дешёвый и не самый большой: у каждого класса свой тариф и своя плата
 * за погрузку (см. шапку data/vehicles.ts), поэтому на коротком плече выигрывает
 * ЗИЛ, а на длинном — тягач, и решать это обязан расчёт, а не предпочтение.
 * Техника из будущего не рассматривается: год берётся из тика, как и в покупке
 * игрока (buyVehicle в app/store.ts).
 */
function bestClassFor(
  state: GameState,
  trailer: TrailerType,
  legs: readonly Leg[],
): VehicleClass | null {
  const year = dateFromTick(state.tick, state.startYear).year

  let best: VehicleClass | null = null
  let bestRate = 0

  for (const vc of VEHICLE_CLASSES) {
    if (vc.availableFrom > year) continue
    if (!vc.trailers.includes(trailer)) continue

    const rate = ringEconomy(vc, legs).profitPerHour
    // Строгое «больше» плюс порядок справочника: при равной прибыли побеждает
    // тот, кто дешевле, — он стоит в справочнике раньше.
    if (best === null || rate > bestRate) {
      best = vc
      bestRate = rate
    }
  }

  return best
}

/** Кузов, в котором поедут оба груза. null — такого кузова нет. */
function sharedTrailer(a: CargoType, b: CargoType): TrailerType | null {
  for (const trailer of trailersFor(a)) {
    if (canCarry(trailer, b)) return trailer
  }
  return null
}

/** Кузов, в котором поедут все перечисленные грузы. */
function trailerForAll(cargoes: readonly CargoType[]): TrailerType | null {
  if (cargoes.length === 0) return null

  for (const trailer of trailersFor(cargoes[0])) {
    if (cargoes.every((cargo) => canCarry(trailer, cargo))) return trailer
  }
  return null
}

/** Длина кольца по кратчайшим путям. Бесконечность — остановка недостижима. */
function ringLength(
  graph: ReturnType<typeof buildGraph>,
  stops: readonly Stop[],
): number {
  let total = 0
  for (let i = 0; i < stops.length; i++) {
    const next = (i + 1) % stops.length
    total += shortestKm(graph, stops[i].nodeId, stops[next].nodeId)
  }
  return total
}

// ─── Шаги: бесплатные ──────────────────────────────────────────────────────

/**
 * Посадить людей за руль и вывести готовые машины на кольцо.
 *
 * Оба действия ничего не стоят, поэтому идут пачкой и без ограничений: машина
 * без водителя не едет вовсе (vehicleSpeedFactor в driver.ts), а машина без
 * линии стоит в гараже. Держать их «на потом» незачем.
 *
 * ВОДИТЕЛЬ ПОДБИРАЕТСЯ ПОД ГРУЗ: первым берётся тот, у кого есть допуски на всё,
 * что возит кольцо, и только если таких нет — любой свободный. Иначе цистерна
 * досталась бы человеку без ДОПОГ, и машина возила бы воздух, ни разу не
 * упершись ни в одну проверку (допуск смотрят при погрузке — canDrive там же).
 */
function staffingSteps(
  state: GameState,
  company: Company,
  fleet: readonly Vehicle[],
  plan: ScriptedPlan,
  line: Line,
  target: number,
): Step[] {
  const steps: Step[] = []

  const seated = new Set<DriverId>()
  const free = freeDrivers(state, company)

  for (const vehicle of fleet) {
    if (vehicle.driverId !== null) continue

    // Водитель, у которого в Driver.vehicleId уже стоит ЭТА машина, пропускается:
    // фаза команд считает такую посадку работой, которой нет, и отбрасывает её
    // как незаконную. Случай редкий (рассинхрон двусторонней связи), но ход
    // терять на нём незачем.
    const fits = (candidate: Driver): boolean =>
      !seated.has(candidate.id) && candidate.vehicleId !== vehicle.id

    const driver =
      free.find(
        (candidate) => fits(candidate) && licensedFor(candidate, plan.cargoes),
      ) ?? free.find(fits)

    // Свободных людей не осталось — эта машина ждёт найма, но соседняя может
    // получить своего: перебор не прерывается.
    if (driver === undefined) continue

    seated.add(driver.id)
    steps.push({
      command: {
        kind: 'посадить-водителя',
        driverId: driver.id,
        vehicleId: vehicle.id,
      },
      thought: `${driver.name} садится за ${vehicleTitle(vehicle)}.`,
    })
  }

  /*
   * ПЕРЕСАДКА: за машину под лицензионный груз садится тот, у кого допуск.
   *
   * Без неё поиск допуска остаётся бесполезным. Своя машина уже укомплектована
   * человеком без ДОПОГ; нанятый с допуском сидит в резерве, потому что пустых
   * сидений нет; кузов есть, кольцо есть, а грузиться нечем — допуск смотрят при
   * погрузке (canDrive в driver.ts), и машина ходит по кольцу порожней. Один
   * приказ «сесть за руль» решает это целиком, а высаженный без допуска
   * становится свободным и достаётся следующей машине или уходит.
   */
  for (const vehicle of fleet) {
    if (vehicle.driverId === null) continue
    // Машина не про это кольцо — кто за рулём, здесь неважно.
    if (!plan.cargoes.some((cargo) => canCarry(vehicle.trailer, cargo))) continue

    const current = company.drivers?.[vehicle.driverId]
    if (current !== undefined && licensedFor(current, plan.cargoes)) continue

    const better = free.find(
      (driver) =>
        !seated.has(driver.id) &&
        driver.vehicleId !== vehicle.id &&
        licensedFor(driver, plan.cargoes),
    )
    if (better === undefined) continue

    seated.add(better.id)
    steps.push({
      command: {
        kind: 'посадить-водителя',
        driverId: better.id,
        vehicleId: vehicle.id,
      },
      thought: `За ${vehicleTitle(vehicle)} садится ${better.name}: у него допуск.`,
    })
  }

  let onLine = vehiclesOnLine(state, company.id, line.id).length

  for (const vehicle of fleet) {
    if (onLine >= target) break
    if (vehicle.lineId !== null) continue
    // Машина без подходящего кузова на это кольцо не годится: прицеп ей купят
    // отдельным шагом, и вот тогда она поедет.
    if (!plan.cargoes.some((cargo) => canCarry(vehicle.trailer, cargo))) continue

    /*
     * И НЕ ВЫПУСКАЕМ МАШИНУ, ЗА РУЛЁМ КОТОРОЙ ЧЕЛОВЕК БЕЗ ДОПУСКА. Она не
     * встанет — она пойдёт по кольцу ПОРОЖНЯКОМ, потому что допуск смотрят при
     * погрузке (canDrive в driver.ts). Замер: сутки такой работы на кольце в
     * 1320 км стоили одиннадцать тысяч рублей и не принесли ни копейки —
     * дороже, чем простой всей конторы за две недели. Пустое сиденье при этом
     * не помеха: машина без водителя стоит и не тратит ничего.
     */
    const atWheel =
      vehicle.driverId === null ? null : company.drivers?.[vehicle.driverId]
    if (atWheel !== null && atWheel !== undefined) {
      if (!licensedFor(atWheel, plan.cargoes)) continue
    }

    onLine++
    steps.push({
      command: {
        kind: 'назначить-машину',
        vehicleId: vehicle.id,
        lineId: line.id,
      },
      thought: `Вывожу ${vehicleTitle(vehicle)} на кольцо «${line.name}».`,
    })
  }

  return steps
}

// ─── Шаги: платные ─────────────────────────────────────────────────────────

/**
 * Списание сломанной машины: снять с линии и высадить водителя.
 *
 * САМОЕ ДОРОГОЕ, ЧТО КОНКУРЕНТ УМЕЕТ НЕ ДЕЛАТЬ, — это оставить сломанную машину
 * на кольце. Замер прогона на 120 суток: одна поломка на третьи сутки
 * остановила ВСЮ линию из трёх машин до конца партии. Механика здесь такая.
 * Диспетчеризация выдерживает интервал между машинами кольца (departureGapKm в
 * logistics/line.ts) — а сломанная машина остаётся в расчёте интервала и не
 * двигается. Идущая за ней упирается в неё и стоит; следующая упирается в
 * стоящую. Кольцо замирает целиком, выручка падает до нуля, зарплата и топливо
 * продолжают уходить. Со стороны это выглядит как «конкурент почему-то встал».
 *
 * Снятая с линии машина в расчёте интервала больше не участвует, и кольцо
 * оживает. Водитель высаживается заодно: он единственное, что можно спасти, —
 * его посадят за следующую купленную машину, а до тех пор он хотя бы не числится
 * за железом, которое никуда не поедет.
 *
 * ЧИНИТ, А НЕ СПИСЫВАЕТ. Первая версия списывала: команды ремонта в контракте
 * не было, и поломка означала для конкурента конец. Замер ревизии: все три
 * соперника ломались на 50–60-е сутки, рабочий парк пустел, и контора просто
 * платила зарплату до банкротства. Команда «починить» добавлена в контракт
 * именно после этого замера.
 *
 * Снятие с линии осталось, но теперь оно временное: машина уходит в ремонт,
 * чинится и возвращается. Держать сломанную на линии нельзя — она стоит в
 * расчёте интервала и запирает всех позади себя.
 */
function writeOffStep(
  _company: Company,
  fleet: readonly Vehicle[],
  line: Line,
): Step[] | null {
  for (const vehicle of fleet) {
    if (!vehicle.brokenDown) continue
    if (vehicle.lineId === null) continue

    // Один шаг, а не снятие с линии и возврат. Ремонт снимает флаг сразу, и
    // машина продолжает работать на том же кольце. Промежуточное снятие
    // выглядело осмысленно, но каждая команда проверяется на законность
    // ОТДЕЛЬНО, а «вернуть на ту же линию» законно лишь после того, как её
    // сняли, — то есть цепочка разваливалась на первой же проверке.
    const steps: Step[] = [
      {
        command: { kind: 'починить', vehicleId: vehicle.id },
        thought: `${vehicleTitle(vehicle)} стоит сломанный и держит кольцо «${line.name}». В ремонт: простой дороже работ.`,
      },
    ]

    return steps
  }

  return null
}

/**
 * Плановое ТО.
 *
 * Дешевле ремонта на обочине в два с лишним раза (SERVICE_COST_KM против
 * REPAIR_COST_KM с надбавкой за эвакуацию в wear.ts), а главное — поломка
 * останавливает всё кольцо, если машина на нём одна. Поэтому обслуживание идёт
 * первым среди платных шагов: это единственная трата, которая ЭКОНОМИТ.
 */
function serviceStep(
  company: Company,
  fleet: readonly Vehicle[],
  reserve: number,
): Step | null {
  for (const vehicle of fleet) {
    if (!needsService(vehicle)) continue

    const price = serviceCost(vehicle)
    if (!affordable(company, price, reserve)) continue

    return {
      command: { kind: 'обслужить', vehicleId: vehicle.id },
      thought: `${vehicleTitle(vehicle)} перехаживает ТО — загоняю в бокс.`,
    }
  }
  return null
}

/**
 * Прицеп под груз кольца.
 *
 * Тягач без кузова не берёт НИЧЕГО (trailer.ts), поэтому машина без прицепа —
 * это не «машина попроще», а стоящее железо с зарплатой водителя. Прицеп
 * покупается только той машине, чей класс его тянет: полуприцеп на бортовой ЗИЛ
 * не повесить, и подбирать «ближайший подходящий» за конкурента нельзя — он
 * выбирает специализацию, а не просит помочь.
 */
function trailerStep(
  company: Company,
  fleet: readonly Vehicle[],
  plan: ScriptedPlan,
  reserve: number,
): Step | null {
  /*
   * КУЗОВ ПОКУПАЕТСЯ РАНЬШЕ, ЧЕМ НАЙДЁТСЯ ЧЕЛОВЕК С ДОПУСКОМ, и порядок здесь
   * решает судьбу конторы. Разбор стоит прочитать целиком — он про то, как
   * устроен вход в цепочку.
   *
   * Наём БЕСПЛАТЕН, платит зарплата; кузов стоит денег сразу. Пока идёт поиск
   * допуска, счёт тает на ставку в сутки, и если сначала искать, а потом
   * покупать, то к моменту находки на цистерну уже не хватает — контора стоит с
   * нужным человеком и без кузова. Наоборот работает: кузов взят, дальше поиск
   * идёт «в долг» — уйти в минус на месяц игра разрешает (BANKRUPTCY_GRACE_DAYS
   * в data/operating.ts), а первая же ходка с наливным грузом закрывает долг
   * целиком.
   *
   * Машину без допуска покупать всё равно нельзя (см. buyStep): там сумма
   * впятеро больше, и ошибка не отыгрывается.
   */
  const price = TRAILER_PRICE[plan.trailer]
  // Порог считается снаружи и один на два решения — покупку кузова и поиск
  // человека под него (разбор у floor в decide).
  if (price === undefined || !affordable(company, price, reserve)) return null

  for (const vehicle of fleet) {
    if (vehicle.trailer === plan.trailer) continue
    // Машина уже возит грузы этого кольца другим кузовом — менять незачем.
    if (plan.cargoes.some((cargo) => canCarry(vehicle.trailer, cargo))) continue

    const vehicleClass = VEHICLE_CLASS_BY_ID[vehicle.classId]
    if (vehicleClass === undefined) continue
    if (!vehicleClass.trailers.includes(plan.trailer)) continue

    return {
      command: {
        kind: 'купить-прицеп',
        vehicleId: vehicle.id,
        trailer: plan.trailer,
      },
      thought: `Ставлю ${plan.trailer} на ${vehicleTitle(vehicle)}: без него груз не взять.`,
    }
  }
  return null
}

/**
 * Наём — и он же поиск ДОПУСКА.
 *
 * Две причины взять человека, и вторая важнее первой.
 *
 *   ПУСТОЕ СИДЕНЬЕ. Машина без водителя не едет вовсе, и это очевидно.
 *
 *   ЗАКРЫТАЯ ЦЕПОЧКА. Без ДОПОГ не поедут нефть и топливо, без длинномера —
 *   кругляк (CARGO_LICENSE в driver.ts). То есть две трети карты для компании
 *   просто не существуют, пока в штате нет нужного человека, а выдаётся допуск
 *   кандидату случайно (см. наём в logistics/driver.ts). Значит искать
 *   приходится перебором — и это не жадность, а единственный вход в цепочку.
 *
 * Нанимать «про запас» сверх этого нельзя: водитель — постоянный расход, и
 * лишний человек в резерве проедает контору, ничего не давая. Потолок резерва —
 * LICENCE_RESERVE, то есть один.
 */
function hireStep(
  state: GameState,
  company: Company,
  fleet: readonly Vehicle[],
  plan: ScriptedPlan,
  floor: number,
  fieldable: boolean,
): Step | null {
  const spare = freeDrivers(state, company)
  const seats = fleet.filter((vehicle) => vehicle.driverId === null).length

  const needSeat = seats > spare.length
  /*
   * ПОИСК ДОПУСКА НАЧИНАЕТСЯ, ТОЛЬКО ЕСЛИ КОЛЬЦО В ПРИНЦИПЕ ПОДЪЁМНО (fieldable):
   * есть чем везти или хватает денег на кузов. Иначе контора нанимает человека
   * под груз, который ей всё равно нечем возить, платит ему ставку и ждёт
   * неизвестно чего. Замер: конкурент со стартовым тентом и капиталом, которого
   * не хватает на цистерну, разорялся на десять суток раньше, чем если бы просто
   * стоял, — и вся разница уходила в зарплату второго водителя.
   */
  const hunting =
    fieldable &&
    missingLicenses(company, plan).length > 0 &&
    spare.length < LICENCE_RESERVE

  if (!needSeat && !hunting) return null

  /*
   * Зарплата — суточная статья, поэтому и порог найма считается сутками: на
   * нового человека должно хватать столько же, сколько компания держит на всё
   * остальное. Иначе контора нанимает водителя в тот же день, когда не может
   * заплатить прежним.
   *
   * ПОРОГ СНИМАЕТСЯ, ПОКА НИ ОДНА МАШИНА НЕ ЗАРАБАТЫВАЕТ (floor = 0, разбор у
   * earning в decide). Сам наём бесплатен — платит зарплата, — а месяц отсрочки
   * до банкротства (BANKRUPTCY_GRACE_DAYS) существует ровно для таких случаев:
   * контора с кузовом, кольцом и без водителя обязана искать человека в долг, а
   * не сидеть при деньгах, которых всё равно не хватит дожить без выручки.
   */
  if (floor > 0 && !affordable(company, DRIVER_WAGE_PER_DAY * RESERVE_DAYS_BASE, floor)) {
    return null
  }

  return {
    command: { kind: 'нанять-водителя' },
    thought: needSeat
      ? 'Машина стоит без водителя — беру человека.'
      : `Без допуска на ${plan.cargoes.join(' и ')} кольцо не поедет. Ищу человека.`,
  }
}

/**
 * Отпустить человека, который под это кольцо не годится.
 *
 * ЕДИНСТВЕННЫЙ СЛУЧАЙ, КОГДА КОНКУРЕНТ УВОЛЬНЯЕТ, и он узкий: в резерве сидит
 * водитель без нужного допуска, все машины укомплектованы, а цепочка без допуска
 * закрыта. Держать такого человека — платить ставку за невозможность работать;
 * отпустить и взять следующего — единственный способ войти в цепочку.
 *
 * УВОЛЬНЕНИЕ ЗАНИМАЕТ ХОД ЦЕЛИКОМ, наём приходит следующим. Смешать их в одну
 * пачку заманчиво — перебор шёл бы вдвое быстрее, — но каждая такая пачка
 * оставляет контору на сутки вовсе без водителя и удлиняет очередь ровно там,
 * где решение и так принимается по одному в сутки. Замер на шестидесяти сутках
 * показал, что быстрее перебор не спасает: кандидаты выводятся из номера тика
 * (hireDriver в driver.ts), и вся разница уходит в то, кому какой человек
 * выпал. Простой порядок оставлен намеренно.
 */
function fireStep(
  state: GameState,
  company: Company,
  fleet: readonly Vehicle[],
  plan: ScriptedPlan,
  growing: boolean,
): Step[] | null {
  // Пустой резерв — не повод выходить: под замену годится и тот, кто сидит за
  // рулём машины, которую он всё равно не может нагрузить (случай первый ниже).
  const spare = freeDrivers(state, company)
  const seats = fleet.filter((vehicle) => vehicle.driverId === null).length
  const hunting = missingLicenses(company, plan).length > 0

  /*
   * Случай первый: ищем допуск, а человека с ним нет ни у кого. Отпускаем
   * ЛЮБОГО, кто этот допуск не имеет, — и в резерве, и за рулём.
   *
   * За рулём это выглядит жёстко, но арифметика однозначна: водитель без ДОПОГ
   * на машине с цистерной не может взять груз (canDrive смотрят при погрузке),
   * то есть машина стоит, а ставка идёт. Держать его И одновременно искать
   * второго — значит платить две ставки вместо одной и вдвое сократить число
   * попыток, которые контора успеет сделать до конца отсрочки.
   *
   * Пока есть пустые сиденья, никого не увольняем: там человек как раз нужен, и
   * следующий наём его туда и посадит.
   */
  if (hunting && seats === 0) {
    const useless =
      spare.find((driver) => !licensedFor(driver, plan.cargoes)) ??
      atWheelWithoutLicence(company, fleet, plan)
    if (useless !== undefined) {
      return [
        {
          command: { kind: 'уволить-водителя', driverId: useless.id },
          thought: `${useless.name} без нужного допуска — расстаёмся, ищу другого.`,
        },
      ]
    }
  }

  /*
   * Случай второй: ЛЮДЕЙ БОЛЬШЕ, ЧЕМ МАШИН. Так бывает после списания — машина
   * сломалась и вычеркнута, а водитель остался. Это самый тихий способ разорить
   * контору: ставка капает каждые сутки, работы нет ни на рубль. Замер прогона
   * на год: шесть списанных машин, шесть оставшихся водителей и минус сто
   * тысяч на счету при полностью исправном плане.
   *
   * Отпускается САМЫЙ НЕОПЫТНЫЙ: навык растёт пробегом (grownSkill в
   * driver.ts), выращенного водителя терять жальче. Ничья разводится по
   * идентификатору — порядок обхода парка не должен решать судьбу человека.
   *
   * ОДИН ЧЕЛОВЕК СВЕРХ ПАРКА ОСТАВЛЯЕТСЯ, ПОКА КОНТОРА РАСТЁТ (growing), и без
   * этой оговорки правило само себя запирает: чтобы купить машину под наливной
   * груз, в штате уже должен быть человек с ДОПОГ, а он до покупки как раз
   * «лишний». Контора нанимала бы и увольняла его по кругу, так и не купив ни
   * одной машины, — ровно это и показал прогон.
   */
  const wanted = seats + (hunting ? LICENCE_RESERVE : 0) + (growing ? 1 : 0)
  if (spare.length > wanted) {
    /*
     * ЕДИНСТВЕННОГО ЧЕЛОВЕКА С ДОПУСКОМ НЕ УВОЛЬНЯЮТ НИКОГДА, и без этой
     * оговорки правило съедало само себя: конкурент неделями искал водителя с
     * ДОПОГ, находил, тут же признавал «лишним» (машины-то ещё нет) и отпускал —
     * и так до самого банкротства, ни разу не выйдя на кольцо. Допуск в этой
     * игре не свойство человека, а КЛЮЧ к цепочке: без него две трети карты
     * закрыты, и стоит он дороже любой экономии на ставке.
     */
    const droppable = spare.filter((driver) => !onlyHolder(company, plan, driver))

    if (droppable.length > 0) {
      const extra = [...droppable].sort((a, b) =>
        a.skill === b.skill ? (a.id < b.id ? -1 : 1) : a.skill - b.skill,
      )[0]

      return [
        {
          command: { kind: 'уволить-водителя', driverId: extra.id },
          thought: `Работы на всех не хватает — отпускаю ${extra.name}.`,
        },
      ]
    }
  }

  return null
}

/**
 * Водитель за рулём машины кольца, у которого нет нужного допуска.
 *
 * Ищется только для замены: такая машина не может взять груз, и человек за её
 * рулём — расход без выработки. Машины, которые к кольцу отношения не имеют
 * (другой кузов), не трогаются: их водители заняты своим делом.
 */
function atWheelWithoutLicence(
  company: Company,
  fleet: readonly Vehicle[],
  plan: ScriptedPlan,
): Driver | undefined {
  for (const vehicle of fleet) {
    if (vehicle.driverId === null) continue
    if (!plan.cargoes.some((cargo) => canCarry(vehicle.trailer, cargo))) continue

    const driver = company.drivers?.[vehicle.driverId]
    if (driver === undefined) continue
    if (!licensedFor(driver, plan.cargoes)) return driver
  }
  return undefined
}

/** Единственный ли это человек в компании с нужным кольцу допуском. */
function onlyHolder(
  company: Company,
  plan: ScriptedPlan,
  driver: Driver,
): boolean {
  const roster = Object.values(company.drivers ?? {})

  for (const cargo of plan.cargoes) {
    const license = CARGO_LICENSE[cargo]
    if (license === undefined) continue
    if (!driver.licenses.includes(license)) continue

    const holders = roster.filter((other) => other.licenses.includes(license))
    if (holders.length <= 1) return true
  }

  return false
}

/**
 * Терминал в городе, где стоит СВОЯ очередь.
 *
 * Смысл ровно тот же, что у игрока: терминал в тихом городе тихо съедает
 * прибыль содержанием, а в узком месте окупается простоем, которого больше нет.
 * Поэтому решение принимается не по «есть деньги», а по накопленному ожиданию
 * собственных машин (Vehicle.queuedTicks — тот самый счётчик, который панель
 * узких мест показывает игроку).
 */
function terminalStep(
  state: GameState,
  company: Company,
  fleet: readonly Vehicle[],
  reserve: number,
): Step | null {
  const type: BuildingType = 'терминал'
  const spec = BUILDING_SPEC[type]
  if (spec === undefined || !affordable(company, spec.price, reserve)) return null

  const buildings = Object.values(company.buildings ?? {})

  for (const vehicle of fleet) {
    if (vehicle.queuedTicks < QUEUE_PATIENCE_TICKS) continue
    if (vehicle.position.kind !== 'узел') continue

    const cityId = vehicle.position.nodeId
    if (state.world.cities[cityId] === undefined) continue
    // Место занято: вторая постройка того же типа в том же городе невозможна
    // по построению ключа (buildingIdFor в economy/buildings.ts).
    if (buildings.some((b) => b.cityId === cityId && b.type === type)) continue

    const hours = Math.round(vehicle.queuedTicks / TICKS_PER_HOUR)
    return {
      command: { kind: 'построить', cityId, type },
      thought: `В ${cityName(state, cityId)} мои машины простояли в очереди ${hours} ч. Ставлю терминал.`,
    }
  }
  return null
}

/**
 * Покупка машины.
 *
 * ДВА УСЛОВИЯ, И ОБА ОБЯЗАТЕЛЬНЫ: есть РАБОТА и есть ДЕНЬГИ.
 *
 *   Работа — это линия, которой не хватает машин по расчёту (fleetForRing).
 *   Покупать в пустоту нельзя: машина без задания стоит денег каждый день и не
 *   приносит ничего, а конкурент, скупающий технику впрок, разоряется без
 *   всякого участия игрока и перестаёт быть соперником.
 *
 *   Деньги — это цена машины ВМЕСТЕ С ПРИЦЕПОМ и сверх запаса наличности.
 *   Голый тягач не может взять груз (trailer.ts), поэтому считать его покупку
 *   по цене тягача значит купить железо, которое не работает.
 *
 * И третье, неочевидное: пока хоть одна своя машина стоит без прицепа или без
 * водителя, новая не покупается. Некомплект — это уже оплаченная и не
 * работающая техника, и добавлять к ней ещё одну значит удваивать убыток.
 *
 * Сюда же относится и допуск: машину под груз, который некому везти, покупать
 * нельзя. Она не встанет — она поедет ПОРОЖНЯКОМ по всему кольцу, потому что
 * допуск проверяется при погрузке (canDrive в driver.ts), а не при выезде. Это
 * худший вид расхода: выглядит как работающая линия и не приносит ничего.
 */
function buyStep(
  company: Company,
  fleet: readonly Vehicle[],
  plan: ScriptedPlan,
  target: number,
  pick: VehicleClass | null,
): Step | null {
  // Денег нет, или парк уже собран — обе причины считаются в decide, чтобы
  // покупка и увольнение отвечали на один и тот же вопрос одинаково.
  if (pick === null) return null
  if (missingLicenses(company, plan).length > 0) return null

  const incomplete = fleet.some(
    (vehicle) =>
      vehicle.driverId === null ||
      !plan.cargoes.some((cargo) => canCarry(vehicle.trailer, cargo)),
  )
  if (incomplete) return null

  const working = fleet.filter((vehicle) =>
    plan.cargoes.some((cargo) => canCarry(vehicle.trailer, cargo)),
  ).length
  if (working >= target) return null

  return {
    command: { kind: 'купить-машину', classId: pick.id },
    thought: `Кольцу «${plan.name}» не хватает машин — беру ${pick.name}.`,
  }
}

/** Сколько машин характер держит на этом кольце. */
function fleetTarget(
  plan: ScriptedPlan,
  personality: CompetitorPersonality,
): number {
  return Math.max(1, Math.ceil(plan.fleetTarget * FLEET_SHARE[personality]))
}

/**
 * Машина, которую компания может купить прямо сейчас, или null.
 *
 * Класс плана — лучший по прибыли; если на него не хватает денег, берётся самый
 * дорогой из тех, что по карману. Ждать «правильную» машину, имея деньги на
 * рабочую, — способ простоять всю партию с полным счётом.
 *
 * Цена считается ВМЕСТЕ С ПРИЦЕПОМ: голый тягач не берёт груз (trailer.ts), и
 * покупка по цене одного тягача оставила бы контору с железом, которое не
 * работает.
 */
function affordableClass(
  state: GameState,
  company: Company,
  plan: ScriptedPlan,
  reserve: number,
): VehicleClass | null {
  const trailerPrice = TRAILER_PRICE[plan.trailer] ?? 0
  const year = dateFromTick(state.tick, state.startYear).year

  const affordableClasses = VEHICLE_CLASSES.filter(
    (vc) =>
      vc.availableFrom <= year &&
      vc.trailers.includes(plan.trailer) &&
      affordable(company, vc.price + trailerPrice, reserve),
  )
  if (affordableClasses.length === 0) return null

  const wanted = VEHICLE_CLASS_BY_ID[plan.classId]
  return wanted !== undefined && affordableClasses.includes(wanted)
    ? wanted
    : affordableClasses.reduce((a, b) => (b.price > a.price ? b : a))
}

// ─── Фразы ─────────────────────────────────────────────────────────────────

/**
 * Объяснение к первому решению по кольцу.
 *
 * Фраза говорит про ГЛАВНОЕ — почему кольцо именно такое, — и различается по
 * характеру, потому что мотив у характеров разный. Это половина ценности всей
 * фичи: противник, чьи мотивы видны, читается как соперник, а невидимый — как
 * случайный шум в экономике (см. Thought в types.ts).
 */
function openingThought(
  state: GameState,
  plan: ScriptedPlan,
  personality: CompetitorPersonality,
): string {
  const [a, b] = plan.claimCities
  const from = cityName(state, a)
  const to = cityName(state, b)
  const there = plan.raw ?? plan.cargoes[0]
  const back = plan.product ?? plan.cargoes[plan.cargoes.length - 1]
  // Третья остановка — сбыт. Она и есть ответ на вопрос «кому сдаём обратное
  // плечо», и в ленте он важнее, чем сам факт кольца.
  const sale =
    plan.cities.length > plan.claimCities.length
      ? cityName(state, plan.cities[plan.cities.length - 1])
      : from

  if (plan.origin === 'копия') {
    return `Маршрут уже обкатан соседом. Повторяю ${plan.name}, чужой опыт дешевле своего.`
  }

  switch (personality) {
    case 'агрессивный':
      return plan.rival
        ? `Иду туда, где уже возят: ${from} — ${to}. Заберу ${there}, сдам ${back} в ${sale}.`
        : `Замыкаю ${from} — ${to}: туда ${there}, обратно ${back} в ${sale}.`
    case 'осторожный':
      return `Беру свободное направление ${from} — ${to}: туда ${there}, обратно ${back} в ${sale}. Оба плеча гружёные.`
    case 'нишевый':
      return `Моё дело — ${back}. Ставлю кольцо ${from} — ${to} и не разбрасываюсь.`
    case 'имитатор':
      return `Копировать пока нечего, начинаю своё: ${from} — ${to}, туда ${there}, обратно ${back}.`
  }
}

/** Как называть машину в ленте: класс и номер, «ЗИЛ-130 (zil-130-2)». */
function vehicleTitle(vehicle: Vehicle): string {
  const vehicleClass = VEHICLE_CLASS_BY_ID[vehicle.classId]
  return vehicleClass === undefined
    ? vehicle.id
    : `${vehicleClass.name} (${vehicle.id})`
}

/** Имя города для фразы. Неизвестный город — свой идентификатор. */
function cityName(state: GameState, cityId: CityId): string {
  return state.world.cities[cityId]?.name ?? cityId
}

// ─── Мелочь про компанию ───────────────────────────────────────────────────

/**
 * Запас наличности, ниже которого конкурент не тратит.
 *
 * Считается от СОБСТВЕННЫХ суточных расходов: зарплата штата плюс содержание
 * построек (upkeepPerTick — та же функция, которой платит фаза расходов, а не
 * вторая копия прейскуранта). Компания без людей всё равно считает себе одну
 * ставку: нулевой резерв означал бы, что первую же машину она покупает на
 * последние деньги.
 */
function cashReserve(
  company: Company,
  personality: CompetitorPersonality,
): number {
  let wages = 0
  for (const driver of Object.values(company.drivers ?? {})) {
    if (Number.isFinite(driver.wagePerDay)) wages += driver.wagePerDay
  }

  const upkeep = upkeepPerTick(company) * TICKS_PER_DAY
  const perDay = Math.max(DRIVER_WAGE_PER_DAY, wages + upkeep)

  return perDay * RESERVE_DAYS[personality]
}

/**
 * Хватает ли денег с учётом запаса.
 *
 * Написано отрицанием намеренно, как и в buildBuilding: NaN на счету обязан
 * означать отказ, а не «условие не выполнилось, значит покупаем».
 */
function affordable(company: Company, price: number, reserve: number): boolean {
  if (!Number.isFinite(price) || price < 0) return false
  return company.money - price >= reserve
}

/** Свои машины в порядке ключей парка — порядок детерминирован. */
function ownVehicles(state: GameState, companyId: CompanyId): Vehicle[] {
  const own: Vehicle[] = []
  for (const id of Object.keys(state.vehicles) as VehicleId[]) {
    const vehicle = state.vehicles[id]
    if (vehicle.ownerId === companyId) own.push(vehicle)
  }
  return own
}

/** Машины компании, работающие на этой линии. */
function vehiclesOnLine(
  state: GameState,
  companyId: CompanyId,
  lineId: Line['id'],
): Vehicle[] {
  return ownVehicles(state, companyId).filter(
    (vehicle) => vehicle.lineId === lineId,
  )
}

/**
 * Водители без машины.
 *
 * Истина о том, кто за рулём, — ПОЛЕ МАШИНЫ (см. шапку logistics/driver.ts),
 * поэтому свободным считается тот, кого не найти ни за одной машиной, а не тот,
 * у кого пусто в Driver.vehicleId. Разойдись эти записи — конкурент сажал бы
 * второго человека за занятый руль и терял бы ход на незаконной команде.
 */
function freeDrivers(state: GameState, company: Company): Driver[] {
  const atWheel = new Set<DriverId>()
  for (const vehicle of Object.values(state.vehicles)) {
    if (vehicle.ownerId !== company.id) continue
    if (vehicle.driverId !== null) atWheel.add(vehicle.driverId)
  }

  return Object.values(company.drivers ?? {}).filter(
    (driver) => !atWheel.has(driver.id),
  )
}

/** Есть ли у водителя допуски на все эти грузы. */
function licensedFor(driver: Driver, cargoes: readonly CargoType[]): boolean {
  return cargoes.every((cargo) => {
    const license = CARGO_LICENSE[cargo]
    return license === undefined || driver.licenses.includes(license)
  })
}

/**
 * Допуски, которых нет НИ У КОГО в компании, а кольцу они нужны.
 *
 * Спрашивается про весь штат, а не про конкретного человека: одного водителя с
 * ДОПОГ достаточно, чтобы цепочка открылась, — остальных посадят на плечи, где
 * допуск не нужен, или наймут потом.
 */
function missingLicenses(
  company: Company,
  plan: ScriptedPlan,
): DriverLicense[] {
  const drivers = Object.values(company.drivers ?? {})
  const missing: DriverLicense[] = []

  for (const cargo of plan.cargoes) {
    const license = CARGO_LICENSE[cargo]
    if (license === undefined || missing.includes(license)) continue
    if (!drivers.some((driver) => driver.licenses.includes(license))) {
      missing.push(license)
    }
  }

  return missing
}

/** Города, где компания работает: остановки её линий и её постройки. */
function citiesOf(state: GameState, companyId: CompanyId): Set<CityId> {
  const cities = new Set<CityId>()

  const company: Company | undefined = state.companies[companyId]
  if (company === undefined) return cities

  for (const line of Object.values(company.lines ?? {})) {
    for (const stop of line.stops) cities.add(stop.nodeId)
  }
  for (const building of Object.values(company.buildings ?? {})) {
    cities.add(building.cityId)
  }

  return cities
}

/**
 * Линия компании под этот план — по последовательности остановок.
 *
 * Сравниваются города, а не имя: имя игрок (и модель) может переписать, а набор
 * остановок и есть сама линия. Порядок значим — кольцо «A → B → C» и «A → C → B»
 * это разные маршруты с разными плечами.
 */
function findLine(company: Company, plan: ScriptedPlan): Line | undefined {
  for (const line of Object.values(company.lines ?? {})) {
    if (line.stops.length !== plan.stops.length) continue

    let same = true
    for (let i = 0; i < line.stops.length; i++) {
      if (line.stops[i].nodeId !== plan.stops[i].nodeId) {
        same = false
        break
      }
    }
    if (same) return line
  }
  return undefined
}

/**
 * Глубокая копия остановок.
 *
 * Списки грузов копируются поимённо, а не спредом верхнего уровня: команда
 * уходит в СОСТОЯНИЕ и живёт там до следующего тика, а массивы плана
 * пересобираются на каждом решении. Общий массив означал бы, что содержимое
 * уже отданной команды меняется задним числом.
 */
function copyStops(stops: readonly Stop[]): Stop[] {
  return stops.map((stop) => ({
    nodeId: stop.nodeId,
    unload: [...stop.unload],
    load: [...stop.load],
  }))
}
