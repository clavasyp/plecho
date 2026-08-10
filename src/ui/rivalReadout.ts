/**
 * Чтение соперников: снимок мира → «кто на карте, чем занят и о чём думает».
 *
 * Слой между симуляцией и ui/RivalPanel.tsx, устроенный так же, как
 * cityReadout для карточки города, fleetReadout для парка и bottleneckReadout
 * для узких мест, и по тем же двум причинам. Формальная: .tsx, экспортирующий
 * что-то кроме компонентов, ломает Fast Refresh. Существенная: разметку ломает
 * дизайнер, и это видно глазом, а диагноз ломается молча — числа остаются
 * правдоподобными, а смысл меняется на противоположный.
 *
 * ─── ГЛАВНЫЙ ВОПРОС ЭТОГО ФАЙЛА: ЧТО ЧЕСТНО ПОКАЗЫВАТЬ ПРО ЧУЖУЮ КОНТОРУ ────
 *
 * Соблазн показать всё велик: состояние лежит в одной структуре, и остаток на
 * счету конкурента отделён от остатка игрока одним ключом словаря. Взять его
 * оттуда — одна строка. Именно поэтому решение записано здесь, в коде, а не
 * оставлено на усмотрение разметки.
 *
 * ПРАВИЛО ОДНО: ПОКАЗЫВАЕТСЯ ТО, ЧТО ВИДНО СНАРУЖИ. Перевозчик разглядывает
 * конкурента с обочины, а не через его бухгалтерию.
 *
 *   ВИДНО и потому показывается:
 *     — машины: они ездят по тем же дорогам, их можно пересчитать;
 *     — прицепы: под что специализирован парк, читается с одного взгляда;
 *     — линии и города: куда его машины ходят изо дня в день;
 *     — постройки: терминал стоит посреди города и никуда не прячется;
 *     — гружёный и порожний пробег: гружёная фура отличима от порожней
 *       (на карте это ровно то же самое — VehicleMesh красит прицеп по грузу);
 *     — банкротство: это публичный факт, а не коммерческая тайна;
 *     — то, что он сам сказал, — лента рассуждений.
 *
 *   НЕ ВИДНО и потому НЕ показывается:
 *     — ОСТАТОК НА СЧЕТУ. Company.money конкурента в RivalRow не попадает
 *       вовсе: поле money заполнено только у игрока (см. ниже). Показать чужой
 *       счёт значило бы дать игроку то, чего не даёт ни одна честная модель
 *       конкуренции, и заодно обесценить главное содержимое панели: зачем
 *       читать мотивы соперника, если видно его кошелёк. Разорившийся
 *       конкурент при этом обозначен — банкротство публично;
 *     — износ, пробег с ТО, усталость и лояльность его водителей: чужой
 *       одометр с обочины не читается;
 *     — очередь его команд (pendingCommands): это ещё не сделанный ход, а
 *       намерение, и подглядывать в него — то же самое, что подсказывать.
 *
 * ВМЕСТО ЧУЖОГО СЧЁТА ПАНЕЛЬ СЧИТАЕТ ВЛОЖЕНИЕ (invested): сумму прайсовых цен
 * его машин, прицепов и построек. Это ЧЕСТНАЯ величина ровно потому, что
 * собирается из наблюдаемого: видно, сколько у него КамАЗов и стоит ли в Туле
 * его терминал, а цены техники в 1994-м знает любой перевозчик. И это ВЛОЖЕНИЕ,
 * а не текущая стоимость: износ в неё не заложен, потому что снаружи не виден.
 * Величина сравнима у всех четырёх компаний — включая игрока, — и потому годится
 * для той самой строки «кто крупнее», ради которой в панель и смотрят.
 *
 * ДОЛЯ РЫНКА СЧИТАЕТСЯ ПО ГРУЖЁНЫМ КИЛОМЕТРАМ, и это тоже выбор, а не
 * умолчание. Тонно-километров в состоянии нет: Vehicle помнит loadedKm и
 * emptyKm, но не помнит, сколько тонн он вёз на каждом из них (types.ts —
 * истина, полей туда не добавить). Домножить километры на грузоподъёмность
 * значило бы завести в интерфейсе ВТОРУЮ экономическую модель, которая молча
 * разойдётся с симуляцией, — ровно ту ошибку, от которой предостерегает весь
 * проект. Поэтому доля честно называется «по гружёному пробегу», и панель
 * говорит об этом словами: чьи машины больше ездят с грузом.
 *
 * Модуль чистый: смотрит на один снимок, ничего не меняет, про React и three не
 * знает.
 */

import { BUILDING_SPEC } from '../data/infrastructure'
import { TRAILER_PRICE, VEHICLE_CLASS_BY_ID } from '../data/vehicles'
import { dateFromTick, formatDate, formatTime } from '../sim/time'
import type {
  BuildingType,
  CargoType,
  CityId,
  Company,
  CompanyId,
  CompetitorPersonality,
  GameState,
  LineId,
  Vehicle,
} from '../sim/types'
import { emptyShare } from './lineEconomy'

// ─── Строка компании ───────────────────────────────────────────────────────

/**
 * Одна контора в списке — и игрок в том числе.
 *
 * ИГРОК В ТОМ ЖЕ СПИСКЕ И ПО ТЕМ ЖЕ ПОЛЯМ. Список, в котором соперники
 * измеряются одной меркой, а игрок другой, не отвечает на вопрос, ради которого
 * он существует: «я обхожу их или они меня». Поэтому вложение, парк, доля и
 * порожний пробег у всех считаются одной и той же функцией, а отличается игрок
 * ровно двумя вещами — флагом isPlayer и заполненным money.
 */
export type RivalRow = {
  id: CompanyId
  name: string
  /** Это контора игрока. Ленты рассуждений у неё нет и быть не может. */
  isPlayer: boolean
  /** Характер. У игрока пуст: он и есть тот, кто решает. */
  personality: CompetitorPersonality | null
  /** Кто ведёт компанию прямо сейчас: человек, скрипт или модель. */
  controller: Company['controller']
  /** Разорена. Публичный факт, а не подсмотренный. */
  bankrupt: boolean

  /** Машин в парке. Их видно на дороге. */
  fleet: number
  /**
   * Машин, которые стоят и не повезут ничего: сломанные и без водителя.
   *
   * Тоже наблюдаемо — грузовик у обочины виден лучше едущего. Это единственная
   * беда соперника, которую игроку показывают: она читается снаружи целиком.
   */
  stalled: number
  /** Водителей в штате, включая резерв. */
  drivers: number
  /** Линий в сети. */
  lines: number
  /** Городов, где он работает: остановки его линий плюс его постройки. */
  cities: number
  /** Терминалов, складов и хабов. */
  buildings: number

  /**
   * Вложено в парк и постройки по прайсу, рубли.
   *
   * ЗАМЕНА ЧУЖОМУ СЧЁТУ, а не дополнение к нему. Разбор — в шапке файла.
   */
  invested: number

  /**
   * Остаток на счету, рубли. НЕ NULL ТОЛЬКО У ИГРОКА.
   *
   * Тип с null здесь — не забота о старых сейвах, а сам замок: чтобы показать
   * чужие деньги, разметке пришлось бы сначала объяснить, откуда она взяла
   * число, которого в строке нет.
   */
  money: number | null

  /** Доля рынка по гружёным километрам, 0..1. null — никто ещё не вёз. */
  share: number | null
  loadedKm: number
  emptyKm: number
  /** Доля порожнего пробега, 0..1. null — пробега нет. */
  empty: number | null

  /** Записей в ленте рассуждений. */
  thoughts: number
  /**
   * Сколько из них подумала МОДЕЛЬ, а не скрипт.
   *
   * Пара чисел, а не доля: «18 из 24» — утверждение, «75%» — оценка, и в
   * вопросе о том, что игрок сейчас читает, оценки быть не должно.
   */
  fromModel: number
}

/** Накопленное по парку одной компании за один проход по машинам. */
type FleetTotals = {
  fleet: number
  stalled: number
  loadedKm: number
  emptyKm: number
  invested: number
}

/**
 * Прайсовая цена машины с прицепом.
 *
 * Цены берутся у справочника техники — того самого, по которому с компании
 * списывают деньги при покупке. Своей таблицы цен в интерфейсе нет и быть не
 * может: она разошлась бы с настоящей молча, а оценка «кто крупнее» осталась бы
 * правдоподобной.
 *
 * Неизвестный класс или прицеп стоит ноль, а не роняет панель: сейв прошлой
 * версии с выброшенным классом техники — это повод показать парк поменьше, а не
 * пустой экран вместо игры.
 */
export function vehicleValue(vehicle: Vehicle): number {
  const price = VEHICLE_CLASS_BY_ID[vehicle.classId]?.price ?? 0
  const trailer =
    vehicle.trailer === null ? 0 : (TRAILER_PRICE[vehicle.trailer] ?? 0)
  return price + trailer
}

/** Прайсовая стоимость построек компании. */
export function buildingsValue(company: Company): number {
  let sum = 0
  for (const building of Object.values(company.buildings ?? {})) {
    sum += BUILDING_SPEC[building.type]?.price ?? 0
  }
  return sum
}

/**
 * Разбор парка по владельцам — ОДНИМ проходом по всем машинам мира.
 *
 * Проход один, а не по компании: машин в мире к середине партии сотни, компаний
 * четыре, и фильтр по владельцу внутри цикла по компаниям означал бы четыре
 * прохода вместо одного на каждом тике. Панель перерисовывается каждый тик —
 * это её работа.
 */
function fleetTotals(state: GameState): Map<CompanyId, FleetTotals> {
  const totals = new Map<CompanyId, FleetTotals>()

  for (const vehicle of Object.values(state.vehicles)) {
    let row = totals.get(vehicle.ownerId)
    if (row === undefined) {
      row = { fleet: 0, stalled: 0, loadedKm: 0, emptyKm: 0, invested: 0 }
      totals.set(vehicle.ownerId, row)
    }

    row.fleet += 1
    if (vehicle.brokenDown || vehicle.driverId === null) row.stalled += 1
    row.invested += vehicleValue(vehicle)

    // Битые счётчики из старого сохранения не должны отравить сумму: NaN,
    // попавший в долю рынка, делает её NaN у ВСЕХ — знаменатель общий.
    if (Number.isFinite(vehicle.loadedKm)) row.loadedKm += vehicle.loadedKm
    if (Number.isFinite(vehicle.emptyKm)) row.emptyKm += vehicle.emptyKm
  }

  return totals
}

/**
 * Список контор для панели.
 *
 * ПОРЯДОК — ПО ДОЛЕ РЫНКА, СВЕРХУ ТОТ, КТО БОЛЬШЕ ВОЗИТ. Панель отвечает на
 * вопрос «кто впереди», и алфавит на него не отвечает. Прыгать строки при этом
 * почти не будут: гружёный пробег накапливается за партию целиком, и обогнать
 * соседа на нём — событие, а не рябь.
 *
 * Ничьи разводятся вложением, а затем идентификатором — чтобы порядок был
 * ОПРЕДЕЛЁННЫМ. В первые сутки партии у всех четверых по нулю километров и по
 * одному ЗИЛу, и без последней ступени список перетасовывался бы от порядка
 * ключей в словаре.
 */
export function rivalRows(state: GameState): RivalRow[] {
  const totals = fleetTotals(state)

  /*
   * Знаменатель доли — гружёный пробег ВСЕХ компаний, включая игрока. Доля
   * рынка без себя самого не доля рынка, а отношение к соседям.
   */
  let marketKm = 0
  for (const row of totals.values()) marketKm += row.loadedKm

  const rows: RivalRow[] = []

  for (const id of Object.keys(state.companies) as CompanyId[]) {
    const company = state.companies[id]
    const fleet = totals.get(id) ?? {
      fleet: 0,
      stalled: 0,
      loadedKm: 0,
      emptyKm: 0,
      invested: 0,
    }
    const isPlayer = id === state.playerId
    const network = networkOf(state, id)

    rows.push({
      id,
      name: company.name,
      isPlayer,
      personality: company.personality ?? null,
      controller: company.controller,
      bankrupt: company.bankrupt,

      fleet: fleet.fleet,
      stalled: fleet.stalled,
      drivers: Object.keys(company.drivers ?? {}).length,
      lines: network.lines.length,
      cities: network.cities.length,
      buildings: Object.keys(company.buildings ?? {}).length,

      invested: fleet.invested + buildingsValue(company),
      /*
       * ЗДЕСЬ И СТОИТ ЗАМОК. Чужие деньги не «скрыты фильтром» и не «пока не
       * показываются» — их в строке нет. Единственная ветка, в которой money
       * получает число, проверяет, что это игрок.
       */
      money: isPlayer ? company.money : null,

      share: marketKm > 0 ? fleet.loadedKm / marketKm : null,
      loadedKm: fleet.loadedKm,
      emptyKm: fleet.emptyKm,
      empty: emptyShare(fleet.loadedKm, fleet.emptyKm),

      thoughts: (company.thinking ?? []).length,
      fromModel: (company.thinking ?? []).filter((t) => t.fromModel).length,
    })
  }

  return rows.sort(
    (a, b) =>
      b.loadedKm - a.loadedKm ||
      b.invested - a.invested ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
}

// ─── Где он работает ───────────────────────────────────────────────────────

/**
 * Кольцо соперника глазами наблюдателя.
 *
 * ГОРОДА И ГРУЗЫ, А НЕ ОСТАНОВКИ С ФЛАГАМИ. Игроку не нужен чужой редактор
 * линий — ему нужен ответ на вопрос «куда он лезет»: по каким городам ходит и
 * что возит. Остальное (что именно грузит на третьей остановке) — это
 * подробность чужой настройки, из которой решения не следует.
 */
export type RivalLine = {
  id: LineId
  name: string
  /** Города кольца по порядку обхода. */
  cities: { id: CityId; name: string }[]
  /** Грузы, которые кольцо берёт, без повторов и в порядке появления. */
  cargo: CargoType[]
  /** Машин назначено на линию. */
  vehicles: number
}

/** Город, в котором соперник работает. */
export type RivalCity = {
  id: CityId
  name: string
  /** Его постройка здесь. null — работает без своего терминала. */
  building: BuildingType | null
}

/** Сеть компании: её кольца и города, в которых она появляется. */
export type RivalNetwork = {
  lines: RivalLine[]
  cities: RivalCity[]
}

/** Старшинство построек для показа: чем больше, тем заметнее в городе. */
const BUILDING_RANK: Record<BuildingType, number> = {
  склад: 1,
  терминал: 2,
  хаб: 3,
}

/**
 * Сеть компании — то, что видно с обочины.
 *
 * ГОРОДА СОБИРАЮТСЯ ИЗ ЛИНИЙ И ПОСТРОЕК, а не из положения машин. Машина в
 * городе — это «он там сейчас», линия — «он ходит туда постоянно»; панель
 * отвечает на второй вопрос, потому что решение игрок принимает против
 * постоянного присутствия, а не против проезжающего грузовика.
 *
 * ПОРЯДОК ГОРОДОВ — ПО ПЕРВОМУ ПОЯВЛЕНИЮ в кольцах, и уже потом города, где у
 * него только постройка. Так список читается как маршрут, а не как выборка.
 */
export function networkOf(state: GameState, id: CompanyId): RivalNetwork {
  const company: Company | undefined = state.companies[id]
  if (company === undefined) return { lines: [], cities: [] }

  /* Машины по линиям — одним проходом, по той же причине, что и парк выше. */
  const perLine = new Map<LineId, number>()
  for (const vehicle of Object.values(state.vehicles)) {
    if (vehicle.ownerId !== id) continue
    if (vehicle.lineId === null) continue
    perLine.set(vehicle.lineId, (perLine.get(vehicle.lineId) ?? 0) + 1)
  }

  const buildingAt = new Map<CityId, BuildingType>()
  for (const building of Object.values(company.buildings ?? {})) {
    /*
     * Крупнейшая постройка города выигрывает показ. Строк на город одна, а
     * терминал рядом с хабом — это про хаб: он и постов даёт больше, и стоит
     * втрое дороже. Порядок задан BUILDING_RANK, а не Object.keys: порядок
     * ключей словаря — это порядок, в котором их когда-то записали.
     */
    const known = buildingAt.get(building.cityId)
    if (known === undefined || BUILDING_RANK[building.type] > BUILDING_RANK[known]) {
      buildingAt.set(building.cityId, building.type)
    }
  }

  const cities: RivalCity[] = []
  const seen = new Set<CityId>()
  const noteCity = (cityId: CityId): void => {
    if (seen.has(cityId)) return
    seen.add(cityId)
    const city = state.world.cities[cityId]
    if (city === undefined) return
    cities.push({
      id: cityId,
      name: city.name,
      building: buildingAt.get(cityId) ?? null,
    })
  }

  const lines: RivalLine[] = []
  for (const lineId of Object.keys(company.lines ?? {}) as LineId[]) {
    const line = company.lines[lineId]
    const lineCities: { id: CityId; name: string }[] = []
    const cargo: CargoType[] = []

    for (const stop of line.stops) {
      const city = state.world.cities[stop.nodeId]
      /*
       * Остановка в неизвестном городе пропускается, а не печатается
       * идентификатором. Такое бывает только в сейве от карты другой версии, и
       * «moscow-2» посреди списка русских названий читается как поломка
       * панели, а не как недостающие данные.
       */
      if (city !== undefined) lineCities.push({ id: stop.nodeId, name: city.name })
      noteCity(stop.nodeId)

      for (const type of stop.load) {
        if (!cargo.includes(type)) cargo.push(type)
      }
    }

    lines.push({
      id: lineId,
      name: line.name,
      cities: lineCities,
      cargo,
      vehicles: perLine.get(lineId) ?? 0,
    })
  }

  // Города, где у него только бетон и ни одной остановки, тоже места работы.
  for (const cityId of buildingAt.keys()) noteCity(cityId)

  return { lines, cities }
}

// ─── Лента рассуждений ─────────────────────────────────────────────────────

/**
 * Одна запись ленты, готовая к показу.
 *
 * ОТМЕТКА ОБ ИСТОЧНИКЕ ЕДЕТ ВМЕСТЕ С ТЕКСТОМ И НЕ ОТДЕЛЯЕТСЯ ОТ НЕГО НИГДЕ.
 * Соблазн посчитать источник один раз на всю ленту («сегодня отвечает модель»)
 * велик и неверен: канал модели может отвалиться на одном ответе из десяти, и
 * тогда общая пометка соврёт про девять записей сразу. Флаг у каждой записи
 * свой, потому что и происхождение у каждой своё.
 */
export type FeedEntry = {
  /** Ключ для React. Тик не годится: за один тик мыслей может быть две. */
  key: string
  tick: number
  /** «14 мая 1994, 23:45» — когда подумалось. */
  when: string
  text: string
  /** Ложь — рассуждение подставлено скриптом, а не моделью. */
  fromModel: boolean
}

/**
 * Лента компании, СВЕЖИМ ВВЕРХ.
 *
 * В состоянии лента растёт вниз (rememberThought дописывает в конец), а
 * читается сверху: свежая мысль объясняет то, что происходит на карте прямо
 * сейчас, и ради неё панель открывают. Разворот делается здесь, а не в
 * разметке, чтобы порядок был проверен тестом — глазами перепутанный порядок
 * ленты не поймать, обе версии выглядят одинаково правдоподобно.
 *
 * ОБРЕЗКИ ЗДЕСЬ НЕТ. Длину ленты держит симуляция (THINKING_LIMIT в
 * sim/tick.ts), и второе правило обрезки, заведённое в интерфейсе, разошлось бы
 * с первым молча: игрок видел бы двадцать записей там, где их двадцать четыре,
 * и решил бы, что старое пропадает быстрее, чем на самом деле.
 */
export function thoughtFeed(
  company: Company | undefined,
  startYear: number,
): FeedEntry[] {
  if (company === undefined) return []
  const feed = company.thinking ?? []

  const entries: FeedEntry[] = []
  for (let index = feed.length - 1; index >= 0; index -= 1) {
    const thought = feed[index]
    const date = dateFromTick(thought.tick, startYear)
    entries.push({
      key: `${index}-${thought.tick}`,
      tick: thought.tick,
      when: `${formatDate(date)}, ${formatTime(date)}`,
      text: thought.text,
      fromModel: thought.fromModel,
    })
  }

  return entries
}

// ─── Сводка ────────────────────────────────────────────────────────────────

/** Итог по всем конторам — для кнопки вызова свёрнутой панели. */
export type RivalSummary = {
  /** Сколько контор, кроме игрока. */
  rivals: number
  /** Сколько из них ещё живы. */
  alive: number
  /**
   * Соперник, обошедший игрока по доле рынка. null — игрок впереди всех.
   *
   * ЭТО И ЕСТЬ ПОВОД ОТОРВАТЬ ИГРОКА ОТ КАРТЫ, и другого повода у панели нет.
   * Кнопка, горящая постоянно, перестаёт что-либо значить через десять минут
   * игры — тот же довод, что у кнопок парка и узких мест.
   */
  leader: RivalRow | null
  /** Доля игрока, 0..1. null — никто ещё не вёз. */
  playerShare: number | null
}

export function rivalSummary(rows: readonly RivalRow[]): RivalSummary {
  const player = rows.find((row) => row.isPlayer) ?? null
  const rivals = rows.filter((row) => !row.isPlayer)

  /*
   * Обошёл — значит СТРОГО больше. Равенство долей — это первые сутки партии,
   * когда все четверо стоят на нуле; загоревшаяся на старте кнопка научила бы
   * игрока не обращать на неё внимания ровно до того момента, когда она
   * загорится по делу.
   */
  const playerShare = player?.share ?? null
  const ahead = rivals.filter(
    (row) =>
      !row.bankrupt &&
      row.share !== null &&
      (playerShare === null || row.share > playerShare),
  )

  return {
    rivals: rivals.length,
    alive: rivals.filter((row) => !row.bankrupt).length,
    // Строки уже отсортированы по доле, поэтому первый обогнавший — сильнейший.
    leader: ahead.length > 0 ? ahead[0] : null,
    playerShare,
  }
}
