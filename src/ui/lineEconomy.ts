/**
 * Метрики линии для панели компании.
 *
 * Панель обязана ответить на вопрос «эта линия прибыльна?», и вот в чём
 * трудность: ФАКТИЧЕСКОЙ выручки линии в состоянии нет и быть не может. Деньги
 * начисляются машине в момент разгрузки (logistics/loading.ts) и уходят в общий
 * счёт компании; полей «заработано этой линией» ни в Line, ни в Vehicle нет, а
 * types.ts — контракт, и заводить их ради отчёта нельзя. Восстановить сумму
 * задним числом тоже не из чего: в GameState остаётся только новый остаток.
 *
 * Поэтому здесь считается не факт, а ПОТОЛОК — сколько кольцо принесёт за один
 * круг, если всё сложится идеально. Все допущения смещены в одну сторону, в
 * пользу линии, и это делает число строгой верхней границей:
 *
 *   • кузов полон на каждом гружёном плече — на деле груза может не оказаться;
 *   • груз есть на каждой остановке, где велено грузить;
 *   • машина идёт с крейсерской скоростью — значит круг короче по времени, а
 *     зарплата за него меньше настоящей;
 *   • плечи считаются по кратчайшему пути — реальный маршрут выбирается по
 *     ВРЕМЕНИ и бывает длиннее, то есть топлива уйдёт больше.
 *
 * Отсюда единственное, но сильное утверждение, которое панель имеет право
 * сделать: ЕСЛИ ПОТОЛОК ОТРИЦАТЕЛЬНЫЙ, ЛИНИЯ УБЫТОЧНА ВСЕГДА. Никакая удача с
 * грузом её не спасёт — геометрия кольца и выбор грузов уже не окупают топливо.
 * Положительный потолок ничего не обещает, он только говорит «может работать».
 * Ровно это и нужно игроку в момент проектирования, когда линия ещё ни разу не
 * проехала и фактических данных нет вовсе.
 *
 * НИ ОДНОЙ СОБСТВЕННОЙ ФОРМУЛЫ ЗДЕСЬ НЕТ. Выручка — deliveryRevenue из
 * economy/finance.ts, расходы — distanceCost из economy/operating.ts, ставка
 * водителя — DRIVER_WAGE_PER_DAY из data/operating.ts, расстояния — shortestKm,
 * то есть та же геометрия, по которой считается тариф. Модуль только складывает
 * их в порядке обхода кольца.
 *
 * Модуль чистый и не знает ни про React, ни про three: его можно прогнать
 * тестом без монтирования чего бы то ни было.
 */

import { DRIVER_WAGE_PER_DAY } from '../data/operating'
import { distanceCost } from '../sim/economy/operating'
import { deliveryRevenue } from '../sim/economy/finance'
import { MIN_LINE_STOPS } from '../sim/logistics/line'
import {
  HOME_CITY,
  STARTER_CRUISE_KMH,
  createZil,
} from '../sim/state'
import type {
  CargoType,
  CityId,
  CompanyId,
  Line,
  LineId,
  Vehicle,
  VehicleId,
} from '../sim/types'
import { companyId, vehicleId } from '../sim/types'
import type { RoadGraph } from '../sim/world/graph'
import { shortestKm } from '../sim/world/pathfind'

/** Часов в сутках — перевод суточной ставки водителя в стоимость круга. */
const HOURS_PER_DAY = 24

/**
 * Машина, по которой считается потолок линии.
 *
 * ЗИЛ, собранный тем же createZil, каким игроку выдают настоящие машины: расход,
 * грузоподъёмность и крейсерская скорость приходят из sim/state.ts, а не
 * переписываются здесь числами. Опорная машина ОДНА и не берётся из парка линии
 * намеренно — иначе оценка зависела бы от состояния машин и пересчитывалась бы
 * (вместе с поиском пути) каждый тик. Пока весь парк состоит из одинаковых
 * ЗИЛов, разницы нет вовсе; разные по расходу машины появятся в срезе 5, и тогда
 * же здесь появится выбор, чью экономику показывать.
 */
const REFERENCE_VEHICLE: Vehicle = createZil(
  vehicleId('план'),
  companyId('план'),
  HOME_CITY,
)

// ─── Обход кольца ──────────────────────────────────────────────────────────

/**
 * Остановки в том порядке, в котором их РЕАЛЬНО объезжает машина.
 *
 * Возвращает индексы остановок, начиная с нулевой и без её повтора в конце:
 * кольцо замыкается последним элементом на первый.
 *
 * Недостижимая остановка пропускается — так же поступает диспетчер (разбор в
 * шапке logistics/line.ts). Обход идёт ШАГАМИ, а не перебором остановок подряд:
 * иначе у пропущенной остановки нашлось бы собственное исходящее плечо, и в
 * отчёте (как и на карте) появился бы кусок кольца, которого никто не едет.
 *
 * Общая функция для панели и для отрисовки линий на карте (render/LineMesh.tsx).
 * Двух ответов на вопрос «по каким плечам идёт кольцо» быть не должно: разойдясь,
 * они дали бы карту, на которой нарисовано одно, и отчёт, в котором посчитано
 * другое, — а расхождение это заметить нечем, обе картинки правдоподобны.
 */
export function ringOrder(graph: RoadGraph, line: Line): number[] {
  const count = line.stops.length
  if (count < MIN_LINE_STOPS) return []

  const order: number[] = []
  let from = 0

  for (let visited = 0; visited < count; visited++) {
    order.push(from)

    let next = -1
    for (let step = 1; step < count; step++) {
      const candidate = (from + step) % count
      const km = shortestKm(
        graph,
        line.stops[from].nodeId,
        line.stops[candidate].nodeId,
      )
      if (Number.isFinite(km)) {
        next = candidate
        break
      }
    }

    // Из этой остановки не доехать никуда — кольца нет. Дальше идти некуда.
    if (next < 0) break
    from = next
    if (from === 0) break
  }

  return order
}

// ─── Потолок круга ─────────────────────────────────────────────────────────

export type LinePlan = {
  /** Длина кольца по кратчайшим путям, км. */
  ringKm: number
  /** Сколько из них проходится порожняком, км. */
  emptyKm: number
  /** Доля порожнего пробега по ЗАМЫСЛУ кольца, 0..1. null — кольца нет. */
  emptyShare: number | null
  /** Выручка круга при полном кузове, руб. */
  revenue: number
  /** Расходы круга: топливо, обслуживание, зарплата, руб. */
  costs: number
  /** Потолок итога за круг, руб. Отрицательный — линия убыточна всегда. */
  profit: number
  /**
   * Кольцо не собирается: остановок меньше двух или между ними нет дорог.
   * Считать по такой линии нечего, и показывать ноль вместо честного «нет»
   * значило бы выдать недостроенную линию за безубыточную.
   */
  broken: boolean
}

const NO_PLAN: LinePlan = {
  ringKm: 0,
  emptyKm: 0,
  emptyShare: null,
  revenue: 0,
  costs: 0,
  profit: 0,
  broken: true,
}

/** Что лежит в кузове по замыслу: груз и город, где его взяли. */
type PlannedCargo = { type: CargoType; originId: CityId }

/**
 * Потолок одного круга.
 *
 * КОЛЬЦО ПРОХОДИТСЯ ДВАЖДЫ, и это обязательно. Груз, взятый на последней
 * остановке, сдаётся на первой — то есть первое плечо кольца гружёное, хотя при
 * старте с пустым кузовом оно выглядит порожним. Один проход насчитал бы такой
 * линии лишний порожний пробег и занизил выручку ровно на одно плечо. Первый
 * проход только раскладывает груз по кузову, считается второй.
 *
 * Порядок «выгрузить, потом загрузить» повторяет фазу прибытия
 * (logistics/loading.ts) и по той же причине: машина, привёзшая зерно на
 * мукомольный, стоит в городе, где на складе теперь лежит её же зерно.
 */
export function planLoop(graph: RoadGraph, line: Line): LinePlan {
  const order = ringOrder(graph, line)
  if (order.length < MIN_LINE_STOPS) return NO_PLAN

  const capacity = REFERENCE_VEHICLE.capacity

  let cargo: PlannedCargo | null = null
  let ringKm = 0
  let emptyKm = 0
  let revenue = 0

  for (let pass = 0; pass < 2; pass++) {
    const counting = pass === 1

    for (let k = 0; k < order.length; k++) {
      const stop = line.stops[order[k]]

      // ─── Выгрузка ──────────────────────────────────────────────────────
      if (cargo !== null && stop.unload.includes(cargo.type)) {
        // Сдать груз там, где его и взяли, нельзя — перевозки не было. Тот же
        // запрет, что в фазе прибытия: без него кольцо «погрузил и выгрузил на
        // одной остановке» печатало бы деньги из воздуха.
        if (cargo.originId !== stop.nodeId) {
          if (counting) {
            revenue += deliveryRevenue(
              cargo.type,
              capacity,
              // Тариф платят за КРАТЧАЙШЕЕ расстояние от погрузки до выгрузки,
              // а не за пробег: разбор в шапке loading.ts.
              shortestKm(graph, cargo.originId, stop.nodeId),
            )
          }
          cargo = null
        }
      }

      // ─── Погрузка ──────────────────────────────────────────────────────
      // Берётся ПЕРВЫЙ груз списка: порядок в stop.load задаёт приоритет, и
      // ровно его же читает findPickup в фазе прибытия.
      if (cargo === null && stop.load.length > 0) {
        cargo = { type: stop.load[0], originId: stop.nodeId }
      }

      // ─── Плечо до следующей остановки ──────────────────────────────────
      const next = line.stops[order[(k + 1) % order.length]]
      const km = shortestKm(graph, stop.nodeId, next.nodeId)
      if (counting && Number.isFinite(km) && km > 0) {
        ringKm += km
        if (cargo === null) emptyKm += km
      }
    }
  }

  if (!(ringKm > 0)) return NO_PLAN

  // Расходы круга. Топливо и обслуживание — distanceCost, то есть ровно то, что
  // спишет фаза расходов за этот пробег. Зарплата — суточная ставка на время
  // круга: водителю платят и в рейсе, и на стоянке, поэтому длинное кольцо
  // стоит зарплаты пропорционально своей длительности.
  const hours = ringKm / STARTER_CRUISE_KMH
  const costs =
    distanceCost(REFERENCE_VEHICLE, ringKm) +
    (DRIVER_WAGE_PER_DAY * hours) / HOURS_PER_DAY

  return {
    ringKm,
    emptyKm,
    emptyShare: emptyKm / ringKm,
    revenue,
    costs,
    profit: revenue - costs,
    broken: false,
  }
}

/**
 * Потолки всех линий компании. Граф строится один раз на все.
 *
 * Отдельная функция, а не вызов planLoop в цикле у панели: buildGraph и поиск
 * путей — самое дорогое, что делает интерфейс, и повторять его на каждую линию
 * незачем.
 */
export function planLines(
  graph: RoadGraph,
  lines: Record<LineId, Line>,
): Record<LineId, LinePlan> {
  const plans: Record<LineId, LinePlan> = {}
  for (const id of Object.keys(lines) as LineId[]) {
    plans[id] = planLoop(graph, lines[id])
  }
  return plans
}

// ─── Факт по парку ─────────────────────────────────────────────────────────

/**
 * Доля порожнего пробега, 0..1. null — считать пока не из чего.
 *
 * Складываются счётчики, а не усредняются проценты машин: машина, сделавшая один
 * рейс, и машина, отработавшая полгода, имеют совершенно разный вес, и среднее
 * по процентам врало бы в пользу новичков в парке.
 *
 * ВАЖНО про «пока не из чего». Сумма loadedKm + emptyKm — это пробег, УЖЕ
 * разнесённый по счетам, а разносится он в фазе движения по мере хода. Пока
 * первая машина не проехала ни километра, обе суммы — нули, и честный ответ
 * здесь «нет данных», а не «0%». Показать ноль означало бы поздравить игрока с
 * идеальной работой ровно в тот момент, когда он ещё ничего не сделал.
 */
export function emptyShare(loadedKm: number, emptyKm: number): number | null {
  const total = loadedKm + emptyKm
  if (!Number.isFinite(total) || total <= 0) return null
  return emptyKm / total
}

/** Что фактически наездил парк одной линии. */
export type LineFleet = {
  /** Сколько машин на линии сейчас. */
  count: number
  loadedKm: number
  emptyKm: number
  /** Доля порожнего пробега машин линии. null — нет пробега. */
  emptyShare: number | null
}

const NO_FLEET: LineFleet = {
  count: 0,
  loadedKm: 0,
  emptyKm: 0,
  emptyShare: null,
}

/**
 * Парк, разложенный по линиям, — одним проходом по всем машинам.
 *
 * ИСТИНА О ПРИНАДЛЕЖНОСТИ МАШИНЫ — ПОЛЕ МАШИНЫ, а не список в линии. То же
 * правило, что в groupByLine (logistics/line.ts): список ведёт стор и он может
 * отстать, а машина без своей линии просто не двигается, и такую ошибку видно
 * сразу. Считай панель машины по assignedVehicles — и она показывала бы парк,
 * которого на линии нет.
 *
 * ЧЕСТНАЯ ОГОВОРКА про километры: счётчики машины накопительные и за партию, а
 * машину можно перевести с линии на линию. Пробег, наезженный на прошлой линии,
 * уедет вместе с ней — метрика линии это на самом деле «как ездили ЭТИ машины»,
 * а не «как ездила эта линия». Разделить нельзя: полей под пробег по линиям в
 * types.ts нет. Для решения «где у меня порожняк» этого достаточно, а
 * приписывать точность, которой нет, хуже, чем оговорить.
 */
export function fleetByLine(
  vehicles: Record<VehicleId, Vehicle>,
  ownerId: CompanyId,
): Record<LineId, LineFleet> {
  const byLine: Record<LineId, LineFleet> = {}

  for (const vehicle of Object.values(vehicles)) {
    if (vehicle.ownerId !== ownerId) continue
    if (vehicle.lineId === null) continue

    const current = byLine[vehicle.lineId] ?? { ...NO_FLEET }

    current.count += 1
    // Битые счётчики из старого сохранения не должны отравить сумму: NaN,
    // попавший в метрику, делает её NaN навсегда и молча.
    if (Number.isFinite(vehicle.loadedKm)) current.loadedKm += vehicle.loadedKm
    if (Number.isFinite(vehicle.emptyKm)) current.emptyKm += vehicle.emptyKm
    current.emptyShare = emptyShare(current.loadedKm, current.emptyKm)

    byLine[vehicle.lineId] = current
  }

  return byLine
}

/** Пустой парк — для линии, на которую ещё не поставили ни одной машины. */
export function noFleet(): LineFleet {
  return { ...NO_FLEET }
}
