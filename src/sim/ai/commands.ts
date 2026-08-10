/**
 * Фаза команд: единственная дверь, через которую конкурент попадает в состояние.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ. Срез 6 приводит в игру противника, которым
 * управляет языковая модель. Модель живёт за сетью, отвечает когда захочет и
 * пишет что захочет — а тик обязан остаться синхронным, детерминированным и
 * воспроизводимым из сохранения. Обе половины этого требования сходятся здесь:
 * ответ модели кладётся в Company.pendingCommands, то есть В СОСТОЯНИЕ, а тик
 * разбирает очередь как обычные данные, ничего не зная ни про сеть, ни про
 * модель. Пусти сетевой вызов внутрь тика — и рассыплется всё разом: тесты
 * экономики, прогоны баланса на сотни игровых лет, воспроизведение багов по
 * сейву.
 *
 * ВТОРОЕ ТРЕБОВАНИЕ, И ОНО ЖЕ СМЫСЛ ФАЙЛА: КОНКУРЕНТ ИГРАЕТ ПО ТЕМ ЖЕ ПРАВИЛАМ.
 * Он не исполняет код и не трогает состояние — он возвращает список команд из
 * перечисления Command (types.ts), каждая проверяется на законность, незаконные
 * отбрасываются. Модель предлагает — симуляция решает. Дай ей отдельный путь в
 * состояние, и она немедленно начнёт жульничать, причём незаметно: не «читом»
 * из злого умысла, а потому, что придумает поле, которого нет, город, которого
 * нет, и деньги, которых нет.
 *
 * ГДЕ ЖИВУТ САМИ ПРАВИЛА. Здесь их по возможности НЕТ. Строительство спрашивает
 * economy/buildings.ts, наём — logistics/driver.ts, ТО — logistics/wear.ts,
 * минимальная длина линии — logistics/line.ts, совместимость прицепа —
 * справочник техники. Вторая копия правила разъезжается с первой молча, и
 * обнаруживается это тем, что конкуренту разрешено чуть больше, чем игроку, —
 * то есть ровно тем, ради предотвращения чего этот файл и написан. Там, где
 * правило до сих пор жило только в app/store.ts (двусторонняя связь машины с
 * линией и водителя с машиной, выдача идентификаторов), оно записано здесь один
 * раз в чистом виде: стор — слой интерфейса, звать его из симуляции нельзя, а
 * держать правило в слое интерфейса и было ошибкой.
 *
 * ПРОВЕРКА РАЗДЕЛЕНА НА ДВЕ ПОЛОВИНЫ, и граница между ними содержательная.
 *
 *   НОРМАЛИЗАЦИЯ (normalized) отвечает на вопрос «это вообще команда?». Форма
 *   объекта, типы полей, размеры массивов, ссылки на НЕИЗМЕННЫЙ мир — город на
 *   карте, груз и прицеп в справочниках. Всё это не зависит от того, чья
 *   команда и когда она пришла.
 *
 *   ЗАКОННОСТЬ (isLegalCommand) отвечает на вопрос «этой компании это можно?».
 *   Своё или чужое, хватает ли денег, не банкрот ли, выпускается ли уже такая
 *   техника. Это зависит от компании и от момента.
 *
 * Наружу обе половины отдаются одной функцией isLegal: вызывающему разница не
 * нужна, а рассуждать о ней внутри файла удобнее по отдельности.
 *
 * КОМАНДА, КОТОРОЙ НЕЧЕГО ДЕЛАТЬ, СЧИТАЕТСЯ НЕЗАКОННОЙ. Поставить тот же прицеп,
 * назначить на ту же линию, посадить того же водителя за ту же машину — всё это
 * отбрасывается. Довод тот же, по которому так устроены кнопки в сторе: работы
 * нет, а деньги за неё возьмутся. Модель, повторившая свой прошлый ход, не
 * должна платить второй раз.
 *
 * Все функции чистые: входное состояние не меняется, включая вложенные объекты.
 */

import {
  CARGO_REQUIREMENTS,
  TRAILER_PRICE,
  VEHICLE_CLASS_BY_ID,
} from '../../data/vehicles'
import { buildBuilding, demolishBuilding } from '../economy/buildings'
import { hireDriver } from '../logistics/driver'
import { MIN_LINE_STOPS } from '../logistics/line'
import { TRAILER_TYPES, trailersFor } from '../logistics/trailer'
import { repairVehicle, serviceVehicle } from '../logistics/wear'
import { HOME_CITY, createVehicle } from '../state'
import { dateFromTick } from '../time'
import { lineId as toLineId, vehicleId as toVehicleId } from '../types'
import type {
  Building,
  BuildingId,
  BuildingType,
  CargoType,
  CityId,
  Command,
  Company,
  CompanyId,
  Driver,
  DriverId,
  GameState,
  Line,
  LineId,
  Stop,
  TrailerType,
  Vehicle,
  VehicleId,
} from '../types'

// ─── Потолок очереди ───────────────────────────────────────────────────────

/**
 * Команд, из которых состоит ввод одной машины в строй.
 *
 * Пять: купить тягач, взять прицеп, нанять человека, посадить его за руль,
 * поставить машину на линию. Это не оценка, а прямое следствие того, что машина
 * в этой игре собирается из отдельных решений (см. buyVehicle в app/store.ts) —
 * ровно столько же кликов делает и игрок.
 */
export const COMMANDS_PER_VEHICLE = 5

/**
 * Сколько команд одной компании разбирается за тик. Остальные отбрасываются.
 *
 * ПОТОЛОК ОБЯЗАН БЫТЬ, И ПРИЧИН ТРИ.
 *
 *   ЧЕСТНОСТЬ. Игрок нажимает кнопки руками, по одной. Конкурент, исполняющий
 *   сотню действий за пятнадцать игровых минут, играет не по тем же правилам —
 *   а весь срез затевался ради обратного.
 *
 *   ЦЕНА ТИКА. Каждая команда пересобирает состояние целиком. Очередь на десять
 *   тысяч записей — это не «медленный конкурент», это вставший кадр, причём в
 *   игре, где тик крутится по нескольку раз в секунду.
 *
 *   ОЧЕРЕДЬ — ЭТО СОСТОЯНИЕ. Значит она приезжает из сохранения, которое можно
 *   поправить руками, и из ответа модели, который может быть каким угодно.
 *   Доверять её размеру нельзя ровно по тому же доводу, по которому не доверяют
 *   её содержимому.
 *
 * ВЕЛИЧИНА ВЫВЕДЕНА, А НЕ ПОДОБРАНА: полный ход «завести линию и поставить на
 * неё машину» — это COMMANDS_PER_VEHICLE плюс сама линия, то есть шесть команд.
 * Потолок даёт ДВА таких хода за тик. Больше конкуренту незачем — он думает раз
 * в игровой месяц (docs/АРХИТЕКТУРА.md §7), а не раз в четверть часа.
 *
 * ЛИШНИЕ КОМАНДЫ ОТБРАСЫВАЮТСЯ, А НЕ ПЕРЕНОСЯТСЯ НА СЛЕДУЮЩИЙ ТИК. Перенос
 * означал бы, что очередь на десять тысяч записей будет отравлять сотни
 * следующих тиков, а конкурент всё это время не сможет принять ни одного нового
 * решения. Очередь чистится целиком — см. runCommands.
 */
export const MAX_COMMANDS_PER_TICK = (COMMANDS_PER_VEHICLE + 1) * 2

/**
 * Предел длины имени линии, символов.
 *
 * Имя уходит в панель линий и в сохранение. Модель, которой сказано «назови
 * линию», способна вернуть абзац рассуждений вместо названия — и он навсегда
 * останется в сейве и в интерфейсе. Шестьдесят символов — это заведомо больше
 * любого осмысленного «Москва — Тула — зерно» и заведомо меньше абзаца.
 */
export const MAX_LINE_NAME_LENGTH = 60

/**
 * Предел числа остановок в одной линии — по числу городов на карте.
 *
 * Выводится из мира, а не назначается числом: кольцо, обходящее каждый город
 * страны по разу, — это уже вся карта целиком, и осмысленной сети длиннее не
 * бывает. Повторные заезды в один город кольцо делает само, замыкаясь на первую
 * остановку, так что запас в этом пределе есть.
 *
 * Проверяется ДО обхода массива: смысл предела в том, чтобы не разбирать
 * миллион остановок, а не в том, чтобы аккуратно отвергнуть их по одной.
 */
export function maxLineStops(state: GameState): number {
  return Object.keys(state.world.cities).length
}

// ─── Доступ к хозяйству компании ───────────────────────────────────────────
//
// Сейв прошлой версии мог не знать ни про линии, ни про водителей, ни про
// постройки, ни про очередь команд. Тот же приём, что у Company.drivers в
// logistics/driver.ts: пусто, а не падение.

function linesOf(company: Company): Record<LineId, Line> {
  return company.lines ?? {}
}

function driversOf(company: Company): Record<DriverId, Driver> {
  return company.drivers ?? {}
}

function buildingsOf(company: Company): Record<BuildingId, Building> {
  return company.buildings ?? {}
}

function queueOf(company: Company): readonly Command[] {
  const queue = company.pendingCommands
  return Array.isArray(queue) ? queue : []
}

/** Компания с подменённой записью. Вход не меняется. */
function withCompany(
  state: GameState,
  id: CompanyId,
  company: Company,
): GameState {
  return { ...state, companies: { ...state.companies, [id]: company } }
}

/** Машина, снятая с линии: стоит и ждёт команды. Груз остаётся в кузове. */
function detached(vehicle: Vehicle): Vehicle {
  return { ...vehicle, lineId: null, stopIndex: 0, route: [] }
}

// ─── Нормализация: «это вообще команда?» ───────────────────────────────────

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Груз из справочника или null.
 *
 * Признаком существования служит наличие кузова, в котором груз поедет
 * (trailersFor в logistics/trailer.ts). Отдельного списка типов грузов в игре
 * нет и заводить его здесь нельзя: он разъехался бы с требованиями к прицепам
 * ровно в тот день, когда в мире появится седьмой груз.
 */
function asCargo(value: unknown): CargoType | null {
  if (typeof value !== 'string') return null
  const cargo = value as CargoType
  return trailersFor(cargo).length > 0 ? cargo : null
}

function asTrailer(value: unknown): TrailerType | null {
  if (typeof value !== 'string') return null
  const trailer = value as TrailerType
  return TRAILER_TYPES.includes(trailer) ? trailer : null
}

/**
 * Список грузов остановки — новый массив из проверенных значений.
 *
 * Длина ограничена числом известных грузов (CARGO_REQUIREMENTS в справочнике):
 * «выгрузить всё, что есть» — это шесть записей, а не шесть тысяч. Повторы
 * внутри предела безвредны — погрузка читает список как приоритет, — и вычищать
 * их незачем.
 */
function normalizedCargoList(value: unknown): CargoType[] | null {
  if (!Array.isArray(value)) return null
  if (value.length > CARGO_REQUIREMENTS.length) return null

  const list: CargoType[] = []
  for (const item of value) {
    const cargo = asCargo(item)
    if (cargo === null) return null
    list.push(cargo)
  }
  return list
}

/**
 * Остановки линии — глубокая копия из проверенных значений.
 *
 * КОПИЯ, А НЕ ССЫЛКА, и это не перестраховка. Массив приезжает из разбора
 * ответа модели, и тот, кто его разобрал, продолжает жить своей жизнью: общий
 * объект означал бы, что следующая правка на его стороне задним числом меняет
 * уже работающую линию. Тот же довод, что у copyStops в app/store.ts.
 *
 * Города проверяются здесь же: линия с остановкой в несуществующем городе не
 * «просто не поедет» — она навсегда останется в сохранении и будет каждый тик
 * отправлять диспетчеризацию искать маршрут в никуда.
 */
function normalizedStops(state: GameState, value: unknown): Stop[] | null {
  if (!Array.isArray(value)) return null
  // Меньше двух остановок — не кольцо, а точка: плеча в такой линии нет ни
  // одного. Число берётся у линий (MIN_LINE_STOPS), а не пишется двойкой.
  if (value.length < MIN_LINE_STOPS) return null
  if (value.length > maxLineStops(state)) return null

  const stops: Stop[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null
    const stop = item as { nodeId?: unknown; unload?: unknown; load?: unknown }

    if (!isText(stop.nodeId)) return null
    const nodeId = stop.nodeId as CityId
    if (state.world.cities[nodeId] === undefined) return null

    // Отсутствующий список — это пустой список, а не отказ: транзитная
    // остановка без работы законна (см. Stop в types.ts).
    const unload = normalizedCargoList(stop.unload ?? [])
    const load = normalizedCargoList(stop.load ?? [])
    if (unload === null || load === null) return null

    stops.push({ nodeId, unload, load })
  }

  return stops
}

/**
 * Что угодно → команда контракта или null.
 *
 * КОМАНДА ПЕРЕСОБИРАЕТСЯ ПОЛЕМ ЗА ПОЛЕМ, а не берётся как есть. В состояние
 * обязано попасть только то, что описано в Command: пришедший от модели объект
 * может нести лишние поля («count: -3», «cheat: true»), и молча положить его в
 * сохранение значит однажды прочитать оттуда поле, которого в контракте нет.
 * Заодно так отсекаются подставленные прототипы и геттеры — в новом объекте
 * лежат только значения.
 */
function normalized(state: GameState, raw: unknown): Command | null {
  if (typeof raw !== 'object' || raw === null) return null
  const input = raw as Record<string, unknown>

  switch (input.kind) {
    case 'создать-линию': {
      if (!isText(input.name)) return null
      if (input.name.length > MAX_LINE_NAME_LENGTH) return null

      const stops = normalizedStops(state, input.stops)
      if (stops === null) return null

      return { kind: 'создать-линию', name: input.name, stops }
    }

    case 'удалить-линию': {
      if (!isText(input.lineId)) return null
      return { kind: 'удалить-линию', lineId: input.lineId as LineId }
    }

    case 'купить-машину': {
      if (!isText(input.classId)) return null
      return { kind: 'купить-машину', classId: input.classId }
    }

    case 'купить-прицеп': {
      if (!isText(input.vehicleId)) return null
      const trailer = asTrailer(input.trailer)
      if (trailer === null) return null

      return {
        kind: 'купить-прицеп',
        vehicleId: input.vehicleId as VehicleId,
        trailer,
      }
    }

    case 'назначить-машину': {
      if (!isText(input.vehicleId)) return null
      // null — законное значение: это снятие с линии. А вот пустая строка и
      // undefined — нет, иначе «снять» и «промах в поле» становятся одним и тем
      // же действием.
      if (input.lineId !== null && !isText(input.lineId)) return null

      return {
        kind: 'назначить-машину',
        vehicleId: input.vehicleId as VehicleId,
        lineId: input.lineId === null ? null : (input.lineId as LineId),
      }
    }

    case 'нанять-водителя':
      return { kind: 'нанять-водителя' }

    case 'уволить-водителя': {
      if (!isText(input.driverId)) return null
      return { kind: 'уволить-водителя', driverId: input.driverId as DriverId }
    }

    case 'посадить-водителя': {
      if (!isText(input.driverId)) return null
      if (input.vehicleId !== null && !isText(input.vehicleId)) return null

      return {
        kind: 'посадить-водителя',
        driverId: input.driverId as DriverId,
        vehicleId:
          input.vehicleId === null ? null : (input.vehicleId as VehicleId),
      }
    }

    case 'построить': {
      if (!isText(input.cityId)) return null
      // Тип постройки не сверяется со справочником здесь: правило «что бывает и
      // что это даёт» живёт в BUILDING_SPEC, и спрашивает его buildBuilding.
      // Вторая копия списка типов разъехалась бы с первой при добавлении
      // четвёртого вида построек.
      if (!isText(input.type)) return null

      return {
        kind: 'построить',
        cityId: input.cityId as CityId,
        type: input.type as BuildingType,
      }
    }

    case 'снести': {
      if (!isText(input.buildingId)) return null
      return { kind: 'снести', buildingId: input.buildingId as BuildingId }
    }

    case 'обслужить': {
      if (!isText(input.vehicleId)) return null
      return { kind: 'обслужить', vehicleId: input.vehicleId as VehicleId }
    }

    case 'починить': {
      if (!isText(input.vehicleId)) return null
      return { kind: 'починить', vehicleId: input.vehicleId as VehicleId }
    }

    case 'продать-машину': {
      if (!isText(input.vehicleId)) return null
      return { kind: 'продать-машину', vehicleId: input.vehicleId as VehicleId }
    }

    default:
      // Неизвестный вид команды. Молча, потому что это норма: модель однажды
      // придумает действие, которого в игре нет, и это не повод ронять тик.
      return null
  }
}

// ─── Законность: «этой компании это можно?» ────────────────────────────────

/**
 * Своя машина или null. Чужая — это не «машина, которой нет», а попытка
 * распорядиться чужим имуществом, и разницы для ответа нет никакой.
 */
function ownVehicle(
  state: GameState,
  companyId: CompanyId,
  id: VehicleId,
): Vehicle | null {
  const vehicle = state.vehicles[id]
  if (vehicle === undefined) return null
  return vehicle.ownerId === companyId ? vehicle : null
}

/**
 * Проверка законности уже нормализованной команды.
 *
 * Общие условия — компания существует и не банкрот. У банкрота партия окончена:
 * ему не начисляют расходов (freeze в economy/operating.ts) и не дают строить
 * (buildBuilding), значит и всё остальное ему запрещено тоже. Иначе разорившийся
 * конкурент продолжал бы покупать машины на деньги, которых у него нет.
 */
function isLegalCommand(
  state: GameState,
  companyId: CompanyId,
  command: Command,
): boolean {
  const company: Company | undefined = state.companies[companyId]
  if (company === undefined) return false
  if (company.bankrupt) return false

  switch (command.kind) {
    case 'создать-линию':
      // Всё, что можно было проверить, проверено формой: остановок хватает,
      // города существуют, грузы известны. Денег линия не стоит — она стоит
      // машин, которые на неё поставят.
      return true

    case 'удалить-линию':
      // Чужой линии в своём списке нет — проверка «своё или чужое» и проверка
      // «существует ли» это одна и та же проверка, потому что линии лежат
      // внутри компании.
      return linesOf(company)[command.lineId] !== undefined

    case 'купить-машину': {
      const vehicleClass = VEHICLE_CLASS_BY_ID[command.classId]
      if (vehicleClass === undefined) return false

      // Техника из будущего не продаётся. Год выводится из тика тем же
      // календарём, что и везде: второй экземпляр даты разъехался бы с ним при
      // первой же правке.
      const year = dateFromTick(state.tick, state.startYear).year
      if (year < vehicleClass.availableFrom) return false

      // Покупка в кредит игрой не предусмотрена. Сравнение прямое, а не через
      // отрицание: NaN на счету даёт ложь, то есть отказ, — что и требуется.
      return company.money >= vehicleClass.price
    }

    case 'купить-прицеп': {
      const vehicle = ownVehicle(state, companyId, command.vehicleId)
      if (vehicle === null) return false
      // Тот же прицеп уже стоит — работы нет, и денег брать не за что.
      if (vehicle.trailer === command.trailer) return false

      const vehicleClass = VEHICLE_CLASS_BY_ID[vehicle.classId]
      if (vehicleClass === undefined) return false
      // Совместимость решает справочник техники: прицеп цепляют к машине, а не
      // к грузу, и полуприцеп-цистерну на бортовой ЗИЛ не повесить.
      if (!vehicleClass.trailers.includes(command.trailer)) return false

      const price = TRAILER_PRICE[command.trailer]
      if (price === undefined) return false

      return company.money >= price
    }

    case 'назначить-машину': {
      const vehicle = ownVehicle(state, companyId, command.vehicleId)
      if (vehicle === null) return false
      // Уже на этой линии (или уже снята) — команде нечего делать.
      if (vehicle.lineId === command.lineId) return false

      if (command.lineId === null) return true
      // Чужая линия — та же проверка, что и у удаления: её просто нет в списке.
      return linesOf(company)[command.lineId] !== undefined
    }

    case 'нанять-водителя':
      // Наём бесплатен и у игрока: платит не найм, а зарплата. Единственное
      // ограничение — общее, для банкрота.
      return true

    case 'уволить-водителя':
      return driversOf(company)[command.driverId] !== undefined

    case 'посадить-водителя': {
      const driver = driversOf(company)[command.driverId]
      if (driver === undefined) return false
      // Уже сидит там, куда его сажают (или уже в резерве) — работы нет.
      if (driver.vehicleId === command.vehicleId) return false

      if (command.vehicleId === null) return true
      // Чужую машину своим человеком не укомплектовать: это не наём, а
      // рассинхрон данных.
      return ownVehicle(state, companyId, command.vehicleId) !== null
    }

    case 'построить':
      /*
       * ПРАВИЛО ЗАСТРОЙКИ НЕ ПОВТОРЯЕТСЯ ЗДЕСЬ НИ ОДНОЙ СТРОЧКОЙ. Цена, лимит
       * «одна постройка каждого типа на город», существование города и проверка
       * банкротства живут в economy/buildings.ts, и спросить их иначе, чем
       * попыткой, нельзя: buildBuilding возвращает исходное состояние ПО ССЫЛКЕ,
       * если сделка не состоялась, и это ровно ответ на вопрос о законности.
       *
       * Цена такой проверки — второй вызов той же функции в applyCommand. Она
       * чистая, вход не меняет, и заплатить один лишний пересчёт объекта
       * дешевле, чем завести вторую копию прейскуранта.
       */
      return buildBuilding(state, companyId, command.cityId, command.type) !== state

    case 'снести':
      /*
       * ВЛАДЕЛЕЦ ПРОВЕРЯЕТСЯ ЗДЕСЬ, А НЕ В СИМУЛЯЦИИ, и это не оплошность
       * buildings.ts. demolishBuilding снесёт постройку любой компании — ему
       * этого законно требует и загрузка сейва, и будущие события мира. Вопрос
       * «кому разрешено» задаётся тем, кто отдаёт команду, ровно как в
       * app/store.ts у игрока.
       */
      return buildingsOf(company)[command.buildingId] !== undefined

    case 'обслужить': {
      const vehicle = ownVehicle(state, companyId, command.vehicleId)
      if (vehicle === null) return false
      // Нужно ли ТО и сколько оно стоит, решает logistics/wear.ts. Ответ
      // «работы нет» он даёт тем же способом — состоянием по ссылке.
      return serviceVehicle(state, command.vehicleId) !== state
    }

    case 'починить': {
      const vehicle = ownVehicle(state, companyId, command.vehicleId)
      if (vehicle === null) return false
      // Целую машину чинить нечего, и цену ремонта знает wear.ts.
      return repairVehicle(state, command.vehicleId) !== state
    }

    case 'продать-машину': {
      const vehicle = ownVehicle(state, companyId, command.vehicleId)
      if (vehicle === null) return false
      // Машину в пути продать нельзя: груз и водитель остались бы в воздухе.
      return vehicle.position.kind === 'узел' && vehicle.cargo === null
    }
  }
}

/**
 * Законна ли команда. Единственная точка входа для проверки.
 *
 * Принимает ЧТО УГОДНО, хотя объявлена принимающей Command: очередь приезжает из
 * сохранения и из разбора ответа модели, и типы там — обещание, а не факт.
 */
export function isLegal(
  state: GameState,
  companyId: CompanyId,
  command: Command,
): boolean {
  const normal = normalized(state, command as unknown)
  return normal !== null && isLegalCommand(state, companyId, normal)
}

// ─── Идентификаторы ────────────────────────────────────────────────────────

/**
 * Свободный идентификатор линии, с именем компании внутри.
 *
 * Схема та же, что у водителей (freeDriverId в logistics/driver.ts): номер идёт
 * от размера списка и дальше ищет первый незанятый, поэтому создание линии после
 * удалений не затирает работающую. Имя компании в ключе решает вторую задачу —
 * линии конкурента не могут столкнуться с линиями игрока, которые стор нумерует
 * своей сквозной схемой «line-N».
 *
 * Числовым идентификатор быть не должен: числовые ключи движок поднимает наверх
 * и сортирует по-своему, ломая порядок обхода, на который опирается фаза
 * прибытия (разбор — в шапке logistics/loading.ts).
 */
function freeLineId(company: Company, companyId: CompanyId): LineId {
  const lines = linesOf(company)
  let index = Object.keys(lines).length + 1

  for (;;) {
    const id = toLineId(`${companyId}-line-${index}`)
    if (lines[id] === undefined) return id
    index++
  }
}

/**
 * Свободный идентификатор машины: компания, класс, номер.
 *
 * Класс в ключе — по той же причине, что и у покупки игроком: в отладке и в
 * сохранении сразу видно, что за техника. Имя компании впереди развязывает
 * нумерацию с игроцкой: его ключи не начинаются с «zil-130-», поэтому две схемы
 * не пересекаются никогда, а не «обычно».
 */
function freeVehicleId(
  vehicles: Record<VehicleId, Vehicle>,
  companyId: CompanyId,
  classId: string,
): VehicleId {
  let index = 1

  for (;;) {
    const id = toVehicleId(`${companyId}-${classId}-${index}`)
    if (vehicles[id] === undefined) return id
    index++
  }
}

// ─── Применение ────────────────────────────────────────────────────────────

/**
 * Машины, снятые с удалённой линии.
 *
 * Только СВОИ. Идентификаторы линий уникальны внутри компании, а не в мире, и
 * чужая машина, ссылающаяся на такой же ключ, стоит на СВОЕЙ линии соседа —
 * трогать её значит распоряжаться чужим парком.
 */
function detachFromLine(
  vehicles: Record<VehicleId, Vehicle>,
  ownerId: CompanyId,
  id: LineId,
): Record<VehicleId, Vehicle> {
  let next: Record<VehicleId, Vehicle> | null = null

  for (const key of Object.keys(vehicles) as VehicleId[]) {
    const vehicle = vehicles[key]
    if (vehicle.lineId !== id || vehicle.ownerId !== ownerId) continue

    if (next === null) next = { ...vehicles }
    next[key] = detached(vehicle)
  }

  return next ?? vehicles
}

/**
 * Двусторонняя связь машины с линией.
 *
 * Машина помнит линию, линия помнит машины. Держать связь в одном месте было бы
 * честнее, но интерфейсу нужны оба направления — «на какой линии эта машина» и
 * «сколько машин на линии», — а обход всего парка ради второго вопроса на каждый
 * кадр того не стоит. Раз копий две, обновлять их обязано одно место.
 *
 * Маршрут стирается в обе стороны: поставили на линию — диспетчеризация выдаст
 * свой на ближайшем тике, сняли — машина доедет до узла и встанет.
 */
function applyAssignVehicle(
  state: GameState,
  companyId: CompanyId,
  company: Company,
  vehicle: Vehicle,
  lineId: LineId | null,
): GameState {
  const lines: Record<LineId, Line> = { ...linesOf(company) }

  if (vehicle.lineId !== null) {
    const previous = lines[vehicle.lineId]
    if (previous !== undefined) {
      lines[previous.id] = {
        ...previous,
        assignedVehicles: (previous.assignedVehicles ?? []).filter(
          (id) => id !== vehicle.id,
        ),
      }
    }
  }

  if (lineId !== null) {
    const target = lines[lineId]
    const assigned = target.assignedVehicles ?? []
    lines[lineId] = {
      ...target,
      assignedVehicles: assigned.includes(vehicle.id)
        ? assigned
        : [...assigned, vehicle.id],
    }
  }

  const next =
    lineId === null
      ? detached(vehicle)
      : { ...vehicle, lineId, stopIndex: 0, route: [] }

  return withCompany(
    { ...state, vehicles: { ...state.vehicles, [vehicle.id]: next } },
    companyId,
    { ...company, lines },
  )
}

/**
 * Двусторонняя связь водителя с машиной.
 *
 * Освобождать приходится ОБЕ прежние связи: машина, на которую садится
 * водитель, могла быть занята другим человеком, а сам он мог сидеть за другой
 * машиной. Пропусти любую — и получишь водителя-призрака, которого панель
 * показывает за рулём машины, где уже сидит второй.
 */
function applySeatDriver(
  state: GameState,
  companyId: CompanyId,
  company: Company,
  driver: Driver,
  target: Vehicle | null,
): GameState {
  const drivers: Record<DriverId, Driver> = { ...driversOf(company) }
  const vehicles: Record<VehicleId, Vehicle> = { ...state.vehicles }

  // Машина, с которой водитель уходит. Своя — чужую он занимать не мог, а
  // ссылка на чужую в сохранении это рассинхрон, который чинится не отсюда.
  const previous = driver.vehicleId
  if (
    previous !== null &&
    vehicles[previous] !== undefined &&
    vehicles[previous].ownerId === companyId
  ) {
    vehicles[previous] = { ...vehicles[previous], driverId: null }
  }

  // Человек, который сидел за целевой машиной.
  if (target !== null && target.driverId !== null) {
    const displaced = drivers[target.driverId]
    if (displaced !== undefined) {
      drivers[displaced.id] = { ...displaced, vehicleId: null }
    }
  }

  drivers[driver.id] = { ...driver, vehicleId: target === null ? null : target.id }
  if (target !== null) {
    vehicles[target.id] = { ...vehicles[target.id], driverId: driver.id }
  }

  return withCompany({ ...state, vehicles }, companyId, {
    ...company,
    drivers,
  })
}

/** Уволить: убрать из штата и освободить его машину. */
function applyFireDriver(
  state: GameState,
  companyId: CompanyId,
  company: Company,
  driver: Driver,
): GameState {
  const drivers: Record<DriverId, Driver> = { ...driversOf(company) }
  delete drivers[driver.id]

  /*
   * Увольнение БЕСПЛАТНО, и это не поблажка. Настоящая цена решения в том, что
   * машина под уволенным встаёт: она не поедет, пока за руль не сядет другой
   * (vehicleSpeedFactor в logistics/driver.ts).
   */
  const seat = driver.vehicleId
  const vehicles =
    seat !== null &&
    state.vehicles[seat] !== undefined &&
    state.vehicles[seat].ownerId === companyId
      ? {
          ...state.vehicles,
          [seat]: { ...state.vehicles[seat], driverId: null },
        }
      : state.vehicles

  return withCompany({ ...state, vehicles }, companyId, { ...company, drivers })
}

/**
 * Применить ОДНУ команду. Незаконная не применяется молча.
 *
 * Возвращает НОВОЕ состояние либо исходное ПО ССЫЛКЕ, если команда отброшена, —
 * по совпадению ссылок вызывающий отличает сделанное от отвергнутого, ровно как
 * во всех остальных фазах.
 */
export function applyCommand(
  state: GameState,
  companyId: CompanyId,
  command: Command,
): GameState {
  const normal = normalized(state, command as unknown)
  if (normal === null) return state
  if (!isLegalCommand(state, companyId, normal)) return state

  // Компания заведомо есть: без неё команда не была бы законной.
  const company = state.companies[companyId]

  switch (normal.kind) {
    case 'создать-линию': {
      const id = freeLineId(company, companyId)
      // Остановки уже скопированы нормализацией — второй копии не нужно.
      const line: Line = {
        id,
        name: normal.name,
        stops: normal.stops,
        assignedVehicles: [],
      }

      return withCompany(state, companyId, {
        ...company,
        lines: { ...linesOf(company), [id]: line },
      })
    }

    case 'удалить-линию': {
      const lines = { ...linesOf(company) }
      delete lines[normal.lineId]

      // Машины удалённой линии остаются в парке и встают без задания. Удалять
      // их вместе с линией было бы катастрофой в один ход; оставлять на
      // несуществующей линии — тихой поломкой диспетчеризации.
      const vehicles = detachFromLine(state.vehicles, companyId, normal.lineId)

      return withCompany({ ...state, vehicles }, companyId, {
        ...company,
        lines,
      })
    }

    case 'купить-машину': {
      const vehicleClass = VEHICLE_CLASS_BY_ID[normal.classId]
      const id = freeVehicleId(state.vehicles, companyId, vehicleClass.id)
      // ГОЛЫЙ ТЯГАЧ: без прицепа и без водителя, ровно как у игрока. Машина в
      // этой игре собирается из трёх решений, и покупка только первое из них.
      const truck = createVehicle(id, companyId, HOME_CITY, vehicleClass.id)

      return withCompany(
        { ...state, vehicles: { ...state.vehicles, [id]: truck } },
        companyId,
        { ...company, money: company.money - vehicleClass.price },
      )
    }

    case 'купить-прицеп': {
      const vehicle = state.vehicles[normal.vehicleId]
      const price = TRAILER_PRICE[normal.trailer]

      // Старый прицеп не продаётся и денег не возвращает: смена специализации
      // обязана стоить, иначе выгодно менять кузов под каждый рейс.
      return withCompany(
        {
          ...state,
          vehicles: {
            ...state.vehicles,
            [normal.vehicleId]: { ...vehicle, trailer: normal.trailer },
          },
        },
        companyId,
        { ...company, money: company.money - price },
      )
    }

    case 'назначить-машину':
      return applyAssignVehicle(
        state,
        companyId,
        company,
        state.vehicles[normal.vehicleId],
        normal.lineId,
      )

    case 'нанять-водителя':
      /*
       * СИД — НОМЕР ТИКА, и это требование самого найма (см. hireDriver в
       * logistics/driver.ts): кандидат выводится отдельным потоком ГПСЧ, а не
       * общим rngState, чтобы решение конкурента не сдвигало всю дальнейшую
       * историю партии — поломки, события, погоду. Номер тика лежит в
       * сохранении, поэтому партия воспроизводится вместе с наймами.
       *
       * Два найма в одном тике дают РАЗНЫХ людей: ключ потока включает номер
       * найма, который растёт вместе со штатом.
       */
      return hireDriver(state, companyId, state.tick)

    case 'уволить-водителя':
      return applyFireDriver(
        state,
        companyId,
        company,
        driversOf(company)[normal.driverId],
      )

    case 'посадить-водителя':
      return applySeatDriver(
        state,
        companyId,
        company,
        driversOf(company)[normal.driverId],
        normal.vehicleId === null ? null : state.vehicles[normal.vehicleId],
      )

    case 'построить':
      // Всё решение — цена, лимит на город, списание — внутри buildings.ts.
      return buildBuilding(state, companyId, normal.cityId, normal.type)

    case 'снести':
      // Владелец проверен законностью; снос сам по себе компанию не выбирает.
      return demolishBuilding(state, normal.buildingId)

    case 'обслужить':
      // Цена работ считается от класса и износа машины внутри wear.ts, и
      // повторять её здесь значило бы завести вторую копию прейскуранта.
      return serviceVehicle(state, normal.vehicleId)

    case 'починить':
      return repairVehicle(state, normal.vehicleId)

    case 'продать-машину':
      return sellVehicle(state, companyId, normal.vehicleId)
  }
}

/**
 * Продать машину: снять с линии, высадить водителя, вернуть часть цены.
 *
 * Возвращается ПОЛОВИНА цены класса, без учёта прицепа и износа. Точная оценка
 * подержанной техники — отдельная механика поздних срезов; сейчас важно другое:
 * продажа обязана быть невыгодной настолько, чтобы никому не пришло в голову
 * покупать и продавать по кругу, но выгодной достаточно, чтобы избавиться от
 * лишней машины было решением, а не потерей всего.
 */
function sellVehicle(
  state: GameState,
  companyId: CompanyId,
  vehicleId: VehicleId,
): GameState {
  const vehicle = state.vehicles[vehicleId]
  const company = state.companies[companyId]
  if (vehicle === undefined || company === undefined) return state

  const vehicleClass = VEHICLE_CLASS_BY_ID[vehicle.classId]
  const refund = vehicleClass === undefined ? 0 : Math.round(vehicleClass.price / 2)

  const vehicles = { ...state.vehicles }
  delete vehicles[vehicleId]

  // Водитель освобождается, а не увольняется: он в штате и может сесть в другую.
  const drivers = { ...company.drivers }
  for (const [id, driver] of Object.entries(drivers) as [DriverId, Driver][]) {
    if (driver.vehicleId === vehicleId) drivers[id] = { ...driver, vehicleId: null }
  }

  // И с линии снять: назначенная на несуществующую машину линия — битая ссылка.
  const lines = { ...company.lines }
  for (const [id, line] of Object.entries(lines) as [LineId, Line][]) {
    if (!line.assignedVehicles.includes(vehicleId)) continue
    lines[id] = {
      ...line,
      assignedVehicles: line.assignedVehicles.filter((v) => v !== vehicleId),
    }
  }

  return {
    ...state,
    vehicles,
    companies: {
      ...state.companies,
      [companyId]: {
        ...company,
        money: company.money + refund,
        drivers,
        lines,
      },
    },
  }
}

// ─── Фаза ──────────────────────────────────────────────────────────────────

/** Очередь компании, вычищенная после разбора. */
function clearedQueue(state: GameState, companyId: CompanyId): GameState {
  const company: Company | undefined = state.companies[companyId]
  if (company === undefined) return state
  if (queueOf(company).length === 0) return state

  return withCompany(state, companyId, { ...company, pendingCommands: [] })
}

/**
 * Фаза команд целиком. Возвращает НОВОЕ состояние.
 *
 * МЕСТО В ТИКЕ — СРАЗУ ПОСЛЕ ВРЕМЕНИ, ПЕРВОЙ ИЗ СОДЕРЖАТЕЛЬНЫХ ФАЗ. Решения
 * принимаются в начале дня, а не посреди рейса: машина, купленная этой фазой,
 * успевает получить маршрут в диспетчеризации того же тика, а линия, заведённая
 * сейчас, начинает работать сегодня. Поставь фазу в конец — и каждое решение
 * конкурента опаздывало бы ровно на тик, а на ускорении времени величина
 * опоздания зависела бы от числа тиков за кадр.
 *
 * ПОРЯДОК КОМПАНИЙ — ПОРЯДОК КЛЮЧЕЙ, и он значим: компании делят между собой
 * общий парк идентификаторов машин и общий мир, в котором строят. Порядок
 * вставки ключей воспроизводим (разбор — в шапке logistics/loading.ts), список
 * снимается с ИСХОДНОГО состояния, а команды внутри компании применяются одна за
 * другой — так купленная машина видна следующей же команде той же компании.
 *
 * ОЧЕРЕДЬ ЧИСТИТСЯ ВСЕГДА, ДАЖЕ ЕСЛИ ВСЁ ОТБРОШЕНО. Иначе битая команда
 * отбрасывалась бы вечно, каждый тик до конца партии, а очередь на десять тысяч
 * записей навсегда съела бы кадр. Команда — это разовое предложение, а не
 * намерение: не прошла — модель предложит другое.
 */
export function runCommands(state: GameState): GameState {
  let next = state
  let changed = false

  for (const id of Object.keys(state.companies) as CompanyId[]) {
    const queue = queueOf(state.companies[id])
    if (queue.length === 0) continue

    const limit = Math.min(queue.length, MAX_COMMANDS_PER_TICK)
    for (let i = 0; i < limit; i++) {
      next = applyCommand(next, id, queue[i])
    }

    // Чистится очередь ТЕКУЩЕГО состояния, а не исходного: команды уже могли
    // подменить компанию, и запись по старой ссылке потеряла бы их работу.
    next = clearedQueue(next, id)
    changed = true
  }

  return changed ? next : state
}
