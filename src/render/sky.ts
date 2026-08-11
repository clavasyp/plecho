/**
 * Время суток, сезон и эпоха как ЧИСТАЯ ФУНКЦИЯ ОТ ТИКА.
 *
 * Тут нет ни Three.js, ни React, ни состояния: на вход номер тика и год начала
 * партии, на выход — числа, которые Scene.tsx кладёт в свет, туман и материал
 * подложки. Ровно поэтому всё это проверяется обычным юнит-тестом в Node
 * (sky.test.ts), а не «посмотрите на скриншот».
 *
 * ГЛАВНОЕ ТРЕБОВАНИЕ — НЕПРЕРЫВНОСТЬ. Свет обязан ехать, а не переключаться:
 * рывок цвета виден мгновенно и читается как баг рендера, даже если картинка в
 * обоих положениях правильная. Отсюда два решения, определившие весь файл.
 *
 * ПЕРВОЕ: НИКАКИХ ТАБЛИЦ КЛЮЧЕВЫХ КАДРОВ ПО ЧАСАМ. Всё считается от одной
 * величины — высоты солнца `sun`, которая сама есть синус времени суток,
 * приподнятый косинусом времени года. Синус и косинус периодичны по построению,
 * значит склейка полуночи и склейка Нового года получаются бесплатно и не могут
 * разъехаться от правки константы. Таблица «в 6:00 такой цвет, в 7:00 такой»
 * дала бы ту же картинку и ступеньку на каждой границе, а зимой ещё и рассвет в
 * шесть утра.
 *
 * ВТОРОЕ: СЕЗОН БЕРЁТСЯ НЕ ПО НОМЕРУ МЕСЯЦА. `season()` из sim/time.ts — это
 * переключатель для экономики, и он обязан щёлкать первого числа: ставки,
 * осевые ограничения и погода меняются днём, а не постепенно. Для картинки тот
 * же щелчок означал бы, что 28 февраля карта белая, а 1 марта уже нет. Поэтому
 * здесь сезоны смешиваются по доле года — но так, что в СЕРЕДИНЕ каждого месяца
 * преобладает ровно тот сезон, который вернёт `season()`. Это проверяется
 * тестом на всех двенадцати месяцах: два представления времени расходиться не
 * имеют права.
 *
 * АЛЛОКАЦИИ. Расчёт идёт каждый кадр, поэтому главная функция ничего не
 * создаёт: она ПИШЕТ в заранее выделенную структуру (`atmosphereInto`), как
 * resolvePlacement в VehicleMesh.tsx. Готовый буфер `atmosphere` экспортируется
 * — это тот же приём, что `clock.alpha` в app/loop.ts: сцену обновляет Scene, а
 * прочитать текущее состояние света может любой слой карты, не заводя своей
 * копии расчёта (ночные окна городов и фары — следующие в очереди).
 */

import { dayProgress, daysInYear } from '../sim/time'
import { TICKS_PER_DAY } from '../sim/types'
import type { Season } from '../sim/types'
import { daylight, era, fogRange, lighting, palette, seasonGround } from './palette'

/** Цвет в пространстве sRGB, каналы 0..1. */
export type Rgb = { r: number; g: number; b: number }

/** Направление в мировых координатах. Единичной длины не гарантирует. */
export type Vec3 = { x: number; y: number; z: number }

/**
 * Состояние атмосферы на конкретный тик — всё, что Scene кладёт в сцену.
 *
 * Вложенные объекты помечены readonly: ссылку менять нельзя, поля — можно и
 * нужно. Это и есть контракт буфера: структура выделяется один раз, а каждый
 * кадр в неё пишутся новые числа.
 */
export type Atmosphere = {
  /**
   * Воздух: цвет неба, тумана и фона канваса — ОДНО значение.
   *
   * Не три поля намеренно. Туман растворяет дальний план именно в фон, и любое
   * расхождение между ними даёт светлый или тёмный ободок по краю карты (об
   * этом сказано и в Scene.tsx). Одно поле делает рассинхронизацию невозможной.
   */
  readonly air: Rgb
  fogNear: number
  fogFar: number

  readonly key: Rgb
  keyIntensity: number
  /** Единичное направление НА источник: свет идёт оттуда в начало координат. */
  readonly keyDirection: Vec3

  readonly fill: Rgb
  fillIntensity: number
  readonly fillDirection: Vec3

  readonly ambient: Rgb
  ambientIntensity: number

  /** Цвет подложки — сезон читается прежде всего по нему. */
  readonly ground: Rgb

  /** Сдвиг насыщенности кадра для HueSaturation: −1 серое, 0 как есть. */
  saturation: number

  /** Высота солнца, −1.2..1.2. Отрицательная — солнце за горизонтом. */
  sun: number
  /** 0 — глубокая ночь, 1 — полный день. */
  daylight: number
  /** 1 в момент, когда солнце на горизонте, 0 днём и ночью. */
  twilight: number
  /** Доля зимы в смеси сезонов, 0..1. */
  winter: number
}

// ─── Форма суток и года ────────────────────────────────────────────────────

const TAU = Math.PI * 2

/**
 * Размах суточной дуги и сезонный подъём солнца.
 *
 * Пара определяет длину дня: солнце над горизонтом, пока
 * `SUN_SWING · sin > −SUN_TILT · cos`. При этих значениях в середине июня день
 * длится около пятнадцати часов, в середине декабря — около девяти. Настоящий
 * ЦФО ещё контрастнее (17.5 против 7), но там солнце зимой ползёт по самому
 * горизонту, и на изометрии это дало бы сутки плоского света без теней.
 */
const SUN_SWING = 0.86
const SUN_TILT = 0.34

/**
 * Доля года, на которую приходится летнее солнцестояние (21 июня).
 *
 * Не совпадает с серединой лета из `season()` — и не должна. Солнце выше всего
 * в июне, а теплее и суше всего в июле: астрономия опережает погоду примерно на
 * месяц. Поэтому дуга солнца привязана к солнцестоянию, а цвет земли — к
 * метеорологическим сезонам, и это два разных числа, а не одно с опечаткой.
 */
const SOLSTICE = 0.475

/** Границы перехода «ночь → день» по высоте солнца. */
const DAY_EDGE_LOW = -0.1
const DAY_EDGE_HIGH = 0.3

/**
 * Ширина сумерек по высоте солнца.
 *
 * Гауссиан, а не треугольник от |sun|: у модуля излом ровно в момент, когда
 * сумерки в максимуме, то есть скорость изменения цвета скачком меняет знак
 * на самом заметном месте суток. Экспонента гладкая везде.
 */
const TWILIGHT_WIDTH = 0.26

/** Насколько сумеречный оттенок вытесняет обычный цвет ключа и воздуха. */
const TWILIGHT_KEY_TINT = 0.85
const TWILIGHT_AIR_TINT = 0.7
/** Сумерки ещё и приглушают ключ: солнце у горизонта светит вскользь. */
const TWILIGHT_DIM = 0.28

/**
 * Дуга солнца в мировых координатах.
 *
 * Горизонтальная составляющая идёт с востока на запад (`SUN_EAST` при
 * cos = +1 на рассвете, −SUN_EAST на закате), постоянный снос `SUN_SOUTH`
 * держит солнце в южной половине неба, а высота поднимается вместе с `sun`.
 *
 * Пол `SUN_FLOOR` — не украшение: ночью солнце уходит под горизонт, и честное
 * направление светило бы карте в днище. Источник остаётся низко над землёй с
 * лунной яркостью 0.18 — при ней направление уже почти ни на что не влияет, но
 * тени не переворачиваются.
 */
const SUN_EAST = 1
const SUN_SOUTH = 0.5
const SUN_FLOOR = 0.22
const SUN_RISE = 1.2

/** Заливка зеркалит ключ по горизонтали и стоит низко (см. Scene.tsx). */
const FILL_HEIGHT = 0.35

/**
 * Середины метеорологических сезонов в долях года.
 *
 * Это середины декабрь-февраля, март-мая, июнь-августа и сентябрь-ноября —
 * тех самых троек, по которым режет `season()` из sim/time.ts. В этих точках
 * сезон звучит в полную силу, между ними — плавный переход.
 */
const SEASON_ORDER: readonly Season[] = ['зима', 'весна', 'лето', 'осень']
const SEASON_CENTER: readonly number[] = [0.04, 0.286, 0.538, 0.79]

/** Предел отматывания лет — страховка от бесконечного цикла на битом тике. */
const MAX_YEARS = 10_000

// ─── Мелкая математика ─────────────────────────────────────────────────────

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/** Сглаженная ступенька 3t²−2t³ на уже нормированном аргументе. */
function smooth(t: number): number {
  const x = clamp01(t)
  return x * x * (3 - 2 * x)
}

/** Сглаженный переход между двумя порогами. */
function ramp(low: number, high: number, value: number): number {
  return smooth((value - low) / (high - low))
}

/** Дробная часть в [0, 1) — доля года и доля суток обязаны быть внутри. */
function wrap01(value: number): number {
  if (!Number.isFinite(value)) return 0
  const rest = value % 1
  return rest < 0 ? rest + 1 : rest
}

function mixInto(out: Rgb, from: Rgb, to: Rgb, t: number): void {
  const k = clamp01(t)
  out.r = from.r + (to.r - from.r) * k
  out.g = from.g + (to.g - from.g) * k
  out.b = from.b + (to.b - from.b) * k
}

/** Подмешать цвет в уже посчитанный — второй слой поверх первого. */
function blendInto(out: Rgb, to: Rgb, t: number): void {
  const k = clamp01(t)
  out.r += (to.r - out.r) * k
  out.g += (to.g - out.g) * k
  out.b += (to.b - out.b) * k
}

/** Разбор '#rrggbb' в каналы 0..1. Вызывается один раз на модуль. */
function hex(value: string): Rgb {
  const packed = Number.parseInt(value.slice(1), 16)
  return {
    r: ((packed >> 16) & 0xff) / 255,
    g: ((packed >> 8) & 0xff) / 255,
    b: (packed & 0xff) / 255,
  }
}

// Палитра разбирается на числа один раз при загрузке модуля: в кадре парсить
// строки нельзя, а второго источника цвета это не заводит — здесь только
// перевод того, что записано в palette.ts, в удобное для смешивания
// представление.
const KEY_DAY = hex(lighting.keyColor)
const KEY_NIGHT = hex(daylight.keyNight)
const KEY_DAWN = hex(daylight.keyDawn)
const KEY_DUSK = hex(daylight.keyDusk)

const FILL_DAY = hex(lighting.fillColor)
const FILL_NIGHT = hex(daylight.fillNight)

const AMBIENT_DAY = hex(lighting.ambientColor)
const AMBIENT_NIGHT = hex(daylight.ambientNight)

const AIR_NIGHT = hex(palette.background)
const AIR_DAY = hex(daylight.airDay)
const AIR_DAWN = hex(daylight.airDawn)
const AIR_DUSK = hex(daylight.airDusk)
const AIR_WINTER = hex(daylight.airWinter)

const GROUND: readonly Rgb[] = SEASON_ORDER.map((name) =>
  hex(seasonGround[name]),
)

/** Промежуточные цвета сумерек — тоже буфер, а не результат кадра. */
const scratchWarmKey: Rgb = { r: 0, g: 0, b: 0 }
const scratchWarmAir: Rgb = { r: 0, g: 0, b: 0 }

// ─── Календарь для картинки ────────────────────────────────────────────────

/**
 * Тик, годный для расчёта.
 *
 * Отрицательный и нечисловой тик приводятся к началу партии — и это не
 * перестраховка. Тик приходит из рендера уже интерполированным
 * (`prev.tick + (state.tick − prev.tick)·alpha`), а на первом кадре после
 * загрузки сохранения или отката alpha может уйти за края. Календарь на такое
 * бросает исключение (dateFromTick), но бросать исключение в цикле кадра
 * означало бы уронить сцену вместо одного неверного цвета.
 *
 * Приводится ЗДЕСЬ, а не в каждой функции по-своему: dayProgress заворачивает
 * отрицательный тик в конец суток, а календарь — в начало партии, и без общего
 * входа полночь и доля года разъехались бы на этих значениях.
 */
function safeTick(tick: number): number {
  return Number.isFinite(tick) && tick > 0 ? tick : 0
}

/** Тик, приведённый к суткам. */
function daysSinceStart(tick: number): number {
  return safeTick(tick) / TICKS_PER_DAY
}

/**
 * Календарный год тика.
 *
 * Отматывается циклом по той же причине, что и в dateFromTick: партия живёт
 * десятки лет, то есть речь о паре десятков итераций, зато переходы через
 * високосный год видно глазами.
 */
export function yearAt(tick: number, startYear: number): number {
  let rest = daysSinceStart(tick)
  let year = Math.trunc(startYear)
  for (let guard = 0; guard < MAX_YEARS; guard++) {
    const length = daysInYear(year)
    if (rest < length) break
    rest -= length
    year += 1
  }
  return year
}

/**
 * Доля года, 0..1: 0 — полночь 1 января, 1 не достигается никогда.
 *
 * Дробная и непрерывная — от неё считаются и высота солнца, и смесь сезонов, и
 * эпоха. Целочисленный день года дал бы ступеньку раз в сутки на каждой из трёх.
 */
export function yearPhaseAt(tick: number, startYear: number): number {
  let rest = daysSinceStart(tick)
  let year = Math.trunc(startYear)
  for (let guard = 0; guard < MAX_YEARS; guard++) {
    const length = daysInYear(year)
    if (rest < length) return rest / length
    rest -= length
    year += 1
  }
  return 0
}

/**
 * Индекс сезона, чья середина ближайшая СЛЕВА по кругу года.
 *
 * Вместе с seasonBlendAt задаёт разбиение единицы: в любой момент звучат не
 * больше двух сезонов, и их доли в сумме дают ровно 1. Отсюда простота — смесь
 * считается одним смешиванием двух цветов, без нормировки четырёх весов.
 */
export function seasonIndexAt(yearPhase: number): number {
  const phase = wrap01(yearPhase)
  for (let i = SEASON_CENTER.length - 1; i >= 0; i--) {
    if (phase >= SEASON_CENTER[i]) return i
  }
  // Раньше середины зимы — значит, мы всё ещё на отрезке «осень → зима»,
  // начавшемся в прошлом году.
  return SEASON_CENTER.length - 1
}

/** Доля СЛЕДУЮЩЕГО сезона в смеси, 0..1. */
export function seasonBlendAt(yearPhase: number): number {
  const phase = wrap01(yearPhase)
  const index = seasonIndexAt(phase)
  const from = SEASON_CENTER[index]
  const next = SEASON_CENTER[(index + 1) % SEASON_CENTER.length]
  // Отрезок «осень → зима» переваливает через Новый год: правый край и, если мы
  // уже в новом году, сама доля года переносятся на год вперёд.
  const to = next > from ? next : next + 1
  const here = phase >= from ? phase : phase + 1
  return smooth((here - from) / (to - from))
}

/** Доля конкретного сезона в смеси, 0..1. Сумма по всем четырём равна 1. */
export function seasonWeightAt(yearPhase: number, target: Season): number {
  const index = seasonIndexAt(yearPhase)
  const blend = seasonBlendAt(yearPhase)
  if (SEASON_ORDER[index] === target) return 1 - blend
  if (SEASON_ORDER[(index + 1) % SEASON_ORDER.length] === target) return blend
  return 0
}

/**
 * Высота солнца: −1.2 (глубокая зимняя полночь) .. 1.2 (летний полдень).
 *
 * Одна величина, из которой выведено всё остальное. Ноль — солнце ровно на
 * горизонте, то есть середина сумерек.
 */
export function sunAt(tick: number, startYear: number): number {
  const day = dayProgress(safeTick(tick))
  const year = yearPhaseAt(tick, startYear)
  return (
    SUN_SWING * Math.sin(TAU * (day - 0.25)) +
    SUN_TILT * Math.cos(TAU * (year - SOLSTICE))
  )
}

/**
 * Насыщенность кадра по году, вход HueSaturation.
 *
 * Год берётся ДРОБНЫМ: на границе 31 декабря и 1 января насыщенность обязана
 * продолжиться, а не шагнуть на 1/36 диапазона. Раньше 1994-го и позже 2030-го
 * значение упирается в края — партия за пределами эпохи не должна выцветать в
 * ноль или уходить в кислоту.
 */
export function saturationAt(tick: number, startYear: number): number {
  const year = yearAt(tick, startYear) + yearPhaseAt(tick, startYear)
  const t = clamp01((year - era.fromYear) / (era.toYear - era.fromYear))
  return era.saturationFrom + (era.saturationTo - era.saturationFrom) * t
}

// ─── Атмосфера ─────────────────────────────────────────────────────────────

/** Пустой буфер атмосферы. Заполняется atmosphereInto. */
export function createAtmosphere(): Atmosphere {
  return {
    air: { r: 0, g: 0, b: 0 },
    fogNear: fogRange.near,
    fogFar: fogRange.far,
    key: { r: 0, g: 0, b: 0 },
    keyIntensity: 0,
    keyDirection: { x: 0, y: 1, z: 0 },
    fill: { r: 0, g: 0, b: 0 },
    fillIntensity: 0,
    fillDirection: { x: 0, y: 1, z: 0 },
    ambient: { r: 0, g: 0, b: 0 },
    ambientIntensity: 0,
    ground: { r: 0, g: 0, b: 0 },
    saturation: 0,
    sun: 0,
    daylight: 0,
    twilight: 0,
    winter: 0,
  }
}

/**
 * Атмосфера на заданный тик. Пишет в `out`, ничего не создаёт и не читает
 * никакого состояния, кроме своих аргументов.
 *
 * Порядок расчёта: высота солнца → день и сумерки → цвета → направления.
 * Он же порядок зависимостей: ни одна величина ниже не влияет на верхние.
 */
export function atmosphereInto(
  out: Atmosphere,
  tick: number,
  startYear: number,
): Atmosphere {
  const day = dayProgress(safeTick(tick))
  const year = yearPhaseAt(tick, startYear)

  const sun =
    SUN_SWING * Math.sin(TAU * (day - 0.25)) +
    SUN_TILT * Math.cos(TAU * (year - SOLSTICE))

  const light = ramp(DAY_EDGE_LOW, DAY_EDGE_HIGH, sun)

  // Колокол вокруг горизонта. Считается от высоты солнца, а не от часа, поэтому
  // летом сумерки длинные и пологие, а зимой короткие — сами собой.
  const near = sun / TWILIGHT_WIDTH
  const twilight = Math.exp(-near * near)

  // Утро или вечер. cos суточной дуги равен +1 на рассвете и −1 на закате,
  // значит одна и та же формула отвечает и за оттенок, и за сторону света.
  const eastward = Math.cos(TAU * (day - 0.25))
  const morning = 0.5 + 0.5 * eastward

  const seasonIndex = seasonIndexAt(year)
  const seasonBlend = seasonBlendAt(year)
  const winter = seasonWeightAt(year, 'зима')

  out.sun = sun
  out.daylight = light
  out.twilight = twilight
  out.winter = winter

  // Ключевой свет: ночь → день, затем поверх — низкое солнце.
  mixInto(out.key, KEY_NIGHT, KEY_DAY, light)
  mixInto(scratchWarmKey, KEY_DUSK, KEY_DAWN, morning)
  blendInto(out.key, scratchWarmKey, twilight * TWILIGHT_KEY_TINT)

  out.keyIntensity =
    (lighting.keyNightIntensity +
      (lighting.keyIntensity - lighting.keyNightIntensity) * light) *
    (1 - TWILIGHT_DIM * twilight)

  mixInto(out.fill, FILL_NIGHT, FILL_DAY, light)
  out.fillIntensity =
    lighting.fillNightIntensity +
    (lighting.fillIntensity - lighting.fillNightIntensity) * light

  mixInto(out.ambient, AMBIENT_NIGHT, AMBIENT_DAY, light)
  // Снег возвращает свету половину и заметно поднимает рассеянную составляющую:
  // зимний день светлее летнего в тенях, хотя солнце ниже.
  out.ambientIntensity =
    (lighting.ambientNightIntensity +
      (lighting.ambientIntensity - lighting.ambientNightIntensity) * light) *
    (1 + 0.25 * winter * light)

  // Воздух. Зимняя дымка кладётся последней и только днём: ночью снег ничего не
  // подсвечивает, а светлый туман в темноте выглядел бы протечкой фона.
  mixInto(out.air, AIR_NIGHT, AIR_DAY, light)
  mixInto(scratchWarmAir, AIR_DUSK, AIR_DAWN, morning)
  blendInto(out.air, scratchWarmAir, twilight * TWILIGHT_AIR_TINT)
  blendInto(out.air, AIR_WINTER, winter * light * 0.45)

  out.fogNear = fogRange.near
  out.fogFar = fogRange.farNight + (fogRange.far - fogRange.farNight) * light

  const groundFrom = GROUND[seasonIndex]
  const groundTo = GROUND[(seasonIndex + 1) % GROUND.length]
  mixInto(out.ground, groundFrom, groundTo, seasonBlend)

  out.saturation = saturationAt(tick, startYear)

  // Направление на солнце. Нормируем сами: длина вектора важна — Scene
  // умножает его на вынос источника, от которого зависит охват карты теней.
  const height = SUN_FLOOR + SUN_RISE * (sun > 0 ? sun : 0)
  const x = SUN_EAST * eastward
  const z = SUN_SOUTH
  const length = Math.sqrt(x * x + height * height + z * z)
  out.keyDirection.x = x / length
  out.keyDirection.y = height / length
  out.keyDirection.z = z / length

  // Заливка зеркальна по горизонтали и прижата к земле: подсвечивает ровно те
  // грани, что у ключа в тени. Под карту её класть бессмысленно — снизу
  // освещались бы днища коробок, которых с изометрии не видно.
  const fillHeight = height * FILL_HEIGHT
  const fillLength = Math.sqrt(x * x + fillHeight * fillHeight + z * z)
  out.fillDirection.x = -x / fillLength
  out.fillDirection.y = fillHeight / fillLength
  out.fillDirection.z = -z / fillLength

  return out
}

/**
 * Текущая атмосфера кадра — общий буфер сцены.
 *
 * Пишет в него ровно один хозяин (Scene.tsx, раз в кадр, до отрисовки). Читать
 * может кто угодно: слою карты, которому понадобится «сейчас ночь?» — ночным
 * окнам городов, фарам, зимним обочинам, — не нужно ни повторять расчёт, ни
 * заводить подписку на тик. Та же схема, что у `clock.alpha` в app/loop.ts, и
 * та же причина: величина меняется каждый кадр и нужна только в useFrame.
 *
 * Заполнен сразу, а не нулями: читатель, оказавшийся в кадре раньше Scene,
 * должен получить полночь начала партии, а не чёрный свет и белый туман.
 */
export const atmosphere = atmosphereInto(createAtmosphere(), 0, era.fromYear)
