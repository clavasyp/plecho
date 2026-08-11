/**
 * Чтение узких мест: снимок мира → «где сеть стоит и во что это обходится».
 *
 * Слой между симуляцией и ui/BottleneckPanel.tsx, устроенный так же, как
 * cityReadout для карточки города и fleetReadout для парка, и по тем же двум
 * причинам. Формальная: .tsx, экспортирующий что-то кроме компонентов, ломает
 * Fast Refresh. Существенная: разметку ломает дизайнер, и это видно глазом, а
 * диагноз ломается молча — числа остаются правдоподобными, а смысл меняется на
 * противоположный. Отделённый, он проверяется тестом без браузера.
 *
 * ГЛАВНОЕ ПРАВИЛО ФАЙЛА, ТО ЖЕ, ЧТО У СОСЕДЕЙ: ни одной собственной формулы.
 * Число постов спрашивается у postsAt (logistics/service.ts) — той самой
 * функции, по которой очередь и раздаётся; ставка простоя — у wagePerTick
 * (economy/operating.ts), той самой, которой зарплата списывается; цена и
 * содержание построек — у BUILDING_SPEC. Панель со своей формулой хуже
 * отсутствующей панели: она врёт убедительно.
 *
 * ─── ЧТО ЗДЕСЬ СЧИТАЕТСЯ ПОТЕРЕЙ, И ПОЧЕМУ ИМЕННО ЭТО ──────────────────────
 *
 * ПРОСТОЙ ПОКАЗЫВАЕТСЯ В РУБЛЯХ, А НЕ В ТИКАХ, и это не косметика. «Машина
 * ждёт 14 тиков» не сравнимо ни с ценой терминала, ни с содержанием, ни с
 * простоем в соседнем городе — то есть не помогает принять ни одного решения.
 * Рубли сравнимы со всем сразу, и решение «строить или нет» становится
 * арифметикой, а не ощущением.
 *
 * ПОТЕРЯ — ЭТО ЗАРПЛАТА, УПЛАЧЕННАЯ ЗА СТОЯНИЕ, и ровно она. Разбор стоит того,
 * чтобы его записать, потому что соблазн насчитать больше велик.
 *
 *   В игре есть ровно ОДНА статья расходов, которая идёт по времени, а не по
 *   километрам, — зарплата водителя (payrollPerTick в economy/operating.ts): ему
 *   платят и в рейсе, и на стоянке, и в очереди у рампы. Топливо и обслуживание
 *   начисляются по пробегу, а стоящая машина не проезжает ни метра, значит их
 *   она честно не тратит. Поэтому «сколько денег УШЛО за это стояние» — величина
 *   не оценочная, а точная, и она равна зарплате за время ожидания.
 *
 *   УПУЩЕННАЯ ВЫРУЧКА СЮДА НЕ ВХОДИТ, И ЭТО ОСОЗНАННЫЙ ОТКАЗ. Машина в очереди
 *   не только проедает зарплату — она ещё и не везёт, и настоящая цена очереди
 *   выше показанной. Но посчитать её нечем: фактической выручки линии в
 *   состоянии нет и быть не может (разбор — в шапке ui/lineEconomy.ts), а
 *   выдумать её здесь значило бы завести в интерфейсе ВТОРУЮ экономическую
 *   модель — ровно ту ошибку, от которой предостерегает весь проект. Поэтому
 *   показанное число — НИЖНЯЯ ГРАНИЦА потерь, и панель говорит об этом словами.
 *
 *   Полезное следствие у такой честности одно, зато сильное: срок окупаемости,
 *   посчитанный по заниженной экономии, оказывается ЗАВЫШЕННЫМ. Значит «окупится
 *   за 90 суток» можно читать как «окупится не дольше чем за 90», и это
 *   утверждение, на которое можно опереться, — в отличие от красивой оценки,
 *   которая может соврать в любую сторону.
 *
 * МАШИНА БЕЗ ВОДИТЕЛЯ ГОРИТ НА НОЛЬ РУБЛЕЙ В СУТКИ, и это не дыра в расчёте.
 * Зарплату ей платить некому, а её собственная беда — «стоит без водителя» —
 * уже названа в панели парка. В очереди она при этом место занимает и в списке
 * остаётся: игрок должен видеть, что пост держит машина, которая никуда и не
 * собиралась.
 *
 * ─── ЧТО ЭТА ПАНЕЛЬ ЗНАЕТ И ЧЕГО НЕ ЗНАЕТ ─────────────────────────────────
 *
 * ОЧЕРЕДЬ — ЭТО СНИМОК. Vehicle.queuedTicks обнуляется в тот момент, когда
 * машине достаётся пост (см. runService), а накопленной за партию истории
 * простоев в контракте нет: types.ts — истина, полей туда не добавить. Значит
 * панель отвечает на вопрос «где сеть стоит ПРЯМО СЕЙЧАС», а не «где она стояла
 * за месяц». Это ограничение, и врать о нём нельзя; но для решения, ради
 * которого панель написана, его достаточно — хроническое узкое место видно в
 * ней почти всегда, а разовое совпадение исчезает через тик.
 *
 * ОЧЕРЕДЬ СЧИТАЕТСЯ ПО КОМПАНИИ, а не по узлу целиком, потому что так она
 * устроена в симуляции: базовый пост завода достаётся каждой компании свой, и
 * машины конкурента очередь игрока не удлиняют (разбор — в шапке
 * logistics/service.ts). Показать здесь чужие машины значило бы обещать, что их
 * можно расшить своим терминалом, — а нельзя.
 *
 * Модуль чистый: смотрит на один снимок, ничего не меняет, про React и three не
 * знает.
 */

import { BUILDING_SPEC } from '../data/infrastructure'
import { VEHICLE_CLASS_BY_ID } from '../data/vehicles'
import {
  buildingsIn,
  freeStorage,
  storageCapacity,
} from '../sim/economy/buildings'
import { wagePerTick } from '../sim/economy/operating'
import { driverOf } from '../sim/logistics/driver'
import { postsAt } from '../sim/logistics/service'
import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../sim/types'
import type {
  Building,
  BuildingId,
  BuildingType,
  CargoType,
  CityId,
  Company,
  CompanyId,
  GameState,
  Tons,
  Vehicle,
  VehicleId,
} from '../sim/types'
import { fmtInteger } from './fleetReadout'

/**
 * Порядок типов построек в витрине — от дешёвого к дорогому.
 *
 * Список свой, а не Object.keys(BUILDING_SPEC): порядок ключей объекта — это
 * порядок, в котором их когда-то написали в файле данных, и он молча изменится
 * при первой же правке. Витрина, в которой строки прыгают местами от
 * перебалансировки, читается как сломанная.
 *
 * Ступень видна прямо в порядке: терминал плюс склад — четыре поста и 400 тонн
 * за 160 000, хаб — шесть постов и 1200 тонн за 260 000. Дешевле, слабее и
 * доступно раньше, то есть путь к хабу, а не альтернатива ему.
 */
export const BUILDING_ORDER: readonly BuildingType[] = ['терминал', 'склад', 'хаб']

/**
 * Постройка, которой расшивают очередь.
 *
 * Терминал: три поста, хранить нечего. Именно он предлагается прямо из панели
 * узких мест — потому что узкое место это ПОСТЫ, а не хранение. Склад очередь не
 * расшивает почти совсем (пост у него один), хаб решает ту же задачу втрое
 * дороже, и подсовывать их вместо ответа на заданный вопрос значит продавать, а
 * не советовать.
 */
export const RELIEF_BUILDING: BuildingType = 'терминал'

// ─── Форматирование ────────────────────────────────────────────────────────

/**
 * Время ожидания для чтения глазом.
 *
 * До десяти часов — с десятой долей: на этом масштабе разница между 0.5 и 4
 * часами решает, случайная это заминка или настоящая пробка. Дальше целые часы,
 * а после двух суток — сутки: машина, стоящая третьи сутки, это уже не «сколько
 * именно», а «сеть встала».
 */
export function fmtWait(ticks: number): string {
  if (!Number.isFinite(ticks) || ticks <= 0) return '—'

  const hours = ticks / TICKS_PER_HOUR
  if (hours < 10) return `${hours.toFixed(1).replace('.', ',')} ч`
  if (hours < 48) return `${Math.round(hours)} ч`
  return `${(hours / 24).toFixed(1).replace('.', ',')} сут`
}

/** Срок окупаемости в сутках. Всё, что дальше года, — просто «долго». */
export function fmtPayback(days: number | null): string {
  if (days === null || !Number.isFinite(days) || days <= 0) return '—'
  if (days >= 365) return '365+ сут'
  return `${Math.round(days)} сут`
}

// ─── Одна машина в очереди ─────────────────────────────────────────────────

/**
 * Машина, которой не хватило поста.
 *
 * ЛИНИЯ И КЛАСС НАЗВАНЫ НЕ ДЛЯ КРАСОТЫ. Очередь расшивают двумя способами:
 * терминалом и перестройкой сети, — и второй требует знать, ЧЬИ машины стоят.
 * Три машины одной линии в одном городе означают, что кольцо слишком плотное для
 * этого узла; три машины разных линий — что узел просто перегружен, и его надо
 * либо расшивать бетоном, либо разносить погрузку по разным городам.
 */
export type QueueEntry = {
  id: VehicleId
  /** Название класса из справочника. Битая ссылка отдаёт сам classId. */
  className: string
  /** Название линии. null — машина работает разовым рейсом. */
  lineName: string | null
  /** Имя водителя. null — машина стоит без водителя и зарплаты не жжёт. */
  driverName: string | null

  /** Тиков в очереди с последнего обслуживания. */
  queuedTicks: number
  /** Уже уплачено зарплаты за это стояние, рубли. */
  lost: number
  /** Ставка простоя, рубли за игровые сутки. */
  lostPerDay: number

  /** Что в кузове. null — машина порожняя и ждёт погрузки, а не выгрузки. */
  cargo: CargoType | null

  /**
   * Машина стоит с грузом, который в этом городе некому принять.
   *
   * ЭТО НЕ ОЧЕРЕДЬ, И РАЗНИЦА СТОИТ ДЕНЕГ. Очередь лечится терминалом — постов
   * станет больше, машины поедут быстрее. Непринятый груз терминалом не лечится
   * ВООБЩЕ: склад получателя полон, и сколько ни строй рамп, разгружаться всё
   * равно некуда. Слитые в одно число, эти два случая дают самый дорогой вид
   * вранья — правдоподобный совет купить терминал за 90 000 там, где он не
   * изменит ничего.
   *
   * Признак — счётчик отказов машины (blockedTicks, разбор у markBlocked в
   * sim/logistics/loading.ts): он растёт только тогда, когда машина ПОДЪЕХАЛА
   * сдавать и ей отказали.
   */
  refused: boolean
}

/**
 * Город, в котором стоят машины компании.
 *
 * `busy` и `waiting` — разные вещи, и путать их нельзя. Машина на посту РАБОТАЕТ:
 * тонны идут через рампу, это не потеря, а обычная перевалка, за которую и
 * платят. Потеря — только `waiting`, машины, которым поста не хватило.
 */
export type CityQueue = {
  cityId: CityId
  cityName: string

  /** Постов у компании в этом городе: базовый плюс постройки. */
  posts: number
  /** Машин на постах прямо сейчас — они работают, а не теряют время. */
  busy: number
  /** Машин в очереди. Ноль — узкого места здесь нет. */
  waiting: number

  /** Уплачено зарплаты за нынешнее стояние всей очереди, рубли. */
  lost: number
  /** Ставка простоя очереди, рубли в сутки, пока она такая. */
  lostPerDay: number
  /** Самое долгое ожидание в очереди, тиков. */
  worstTicks: number

  /**
   * Очередь в порядке обслуживания: кто дольше ждёт, тот и зайдёт первым.
   *
   * Порядок ТОТ ЖЕ, что раздаёт посты в logistics/service.ts, и это обязательно:
   * оценка окупаемости считает, что новые посты достанутся первым в списке.
   * Разойдись порядки — и панель обещала бы расшить не тех, кого расшьёт.
   */
  entries: QueueEntry[]

  /** Что здесь можно построить и что это даст. Порядок — BUILDING_ORDER. */
  offers: BuildOffer[]
}

// ─── Предложение построить ─────────────────────────────────────────────────

/**
 * Постройка с ценой, содержанием и оценкой окупаемости.
 *
 * НЕДОСТУПНОЕ НЕ ПРЯЧЕТСЯ, а гаснет и объясняет причину — то же правило, что в
 * витрине техники (fleetReadout.classOffers): копить невозможно на то, чего не
 * видно, а «хаб за 260 000» это цель на первые годы партии.
 *
 * ОТКАЗ И ВЕРДИКТ — РАЗНЫЕ ПОЛЯ. `reason` запрещает нажать кнопку (нет денег,
 * место занято, компания разорена). `verdict` не запрещает ничего: он говорит,
 * окупится ли постройка при нынешней очереди. Постройка, которая не окупается,
 * остаётся доступной намеренно — игрок вправе строить впрок под сеть, которой
 * ещё нет, и запрещать ему это значило бы играть за него.
 */
export type BuildOffer = {
  type: BuildingType
  price: number
  upkeepPerDay: number
  /** Постов добавит. */
  posts: number
  /** Вместимость склада, тонн. Ноль у чистого терминала. */
  storage: Tons

  /** Такая постройка у компании в этом городе уже есть. */
  built: boolean
  affordable: boolean
  /** Кнопку можно нажимать. */
  available: boolean
  /** Почему нельзя. null — можно. */
  reason: string | null

  /** Скольким ждущим машинам достанется пост сразу. */
  relieved: number
  /** Зарплата, которая перестанет гореть, рубли в сутки. */
  savedPerDay: number
  /** Чистый выигрыш: экономия минус содержание, рубли в сутки. */
  netPerDay: number
  /**
   * За сколько суток вернётся цена. null — при нынешней очереди не вернётся.
   *
   * Оценка ЗАВЫШЕНА, и это следует из того, что экономия занижена (разбор — в
   * шапке файла): упущенная выручка в неё не входит. Читать надо «не дольше
   * чем», а не «ровно столько».
   */
  paybackDays: number | null
  /** Тот же ответ словами — панель его только раскрашивает. */
  verdict: string
}

// ─── Постройки в городе ────────────────────────────────────────────────────

/** Постройка компании — со всем, что нужно, чтобы решиться её снести. */
export type BuildingView = {
  id: BuildingId
  type: BuildingType
  posts: number
  storage: Tons
  /** Сколько всего лежит на складе, тонн. */
  stored: Tons
  /** Что именно лежит. Пусто — сносить можно без потерь. */
  cargo: { type: CargoType; tons: Tons }[]
  upkeepPerDay: number
}

/**
 * Чужая постройка в этом городе.
 *
 * ВИДНА, НО НЕ УПРАВЛЯЕТСЯ, и показывать её нужно ровно затем, чтобы игрок не
 * искал объяснения тому, чего не происходит: терминал конкурента не добавляет
 * ему ни одного поста (Building.ownerId в logistics/service.ts), и без этой
 * строки город с чужим хабом выглядел бы как город, где что-то сломалось.
 */
export type ForeignBuilding = {
  id: BuildingId
  type: BuildingType
  ownerName: string
  posts: number
}

// ─── Сбор очереди ──────────────────────────────────────────────────────────

/** Целое неотрицательное число тиков. Битые данные дают ноль, а не NaN. */
function wholeTicks(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

/** Название города. Битая ссылка отдаёт идентификатор — он называет виновника. */
function cityName(state: GameState, id: CityId): string {
  return state.world.cities[id]?.name ?? id
}

/** Черновик узла: машины на постах и машины в очереди. */
type Draft = {
  cityId: CityId
  busy: number
  /** Кандидаты вместе с местом в парке — оно разрывает ничью по ожиданию. */
  waiting: { rank: number; entry: QueueEntry }[]
}

/**
 * Разобрать одну ждущую машину.
 *
 * Ставка простоя спрашивается у wagePerTick — той самой функции, которой фаза
 * расходов списывает зарплату. Своей формулы «wagePerDay / 96» здесь нет
 * намеренно: разойдись она с симуляцией, и панель считала бы потери по одной
 * ставке, а деньги уходили бы по другой.
 */
function entryFor(
  state: GameState,
  company: Company,
  vehicle: Vehicle,
  queued: number,
): QueueEntry {
  const driver = driverOf(state, vehicle)
  const perTick = driver === null ? 0 : wagePerTick(driver)
  const line =
    vehicle.lineId === null ? null : (company.lines?.[vehicle.lineId] ?? null)

  return {
    id: vehicle.id,
    className: VEHICLE_CLASS_BY_ID[vehicle.classId]?.name ?? vehicle.classId,
    lineName: line?.name ?? null,
    driverName: driver?.name ?? null,

    queuedTicks: queued,
    lost: perTick * queued,
    lostPerDay: perTick * TICKS_PER_DAY,

    cargo: vehicle.cargo?.type ?? null,
    refused: vehicle.blockedTicks > 0,
  }
}

/**
 * Один проход по парку компании: кто где стоит.
 *
 * ЧТО СЧИТАЕТСЯ ОЧЕРЕДЬЮ, решает не эта функция, а контракт фазы обслуживания:
 * `queuedTicks > 0` означает «поста не хватило», `serviceTicksLeft > 0` —
 * «стоит под погрузкой». Своего определения простоя здесь нет и быть не должно:
 * машина, которой в узле просто нечего делать, обнулена в обоих счётчиках
 * (см. runService) и в очередь не попадает — иначе панель показывала бы узким
 * местом всякую стоянку.
 *
 * ОДНО СЛЕПОЕ ПЯТНО ЕСТЬ, И ОНО ОБЩЕЕ С СИМУЛЯЦИЕЙ. Погрузка длиной в один тик
 * (партия меньше полутора тонн) оставляет оба счётчика нулевыми уже в тик выдачи
 * поста, поэтому такая машина не попадает ни в `busy`, ни в очередь. Ровно так же
 * её не считает и сама фаза обслуживания, когда раздаёт посты, — то есть панель
 * ошибается там же и на столько же, на сколько ошибается игра. Своя, более
 * точная арифметика была бы здесь хуже: она показывала бы занятость, которой
 * симуляция не видит, и терминал не давал бы обещанного.
 */
function collect(state: GameState, ownerId: CompanyId): Map<CityId, Draft> {
  const company = state.companies[ownerId]
  const nodes = new Map<CityId, Draft>()
  if (company === undefined) return nodes

  const ids = Object.keys(state.vehicles) as VehicleId[]

  for (let rank = 0; rank < ids.length; rank++) {
    const vehicle = state.vehicles[ids[rank]]
    if (vehicle.ownerId !== ownerId) continue
    if (vehicle.position.kind !== 'узел') continue

    const service = wholeTicks(vehicle.serviceTicksLeft)
    const queued = wholeTicks(vehicle.queuedTicks)
    if (service === 0 && queued === 0) continue

    const cityId = vehicle.position.nodeId
    let node = nodes.get(cityId)
    if (node === undefined) {
      node = { cityId, busy: 0, waiting: [] }
      nodes.set(cityId, node)
    }

    if (service > 0) {
      node.busy++
      continue
    }

    node.waiting.push({ rank, entry: entryFor(state, company, vehicle, queued) })
  }

  return nodes
}

/** Пустой узел: город, где ни одна машина компании сейчас не стоит. */
function emptyDraft(cityId: CityId): Draft {
  return { cityId, busy: 0, waiting: [] }
}

/**
 * Черновик узла → строка панели.
 *
 * Очередь сортируется ТЕМ ЖЕ правилом, что раздаёт посты: кто дольше ждёт — тот
 * первый, при равном ожидании — кто раньше в парке. Обе части порядка обязаны
 * быть определены, иначе ничьи остаются на усмотрение движка и список
 * перетасовывается между тиками сам собой.
 */
function rowFrom(
  state: GameState,
  ownerId: CompanyId,
  draft: Draft,
): CityQueue {
  const entries = [...draft.waiting]
    .sort(
      (a, b) => b.entry.queuedTicks - a.entry.queuedTicks || a.rank - b.rank,
    )
    .map((candidate) => candidate.entry)

  let lost = 0
  let lostPerDay = 0
  let worstTicks = 0
  for (const entry of entries) {
    lost += entry.lost
    lostPerDay += entry.lostPerDay
    if (entry.queuedTicks > worstTicks) worstTicks = entry.queuedTicks
  }

  return {
    cityId: draft.cityId,
    cityName: cityName(state, draft.cityId),

    // Посты спрашиваются у симуляции, а не складываются здесь из BASE_POSTS и
    // построек: сумма живёт в одном месте (postsAt), и разойдись эти две
    // формулы — терминал добавлял бы посты в очереди, но не в панели.
    posts: postsAt(state, draft.cityId, ownerId),
    busy: draft.busy,
    waiting: entries.length,

    lost,
    lostPerDay,
    worstTicks,
    entries,

    offers: buildOffers(state, ownerId, draft.cityId, entries),
  }
}

/**
 * Города, где машины компании стоят в очереди, — дороже всего сверху.
 *
 * СОРТИРОВКА ПО ДЕНЬГАМ, А НЕ ПО АЛФАВИТУ И НЕ ПО ЧИСЛУ МАШИН. Панель отвечает
 * на вопрос «куда бежать первым делом», и первым делом бегут туда, где дороже:
 * две машины по тысяче в сутки важнее пяти по двести. Ничья по деньгам
 * разрывается временем ожидания, потом именем города — порядок обязан быть
 * определён до конца, иначе строки меняются местами между тиками сами собой, и
 * игрок промахивается мимо кнопки.
 *
 * ЦЕНА ТАКОЙ СОРТИРОВКИ ЧЕСТНО ЕСТЬ: строки всё-таки прыгают, когда очередь
 * меняется. В панели парка список поэтому НЕ сортируется по беде (см.
 * fleetRows) — но там строк десятки и в них целятся мышью, а здесь их единицы, и
 * весь смысл панели в том, какая строка сверху.
 */
export function bottleneckRows(
  state: GameState,
  ownerId: CompanyId,
): CityQueue[] {
  const rows: CityQueue[] = []

  for (const draft of collect(state, ownerId).values()) {
    // Город, где все машины на постах, — не узкое место, а работающий узел.
    // Показать его значило бы утопить настоящую пробку в списке исправных
    // городов.
    if (draft.waiting.length === 0) continue
    rows.push(rowFrom(state, ownerId, draft))
  }

  return rows.sort(
    (a, b) =>
      b.lost - a.lost ||
      b.worstTicks - a.worstTicks ||
      a.cityName.localeCompare(b.cityName, 'ru'),
  )
}

/**
 * Один город, даже если очереди в нём нет.
 *
 * Нужен карточке города: там строка про посты и очередь стоит рядом с кнопками
 * строительства и обязана быть на месте всегда. Пустая очередь — это ответ
 * «здесь не стоят», а не отсутствие ответа.
 */
export function cityQueue(
  state: GameState,
  ownerId: CompanyId,
  cityId: CityId,
): CityQueue {
  const draft = collect(state, ownerId).get(cityId) ?? emptyDraft(cityId)
  return rowFrom(state, ownerId, draft)
}

// ─── Витрина построек ──────────────────────────────────────────────────────

/**
 * Зарплата, которая перестанет гореть, если добавить столько-то постов.
 *
 * Расшиваются ПЕРВЫЕ в очереди — те, кому пост достанется по правилу
 * обслуживания. Больше, чем стоит в очереди, ни один терминал не расшьёт: три
 * поста при одной ждущей машине спасают одну зарплату, а не три.
 *
 * МАШИНЫ С НЕПРИНЯТЫМ ГРУЗОМ ИЗ РАСЧЁТА ИСКЛЮЧЕНЫ, и это главное здесь.
 * Терминал добавляет РАМПЫ, а машина с отказом стоит не из-за рампы — ей
 * некуда сдать груз, склад получателя полон. Посчитай её в окупаемость, и
 * панель пообещает игроку возврат девяноста тысяч там, где не изменится
 * ровно ничего: замер показал узел, где 12.9 процентных пункта очереди из 13
 * были именно таким мёртвым стоянием.
 */
function savedPerDayFor(
  entries: readonly QueueEntry[],
  posts: number,
): { relieved: number; saved: number } {
  const slots = Number.isFinite(posts) && posts > 0 ? Math.floor(posts) : 0
  const helped = entries.filter((entry) => !entry.refused)
  const relieved = Math.min(helped.length, slots)

  let saved = 0
  for (let i = 0; i < relieved; i++) saved += helped[i].lostPerDay

  return { relieved, saved }
}

/**
 * Что можно построить в этом городе и что это даст.
 *
 * Очередь передаётся аргументом, а не собирается внутри: строку панели уже
 * посчитали, и второй проход по парку ради тех же машин был бы не только лишней
 * работой, но и вторым мнением о том, кто в очереди первый.
 */
export function buildOffers(
  state: GameState,
  ownerId: CompanyId,
  cityId: CityId,
  entries: readonly QueueEntry[],
): BuildOffer[] {
  const company = state.companies[ownerId]
  const money = company?.money ?? 0
  const bankrupt = company?.bankrupt ?? false

  const standing =
    company === undefined ? [] : buildingsIn(company, cityId).map((b) => b.type)

  return BUILDING_ORDER.map((type) => {
    const spec = BUILDING_SPEC[type]
    const built = standing.includes(type)
    const affordable = money >= spec.price

    const reason = built
      ? 'уже построен'
      : bankrupt
        ? 'компания разорена'
        : !affordable
          ? `не хватает ${fmtInteger(spec.price - money)} руб`
          : null

    const { relieved, saved } = savedPerDayFor(entries, spec.posts)
    const netPerDay = saved - spec.upkeepPerDay
    const paybackDays = netPerDay > 0 ? spec.price / netPerDay : null

    return {
      type,
      price: spec.price,
      upkeepPerDay: spec.upkeepPerDay,
      posts: spec.posts,
      storage: spec.storage,

      built,
      affordable,
      available: reason === null,
      reason,

      relieved,
      savedPerDay: saved,
      netPerDay,
      paybackDays,
      verdict: verdictFor({
        waiting: entries.length,
        relieved,
        saved,
        upkeepPerDay: spec.upkeepPerDay,
        paybackDays,
      }),
    }
  })
}

/**
 * Вердикт по окупаемости словами.
 *
 * Живёт здесь, а не в разметке, ровно по той же причине, по которой здесь живут
 * числа: фразу «окупится за столько-то» можно проверить тестом, а нарисованную в
 * .tsx — нельзя. Тот же приём, что citySupplyStatus в ui/cityReadout.ts.
 *
 * ФОРМУЛИРОВКИ РАЗНЫЕ ДЛЯ РАЗНЫХ СЛУЧАЕВ, И ЭТО НЕ ПРИДИРКА К СЛОВАМ. «Очереди
 * нет» и «очередь есть, но короткая» требуют от игрока противоположного:
 * в первом случае строить не надо вовсе, во втором — надо подумать, не подождать
 * ли, пока сеть подрастёт. Одна фраза на оба случая не советует ничего.
 */
function verdictFor(input: {
  waiting: number
  relieved: number
  saved: number
  upkeepPerDay: number
  paybackDays: number | null
}): string {
  if (input.waiting === 0) {
    return 'очереди здесь нет — будет только проедать прибыль'
  }
  if (input.relieved === 0) return 'постов не добавляет — очередь не расшивает'

  if (input.paybackDays !== null) {
    // «Не дольше», а не «ровно»: экономия занижена на упущенную выручку, значит
    // срок завышен. Разбор — в шапке файла.
    return `окупится не дольше чем за ${fmtPayback(input.paybackDays)}`
  }

  return `зарплата очереди ${fmtInteger(
    input.saved,
  )} против содержания ${fmtInteger(
    input.upkeepPerDay,
  )} руб/сут — этой очередью не окупается`
}

// ─── Постройки города ──────────────────────────────────────────────────────

/** Что лежит на складе постройки, в порядке ключей склада. */
function cargoOf(building: Building): { type: CargoType; tons: Tons }[] {
  const stock = building.stock ?? {}
  const list: { type: CargoType; tons: Tons }[] = []

  for (const key of Object.keys(stock) as CargoType[]) {
    const tons = stock[key] ?? 0
    if (Number.isFinite(tons) && tons > 0) list.push({ type: key, tons })
  }

  return list
}

/**
 * Постройки компании в городе.
 *
 * ОСТАТОК НА СКЛАДЕ СЧИТАЕТСЯ ФУНКЦИЯМИ СИМУЛЯЦИИ (вместимость минус свободное
 * место), а не сложением ключей склада своим циклом. Разница видна ровно там,
 * где она дороже всего: остаток в 4e-16 тонны симуляция считает нулём (порог
 * значимости в economy/buildings.ts), а наивная сумма показала бы «0 т» и при
 * этом «свободно 400 из 400» — то есть два числа, противоречащих друг другу.
 */
export function ownBuildings(
  state: GameState,
  ownerId: CompanyId,
  cityId: CityId,
): BuildingView[] {
  const company = state.companies[ownerId]
  if (company === undefined) return []

  return buildingsIn(company, cityId).map((building) => ({
    id: building.id,
    type: building.type,
    posts: building.posts,
    storage: storageCapacity(building),
    stored: storageCapacity(building) - freeStorage(building),
    cargo: cargoOf(building),
    // Содержание берётся у СПРАВОЧНИКА, а не у постройки, — ровно как в
    // upkeepPerTick: посты и вместимость постройка обещала игроку при покупке,
    // а цена содержания это цена мира, и дорожает она у всех сразу.
    upkeepPerDay: BUILDING_SPEC[building.type]?.upkeepPerDay ?? 0,
  }))
}

/** Постройки ВСЕХ ОСТАЛЬНЫХ компаний в этом городе. */
export function foreignBuildings(
  state: GameState,
  ownerId: CompanyId,
  cityId: CityId,
): ForeignBuilding[] {
  const found: ForeignBuilding[] = []

  for (const key of Object.keys(state.companies) as CompanyId[]) {
    if (key === ownerId) continue
    const company = state.companies[key]

    for (const building of buildingsIn(company, cityId)) {
      found.push({
        id: building.id,
        type: building.type,
        ownerName: company.name,
        posts: building.posts,
      })
    }
  }

  return found
}

// ─── Сводка по сети ────────────────────────────────────────────────────────

/**
 * Итог по всем узким местам разом — для кнопки вызова и шапки панели.
 *
 * Кнопка обязана сообщать беду, не открывая ничего: «узкие места · 1 700 руб/сут»
 * это повод открыть панель, а «узкие места» само по себе — нет.
 */
export type BottleneckSummary = {
  /** Городов с очередью. */
  cities: number
  /** Машин в очередях, по всей сети. */
  waiting: number
  /** Уплачено зарплаты за нынешние стояния, рубли. */
  lost: number
  /** Ставка простоя всей сети, рубли в сутки. */
  lostPerDay: number
}

export function bottleneckSummary(
  rows: readonly CityQueue[],
): BottleneckSummary {
  const summary: BottleneckSummary = {
    cities: rows.length,
    waiting: 0,
    lost: 0,
    lostPerDay: 0,
  }

  for (const row of rows) {
    summary.waiting += row.waiting
    summary.lost += row.lost
    summary.lostPerDay += row.lostPerDay
  }

  return summary
}
