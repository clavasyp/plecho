/**
 * Чтение парка: снимок мира → строки панели парка.
 *
 * Слой между симуляцией и ui/FleetPanel.tsx, устроенный так же, как cityReadout
 * для карточки города, и по тем же двум причинам. Формальная: .tsx, который
 * экспортирует что-то кроме компонентов, ломает Fast Refresh. Существенная:
 * разметку ломает дизайнер, и это видно глазом, а диагноз ломается молча —
 * числа остаются правдоподобными, а смысл меняется на противоположный.
 * Отделённый, он проверяется тестом без браузера.
 *
 * ГЛАВНОЕ ПРАВИЛО ФАЙЛА, ТО ЖЕ, ЧТО У СОСЕДЕЙ: ни одной собственной формулы.
 * Ставка обслуживания, цена ТО и ремонта, расход на километр, признак отдыха,
 * допуски, совместимость прицепа с грузом — всё зовётся из src/sim теми же
 * функциями, которыми это считает симуляция, а цены и характеристики техники
 * берутся из src/data. Панель со своей формулой хуже отсутствующей панели: она
 * врёт убедительно (разбор того, как в этом проекте расходятся две формулы
 * одного и того же, — в шапке sim/world/speed.ts).
 *
 * ─── ЗАЧЕМ ЭТОТ ФАЙЛ ВООБЩЕ НУЖЕН: РЕШЕНИЕ «ПОРА СПИСЫВАТЬ» ────────────────
 *
 * Панель парка отвечает на один вопрос, которого до среза 4 в игре не было:
 * ЧТО ДЕЛАТЬ С ЭТОЙ МАШИНОЙ. Продолжать возить, отправить на ТО, ремонтировать
 * после поломки или списывать. Ответ не даётся одним числом — его дают ДВА,
 * и стоять они обязаны рядом:
 *
 *   износ                — сколько ресурса машина уже потратила;
 *   обслуживание, руб/км — во что этот износ обходится КАЖДЫЙ километр.
 *
 * Первое без второго — счётчик, который ничего не советует: игрок видит «73%» и
 * не знает, много это или мало. Второе без первого — расход, про который
 * непонятно, вырастет он ещё или уже нет. Вместе они и есть решение, потому что
 * машина перестаёт быть нужной не при «износе больше N», а когда переменные
 * расходы догоняют выручку за километр (полный разбор — в шапке
 * sim/logistics/wear.ts).
 *
 * Поэтому здесь считается ещё и ПОРОГ СПИСАНИЯ (writeOffWear) — тот износ, при
 * котором расходы на километр сравниваются с потолком выручки на километр.
 * Порог свой у каждого класса и он НЕ константа игры: у ЗИЛа он около 0.73, у
 * тягача около 0.52, и никакого общего «списывай на семидесяти процентах» не
 * существует. Считается он не алгеброй, а поиском деления пополам по тем же
 * функциям симуляции — см. writeOffWear о том, почему именно так.
 */

import { TARIFF_PER_TON_KM } from '../data/operating'
import {
  TRAILER_PRICE,
  VEHICLE_CLASSES,
  VEHICLE_CLASS_BY_ID,
} from '../data/vehicles'
import { distanceCost } from '../sim/economy/operating'
import {
  CARGO_LICENSE,
  canDrive,
  isResting,
} from '../sim/logistics/driver'
import { TRAILER_TYPES, cargoFor } from '../sim/logistics/trailer'
import {
  maintenancePerKm,
  needsService,
  repairCost,
  serviceCost,
} from '../sim/logistics/wear'
import { HOME_CITY, createVehicle } from '../sim/state'
import { companyId, vehicleId } from '../sim/types'
import type {
  CargoType,
  City,
  CityId,
  Driver,
  DriverId,
  DriverLicense,
  Edge,
  EdgeId,
  Line,
  LineId,
  Tons,
  TrailerType,
  Vehicle,
  VehicleId,
} from '../sim/types'

// ─── Форматирование ────────────────────────────────────────────────────────

/**
 * Форматтеры создаются по одному на модуль.
 *
 * Intl.NumberFormat стоит заметно дороже самого форматирования, а панель
 * пересобирает все строки каждый тик — тот же довод, что в CompanyPanel.
 */
const INTEGER = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 })

/** Целые рубли и километры: копейки в панели — шум, решения принимают не по ним. */
export function fmtInteger(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return INTEGER.format(Math.round(value))
}

/**
 * Ставка за километр — всегда с одним знаком после запятой.
 *
 * Здесь десятая доля значит много: разница между 4,5 и 9,7 руб/км это разница
 * между новой машиной и той, которую пора списывать, а округление до рубля
 * стёрло бы половину шкалы решения.
 */
export function fmtRate(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return value.toFixed(1).replace('.', ',')
}

/** Тонны — с одним знаком, чтобы «6,0 т» и «0,4 т» стояли одной шириной. */
export function fmtTons(tons: Tons): string {
  if (!Number.isFinite(tons)) return '—'
  return tons.toFixed(1).replace('.', ',')
}

/** Доля 0..1 в проценты. Прочерк на битом числе, а не «NaN%». */
export function fmtShare(share: number | null): string {
  if (share === null || !Number.isFinite(share)) return '—'
  return `${Math.round(share * 100)}%`
}

/**
 * Русское склонение по числу.
 *
 * Третья копия правила в проекте (CompanyPanel, LineEditor, здесь) и тот же
 * осознанный долг: общего слоя интерфейса пока нет, а панель с «5 машина»
 * выглядит черновиком — это дороже небольшого дублирования.
 */
export function plural(
  count: number,
  forms: readonly [string, string, string],
): string {
  const hundreds = count % 100
  if (hundreds >= 11 && hundreds <= 14) return forms[2]
  const units = count % 10
  if (units === 1) return forms[0]
  if (units >= 2 && units <= 4) return forms[1]
  return forms[2]
}

// ─── Экономика километра ───────────────────────────────────────────────────

/**
 * Потолок выручки машины за километр, рубли.
 *
 *     m · t — грузоподъёмность класса на его же тариф за тонно-километр
 *
 * ЭТО ЛЕВАЯ ГРАНИЦА ГЛАВНОГО ИНВАРИАНТА ИГРЫ (c < m·t·p < 2c, разбор — в шапке
 * src/data/operating.ts), и потому именно с ней сравниваются расходы: пока
 * километр приносит больше, чем стоит, машина отбивает хотя бы идеальный рейс;
 * как только перестал — не отобьёт никакой.
 *
 * НАДБАВКА ЗА ГРУЗ (0.95…1.2) СЮДА НЕ ВХОДИТ, и это честнее, чем входила бы:
 * панель не знает, что машина повезёт завтра, а показать порог, посчитанный по
 * самому дорогому грузу карты, значило бы обещать выручку, которой у этой
 * машины может не быть никогда — нефть и топливо требуют цистерны и ДОПОГ.
 * Нейтральный груз (зерно, пиломатериалы) даёт ровно этот множитель, равный
 * единице, поэтому число — не «средняя температура», а конкретный случай.
 *
 * Плата за погрузку тоже не входит: она не зависит от километров, а здесь
 * сравниваются именно километровые величины.
 *
 * Неизвестный класс (сейв старше справочника) откатывается к общему тарифу —
 * тот же приём, что в maintenancePerKm для ставки обслуживания. Ноль здесь
 * означал бы машину, которая не зарабатывает вовсе, то есть «списать немедленно»
 * из-за дефекта данных.
 */
export function revenuePerKm(vehicle: Vehicle): number {
  const vc = VEHICLE_CLASS_BY_ID[vehicle.classId]
  const tariff = vc === undefined ? TARIFF_PER_TON_KM : vc.tariffPerTonKm
  const value = vehicle.capacity * tariff
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Переменные расходы машины за километр, рубли: топливо плюс обслуживание.
 *
 * Считает distanceCost — та самая функция, которой списывает деньги фаза
 * расходов, вызванная на один километр. Водитель передаётся: опытный жжёт
 * меньше на той же машине, и в строке парка игрок должен видеть СВОЙ расход, а
 * не паспортный.
 */
export function costPerKm(vehicle: Vehicle, driver: Driver | null): number {
  return distanceCost(vehicle, 1, driver)
}

/**
 * Сколько шагов деления пополам делает поиск порога списания.
 *
 * Двадцать четыре шага сужают отрезок 0..1 до 6e-8 — точность, заведомо лишняя
 * для числа, которое показывается в процентах. Дешевле взять с запасом, чем
 * потом объяснять дрожание последнего процента.
 */
const WRITE_OFF_STEPS = 24

/** Расходы на километр у той же машины с другим износом. */
function costAtWear(vehicle: Vehicle, wear: number): number {
  // Копия, а не правка машины: функция обязана быть чистой, а вход — остаться
  // нетронутым на всех уровнях вложенности.
  return costPerKm({ ...vehicle, wear }, null)
}

/**
 * Износ, при котором машина перестаёт отбивать даже идеальный рейс. null —
 * не перестаёт до конца ресурса.
 *
 * ПОЧЕМУ ПОИСК, А НЕ ФОРМУЛА. Алгебраическое решение известно и выписано в
 * шапке sim/logistics/wear.ts: w* = √((m·t·p − c(0)) / (G·maint)). Вписать его
 * сюда значило бы завести ВТОРУЮ запись модели износа — в интерфейсе, — и
 * первая же правка формы кривой (сегодня квадрат, завтра куб) разошлась бы с
 * ней молча: панель продолжала бы показывать правдоподобное число, но не то.
 * Деление пополам зовёт те же функции симуляции и остаётся верным при любой
 * монотонной модели старения, а монотонность здесь гарантирована смыслом —
 * изношенная машина не может обслуживаться дешевле новой.
 *
 * ВОДИТЕЛЬ В ПОРОГ НЕ ВХОДИТ. Порог — свойство ЖЕЛЕЗА: водителя пересаживают
 * за пятнадцать минут, а машина остаётся. Иначе одна и та же машина
 * «списывалась» бы то раньше, то позже от того, кто сегодня за рулём.
 *
 * Ноль означает, что машина невыгодна уже новой, — состояние невозможное для
 * справочника, который проверен тестом инварианта, но возможное для битого
 * сохранения, и молчать о нём нельзя.
 */
export function writeOffWear(vehicle: Vehicle): number | null {
  const revenue = revenuePerKm(vehicle)
  if (!(revenue > 0)) return null

  if (costAtWear(vehicle, 0) >= revenue) return 0
  if (costAtWear(vehicle, 1) < revenue) return null

  let low = 0
  let high = 1
  for (let step = 0; step < WRITE_OFF_STEPS; step++) {
    const mid = (low + high) / 2
    if (costAtWear(vehicle, mid) < revenue) low = mid
    else high = mid
  }
  return high
}

// ─── Строка парка ──────────────────────────────────────────────────────────

/**
 * Беда машины, из-за которой она не зарабатывает. Порядок — по важности.
 *
 * Отдельным полем, а не тремя булевыми флагами в разметке: строка обязана
 * назвать ОДНУ главную причину простоя, иначе у сломанного тягача без прицепа и
 * без водителя загорятся три метки сразу и ни одна не будет прочитана.
 *
 * Сломана важнее всего: она стоит поперёк линии и тратит деньги на эвакуацию.
 * Дальше отсутствие водителя (машина физически не тронется), потом прицепа
 * (тронется, но груза не возьмёт). ТО — не простой вовсе, а счёт, который
 * растёт; поэтому оно последнее.
 */
export type FleetTrouble =
  | 'сломана'
  | 'без водителя'
  | 'без прицепа'
  | 'пора на ТО'
  | null

/** Одна машина парка, разобранная в готовые к показу величины. */
export type FleetRow = {
  id: VehicleId
  /** Название класса из справочника. Битая ссылка отдаёт сам classId. */
  className: string
  capacity: Tons

  trailer: TrailerType | null
  /** Грузы, которые машина физически способна взять. Пусто — прицепа нет. */
  carries: CargoType[]

  driverId: DriverId | null
  driverName: string | null

  /** Износ 0..1 и ставка обслуживания при нём — два числа одного решения. */
  wear: number
  maintenancePerKm: number
  /** Паспортная ставка класса, руб/км: точка отсчёта для предыдущего числа. */
  basePerKm: number
  /** Все переменные расходы, руб/км: топливо этого водителя плюс обслуживание. */
  costPerKm: number
  /** Потолок выручки, руб/км. Ниже него машина не отбивает даже идеальный рейс. */
  revenuePerKm: number
  /** Износ, на котором расходы догонят потолок. null — не догонят до конца. */
  writeOffWear: number | null

  odometer: number
  kmSinceService: number
  serviceDue: boolean
  serviceCost: number
  brokenDown: boolean
  repairCost: number

  cargo: { type: CargoType; tons: Tons } | null

  /** Где сейчас: «Москва → Тула» на ребре, «Тула» в узле. */
  leg: string
  /** Доля пройденного плеча 0..1. null — машина стоит в узле. */
  progress: number | null
  /** Конечный город маршрута. null — маршрута нет или он и так виден в leg. */
  destination: string | null
  /** Стоит без задания, то есть не зарабатывает вообще ничего. */
  idle: boolean

  lineId: LineId | null
  lineName: string | null

  trouble: FleetTrouble
}

/** Всё, что нужно разбору, кроме самих машин. */
export type FleetContext = {
  cities: Record<CityId, City>
  edges: Record<EdgeId, Edge>
  lines: Record<LineId, Line>
  drivers: Record<DriverId, Driver>
}

/**
 * Название города по идентификатору.
 *
 * Битая ссылка отдаёт сам идентификатор, а не «???»: строка «moscow-2» сразу
 * называет виновника, а прочерк отправляет искать вслепую. Правило то же, что
 * было в CompanyPanel, откуда разбор положения сюда и переехал.
 */
function cityName(id: CityId, cities: Record<CityId, City>): string {
  return cities[id]?.name ?? id
}

/** Доля 0..1 из возможно битого числа. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value <= 0) return 0
  return value >= 1 ? 1 : value
}

/** Главная беда машины или null, если она работает. Порядок — из FleetTrouble. */
function troubleOf(vehicle: Vehicle): FleetTrouble {
  if (vehicle.brokenDown) return 'сломана'
  if (vehicle.driverId === null) return 'без водителя'
  if (vehicle.trailer === null) return 'без прицепа'
  // needsService — функция симуляции: интервал ТО живёт там же, где износ.
  if (needsService(vehicle)) return 'пора на ТО'
  return null
}

/** Где машина и куда едет — три поля строки, разобранные вместе. */
function positionOf(
  vehicle: Vehicle,
  ctx: FleetContext,
): Pick<FleetRow, 'leg' | 'progress' | 'destination' | 'idle'> {
  const route = vehicle.route
  const finalStop = route.length > 0 ? route[route.length - 1] : null

  if (vehicle.position.kind === 'узел') {
    const here = vehicle.position.nodeId
    return {
      leg: cityName(here, ctx.cities),
      progress: null,
      // Конечная совпала с местом стоянки — маршрут доеден, показывать нечего.
      destination:
        finalStop !== null && finalStop !== here
          ? cityName(finalStop, ctx.cities)
          : null,
      idle: route.length === 0,
    }
  }

  const edge: Edge | undefined = ctx.edges[vehicle.position.edgeId]
  const fromId = vehicle.position.fromId

  // Ребро исчезло из мира или машина стоит не на своём ребре — то же правило,
  // что и в рендере: врать наугад хуже, чем честно показать, что положение не
  // разобрано.
  if (edge === undefined || (fromId !== edge.from && fromId !== edge.to)) {
    return {
      leg: 'в пути',
      progress: null,
      destination:
        finalStop !== null ? cityName(finalStop, ctx.cities) : null,
      idle: false,
    }
  }

  const toId = fromId === edge.from ? edge.to : edge.from

  return {
    leg: `${cityName(fromId, ctx.cities)} → ${cityName(toId, ctx.cities)}`,
    /*
     * Доля берётся из состояния как есть, без интерполяции по кадрам, в отличие
     * от положения машины на карте: скачок метки глаз ловит как рывок, а скачок
     * числа с 40% на 46% — это просто новое показание прибора.
     */
    progress: clamp01(vehicle.position.progress),
    // Ближайший конец плеча уже написан в leg — повторять его стрелкой значит
    // занять место ничем.
    destination:
      finalStop !== null && finalStop !== toId
        ? cityName(finalStop, ctx.cities)
        : null,
    idle: false,
  }
}

/**
 * Разбор одной машины. Порядок машин задаёт вызывающий.
 *
 * Функция чистая и ничего не мутирует, включая вложенные объекты: единственная
 * копия машины делается внутри costAtWear и наружу не выходит.
 */
export function fleetRow(vehicle: Vehicle, ctx: FleetContext): FleetRow {
  const vc = VEHICLE_CLASS_BY_ID[vehicle.classId]
  const driver =
    vehicle.driverId === null ? null : (ctx.drivers[vehicle.driverId] ?? null)
  const line = vehicle.lineId === null ? null : (ctx.lines[vehicle.lineId] ?? null)

  return {
    id: vehicle.id,
    className: vc?.name ?? vehicle.classId,
    capacity: vehicle.capacity,

    trailer: vehicle.trailer,
    // Список грузов кузова — из sim/logistics/trailer.ts, то есть из индекса по
    // CARGO_REQUIREMENTS. Своей таблицы совместимости в интерфейсе нет: она
    // разошлась бы с погрузкой, и игрок видел бы прицеп, с которым машина потом
    // стоит порожней.
    carries: vehicle.trailer === null ? [] : cargoFor(vehicle.trailer),

    driverId: vehicle.driverId,
    driverName: driver?.name ?? null,

    wear: clamp01(vehicle.wear),
    maintenancePerKm: maintenancePerKm(vehicle),
    basePerKm: vc?.maintenancePerKm ?? maintenancePerKm({ ...vehicle, wear: 0 }),
    costPerKm: costPerKm(vehicle, driver),
    revenuePerKm: revenuePerKm(vehicle),
    writeOffWear: writeOffWear(vehicle),

    odometer: vehicle.odometer,
    kmSinceService: vehicle.kmSinceService,
    serviceDue: needsService(vehicle),
    serviceCost: serviceCost(vehicle),
    brokenDown: vehicle.brokenDown,
    repairCost: repairCost(vehicle),

    cargo:
      vehicle.cargo === null
        ? null
        : { type: vehicle.cargo.type, tons: vehicle.cargo.tons },

    ...positionOf(vehicle, ctx),

    lineId: vehicle.lineId,
    lineName: line?.name ?? null,

    trouble: troubleOf(vehicle),
  }
}

/**
 * Парк одной компании в порядке ключей состояния.
 *
 * ПОРЯДОК НЕ СОРТИРУЕТСЯ ПО БЕДЕ, хотя соблазн велик. Список, в котором строки
 * меняются местами от того, что машина сломалась или доехала до города, нельзя
 * читать: игрок целится в строку, а под курсором к моменту клика оказывается
 * другая машина. Беды видны метками и сводкой сверху (fleetSummary), а порядок
 * остаётся тем же, в каком машины покупались.
 */
export function fleetRows(
  vehicles: readonly Vehicle[],
  ctx: FleetContext,
): FleetRow[] {
  return vehicles.map((vehicle) => fleetRow(vehicle, ctx))
}

// ─── Сводка по парку ───────────────────────────────────────────────────────

/**
 * Сколько машин стоит и почему.
 *
 * Нужна двум панелям сразу: панель компании показывает по ней одну строку
 * («парк: 4 машины, 1 сломана»), панель парка — шапку. Считается один раз
 * здесь, потому что две сводки по одним и тем же машинам однажды разойдутся, и
 * доверия не будет ни одной.
 */
export type FleetSummary = {
  count: number
  broken: number
  driverless: number
  trailerless: number
  serviceDue: number
  /** Стоят без задания: линии нет и разового рейса тоже. */
  idle: number
  /** Износ выше порога списания — машина не отбивает даже идеальный рейс. */
  wornOut: number
  /** Сколько машин чем-то больны. По ним и считается «остановленные деньги». */
  troubled: number
}

export function fleetSummary(rows: readonly FleetRow[]): FleetSummary {
  const summary: FleetSummary = {
    count: rows.length,
    broken: 0,
    driverless: 0,
    trailerless: 0,
    serviceDue: 0,
    idle: 0,
    wornOut: 0,
    troubled: 0,
  }

  for (const row of rows) {
    if (row.brokenDown) summary.broken++
    if (row.driverId === null) summary.driverless++
    if (row.trailer === null) summary.trailerless++
    if (row.serviceDue) summary.serviceDue++
    if (row.idle) summary.idle++
    if (row.writeOffWear !== null && row.wear >= row.writeOffWear) {
      summary.wornOut++
    }
    if (row.trouble !== null) summary.troubled++
  }

  return summary
}

// ─── Покупка техники ───────────────────────────────────────────────────────

/**
 * Класс техники в списке покупки — со всем, что нужно для решения.
 *
 * НЕДОСТУПНЫЕ КЛАССЫ ОСТАЮТСЯ В СПИСКЕ. Спрятать технику, которая ещё не
 * выпускается или пока не по деньгам, значит отнять у игрока цель: копить
 * невозможно на то, чего не видно, а «в 2000 году появится двадцатитонник» —
 * это половина плана на первые шесть лет партии. Поэтому строка не исчезает, а
 * гаснет и объясняет причину.
 */
export type ClassOffer = {
  id: string
  name: string
  capacity: Tons
  cruiseKmh: number
  fuelPer100Km: number
  maintenancePerKm: number
  tariffPerTonKm: number
  handlingPerTon: number
  price: number
  availableFrom: number
  trailers: TrailerType[]

  /** Переменные расходы новой машины, руб/км. */
  costPerKm: number
  /** Потолок выручки, руб/км: m·t, левая граница главного инварианта. */
  revenuePerKm: number

  /** Класс уже выпускается. */
  released: boolean
  /** Денег хватает. */
  affordable: boolean
  /** Кнопку можно нажимать. */
  available: boolean
  /** Почему нельзя. null — можно. */
  reason: string | null
}

/**
 * Новая машина каждого класса — образец для витрины.
 *
 * Собирается тем же createVehicle, каким игроку выдают настоящие машины, а не
 * литералом с полями: расход, грузоподъёмность и класс приходят из справочника
 * через sim/state.ts, и витрина не может разойтись с тем, что игрок получит по
 * кнопке «купить». Тот же приём и по той же причине — REFERENCE_VEHICLE в
 * ui/lineEconomy.ts.
 *
 * Считается один раз при загрузке модуля: справочник неизменяем, а витрина
 * пересобирается на каждый кадр открытой панели.
 */
const SHOWROOM: Record<string, Vehicle> = Object.fromEntries(
  VEHICLE_CLASSES.map((vc) => [
    vc.id,
    createVehicle(
      vehicleId(`витрина-${vc.id}`),
      companyId('витрина'),
      HOME_CITY,
      vc.id,
    ),
  ]),
)

/**
 * Витрина техники на этот год и эти деньги.
 *
 * Год приходит снаружи, а не считается здесь: календарь в игре ровно один
 * (sim/time.ts), и второй экземпляр даты разъехался бы с ним при первой правке.
 *
 * Расходы и выручка на километр считаются по машине, СОБРАННОЙ ИЗ КЛАССА, а не
 * по формуле рядом: costPerKm ниже — та же функция, что показывает расход
 * работающей машины в строке парка, и разойтись эти два числа не могут.
 */
export function classOffers(
  year: number,
  money: number,
  bankrupt: boolean,
): ClassOffer[] {
  return VEHICLE_CLASSES.map((vc) => {
    const released = year >= vc.availableFrom
    const affordable = money >= vc.price
    const fresh = SHOWROOM[vc.id]

    const reason = bankrupt
      ? 'компания разорена'
      : !released
        ? `выпускается с ${vc.availableFrom} года`
        : !affordable
          ? `не хватает ${fmtInteger(vc.price - money)} руб`
          : null

    return {
      id: vc.id,
      name: vc.name,
      capacity: vc.capacity,
      cruiseKmh: vc.cruiseKmh,
      fuelPer100Km: vc.fuelPer100Km,
      maintenancePerKm: vc.maintenancePerKm,
      tariffPerTonKm: vc.tariffPerTonKm,
      handlingPerTon: vc.handlingPerTon,
      price: vc.price,
      availableFrom: vc.availableFrom,
      trailers: [...vc.trailers],

      costPerKm: costPerKm(fresh, null),
      revenuePerKm: revenuePerKm(fresh),

      released,
      affordable,
      available: reason === null,
      reason,
    }
  })
}

// ─── Прицепы ───────────────────────────────────────────────────────────────

/**
 * Прицеп в списке покупки: цена и — главное — что он позволяет возить.
 *
 * СПИСОК ГРУЗОВ ЗДЕСЬ ВАЖНЕЕ ЦЕНЫ. Прицепы дёшевы намеренно (разбор — у
 * TRAILER_PRICE в data/vehicles.ts): решение не в том, накопить ли, а в том,
 * ПОД ЧТО специализировать машину. Цистерна возит два груза из шести, зерновоз
 * — один; выбрать это вслепую нельзя, а держать в голове таблицу совместимости
 * игрок не обязан.
 *
 * НЕПОДХОДЯЩИЕ КЛАССУ ПРИЦЕПЫ ТОЖЕ В СПИСКЕ. Полуприцеп-цистерну на бортовой
 * ЗИЛ не повесить, и увидеть это игрок должен здесь, а не гадать, почему в
 * списке три строки вместо шести.
 */
export type TrailerOffer = {
  trailer: TrailerType
  price: number
  /** Грузы, которые в нём поедут, в порядке справочника: сначала «родной». */
  cargo: CargoType[]
  /** Класс машины тянет такой прицеп. */
  fits: boolean
  affordable: boolean
  /** Уже стоит на этой машине. */
  current: boolean
  available: boolean
  reason: string | null
}

/**
 * Витрина прицепов для конкретной машины.
 *
 * Совместимость решает СПРАВОЧНИК ТЕХНИКИ, а не список грузов: прицеп цепляют к
 * машине, а не к грузу, — то же правило, что в store.buyTrailer, и оно обязано
 * читаться одинаково в проверке и в интерфейсе.
 */
export function trailerOffers(
  vehicle: Vehicle,
  money: number,
  bankrupt: boolean,
): TrailerOffer[] {
  const vc = VEHICLE_CLASS_BY_ID[vehicle.classId]

  return TRAILER_TYPES.map((trailer) => {
    const price = TRAILER_PRICE[trailer] ?? 0
    const fits = vc !== undefined && vc.trailers.includes(trailer)
    const affordable = money >= price
    const current = vehicle.trailer === trailer

    const reason = current
      ? 'уже стоит'
      : bankrupt
        ? 'компания разорена'
        : !fits
          ? `${vc?.name ?? vehicle.classId} такой не тянет`
          : !affordable
            ? `не хватает ${fmtInteger(price - money)} руб`
            : null

    return {
      trailer,
      price,
      cargo: cargoFor(trailer),
      fits,
      affordable,
      current,
      available: reason === null,
      reason,
    }
  })
}

// ─── Водители ──────────────────────────────────────────────────────────────

/** Строка штата: человек со всем, что решает игрок про него. */
export type DriverRow = {
  id: DriverId
  name: string
  skill: number
  licenses: DriverLicense[]
  fatigue: number
  hoursOnDuty: number
  wagePerDay: number
  loyalty: number

  /** На обязательном отдыхе: машина стоит, зарплата идёт. */
  resting: boolean

  vehicleId: VehicleId | null
  /** Машина, за которой закреплён: «КамАЗ-5320 kamaz-5320-1». null — резерв. */
  seat: string | null

  /**
   * Грузы, которые он НЕ имеет права везти.
   *
   * Список нужен там же, где нанимают: без ДОПОГ машина с цистерной не возьмёт
   * ни нефти, ни топлива, и узнавать об этом через сутки простоя — худший из
   * возможных способов. Считается через canDrive, то есть по той же карте
   * допусков, которой пользуется погрузка.
   */
  denied: CargoType[]
}

/**
 * Грузы, требующие допуска, в порядке карты допусков.
 *
 * Считается один раз при загрузке модуля: карта неизменяема, а строк штата
 * панель пересобирает десятки за тик.
 */
const LICENSED_CARGO = Object.keys(CARGO_LICENSE) as CargoType[]

export function driverRow(
  driver: Driver,
  vehicles: Record<VehicleId, Vehicle>,
): DriverRow {
  const seatVehicle =
    driver.vehicleId === null ? undefined : vehicles[driver.vehicleId]
  const seatClass =
    seatVehicle === undefined
      ? undefined
      : VEHICLE_CLASS_BY_ID[seatVehicle.classId]

  return {
    id: driver.id,
    name: driver.name,
    skill: clamp01(driver.skill),
    licenses: [...driver.licenses],
    fatigue: clamp01(driver.fatigue),
    hoursOnDuty: driver.hoursOnDuty,
    wagePerDay: driver.wagePerDay,
    loyalty: clamp01(driver.loyalty),

    // Признак отдыха спрашивается у симуляции: он выводится из счётчика смены,
    // отдельного поля под него нет и быть не должно (см. isResting).
    resting: isResting(driver),

    vehicleId: driver.vehicleId,
    seat:
      seatVehicle === undefined
        ? null
        : `${seatClass?.name ?? seatVehicle.classId} ${seatVehicle.id}`,

    denied: LICENSED_CARGO.filter((cargo) => !canDrive(driver, cargo)),
  }
}

/** Штат компании в порядке ключей. Порядок стабилен по той же причине, что парк. */
export function driverRows(
  drivers: Record<DriverId, Driver>,
  vehicles: Record<VehicleId, Vehicle>,
): DriverRow[] {
  return (Object.keys(drivers) as DriverId[]).map((id) =>
    driverRow(drivers[id], vehicles),
  )
}

/** Суточный фонд оплаты труда, рубли. Постоянная статья: платят всем и всегда. */
export function payrollPerDay(rows: readonly DriverRow[]): number {
  let total = 0
  for (const row of rows) {
    if (Number.isFinite(row.wagePerDay)) total += row.wagePerDay
  }
  return total
}
