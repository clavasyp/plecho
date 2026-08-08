/**
 * Модель состояния игры.
 *
 * Всё состояние — одна сериализуемая структура. Никакого игрового состояния за
 * её пределами: сохранение это JSON.stringify(state), загрузка — JSON.parse.
 *
 * Здесь описан срез 1 (мир, время, движение). Экономика, линии, водители и
 * инфраструктура добавляются в срезах 2–5, их формы — в docs/АРХИТЕКТУРА.md.
 * Типы намеренно не заводятся заранее: неиспользуемые определения устаревают
 * быстрее, чем становятся нужны.
 */

// ─── Идентификаторы ────────────────────────────────────────────────────────
// Строковые литеральные типы вместо number: в отладке и в сохранении сразу
// видно, что за сущность, а перепутать CityId с EdgeId не даёт компилятор.

export type CityId = string & { readonly __brand: 'CityId' }
export type EdgeId = string & { readonly __brand: 'EdgeId' }
export type VehicleId = string & { readonly __brand: 'VehicleId' }
export type CompanyId = string & { readonly __brand: 'CompanyId' }

export const cityId = (id: string) => id as CityId
export const edgeId = (id: string) => id as EdgeId
export const vehicleId = (id: string) => id as VehicleId
export const companyId = (id: string) => id as CompanyId

// ─── География ─────────────────────────────────────────────────────────────

/** Точка на сфере — как в исходных данных. */
export type LatLon = {
  lat: number
  lon: number
}

/** Точка на игровой плоскости в километрах после проекции. */
export type Point2 = {
  x: number
  y: number
}

/** Профиль города определяет, какие предприятия у него в окрестностях. */
export type CityProfile =
  | 'столица'
  | 'промышленный'
  | 'аграрный'
  | 'транзитный'
  | 'ресурсный'

export type City = {
  id: CityId
  name: string
  coord: LatLon
  /** Жителей. Определяет силуэт, спрос и размер узла на карте. */
  population: number
  profile: CityProfile
}

/** Класс дороги задаёт базовую скорость и пропускную способность. */
export type RoadClass = 'федеральная' | 'региональная' | 'местная'

export type Edge = {
  id: EdgeId
  from: CityId
  to: CityId
  /** Длина по дороге, не по прямой. */
  km: number
  class: RoadClass
  /** Обозначение трассы для интерфейса: «М-4», «Р-132». */
  route: string
  /** 0..1 — качество покрытия. Влияет на скорость и износ. */
  quality: number
}

// ─── Время ─────────────────────────────────────────────────────────────────

/** Один тик симуляции. Всё игровое время выражается в тиках. */
export const MINUTES_PER_TICK = 15
export const TICKS_PER_HOUR = 60 / MINUTES_PER_TICK
export const TICKS_PER_DAY = TICKS_PER_HOUR * 24

export type Season = 'зима' | 'весна' | 'лето' | 'осень'

/** Производное от tick представление — удобно для интерфейса, не хранится. */
export type GameDate = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  season: Season
}

export type GameSpeed = 0 | 1 | 2 | 5

// ─── Транспорт ─────────────────────────────────────────────────────────────

/**
 * Положение машины на карте.
 *
 * Машина либо стоит в узле, либо едет по ребру. Третьего не дано — это
 * упрощает и движение, и отрисовку, и сериализацию.
 */
export type VehiclePosition =
  | { kind: 'узел'; nodeId: CityId }
  | {
      kind: 'ребро'
      edgeId: EdgeId
      /** Откуда выехали — ребро само по себе ненаправленное. */
      fromId: CityId
      /** 0..1 — доля пройденного пути от fromId. */
      progress: number
    }

export type Vehicle = {
  id: VehicleId
  ownerId: CompanyId
  position: VehiclePosition
  /**
   * Оставшийся маршрут — города, которые предстоит посетить по порядку.
   * Пустой массив означает, что машина стоит без задания.
   */
  route: CityId[]
  /** Крейсерская скорость по идеальной дороге, км/ч. */
  cruiseKmh: number
  /** Накопленный пробег, км. Разделение на гружёный и порожний — в срезе 3. */
  odometer: number
}

// ─── Компании ──────────────────────────────────────────────────────────────

/**
 * Игрок и конкуренты — одна и та же структура.
 * Логика компании пишется один раз, различие только в том, кто решает.
 */
export type Company = {
  id: CompanyId
  name: string
  money: number
  controller: 'человек' | 'скрипт' | 'модель'
}

// ─── Состояние игры ────────────────────────────────────────────────────────

export type GameState = {
  /** Состояние ГПСЧ. Записывается обратно после каждого использования. */
  rngState: number

  /** Сколько тиков прошло с начала партии. Дата выводится отсюда. */
  tick: number

  /** Год, с которого начинается партия. */
  startYear: number

  world: {
    cities: Record<CityId, City>
    edges: Record<EdgeId, Edge>
  }

  companies: Record<CompanyId, Company>
  playerId: CompanyId

  vehicles: Record<VehicleId, Vehicle>
}
