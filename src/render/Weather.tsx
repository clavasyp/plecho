/**
 * Погода: осадки в воздухе и снежный покров с позёмкой на земле.
 *
 * ЗАЧЕМ. Из §15 концепта: «зимой карта белеет». До этого слоя единственным
 * следом времени года была строчка «зима» в панели времени — карта в январе и в
 * июле выглядела абсолютно одинаково. Погода ничего не решает в симуляции и
 * НЕ ИМЕЕТ ПРАВА её касаться: она меняет картинку и настроение, и весь её вход —
 * это два числа из состояния, tick и startYear.
 *
 * ЧТО ИМЕННО ВИДНО.
 *   • Зимой — снег в воздухе (круглая крупинка, медленное падение, боковое
 *     покачивание) и снежное поле на земле: пятнами в ноябре, сплошным полем в
 *     феврале. Пока идёт снегопад, по полю ползёт позёмка — вытянутые по ветру
 *     струи, которые видно движением, а не цветом.
 *   • Осенью — дождь (косая вытянутая струя вместо крупинки) и дымка, самая
 *     плотная в октябре.
 *   • Весной снег переходит в дождь, летом остаются редкие короткие ливни.
 *   • В ясный день не видно НИЧЕГО и не стоит НИЧЕГО — оба объекта уходят в
 *     visible = false, то есть не попадают даже в список отрисовки.
 *
 * ПОЧЕМУ ЗЕМЛЯ БЕЛЕЕТ, А ДОРОГИ И ГОРОДА — НЕТ. Пелена лежит на уровне
 * layers.ground, а полотно дорог (layers.roadLocal и выше) и площадки городов
 * (layers.cityPad) лежат ВЫШЕ неё и рисуются раньше, поэтому снег до них не
 * достаёт по тесту глубины. Побочный, но самый ценный эффект: на белом поле
 * тёмные пятна городов и нитки трасс наконец читаются с общего плана — зимой
 * карта перестаёт быть проволочной схемой на чёрном.
 *
 * СВОЕЙ ВЫСОТЫ У ПЕЛЕНЫ НЕТ. Она лежит ровно на layers.ground, копланарно
 * подложке, а от Z-конфликта её спасает polygonOffset — сдвиг в буфере глубины,
 * а не в мире. Это принципиально: выдумать себе Y между ground и cityPad значило
 * бы завести второй источник высот мимо layers.ts, а такой разбор в проекте уже
 * был. Ортографической камере polygonOffset подходит идеально: глубина у неё
 * линейная, и сдвиг работает одинаково по всему кадру.
 *
 * ЦВЕТА — ТОЛЬКО ИЗ ПАЛИТРЫ, И ОНИ НЕ СВЕТЯТСЯ. Снег — это palette.text,
 * приглушённый множителем, дождь и дымка — palette.textDim. Множители нужны не
 * для красоты: белое поле во весь экран с яркостью выше postFx.bloomThreshold
 * зацвело бы в блуме и разом сломало стилевой замок «светится только акцент».
 * Худший случай смешения проверяется юнит-тестом (Weather.test.ts), а не глазом.
 *
 * ДВА ОБЪЕКТА, ДВА МАТЕРИАЛА, ДВА ВЫЗОВА ОТРИСОВКИ. Все осадки — один Points на
 * пять тысяч частиц; вся земля — один quad. Ни одного объекта в цикле кадра:
 * фаза погоды считается в заранее выделенный объект, цвет смешивается в заранее
 * выделенный THREE.Color, а кадр правит только числа в uniform-ах.
 *
 * ПОЛЕ ЧАСТИЦ ПРИВЯЗАНО К КАМЕРЕ, А СНЕЖИНКИ — К МИРУ. Коробка с частицами
 * каждый кадр встаёт по центру видимой земли и растягивается по размеру кадра:
 * иначе при зуме ×16 снег остался бы за краями экрана, а на общем плане сыпал бы
 * по пустоте вокруг карты. Чтобы поле при этом не ехало вместе с камерой (снег,
 * приклеенный к экрану, — самый дешёвый вид дешевизны), сдвиг камеры вносится в
 * fract() противоходом: поле периодично по размеру коробки, поэтому снежинки
 * стоят в мировых координатах, а коробка скользит под ними.
 */

import { useEffect, useMemo, useRef } from 'react'
import type { JSX } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useGameStore } from '../app/store'
import { Rng } from '../sim/rng'
import { daysInYear } from '../sim/time'
import { TICKS_PER_DAY } from '../sim/types'
import { layers } from './layers'
import { palette } from './palette'

// ─── Модель погоды ──────────────────────────────────────────────────────────

/**
 * Состояние погоды в момент времени. Все величины — 0..1.
 *
 * Ровно эти четыре числа управляют картинкой. Ни строк, ни перечислений: тип
 * осадков — не переключатель, а `rain`, потому что в марте снег переходит в
 * дождь постепенно, и в переходе форма частицы, скорость падения и цвет обязаны
 * ехать вместе, а не щёлкать.
 */
export type WeatherPhase = {
  /** Плотность осадков: 0 — ясно. */
  intensity: number
  /** Что именно сыпет: 0 — снег, 1 — дождь. */
  rain: number
  /** Снежный покров на земле. */
  cover: number
  /** Дымка. */
  haze: number
}

/**
 * Годовые кривые. Узел на каждый месяц, январь первый; между узлами — плавная
 * интерполяция, на границе года — по кругу.
 *
 * Год считается двенадцатью равными долями, а не календарными месяцами: узел
 * «март» приходится примерно на 27 февраля. Для кривой, по которой тает снег,
 * разница в двое суток не значит ничего, а вот честный календарь потребовал бы
 * разбирать дату каждый кадр.
 */

/**
 * Снежный покров. Февраль — максимум, май-октябрь — голая земля.
 *
 * Спад начинается только с мартовского узла: узлы стоят по равным долям года,
 * поэтому сосед тянет кривую вниз уже с середины предыдущего месяца, и
 * «февраль 1.0, март 0.6» означало бы сход снега в середине февраля.
 */
const COVER_YEAR = [0.92, 1, 0.9, 0.35, 0.03, 0, 0, 0, 0, 0.04, 0.3, 0.7]

/** Доля дождя в осадках. Зима — чистый снег, лето — чистый дождь. */
const RAIN_YEAR = [0, 0, 0.15, 0.6, 0.95, 1, 1, 1, 1, 0.85, 0.4, 0.08]

/** Насколько год мокрый: доля дней с осадками. Осень — самая мокрая. */
const WET_YEAR = [0.5, 0.45, 0.45, 0.4, 0.4, 0.35, 0.3, 0.3, 0.45, 0.62, 0.6, 0.55]

/**
 * Дымка. Октябрь-ноябрь — плотная, середина лета — чистый ноль.
 *
 * Ноль здесь не «поменьше», а именно ноль: пока дымка хоть чуть-чуть больше
 * нуля, пелена остаётся в списке отрисовки и занимает весь экран ради
 * невидимого. Три нулевых узла подряд дают полтора месяца, когда погоды на
 * карте нет вообще.
 */
const HAZE_YEAR = [0.12, 0.1, 0.22, 0.3, 0.12, 0, 0, 0, 0.24, 0.45, 0.4, 0.2]

/**
 * Суточная случайность — две таблицы взаимно простой длины.
 *
 * Погода обязана быть РАЗНОЙ ото дня ко дню, иначе февраль превращается в один
 * бесконечный снегопад, а «выключено» никогда не проверяется на живой карте.
 * Таблицы вместо генератора на лету — потому что фаза считается каждый кадр, а
 * Rng.from() создавал бы объект в цикле кадра. Длины 509 и 251 простые и разные,
 * поэтому пара значений повторяется раз в 127 759 дней, то есть никогда.
 */
const DAY_WET = fillTable(509, 'погода:мокрые дни')
const DAY_FORCE = fillTable(251, 'погода:сила')

function fillTable(size: number, key: string): Float64Array {
  const rng = Rng.forKey(key)
  const table = new Float64Array(size)
  for (let i = 0; i < size; i++) table[i] = rng.float()
  return table
}

/** Плавная ступенька 0..1 — та же, что в smoothstep у GLSL. */
function ease(t: number): number {
  return t * t * (3 - 2 * t)
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/** Значение годовой кривой по доле года 0..1, с замыканием декабря на январь. */
function sampleYear(nodes: readonly number[], yearFraction: number): number {
  const scaled = yearFraction * nodes.length
  const index = Math.floor(scaled)
  const from = nodes[((index % nodes.length) + nodes.length) % nodes.length]
  const to = nodes[((index + 1) % nodes.length + nodes.length) % nodes.length]
  return from + (to - from) * ease(scaled - index)
}

/** Значение суточной таблицы с плавным переходом внутрь суток. */
function sampleDay(table: Float64Array, day: number, fraction: number): number {
  const index = ((day % table.length) + table.length) % table.length
  const next = (index + 1) % table.length
  return table[index] + (table[next] - table[index]) * ease(fraction)
}

/**
 * Погода на момент тика.
 *
 * ЧИСТАЯ ФУНКЦИЯ И БЕЗ ЕДИНОЙ АЛЛОКАЦИИ — она вызывается каждый кадр. Результат
 * пишется в переданный объект; свой создаётся только если его не дали, и это
 * послабление существует ровно для тестов. Рендер обязан передавать свой.
 *
 * Год отматывается тем же daysInYear, что и календарь симуляции: собственного
 * представления о високосных годах здесь нет и быть не должно. Разбирать дату
 * целиком (dateFromTick) не нужно — она создаёт объект, а кривым нужен не месяц,
 * а доля года.
 */
export function sampleWeather(
  tick: number,
  startYear: number,
  out: WeatherPhase = { intensity: 0, rain: 0, cover: 0, haze: 0 },
): WeatherPhase {
  const absoluteDay = Math.floor(tick / TICKS_PER_DAY)
  const dayFraction = tick / TICKS_PER_DAY - absoluteDay

  let dayOfYear = absoluteDay
  let year = startYear
  while (dayOfYear >= daysInYear(year)) {
    dayOfYear -= daysInYear(year)
    year += 1
  }

  const yearFraction = (dayOfYear + dayFraction) / daysInYear(year)

  // День мокрый, когда бросок дня лёг ниже сезонной планки. Не «да/нет», а
  // плавный въезд шириной в четверть броска: иначе дождь включался бы и
  // выключался мгновенно на границе суток.
  const wetness = sampleYear(WET_YEAR, yearFraction)
  const roll = sampleDay(DAY_WET, absoluteDay, dayFraction)
  const wet = clamp01((wetness - roll) * 4)

  const force = 0.45 + 0.55 * sampleDay(DAY_FORCE, absoluteDay, dayFraction)
  const intensity = wet * force
  const rain = sampleYear(RAIN_YEAR, yearFraction)

  out.intensity = intensity
  out.rain = rain
  // Свежий снегопад добавляет покрова сверх сезонной кривой, ливень — дымки.
  out.cover = clamp01(sampleYear(COVER_YEAR, yearFraction) + intensity * (1 - rain) * 0.22)
  out.haze = clamp01(sampleYear(HAZE_YEAR, yearFraction) + intensity * rain * 0.35)
  return out
}

// ─── Цвет и яркость ─────────────────────────────────────────────────────────

/**
 * Множители яркости для цветов из палитры.
 *
 * Не «подобрано на глаз»: palette.text в линейном пространстве даёт яркость
 * около 0.63, то есть ВЫШЕ порога блума (postFx.bloomThreshold = 0.55). Снежное
 * поле во весь экран засветилось бы наравне с фарами и уничтожило бы единственный
 * стилевой замок проекта. Множители опускают худший случай смешения втрое ниже
 * порога — проверяется юнит-тестом, а не доверием.
 */
export const SNOW_TINT = 0.5
export const RAIN_TINT = 0.6
export const MIST_TINT = 0.8

/** Максимальная непрозрачность пелены и осадков — вторая половина того же расчёта. */
export const VEIL_MAX_ALPHA = 0.55
export const FLAKE_MAX_ALPHA = 0.8

const SNOW_COLOR = new THREE.Color(palette.text).multiplyScalar(SNOW_TINT)
const RAIN_COLOR = new THREE.Color(palette.textDim).multiplyScalar(RAIN_TINT)
const MIST_COLOR = new THREE.Color(palette.textDim).multiplyScalar(MIST_TINT)

/**
 * Готовые цвета погоды в линейном пространстве — наружу только для проверки
 * стилевого замка. В uniform-ы уходят их копии, поэтому подкрутить палитру
 * снаружи через этот объект нельзя.
 */
export const WEATHER_COLOR = {
  snow: SNOW_COLOR,
  rain: RAIN_COLOR,
  mist: MIST_COLOR,
} as const

// ─── Поле частиц ────────────────────────────────────────────────────────────

/** Сколько частиц выделено под осадки. Плотность на экране режется uAmount. */
const FLAKES = 5000

/**
 * Запас коробки поверх видимой земли.
 *
 * Видимый кусок земли — прямоугольник, повёрнутый на экране вместе с
 * изометрией. Квадрат со стороной, равной его диагонали, накрывает его при любом
 * повороте камеры, поэтому ширину коробки берём как гипотенузу, а не как
 * максимум из сторон. Остаток — на разброс частиц по высоте.
 */
const SPAN_MARGIN = 1.15

/** Высота коробки в долях её стороны. */
const BOX_HEIGHT = 0.45

/**
 * Скорость падения — оборотов коробки в секунду.
 *
 * Одна высота коробки — это примерно три четверти экрана по вертикали, так что
 * снежинка пересекает кадр секунд за шесть, а капля — за секунду с небольшим.
 * Быстрее снег превращается в помехи на экране, медленнее — висит.
 */
const FALL_SNOW = 0.16
const FALL_RAIN = 0.95

/** Боковой снос — долей коробки в секунду. */
const WIND_SNOW = 0.018
const WIND_RAIN = 0.09

/**
 * Период накопителя фазы падения.
 *
 * Фаза копится по модулю 64, а не по модулю 1, ровно потому, что у каждой
 * частицы свой множитель скорости. Множители заданы кратными 1/64 (см. сборку
 * буфера), поэтому в точке сброса uFall·aSpeed оказывается целым для КАЖДОЙ
 * частицы, а fract() от целого равен fract(0). Сброс проходит без единого
 * скачка; при произвольном множителе весь снег дёргался бы раз в минуту.
 */
const FALL_WRAP = 64

/** Базовый размер частицы в пикселях кадра. */
const FLAKE_PIXELS = 3.6

/**
 * Пороги, ниже которых объект не рисуется вовсе.
 *
 * Разные для трёх величин, потому что видимость у них наступает в разных
 * точках. Снежное поле проступает пятнами только когда покров перебивает
 * верхушки шума — до 0.1 на экране не появляется ни одного пикселя, а
 * полноэкранный quad считается честно. Дымка при 0.03 даёт непрозрачность на
 * грани отбрасывания фрагмента. Осадки при 0.02 — это сотня частиц из пяти
 * тысяч.
 */
export const WEATHER_MIN = {
  intensity: 0.02,
  cover: 0.1,
  haze: 0.03,
} as const

/** Потолок кадрового шага — защита от рывка после свёрнутой вкладки. */
const MAX_DELTA = 0.05

/** Скорость позёмки и дымки по земле, км реального времени в секунду. */
const DRIFT_SPEED = 26
const MIST_SPEED = 5

/**
 * Потолок накопителей по земле, км.
 *
 * Позёмка и дымка сдвигают шум в мировых координатах, а шум по построению
 * непериодичен — точки, где сброс прошёл бы незаметно, не существует. Поэтому
 * накопитель обнуляется в тот момент, когда эффект и так невидим (см. кадр), а
 * этот потолок — только страховка на случай многочасового непрерывного бурана.
 */
const GROUND_WRAP = 200_000

/**
 * Освещение погоды теми же источниками, что и вся сцена.
 *
 * Снег обязан жить под тем же солнцем, что и земля под ним. Без этого зимняя
 * ночь выглядела бы ярче зимнего полудня: пелена рисуется поверх подложки, и
 * неосвещённое белое поле просто заливает кадр, сколько бы света ни осталось в
 * сцене. Поэтому оба материала объявляют lights = true и считают освещённость
 * плоской земли сами.
 *
 * Структура света объявляется вручную, а не через chunk lights_pars_begin: имена
 * и порядок полей у DirectionalLight в three именно такие, а тянуть весь chunk
 * значило бы притащить объявления теней и зондов, которых здесь нет и не нужно.
 * Uniform-ы, которых нет в программе, рендерер просто не заполняет.
 *
 * Направления источников приходят В КООРДИНАТАХ КАМЕРЫ — так их готовит
 * WebGLLights, — поэтому нормаль земли тоже переводится в них, через normalMatrix.
 *
 * Освещённость зажата снизу и сверху. Снизу — потому что ночью снег не чёрный:
 * он собирает и небо, и огни. Сверху — потому что потолок в единицу делает
 * проверку стилевого замка честной: как бы ни выкрутили солнце, яркость снега не
 * может превысить его собственный цвет, а тот заведомо ниже порога блума.
 */
const LIGHTS_GLSL = /* glsl */ `
  uniform vec3 ambientLightColor;

  #if NUM_DIR_LIGHTS > 0
    struct DirectionalLight {
      vec3 direction;
      vec3 color;
    };
    uniform DirectionalLight directionalLights[NUM_DIR_LIGHTS];
  #endif

  const float NIGHT_FLOOR = 0.16;
  const float INV_PI = 0.31830988;

  vec3 daylight(vec3 normal) {
    vec3 irradiance = ambientLightColor;

    #if NUM_DIR_LIGHTS > 0
      for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
        irradiance += directionalLights[i].color *
          max(dot(normal, directionalLights[i].direction), 0.0);
      }
    #endif

    return clamp(irradiance * INV_PI, vec3(NIGHT_FLOOR), vec3(1.0));
  }
`

const FLAKE_VERTEX = /* glsl */ `
  uniform float uFall;
  uniform float uWind;
  uniform float uSway;
  uniform float uAmount;
  uniform float uRain;
  uniform vec2 uOrigin;
  uniform float uSize;
  uniform float uPixels;

  attribute float aRank;
  attribute float aSpeed;
  attribute float aSize;

  varying float vFogDepth;
  varying vec3 vUp;

  void main() {
    // Нормаль земли в координатах камеры — она же нормаль для освещения
    // частицы. Снежинка вертится в полёте всеми гранями, и любая другая нормаль
    // была бы такой же условностью, но не совпадала бы с землёй под ней.
    vUp = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));

    // Частицы сверх текущей плотности уходят за дальнюю плоскость отсечения:
    // это дешевле любого ветвления в отрисовке и не стоит ни одного фрагмента.
    if (aRank > uAmount) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }

    float drop = fract(position.y - uFall * aSpeed);
    float sway = sin(uSway + position.z * 37.0) * 0.012 * (1.0 - uRain);
    float x = fract(position.x + uOrigin.x + uWind + sway);
    float z = fract(position.z + uOrigin.y);

    vec4 world = modelMatrix * vec4(x - 0.5, drop, z - 0.5, 1.0);
    vec4 eye = viewMatrix * world;
    vFogDepth = -eye.z;

    gl_Position = projectionMatrix * eye;
    gl_PointSize = uSize * aSize * uPixels * mix(1.0, 3.5, uRain);
  }
`

const FLAKE_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uRain;
  uniform vec3 fogColor;
  uniform float fogNear;
  uniform float fogFar;

  varying float vFogDepth;
  varying vec3 vUp;

  ${LIGHTS_GLSL}

  void main() {
    // Одна форма на оба вида осадков: круг при uRain = 0 и вытянутая косая
    // струя при uRain = 1. Промежуточные значения дают мокрый снег сами собой.
    vec2 c = gl_PointCoord - 0.5;
    c.y = -c.y;
    c.x -= c.y * uRain * 0.3;
    float shape = length(vec2(c.x * mix(1.0, 5.0, uRain), c.y));
    float alpha = (1.0 - smoothstep(0.22, 0.5, shape)) * uOpacity;

    float fog = smoothstep(fogNear, fogFar, vFogDepth);
    alpha *= 1.0 - fog;
    if (alpha < 0.004) discard;

    gl_FragColor = vec4(mix(uColor * daylight(vUp), fogColor, fog), alpha);
  }
`

const VEIL_VERTEX = /* glsl */ `
  varying vec2 vGround;
  varying vec2 vLocal;
  varying float vFogDepth;
  varying vec3 vUp;

  void main() {
    vUp = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));

    vec4 world = modelMatrix * vec4(position, 1.0);
    vGround = world.xz;
    // Геометрия уже развёрнута в плоскость XZ, поэтому локальные координаты
    // квадрата лежат в x и z, а не в x и y.
    vLocal = position.xz;

    vec4 eye = viewMatrix * world;
    vFogDepth = -eye.z;
    gl_Position = projectionMatrix * eye;
  }
`

const VEIL_FRAGMENT = /* glsl */ `
  uniform float uCover;
  uniform float uDrift;
  uniform float uHaze;
  uniform float uDriftShift;
  uniform float uMistShift;
  uniform vec3 uSnow;
  uniform vec3 uMist;
  uniform float uSnowAlpha;
  uniform float uMistAlpha;
  uniform vec3 fogColor;
  uniform float fogNear;
  uniform float fogFar;

  varying vec2 vGround;
  varying vec2 vLocal;
  varying float vFogDepth;
  varying vec3 vUp;

  ${LIGHTS_GLSL}

  /** Размер снежного пятна, км. Крупные поля, а не рябь. */
  const float SNOW_PATCH = 110.0;
  /** Длина струи позёмки, км, и её сплющенность поперёк ветра. */
  const float DRIFT_SCALE = 45.0;
  const float DRIFT_SQUEEZE = 4.0;
  /** Размер клока дымки, км. */
  const float MIST_SCALE = 160.0;

  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float vnoise(vec2 p) {
    vec2 cell = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(cell);
    float b = hash21(cell + vec2(1.0, 0.0));
    float c = hash21(cell + vec2(0.0, 1.0));
    float d = hash21(cell + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  /**
   * Три октавы, а не пять. Октавы нужны затем, чтобы пятно читалось и на общем
   * плане, и при зуме ×16; каждая следующая стоит полного разбора шума на
   * пиксель, а пелена занимает весь экран.
   */
  float fbm(vec2 p) {
    return vnoise(p) * 0.55
      + vnoise(p * 2.17 + 19.3) * 0.3
      + vnoise(p * 4.63 + 7.1) * 0.15;
  }

  void main() {
    float snow = 0.0;
    float mist = 0.0;

    // Ветвление по uniform-у, то есть одинаковое для всего кадра: в ясный день
    // шум не считается вообще, а не считается и умножается на ноль.
    if (uCover > 0.001) {
      float field = fbm(vGround / SNOW_PATCH);
      // Планка опускается вместе с покровом: сначала снег лежит отдельными
      // пятнами, к февралю смыкается в поле. Не до нуля: при полностью снятой
      // планке поле выходит ровной заливкой на весь экран, а ровная заливка —
      // это уже не снег, а засветка.
      float edge = 0.95 - uCover * 0.8;
      snow = smoothstep(edge, edge + 0.3, field);
      // Даже сомкнувшееся поле держит собственный рельеф: наметённое гуще,
      // выдутое реже. Иначе зимняя карта теряет фактуру целиком.
      snow *= 0.6 + 0.55 * field;

      if (uDrift > 0.001) {
        vec2 g = vec2(vGround.x - uDriftShift, vGround.y * DRIFT_SQUEEZE) / DRIFT_SCALE;
        snow += smoothstep(0.45, 0.8, fbm(g)) * uDrift * 0.6;
      }

      snow = clamp(snow, 0.0, 1.0);
    }

    if (uHaze > 0.001) {
      vec2 m = (vGround + vec2(uMistShift, uMistShift * 0.4)) / MIST_SCALE;
      mist = smoothstep(0.3, 0.8, fbm(m)) * uHaze;
    }

    float snowA = snow * uSnowAlpha;
    float mistA = mist * uMistAlpha;
    float alpha = clamp(snowA + mistA, 0.0, 1.0);

    float fog = smoothstep(fogNear, fogFar, vFogDepth);
    // Мягкий край квадрата. При запасе SPAN_MARGIN он и так за кадром — это
    // страховка на предельных углах камеры, а не элемент картинки.
    float edgeFade = 1.0 - smoothstep(0.4, 0.5, max(abs(vLocal.x), abs(vLocal.y)));
    alpha *= (1.0 - fog) * edgeFade;
    if (alpha < 0.004) discard;

    vec3 color = mix(uSnow, uMist, mistA / max(snowA + mistA, 0.0001));
    gl_FragColor = vec4(mix(color * daylight(vUp), fogColor, fog), alpha);
  }
`

type Kit = {
  flakes: THREE.BufferGeometry
  flakeMaterial: THREE.ShaderMaterial
  veil: THREE.BufferGeometry
  veilMaterial: THREE.ShaderMaterial
  dispose: () => void
}

/**
 * Геометрия и материалы. Собираются один раз за жизнь компонента.
 *
 * Императивно, а не декларативными <bufferAttribute/>: uniform-ы нужны кадру по
 * ссылке, и держать их через ref материала значило бы каждый кадр ходить за
 * ними через две проверки на null.
 */
function buildKit(): Kit {
  const rng = Rng.forKey('погода:поле')

  const seeds = new Float32Array(FLAKES * 3)
  const ranks = new Float32Array(FLAKES)
  const speeds = new Float32Array(FLAKES)
  const sizes = new Float32Array(FLAKES)

  for (let i = 0; i < FLAKES; i++) {
    seeds[i * 3] = rng.float()
    seeds[i * 3 + 1] = rng.float()
    seeds[i * 3 + 2] = rng.float()
    // Ранг равномерен по индексу, а сиды случайны — поэтому отсечение по рангу
    // прореживает поле равномерно, а не выедает из него угол.
    ranks[i] = i / (FLAKES - 1)
    // Скорость строго кратна 1/64 — этого требует бесшовный сброс фазы падения,
    // разбор у FALL_WRAP.
    speeds[i] = rng.int(48, 88) / 64
    sizes[i] = 0.55 + rng.float() * 0.9
  }

  const flakes = new THREE.BufferGeometry()
  flakes.setAttribute('position', new THREE.BufferAttribute(seeds, 3))
  flakes.setAttribute('aRank', new THREE.BufferAttribute(ranks, 1))
  flakes.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1))
  flakes.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))

  const flakeMaterial = new THREE.ShaderMaterial({
    vertexShader: FLAKE_VERTEX,
    fragmentShader: FLAKE_FRAGMENT,
    // UniformsLib.fog и .lights обязательны: рендерер заливает fogColor и
    // параметры источников только в те uniform-ы, которые уже объявлены
    // материалом, — иначе осадки остались бы единственным слоем сцены, который
    // не растворяет туман и не касается солнце.
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      THREE.UniformsLib.lights,
      {
        uFall: { value: 0 },
        uWind: { value: 0 },
        uSway: { value: 0 },
        uAmount: { value: 0 },
        uRain: { value: 0 },
        uOrigin: { value: new THREE.Vector2() },
        uSize: { value: FLAKE_PIXELS },
        uPixels: { value: 1 },
        uColor: { value: SNOW_COLOR.clone() },
        uOpacity: { value: 0 },
      },
    ]),
    transparent: true,
    depthWrite: false,
    fog: true,
    lights: true,
  })

  // Плоскость сразу кладётся в XZ: поворот в матрице объекта конфликтовал бы с
  // покадровым масштабированием коробки, а так объект правит только position и
  // scale.
  const veil = new THREE.PlaneGeometry(1, 1)
  veil.rotateX(-Math.PI / 2)

  const veilMaterial = new THREE.ShaderMaterial({
    vertexShader: VEIL_VERTEX,
    fragmentShader: VEIL_FRAGMENT,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      THREE.UniformsLib.lights,
      {
        uCover: { value: 0 },
        uDrift: { value: 0 },
        uHaze: { value: 0 },
        uDriftShift: { value: 0 },
        uMistShift: { value: 0 },
        uSnow: { value: SNOW_COLOR.clone() },
        uMist: { value: MIST_COLOR.clone() },
        uSnowAlpha: { value: VEIL_MAX_ALPHA },
        uMistAlpha: { value: VEIL_MAX_ALPHA * 0.8 },
      },
    ]),
    transparent: true,
    depthWrite: false,
    fog: true,
    lights: true,
    // Пелена копланарна подложке: своей высоты у неё нет (разбор в шапке), и от
    // Z-конфликта её выносит сдвиг в буфере глубины.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  })

  return {
    flakes,
    flakeMaterial,
    veil,
    veilMaterial,
    dispose: () => {
      flakes.dispose()
      flakeMaterial.dispose()
      veil.dispose()
      veilMaterial.dispose()
    },
  }
}

/** Направление камеры. Заведено один раз снаружи кадра и только мутируется. */
const forward = new THREE.Vector3()

export function Weather(): JSX.Element {
  const flakesRef = useRef<THREE.Points>(null)
  const veilRef = useRef<THREE.Mesh>(null)

  const kit = useMemo(buildKit, [])
  useEffect(() => kit.dispose, [kit])

  /** Живая фаза погоды. Объект один на всё время жизни компонента. */
  const phase = useRef<WeatherPhase>({
    intensity: 0,
    rain: 0,
    cover: 0,
    haze: 0,
  })

  /**
   * Накопители анимации. Реальное время, а не игровое: на паузе мир замирает, а
   * снег продолжает идти — стоящий кадр не должен выглядеть скриншотом.
   */
  const motion = useRef({ fall: 0, wind: 0, sway: 0, drift: 0, mist: 0 })

  useFrame((state, delta) => {
    const flakes = flakesRef.current
    const veil = veilRef.current
    if (flakes === null || veil === null) return

    const game = useGameStore.getState().state
    const now = sampleWeather(game.tick, game.startYear, phase.current)

    const drift = now.cover * now.intensity * (1 - now.rain)
    const showFlakes = now.intensity > WEATHER_MIN.intensity
    const showVeil =
      now.cover > WEATHER_MIN.cover || now.haze > WEATHER_MIN.haze

    flakes.visible = showFlakes
    veil.visible = showVeil

    // Ясный день не стоит ничего: ни объектов в списке отрисовки, ни счёта
    // геометрии кадра. Накопители по земле обнуляются именно здесь — сброс
    // невидимого шума единственный, который не видно (разбор у GROUND_WRAP).
    if (!showFlakes && !showVeil) {
      motion.current.drift = 0
      motion.current.mist = 0
      return
    }

    const step = delta < MAX_DELTA ? delta : MAX_DELTA
    const move = motion.current

    const camera = state.camera as THREE.OrthographicCamera
    camera.getWorldDirection(forward)
    // Полярный угол ограничен контролами 75 градусами, так что взгляд всегда
    // идёт вниз; зажим — страховка от деления на ноль, а не рабочий режим.
    const descent = forward.y < -0.2 ? forward.y : -0.2
    const reach = -camera.position.y / descent
    const centerX = camera.position.x + forward.x * reach
    const centerZ = camera.position.z + forward.z * reach

    const acrossX = (camera.right - camera.left) / camera.zoom
    // Вертикаль экрана ложится на землю тем длиннее, чем ниже камера над
    // горизонтом: делим на синус угла подъёма, он же -forward.y.
    const acrossZ = (camera.top - camera.bottom) / camera.zoom / -descent
    const span = Math.hypot(acrossX, acrossZ) * SPAN_MARGIN

    if (showFlakes) {
      const u = kit.flakeMaterial.uniforms

      move.fall = (move.fall + step * (FALL_SNOW + (FALL_RAIN - FALL_SNOW) * now.rain)) % FALL_WRAP
      move.wind = (move.wind + step * (WIND_SNOW + (WIND_RAIN - WIND_SNOW) * now.rain)) % 1
      move.sway = (move.sway + step * 1.7) % (Math.PI * 2)

      flakes.position.set(centerX, 0, centerZ)
      flakes.scale.set(span, span * BOX_HEIGHT, span)

      // Поле периодично по стороне коробки, поэтому сдвиг камеры, внесённый
      // противоходом, оставляет снежинки стоять в мировых координатах.
      u.uOrigin.value.set(-(centerX / span) % 1, -(centerZ / span) % 1)
      u.uFall.value = move.fall
      u.uWind.value = move.wind
      u.uSway.value = move.sway
      u.uAmount.value = now.intensity
      u.uRain.value = now.rain
      u.uOpacity.value = FLAKE_MAX_ALPHA * (0.45 + 0.55 * now.intensity)
      u.uPixels.value = state.gl.getPixelRatio()
      u.uColor.value.lerpColors(SNOW_COLOR, RAIN_COLOR, now.rain)
    }

    if (showVeil) {
      const u = kit.veilMaterial.uniforms

      move.drift = (move.drift + step * DRIFT_SPEED * drift) % GROUND_WRAP
      move.mist = (move.mist + step * MIST_SPEED) % GROUND_WRAP

      veil.position.set(centerX, layers.ground, centerZ)
      veil.scale.set(span, 1, span)

      u.uCover.value = now.cover
      u.uDrift.value = drift
      u.uHaze.value = now.haze
      u.uDriftShift.value = move.drift
      u.uMistShift.value = move.mist
    }
  })

  /**
   * ДЕВ-ХУК: что именно сейчас на экране.
   *
   * Отвечает не модель погоды, а живые объекты сцены — visible снимается с них,
   * а не с расчёта. Ровно это и требуется доказать сквозным тестом: слой не
   * просто посчитан, а смонтирован и виден (или честно погашен). Проверять
   * погоду снимками пикселей нельзя: зерно постпроцессинга меняет каждый кадр.
   *
   * В продакшен-сборке ветка вырезается целиком.
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return

    const dev = globalThis as unknown as { __plechoWeather?: unknown }

    dev.__plechoWeather = () => ({
      intensity: phase.current.intensity,
      rain: phase.current.rain,
      cover: phase.current.cover,
      haze: phase.current.haze,
      /** Что сыпет — словом, для читаемости отчёта теста. */
      kind:
        phase.current.intensity <= WEATHER_MIN.intensity
          ? 'ясно'
          : phase.current.rain > 0.5
            ? 'дождь'
            : 'снег',
      /** Осадки в списке отрисовки. */
      flakes: flakesRef.current?.visible ?? false,
      /** Земля в списке отрисовки. */
      veil: veilRef.current?.visible ?? false,
      /** Сколько частиц выделено под осадки всего. */
      capacity: FLAKES,
    })

    return () => {
      delete dev.__plechoWeather
    }
  }, [])

  return (
    <group>
      {/*
        Отсечение по пирамиде видимости выключено у обоих объектов: их положение
        и размер задаются кадром, а границы геометрии остаются от единичного
        куба сидов и единичного квадрата — three отбросил бы погоду целиком.
      */}
      <points
        ref={flakesRef}
        geometry={kit.flakes}
        material={kit.flakeMaterial}
        frustumCulled={false}
      />
      {/*
        Порядок отрисовки задан явно, и это не перестраховка. Оба объекта стоят
        в одной точке — по центру видимой земли, — а прозрачные тела рендерер
        сортирует по расстоянию до камеры и при равенстве разрешает ничью по
        внутреннему номеру объекта. Номер зависит от порядка монтирования, то
        есть от порядка строк ниже: без renderOrder пелена рисовалась бы ПОВЕРХ
        падающего снега и притушивала бы каждую снежинку собственной
        полупрозрачностью. Земля обязана лечь первой.
      */}
      <mesh
        ref={veilRef}
        geometry={kit.veil}
        material={kit.veilMaterial}
        frustumCulled={false}
        renderOrder={-1}
      />
    </group>
  )
}
