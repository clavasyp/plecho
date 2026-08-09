/**
 * Чтение проектируемой линии: кольцо остановок → ответы редактору.
 *
 * Слой между симуляцией и редактором линий (ui/LineEditor.tsx), устроенный по
 * образцу ui/cityReadout.ts и ровно по той же причине. Формально — Fast Refresh
 * ломается, когда .tsx экспортирует что-то кроме компонентов, а vitest в этом
 * проекте берёт только .ts (см. vitest.config.ts), то есть проверить разметкой
 * ничего нельзя. По существу — врать может только этот слой: криво нарисованную
 * панель видно глазом, а неверно посчитанное порожнее плечо выглядит совершенно
 * правдоподобно и учит игрока не тому.
 *
 * ЗДЕСЬ ЖИВЁТ ГЛАВНАЯ ПОДСКАЗКА СРЕЗА. Линия — замкнутое кольцо, и плечо,
 * которое пойдёт пустым, видно ещё на этапе проектирования: достаточно прогнать
 * по кольцу один воображаемый рейс и посмотреть, что окажется в кузове на каждом
 * плече. Сказать об этом в редакторе несравнимо полезнее, чем показать через
 * десять игровых суток в отчёте: там это уже потраченные деньги, а здесь ещё
 * решение.
 *
 * ВОПРОС ЗДЕСЬ ДРУГОЙ, ЧЕМ У СИМУЛЯЦИИ, И ЭТО ВАЖНО. Фаза прибытия
 * (sim/logistics/loading.ts) спрашивает «есть ли СЕЙЧАС тонны на складе»;
 * редактор спрашивает «БЫВАЕТ ли здесь такой груз вообще». Ответы намеренно
 * разные: пустой в эту минуту склад мукомольного не означает, что грузить муку
 * в Туле — ошибка проектирования, а вот попытка грузить муку в Смоленске,
 * где мельницы нет и не будет, — именно она. Поэтому функции ниже смотрят на
 * ТИПЫ предприятий, а не на их склады.
 *
 * НИ ОДНОЙ СОБСТВЕННОЙ ФОРМУЛЫ, правило то же, что в cityReadout. Кто что даёт
 * и кто что принимает — выводится из RECIPES и CONSUMER_CARGO, тех же таблиц,
 * по которым это решает симуляция; порядок обхода кольца — у ringOrder из
 * ui/lineEconomy.ts, того же, по которому линия рисуется на карте и считается в
 * отчёте; расстояние берётся у shortestKm — той же функции, которой считается
 * тариф; деньги за порожний пробег — у distanceCost, той же, которой их
 * списывает фаза расходов. Своя копия любого из этих правил разошлась бы с игрой
 * молча.
 *
 * ЧЕМ ЭТОТ ПРОГОН КОЛЬЦА ОТЛИЧАЕТСЯ ОТ planLoop в ui/lineEconomy.ts, и почему их
 * два. Там считается ПОТОЛОК прибыли, и все допущения намеренно смещены в пользу
 * линии: груз есть везде, где велено грузить, кузов всегда полон. Такое
 * допущение обязательно для оценки «может ли кольцо вообще окупиться», но
 * бесполезно для проектирования: команда «грузить муку» в городе без мельницы
 * даёт там гружёное плечо, а в жизни — порожнее. Здесь вопрос ровно обратный и
 * ответ строгий: плечо считается гружёным, только если в городе есть КОМУ дать
 * этот груз. Два ответа, потому что два разных вопроса; общее у них — обход
 * кольца, и он взят одной функцией на всех.
 *
 * Всё в ТОННАХ и КИЛОМЕТРАХ, деньги в рублях. Функции чистые: ни один вход не
 * меняется, включая вложенные массивы остановок.
 */

import { CONSUMER_CARGO, RECIPES, RECIPE_BY_INDUSTRY } from '../data/recipes'
import { distanceCost } from '../sim/economy/operating'
import { MIN_LINE_STOPS } from '../sim/logistics/line'
import { buildGraph } from '../sim/world/graph'
import { shortestKm } from '../sim/world/pathfind'
import { ringOrder } from './lineEconomy'
import type {
  CargoType,
  City,
  CityId,
  Edge,
  EdgeId,
  Industry,
  IndustryId,
  Line,
  Stop,
  Vehicle,
} from '../sim/types'

/**
 * Порядок грузов в списках редактора.
 *
 * Берётся из RECIPES, а не выписывается руками: там грузы уже стоят в
 * содержательном порядке — сначала сырьё источников, потом продукция
 * переработки, — и новый груз попадёт в интерфейс сам, вместе с новой цепочкой.
 * Дубли (два предприятия с одним выходом) отсекаются множеством.
 */
export const CARGO_ORDER: readonly CargoType[] = [
  ...new Set(RECIPES.map((recipe) => recipe.output)),
]

// ─── Что можно делать в городе ─────────────────────────────────────────────

/**
 * Кто в этом городе даёт груз — название предприятия для подписи.
 *
 * null означает «никто», и это ровно тот случай, ради которого функция и нужна:
 * список из шести грузов, половина которых в этом городе бессмысленна, — не
 * выбор, а угадайка.
 */
export function loaderAt(
  industries: Record<IndustryId, Industry>,
  cityId: CityId,
  cargo: CargoType,
): string | null {
  for (const industry of Object.values(industries)) {
    if (industry.cityId !== cityId) continue
    // Грузится ТОЛЬКО готовая продукция — то же правило, что в pickupFrom.
    // Привезённое на завод сырьё продукцией не является ни для кого, и брать
    // его обратно нельзя (иначе появляется вечный двигатель на оплате плеч).
    if (RECIPE_BY_INDUSTRY[industry.type]?.output === cargo) return industry.type
  }
  return null
}

/**
 * Кто в этом городе примет груз.
 *
 * Порядок ответа повторяет findReceiver: сначала предприятия, потом сам город.
 * Город принимает только готовую продукцию (CONSUMER_CARGO) — сырьё ему не
 * нужно, и именно это делает переработку обязательным звеном цепочки.
 *
 * Наличие спроса по населению здесь не проверяется: город без жителей — это
 * дыра в данных мира, а не состояние, под которое стоит рисовать интерфейс.
 */
export function unloaderAt(
  industries: Record<IndustryId, Industry>,
  cityId: CityId,
  cargo: CargoType,
): string | null {
  for (const industry of Object.values(industries)) {
    if (industry.cityId !== cityId) continue
    const recipe = RECIPE_BY_INDUSTRY[industry.type]
    if (recipe?.inputs.some((input) => input.type === cargo)) {
      return industry.type
    }
  }
  return CONSUMER_CARGO.includes(cargo) ? 'город' : null
}

/**
 * Переключатель груза в остановке.
 *
 * `who === null` при `chosen === true` — единственное состояние, которое обязано
 * бросаться в глаза: игрок отметил груз, а потом переставил остановку в другой
 * город, и теперь машина будет уходить отсюда порожней. Молча вычистить такой
 * выбор нельзя — это правка чужого решения; молча оставить неотличимым от
 * рабочего тоже нельзя.
 */
export type CargoSlot = {
  cargo: CargoType
  /** Кто здесь даёт или принимает этот груз. null — никто. */
  who: string | null
  /** Отмечен в остановке. */
  chosen: boolean
}

/** Слоты одного направления остановки. Осмысленные — первыми, за ними битые. */
function slots(
  chosen: readonly CargoType[],
  who: (cargo: CargoType) => string | null,
): CargoSlot[] {
  const live: CargoSlot[] = []
  const dead: CargoSlot[] = []

  for (const cargo of CARGO_ORDER) {
    const owner = who(cargo)
    const picked = chosen.includes(cargo)
    // Груз, которого здесь нет и который не отмечен, в списке не нужен вовсе:
    // именно из таких строк и получается угадайка.
    if (owner === null && !picked) continue
    ;(owner === null ? dead : live).push({ cargo, who: owner, chosen: picked })
  }

  return [...live, ...dead]
}

/** Что можно грузить на этой остановке и что из этого уже отмечено. */
export function loadSlots(
  industries: Record<IndustryId, Industry>,
  stop: Stop,
): CargoSlot[] {
  return slots(stop.load, (cargo) => loaderAt(industries, stop.nodeId, cargo))
}

/** Что можно выгружать на этой остановке и что из этого уже отмечено. */
export function unloadSlots(
  industries: Record<IndustryId, Industry>,
  stop: Stop,
): CargoSlot[] {
  return slots(stop.unload, (cargo) =>
    unloaderAt(industries, stop.nodeId, cargo),
  )
}

// ─── Прогон кольца ─────────────────────────────────────────────────────────

/** Плечо кольца: из остановки в следующую, которую машина реально поедет. */
export type Leg = {
  /**
   * Индекс остановки в line.stops, из которой выходит плечо.
   *
   * Именно индекс, а не порядковый номер по кольцу: остановка, до которой нет
   * дороги, из объезда выпадает, и плечи перестают отвечать позициям списка
   * один в один. Редактор рисует плечо под своей остановкой и находит его по
   * этому полю.
   */
  fromIndex: number
  from: string
  to: string
  /** Кратчайшее расстояние, км. null — дороги между городами нет. */
  km: number | null
  /** Что везёт машина на этом плече. null — идёт порожняком. */
  cargo: CargoType | null
  /** Почему порожняком. null — плечо гружёное. */
  reason: string | null
}

export type RingReport = {
  /** Плечи по числу остановок: последнее замыкает кольцо на первую. */
  legs: Leg[]
  /** Длина круга, км. Недостижимые плечи в сумму не входят. */
  totalKm: number
  /** Сколько из них машина пройдёт пустой. */
  emptyKm: number
  /** Доля порожнего пробега, 0..1. null — считать не из чего. */
  emptyShare: number | null
  /**
   * Во что обойдётся порожний пробег за один круг, рубли. null — в парке нет
   * машины, у которой можно спросить расход.
   */
  emptyCost: number | null
  /** Беды всего кольца, а не отдельного плеча. Пусто — кольцо собрано. */
  warnings: string[]
}

/** Название города. Битая ссылка отдаёт сам идентификатор — как в CompanyPanel. */
function cityName(cities: Record<CityId, City>, id: CityId): string {
  return cities[id]?.name ?? id
}

/**
 * Почему машина уходит с этой остановки порожней.
 *
 * Случаев ровно два, и третьего быть не может: если бы хоть один из
 * перечисленных грузов в городе производили, погрузка его бы и взяла. Поэтому
 * второй ответ утвердительный, а не «наверное». Симуляция в обоих случаях молча
 * отпускает машину пустой (см. findPickup), и без подсказки игрок ищет причину
 * в чём угодно, только не в собственной строке погрузки.
 */
function whyEmpty(stop: Stop, name: string): string {
  // Название города стоит ПЕРЕД двоеточием, а не в предложном падеже внутри
  // фразы: города приходят из данных в именительном («Тула», «Орёл»), и «в Тула
  // ничего не грузят» — это не подсказка, а брак. Склонять названия в коде
  // нельзя, а двоеточие обходится без падежей вовсе.
  if (stop.load.length === 0) return `${name}: ничего не грузят`
  return `${name}: не производят ${stop.load.join(', ')}`
}

/** Результат одного круга: что в кузове на каждом плече и чем круг кончился. */
type Lap = {
  carried: (CargoType | null)[]
  reasons: (string | null)[]
  end: CargoType | null
  /** Хоть раз ли машина за круг что-то сдала. */
  unloaded: boolean
}

/**
 * Прогон одного круга по инструкциям остановок.
 *
 * Повторяет фазу прибытия по существу: сначала выгрузка, потом погрузка, и
 * только то, что перечислено в остановке. Порядок не косметический — разбор в
 * шапке loading.ts: погрузка первой увидела бы полный кузов и отпустила машину
 * порожней с только что привезённым грузом.
 *
 * Кузов один и груз в нём один — как в симуляции. Частичной загрузки нет: тонны
 * здесь не считаются вовсе, потому что вопрос стоит «гружёное плечо или пустое»,
 * а не «насколько полное».
 */
function runLap(
  industries: Record<IndustryId, Industry>,
  cities: Record<CityId, City>,
  stops: readonly Stop[],
  order: readonly number[],
  start: CargoType | null,
): Lap {
  const carried: (CargoType | null)[] = []
  const reasons: (string | null)[] = []
  let cargo = start
  let unloaded = false

  // Обход идёт ПО ПОРЯДКУ ОБЪЕЗДА, а не по списку остановок: пропущенную
  // остановку машина не обслуживает вовсе, и грузить на ней нечего — так же
  // ведёт себя диспетчер (см. logistics/line.ts).
  for (const index of order) {
    const stop = stops[index]
    const name = cityName(cities, stop.nodeId)

    // ─── Выгрузка ──────────────────────────────────────────────────────────
    if (cargo !== null && stop.unload.includes(cargo)) {
      if (unloaderAt(industries, stop.nodeId, cargo) !== null) {
        cargo = null
        unloaded = true
      }
      // Иначе груз едет дальше: сдать его здесь физически некому. Плечо при
      // этом гружёное, и отдельной жалобы не нужно — она появится в warnings,
      // если груз не сдаётся вообще нигде.
    }

    // ─── Погрузка ──────────────────────────────────────────────────────────
    if (cargo === null) {
      for (const wanted of stop.load) {
        if (loaderAt(industries, stop.nodeId, wanted) !== null) {
          cargo = wanted
          break
        }
      }
    }

    carried.push(cargo)
    reasons.push(cargo === null ? whyEmpty(stop, name) : null)
  }

  return { carried, reasons, end: cargo, unloaded }
}

/**
 * Установившийся круг, а не первый.
 *
 * Первый круг машина начинает порожней, и это состояние разовое: дальше она
 * приезжает на первую остановку уже с тем, что взяла на последней. Показать
 * игроку разгонный круг значило бы соврать про кольцо в самом частом случае —
 * когда груз перекладывается через замыкающее плечо.
 *
 * Состояние круга — это ровно «что в кузове на входе», то есть одно из семи
 * значений (шесть грузов и пусто). Перекладывание круга — детерминированная
 * функция на конечном множестве, значит последовательность обязана зациклиться
 * не позже, чем за семь шагов; дальше любой круг повторяется вечно, и любой из
 * них честно описывает работу линии.
 */
function steadyLap(
  industries: Record<IndustryId, Industry>,
  cities: Record<CityId, City>,
  stops: readonly Stop[],
  order: readonly number[],
): Lap {
  const seen = new Set<string>()
  let cargo: CargoType | null = null

  for (let guard = 0; guard <= CARGO_ORDER.length + 1; guard++) {
    const key = cargo ?? '—'
    if (seen.has(key)) break
    seen.add(key)
    cargo = runLap(industries, cities, stops, order, cargo).end
  }

  return runLap(industries, cities, stops, order, cargo)
}

/**
 * Разбор кольца целиком — то, ради чего написан файл.
 *
 * `vehicle` нужен только для перевода километров в рубли: расход у каждой машины
 * свой (Vehicle.fuelPer100Km), и придумывать «среднюю машину» здесь нельзя. Нет
 * машины — нет и суммы, а километры остаются.
 */
export function describeRing(
  line: Line,
  cities: Record<CityId, City>,
  industries: Record<IndustryId, Industry>,
  edges: Record<EdgeId, Edge>,
  vehicle: Vehicle | null,
): RingReport {
  const stops = line.stops
  const warnings: string[] = []

  const nothing: RingReport = {
    legs: [],
    totalKm: 0,
    emptyKm: 0,
    emptyShare: null,
    emptyCost: null,
    warnings,
  }

  // Кольцо короче двух остановок не содержит ни одного плеча — разбор в шапке
  // sim/logistics/line.ts. Порог берётся оттуда же, а не вписан двойкой.
  if (stops.length < MIN_LINE_STOPS) {
    warnings.push(
      `остановок меньше ${MIN_LINE_STOPS} — машины на линии будут стоять`,
    )
    return nothing
  }

  const graph = buildGraph(edges)

  /*
   * Порядок объезда — общий на весь проект (ui/lineEconomy.ts). Он же
   * пропускает недостижимые остановки, ровно как это делает диспетчер: одно
   * порванное плечо не убивает линию, машина едет к ближайшей достижимой
   * следующей. Свой обход здесь означал бы кольцо, нарисованное на карте одним
   * путём, посчитанное в отчёте другим и показанное в редакторе третьим.
   */
  const order = ringOrder(graph, line)
  if (order.length < MIN_LINE_STOPS) {
    warnings.push('между остановками нет дорог — кольцо не собирается')
    return nothing
  }

  // Остановка, до которой не доехать, из объезда выпала. Молчать об этом
  // нельзя: игрок видит её в списке и считает обслуженной.
  for (let i = 0; i < stops.length; i++) {
    if (!order.includes(i)) {
      warnings.push(
        `${cityName(cities, stops[i].nodeId)}: нет дороги, остановку пропускают`,
      )
    }
  }

  const lap = steadyLap(industries, cities, stops, order)

  const legs: Leg[] = []
  let totalKm = 0
  let emptyKm = 0

  for (let k = 0; k < order.length; k++) {
    const from = stops[order[k]].nodeId
    // Замыкание на первую остановку — не деталь реализации, а суть линии:
    // после последней остановки машина идёт к начальной, и это плечо игрок
    // обязан видеть наравне с остальными. Половина порожних пробегов прячется
    // именно в нём.
    const to = stops[order[(k + 1) % order.length]].nodeId

    const km = shortestKm(graph, from, to)
    const reachable = Number.isFinite(km)

    const cargo = lap.carried[k]
    if (reachable) {
      totalKm += km
      if (cargo === null) emptyKm += km
    }

    legs.push({
      fromIndex: order[k],
      from: cityName(cities, from),
      to: cityName(cities, to),
      km: reachable ? km : null,
      cargo,
      reason: lap.reasons[k],
    })
  }

  // Груз, который негде сдать, ездит по кругу вечно: машина занята, плечи
  // числятся гружёными, а выручки нет ни рубля — платят за доставку, а не за
  // катание (см. tariffKm). Из отчёта такую линию не отличить от работающей,
  // поэтому её опознают здесь.
  if (!lap.unloaded && lap.carried.some((cargo) => cargo !== null)) {
    warnings.push('груз едет по кругу — его нигде не выгружают')
  }

  return {
    legs,
    totalKm,
    emptyKm,
    emptyShare: totalKm > 0 ? emptyKm / totalKm : null,
    emptyCost: vehicle === null ? null : distanceCost(vehicle, emptyKm),
    warnings,
  }
}

/**
 * Плечо, выходящее из этой остановки. null — остановку пропускают.
 *
 * Поиск, а не обращение по индексу: плечей может быть меньше, чем остановок, и
 * молчаливый сдвиг на единицу нарисовал бы под каждой остановкой чужое плечо —
 * дефект, который выглядит совершенно нормально.
 */
export function legFrom(report: RingReport, stopIndex: number): Leg | null {
  return report.legs.find((leg) => leg.fromIndex === stopIndex) ?? null
}

// ─── Форматирование ────────────────────────────────────────────────────────

const INTEGER = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 })

/** Километры — всегда целые: решения принимают не по сотням метров. */
export function fmtKm(km: number | null): string {
  if (km === null || !Number.isFinite(km)) return '—'
  return `${INTEGER.format(Math.round(km))} км`
}

/** Рубли — целые и с группировкой разрядов, как в панели компании. */
export function fmtMoney(rub: number | null): string {
  if (rub === null || !Number.isFinite(rub)) return '—'
  return `${INTEGER.format(Math.round(rub))} руб`
}

/** Доля в процентах. null — считать было не из чего. */
export function fmtShare(share: number | null): string {
  if (share === null || !Number.isFinite(share)) return '—'
  return `${Math.round(share * 100)}%`
}
