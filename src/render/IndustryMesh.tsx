/**
 * Предприятия на карте.
 *
 * Города дают спрос, дороги — расстояние, а предприятия дают ПРИЧИНУ ехать. На
 * карте они обязаны отвечать на два вопроса без единой подписи: что это за завод
 * и работает ли он прямо сейчас. Второй вопрос важнее первого — игрок смотрит на
 * карту не любоваться силуэтами, а искать узкое место своей сети.
 *
 * ПЕРВОЕ. ТИП ЧИТАЕТСЯ СИЛУЭТОМ, А НЕ ЦВЕТОМ И НЕ ЗНАЧКОМ. Шесть типов — это
 * шесть узнаваемых наборов примитивов. Цвет для типа не годится: он уже занят
 * состоянием, а палитра проекта холодная и различать в ней шесть оттенков
 * невозможно. Значок-иконка не годится тем более — она не масштабируется вместе
 * с картой и превращает диораму в интерфейс.
 *
 * У КАЖДОГО ТИПА ЕСТЬ ОДНА ДЕТАЛЬ, КОТОРОЙ НЕТ БОЛЬШЕ НИ У КОГО, — и она
 * подобрана так, чтобы пережить расстояние. Общий план съедает мелочь первой,
 * поэтому опознавательный знак у каждого крупный и вынесен вверх:
 *
 *   элеватор      — ряд из шести банок, накрытый ГАЛЕРЕЕЙ во всю длину;
 *   мукомольный   — те же банки, но их ровно две и они под общей перемычкой,
 *                   а пятно квадратное: это переработка, а не хранение;
 *   ЦБК           — самая высокая труба на карте плюс вторая пониже рядом;
 *   лесозаготовка — всё плоское, и над штабелями стоит КОЗЛОВОЙ КРАН: буква «П»,
 *                   которой нет ни на одной другой площадке;
 *   нефтебаза     — четыре ЛЕЖАЩИЕ сосиски и два стоячих барабана: сплошная
 *                   круглая геометрия там, где у лесозаготовки сплошные ящики;
 *   НПЗ           — раструб градирни рядом с ТОНКОЙ ФАКЕЛЬНОЙ СВЕЧОЙ. Контраст
 *                   «широкое и узкое рядом» читается даже размытым пятном.
 *
 * Раньше лесозаготовка и нефтебаза различались только тем, что у одной ящики, а
 * у другой цилиндры; на общем плане обе были одинаковыми плоскими кляксами.
 * Кран и барабаны разводят их по высоте и по массе.
 *
 * ВТОРОЕ, ГЛАВНОЕ. СОСТОЯНИЕ ПОКАЗАНО ДВУМЯ КАНАЛАМИ.
 *
 *   Тон корпусов — аналоговый канал. Загрузка 0..1 гонит цвет предприятия от
 *   buildingLow к buildingHigh: работающий завод «освещён», встающий гаснет и
 *   сползает по тону к рельефу. Канал непрерывный намеренно — производство в
 *   economy/production.ts тоже режет темп ПРОПОРЦИОНАЛЬНО дефициту, и рендер
 *   обязан показывать приближение к краю, а не только сам обрыв.
 *
 *   Ограда площадки — заметный канал. Она уходит в accentDim тем сильнее, чем
 *   ближе предприятие к остановке, и у вставшего завода становится ржавым
 *   прямоугольником вокруг площадки.
 *
 * ПОЧЕМУ ОСТАНОВКА — ОРАНЖЕВАЯ, А НЕ КРАСНАЯ. Красного в палитре нет, и заводить
 * его нельзя: расширение палитры ломает стилевой замок быстрее любой другой
 * ошибки. Но акцент здесь и не подменяет собой красный. В этой игре оранжевый
 * значит не «опасность», а «ДЕЛО ТРАНСПОРТА»: им горят машины, им же
 * подсвечивается город под курсором. Задохнувшийся завод — ровно такое же дело
 * транспорта, только ещё не сделанное, и он берёт тот же цвет по той же причине.
 *
 * ПОЧЕМУ ОГРАДА, А НЕ ВСЯ ПЛОЩАДКА. Соблазн залить оранжевым весь прямоугольник
 * велик — с изометрии земля видна лучше всего. Но десять километров сплошного
 * акцента перекричали бы на общем плане единственный по-настоящему важный
 * оранжевый объект, машину, и замок сломался бы не цветом, а площадью. Ограда
 * даёт ту же однозначность при доле площади.
 *
 * И ничто здесь НЕ СВЕТИТСЯ: emissive у всех трёх материалов нулевой, ржавый
 * прямоугольник — просто освещённая холодным светом краска. Светятся по-прежнему
 * только машины, и на карте их по-прежнему видно первыми.
 *
 * ТРЕТЬЕ. МЕСТО ДЕТЕРМИНИРОВАНО. Смещение от центра города считается от
 * `Rng.forKey(industry.id)`: Math.random дал бы предприятию новое место на каждом
 * ререндере, а в StrictMode — ещё и дважды при монтировании. Направление
 * выбирается лучшим из нескольких кандидатов, как места под здания в CityMesh, но
 * с другой мерой: кандидат тем лучше, чем дальше он от дорог, выходящих из города,
 * и от уже поставленных предприятий того же города. Завод, севший верхом на М-2,
 * читается как ошибка отрисовки, а не как завод у трассы.
 *
 * ЧЕТВЁРТОЕ. ТРИ InstancedMesh НА ВСЮ ПРОМЫШЛЕННОСТЬ: коробки, цилиндры, конусы.
 * Предприятий десяток, деталей в каждом до десяти, плюс площадка и четыре звена
 * ограды — под две сотни примитивов, то есть под две сотни вызовов отрисовки при
 * наивной сборке. Здесь их три, и это число не изменится ни от новых деталей в
 * силуэтах, ни когда карта вырастет за пределы ЦФО: усиление силуэта стоит
 * инстансов, а не вызовов.
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { JSX } from 'react'
import { useFrame } from '@react-three/fiber'
import { Color, Matrix4, Quaternion, Vector3 } from 'three'
import type { InstancedMesh } from 'three'
import { useShallow } from 'zustand/shallow'

import { useGameStore } from '../app/store'
import type { GameStore } from '../app/store'
import { IDLE_UTILIZATION } from '../sim/economy/production'
import { Rng } from '../sim/rng'
import type { CityId, GameState, IndustryId, IndustryType } from '../sim/types'
import { cityPadReach, cityPoint } from './CityMesh'
import { layers } from './layers'
import { palette } from './palette'

// ─── Форма предприятия ─────────────────────────────────────────────────────

/**
 * Деталь площадки в её собственных осях, километры.
 *
 * Ось X — вдоль площадки, Z — поперёк, начало координат в центре. Три вида тел
 * покрывают всю промышленность округа: коробка (корпус, склад, штабель),
 * цилиндр (банка элеватора, колонна, лежащий резервуар) и усечённый конус
 * (градирня и труба — оба сужаются кверху, и именно этим читаются).
 */
export type Part =
  | {
      kind: 'коробка'
      x: number
      z: number
      width: number
      depth: number
      height: number
      /**
       * Низ коробки над площадкой, км. Ноль — стоит на земле.
       *
       * Заведено ради трёх деталей, без которых силуэты не расходятся: галереи
       * элеватора, перемычки мукомольного и балки козлового крана. Все три —
       * горизонтальные тела, ПОДНЯТЫЕ над землёй, и без этого поля их пришлось бы
       * рисовать стоящими на грунте, то есть не рисовать вовсе.
       */
      base?: number
    }
  | {
      kind: 'цилиндр'
      x: number
      z: number
      radius: number
      height: number
      /** Резервуар на боку: ось лежит вдоль X, высота силуэта — диаметр. */
      lying?: boolean
    }
  | { kind: 'конус'; x: number; z: number; radius: number; height: number }

export type Site = {
  /** Габарит площадки вдоль X, км. */
  length: number
  /** Габарит площадки поперёк, км. */
  width: number
  parts: readonly Part[]
}

const box = (
  x: number,
  z: number,
  width: number,
  depth: number,
  height: number,
  base = 0,
): Part => ({ kind: 'коробка', x, z, width, depth, height, base })

/** Стоящее тело вращения: банка, силос, колонна. */
const silo = (x: number, z: number, radius: number, height: number): Part => ({
  kind: 'цилиндр',
  x,
  z,
  radius,
  height,
})

/** Лежащий резервуар. `length` — вдоль оси X площадки. */
const tank = (x: number, z: number, radius: number, length: number): Part => ({
  kind: 'цилиндр',
  x,
  z,
  radius,
  height: length,
  lying: true,
})

/** Сужающееся кверху тело: труба или градирня. */
const stack = (x: number, z: number, radius: number, height: number): Part => ({
  kind: 'конус',
  x,
  z,
  radius,
  height,
})

/**
 * Габариты — километры, то есть заведомо неправдоподобные, ровно как у машин в
 * VehicleMesh.
 *
 * Настоящий элеватор — полсотни метров, на карте шириной 600 км это меньше
 * пикселя. Масштаб выбран из читаемости: площадка в 8–11 км при радиусе
 * застройки среднего города в 6–8 км — это спутник, который явно меньше города,
 * но различим по силуэту уже на среднем зуме (примерно с четырёхкратного, где
 * километр даёт около семи пикселей). Высоты того же порядка, что у застройки:
 * труба ЦБК в 6.9 км сопоставима с пиком областного центра в 5–7 км и потому
 * читается как доминанта окрестности, а не как игла до неба.
 */
export const SITES: Record<IndustryType, Site> = {
  // Ряд одинаковых банок под общей галереей — самый узнаваемый силуэт из всех
  // шести, его ни с чем не спутать даже размытым. Галерея важнее самих банок:
  // она сшивает шесть отдельных цилиндров в ОДНО длинное тело, и издалека
  // элеватор читается сплошной планкой на ножках, а не крупой из точек. Рабочая
  // башня сбоку выше банок: у настоящего элеватора именно она принимает и
  // распределяет зерно.
  'элеватор': {
    length: 10.6,
    width: 4.6,
    parts: [
      silo(-3.1, 0, 0.6, 3.4),
      silo(-1.86, 0, 0.6, 3.4),
      silo(-0.62, 0, 0.6, 3.4),
      silo(0.62, 0, 0.6, 3.4),
      silo(1.86, 0, 0.6, 3.4),
      silo(3.1, 0, 0.6, 3.4),
      box(0, 0, 7, 0.85, 0.5, 3.4),
      box(-4.4, 0, 1.7, 2.4, 5),
    ],
  },

  // Компактный корпус с парой силосов. Намеренно похож на элеватор деталями и
  // непохож пропорциями: там длинный ряд из шести, здесь ровно два цилиндра под
  // короткой перемычкой на квадратном пятне. Это и есть разница между хранением
  // и переработкой, показанная планом, а не подписью.
  'мукомольный': {
    length: 8.2,
    width: 5.2,
    parts: [
      box(0.9, 0, 3.6, 2.8, 2.6),
      silo(-2.2, -0.85, 0.66, 3.9),
      silo(-2.2, 0.85, 0.66, 3.9),
      box(-2.2, 0, 1.6, 2.4, 0.45, 3.9),
      box(3.3, -1.3, 1.2, 1.2, 1.5),
    ],
  },

  // Длинный корпус и труба выше всего вокруг. Труба вынесена к краю площадки:
  // стоя в середине, она сливалась бы с корпусом в один столб. Вторая труба
  // пониже рядом — не украшение: одинокая вертикаль есть у половины карты, а
  // ПАРА разновысоких труб не встречается больше нигде. Штабель брёвен у
  // ограды договаривает, что сюда возят лес.
  'ЦБК': {
    length: 10.8,
    width: 6,
    parts: [
      box(-0.9, 0, 5.2, 3.2, 2.3),
      box(3.2, -0.7, 2.4, 2, 1.6),
      stack(-3.4, 1.7, 0.46, 6.9),
      stack(-2.2, 2.2, 0.34, 4.2),
      box(2.6, 2.2, 3.2, 1, 0.8),
    ],
  },

  // Всё низкое и плоское: делянка — это не завод, и она обязана отличаться от
  // соседей высотой силуэта раньше, чем формой. Три штабеля вдоль, два поперёк,
  // будка — и КОЗЛОВОЙ КРАН над штабелями. Кран здесь несёт всю работу
  // опознания: две стойки с балкой дают контур «П», которого нет ни на одной
  // другой площадке, и он поднимает делянку над остальными плоскими телами
  // ровно настолько, чтобы её было видно, но не настолько, чтобы она перестала
  // читаться как низкая.
  'лесозаготовка': {
    length: 9.6,
    width: 7,
    parts: [
      box(-1.6, -2.3, 3.4, 1.05, 0.95),
      box(-1.6, -0.9, 3.4, 1.05, 0.95),
      box(-1.6, 0.5, 3.4, 1.05, 0.95),
      box(-1.9, 1.95, 2.8, 1.05, 0.9),
      box(2, -1.3, 1.05, 2.6, 0.85),
      box(2, 1.3, 1.05, 2.6, 0.85),
      box(3.9, 2.4, 1.1, 1.1, 1.6),
      box(-3.6, -2.6, 0.34, 0.34, 2.5),
      box(-3.6, 2.6, 0.34, 0.34, 2.5),
      box(-3.6, 0, 0.34, 5.6, 0.4, 2.4),
    ],
  },

  // Четыре лежащих резервуара плюс два стоячих барабана. С изометрии это
  // параллельные «сосиски» и пара шайб — сплошная круглая геометрия, и именно
  // ею нефтебаза отличается от лесозаготовки, у которой сплошные ящики той же
  // высоты. Второе отличие, от НПЗ: хранение ЛЕЖИТ, переработка стоит.
  'нефтебаза': {
    length: 10.4,
    width: 8,
    parts: [
      tank(-1.2, -2.85, 0.85, 4.6),
      tank(-1.2, -0.95, 0.85, 4.6),
      tank(-1.2, 0.95, 0.85, 4.6),
      tank(-1.2, 2.85, 0.85, 4.6),
      silo(3.2, -2, 1.35, 2.4),
      silo(3.2, 2, 1.35, 2.4),
      box(3.3, 0, 1.4, 1.4, 1.5),
    ],
  },

  // Куст тонких колонн, раструб градирни и факельная свеча. Градирня —
  // единственное расширяющееся книзу тело на всей карте, свеча — самое тонкое и
  // высокое. Стоят они РЯДОМ намеренно: пара «широкое и узкое» опознаётся
  // мгновенно и переживает любое расстояние, тогда как каждая деталь по
  // отдельности на общем плане теряется.
  'НПЗ': {
    length: 11.6,
    width: 7,
    parts: [
      stack(-3.9, 0, 1.75, 4.4),
      stack(-1.5, -2.2, 0.3, 6.2),
      silo(0.3, -1.15, 0.4, 5.7),
      silo(1.5, -0.95, 0.4, 4.7),
      silo(0.5, 1.15, 0.4, 5.2),
      silo(1.7, 1, 0.4, 4.3),
      box(1, 0, 3.4, 0.9, 1.2),
      silo(4.2, -1.5, 1.15, 1.6),
      silo(4.2, 1.5, 1.15, 1.6),
    ],
  },
}

/**
 * Во сколько раз верх конуса уже основания.
 *
 * Геометрия у всех конусов одна — иначе это лишний вызов отрисовки на каждую
 * пропорцию, — поэтому и градирня, и труба сужаются одинаково. Значение
 * подобрано по градирне: при 0.62 раструб читается, при 0.8 тело превращается в
 * цилиндр, ниже 0.5 — в конус мороженого.
 */
const TAPER_RATIO = 0.62

/** Граней в теле вращения. На карте больше не различить, а вершины считаются. */
const ROUND_SEGMENTS = 12

// ─── Площадка ──────────────────────────────────────────────────────────────

/**
 * Основание всего, что здесь строится, — уровень площадки города из layers.ts.
 *
 * Один уровень на застройку и промышленность выбран сознательно: это одна и та
 * же земля, и любой свой зазор здесь означал бы, что завод парит или вкопан.
 * Плита площадки заполняет промежуток от нуля до этой высоты, детали стоят на
 * её верхней грани.
 */
const YARD_TOP = layers.cityPad

/** Толщина ограды, км. Тоньше самой узкой дороги — она не должна спорить с сетью. */
const FENCE_THICKNESS = 0.7

/** Высота ограды, км. Достаточно, чтобы поймать ключевой свет и не быть плитой. */
const FENCE_HEIGHT = 0.3

// ─── Размещение ────────────────────────────────────────────────────────────

/**
 * ДОЛГ ЗАКРЫТ: РАЗМЕР ГОРОДА СПРАШИВАЕТСЯ У ГОРОДА.
 *
 * Здесь стояла копия формулы радиуса застройки из CityMesh с честной пометкой
 * «известный долг». Копия работала ровно до того дня, когда силуэт города стал
 * зависеть ещё и от профиля: у аграрного города пятно шире на шестнадцать
 * процентов, у ресурсного уже, и переписанная формула про это не знала бы — то
 * есть заводы аграрных городов встали бы прямо в застройку. Теперь вынос
 * площадки отдаёт сам CityMesh (cityPadReach), и разъехаться двум формулам
 * больше негде, потому что формула одна.
 *
 * Запас, который был оправданием копии, остался и работает против РОСТА города.
 * Расстановка считается один раз (см. подписку в компоненте) и за партию не
 * двигается, а пятно застройки растёт вместе с населением как pop^0.42 — то есть
 * просвет в 2.5 км съедается только примерно двукратным ростом. При игровом
 * темпе в процент за месяц это годы безупречного снабжения; переезжающий же
 * завод раздражал бы с первой минуты.
 */

/** Просвет между краем городской площадки и краем промышленной, км. */
const SITE_CLEARANCE = 2.5

/** Просвет между двумя площадками одного города, км. */
const SITE_GAP = 3

/**
 * Сколько направлений перебирается при выборе места.
 *
 * Как и выборка Митчелла в CityMesh: бросков всегда ровно восемь, даже когда
 * победитель очевиден с первого. Порядок обращений к ГПСЧ — часть контракта, и
 * ранний выход из цикла сдвинул бы все последующие броски, то есть изменил бы
 * размеры и разворот площадки.
 */
const PLACEMENT_CANDIDATES = 8

/** Разброс размера между однотипными предприятиями. Родственники, не клоны. */
const SITE_SCALE_MIN = 0.92
const SITE_SCALE_MAX = 1.1

/** Разворот площадки относительно направления на город, радианы. */
const SITE_YAW_JITTER = 0.22

const TWO_PI = Math.PI * 2

/** Кратчайшая угловая дистанция между направлениями, 0..π. */
function arcBetween(a: number, b: number): number {
  const raw = (((a - b) % TWO_PI) + TWO_PI) % TWO_PI
  return raw > Math.PI ? TWO_PI - raw : raw
}

/** Соседняя площадка того же города: полярные координаты центра и охват. */
type Neighbour = { angle: number; distance: number; radius: number }

/**
 * Насколько далеко нужно отодвинуть площадку, чтобы не задеть соседнюю.
 *
 * Угол уже выбран (см. PLACEMENT_CANDIDATES) и здесь не трогается: у Рязани
 * стоят и ЦБК, и НПЗ, и на восьми кандидатах разойтись на нужные градусы
 * получается не всегда — вокруг города и без того тесно от дорог. Поэтому
 * пересечение снимается ВТОРОЙ координатой, радиусом: одна площадка садится
 * ближе к городу, другая дальше. Промзона в два пояса выглядит осмысленно, а
 * два наложенных друг на друга завода — нет.
 *
 * Формула — закрытое решение, а не подбор шагами. Центры лежат на лучах из
 * одной точки, поэтому расстояние между ними даёт теорема косинусов, а условие
 * «не ближе R» разворачивается в квадратное уравнение относительно искомого
 * расстояния; нужен его больший корень. Он существует, только когда луч вообще
 * проходит ближе R к центру соседа (d·sinΔ < R) — иначе площадки расходятся
 * сами и двигать ничего не надо.
 */
function clearOfNeighbours(
  angle: number,
  distance: number,
  radius: number,
  neighbours: readonly Neighbour[],
): number {
  let result = distance

  for (const other of neighbours) {
    const delta = arcBetween(angle, other.angle)
    const reach = other.radius + radius + SITE_GAP
    const offAxis = other.distance * Math.sin(delta)
    if (offAxis >= reach) continue

    const required =
      other.distance * Math.cos(delta) +
      Math.sqrt(reach * reach - offAxis * offAxis)
    result = Math.max(result, required)
  }

  return result
}

// ─── Разложенная сцена ─────────────────────────────────────────────────────

/**
 * Роль инстанса в раскраске.
 *
 * Тремя ролями исчерпывается всё, что нужно знать о детали при перекраске: тело
 * гаснет вместе с производством, ограда наливается акцентом, площадка не меняется
 * вовсе. Хранить рядом с матрицей саму деталь незачем — форма уже в матрице.
 */
type Role = 'корпус' | 'площадка' | 'ограда'

type Slot = {
  /** Индекс предприятия в layout.sites. */
  owner: number
  /** Доля высоты детали от самой высокой на площадке, 0..1. */
  tone: number
  role: Role
}

type Group = {
  matrices: Matrix4[]
  slots: Slot[]
}

type Layout = {
  /** Предприятия в том порядке, на который ссылается Slot.owner. */
  sites: IndustryId[]
  boxes: Group
  cylinders: Group
  cones: Group
}

const Y_AXIS = new Vector3(0, 1, 0)
const Z_AXIS = new Vector3(0, 0, 1)
const scratchPosition = new Vector3()
const scratchScale = new Vector3()
const scratchRotation = new Quaternion()
const scratchRoll = new Quaternion()

/**
 * Матрица детали: локальные оси площадки → сцена.
 *
 * Поворот площадки — вокруг вертикали на `yaw`, и знак его не произволен.
 * Вращение вокруг +Y переводит локальную ось X в (cos yaw, −sin yaw), тогда как
 * направление на карте задаётся парой (cos a, sin a) — то есть для разворота
 * площадки «от города» нужен yaw = −a. Тот же перевёрнутый знак, что и у Z в
 * cityPoint, и по той же причине (разбор — в шапке projection.ts).
 *
 * `roll` доворачивает тело вращения вокруг локальной Z: лежащему резервуару
 * нужен π/2, всем остальным ноль. Порядок множителей важен — сначала укладываем
 * цилиндр набок в его собственных осях, и только потом разворачиваем площадку.
 */
function partMatrix(
  centerX: number,
  centerZ: number,
  yaw: number,
  localX: number,
  localY: number,
  localZ: number,
  scaleX: number,
  scaleY: number,
  scaleZ: number,
  roll: number,
): Matrix4 {
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)

  scratchPosition.set(
    centerX + localX * cos + localZ * sin,
    localY,
    centerZ - localX * sin + localZ * cos,
  )
  scratchRotation.setFromAxisAngle(Y_AXIS, yaw)
  if (roll !== 0) {
    scratchRoll.setFromAxisAngle(Z_AXIS, roll)
    scratchRotation.multiply(scratchRoll)
  }
  scratchScale.set(scaleX, scaleY, scaleZ)

  return new Matrix4().compose(scratchPosition, scratchRotation, scratchScale)
}

/** Верх детали над площадкой, км: по нему считается тон. */
function partTop(part: Part): number {
  if (part.kind === 'цилиндр' && part.lying === true) {
    return part.radius * 2
  }
  // Поднятая коробка — галерея, перемычка, балка крана: её верх считается от
  // низа, а не от земли, иначе балка на двух стойках получила бы тон подвала.
  if (part.kind === 'коробка') {
    return (part.base ?? 0) + part.height
  }
  return part.height
}

/**
 * Расстановка предприятий и сборка всех матриц.
 *
 * Считается один раз на состав промышленности и не зависит ни от складов, ни от
 * загрузки: форма и место предприятия за партию не меняются, меняется только
 * цвет.
 *
 * СОСТАВ приходит отдельным аргументом `roster` — это то, на что подписан
 * компонент, — а ГЕОГРАФИЯ читается из снимка мира. Разделение не формальность:
 * список предприятий обязан быть ровно тем, изменение которого разбудило
 * пересчёт, иначе геометрия окажется собранной по одному состоянию, а признак
 * её свежести — по другому.
 */
export function buildLayout(
  roster: Record<string, string>,
  world: GameState['world'],
): Layout {
  const boxes: Group = { matrices: [], slots: [] }
  const cylinders: Group = { matrices: [], slots: [] }
  const cones: Group = { matrices: [], slots: [] }
  const sites: IndustryId[] = []

  // Направления дорог, выходящих из каждого города. Предприятие должно встать
  // между лучами трасс, а не на луч: завод верхом на М-2 читается как дефект
  // отрисовки, и никакой силуэт этого впечатления уже не исправит.
  const roadAngles = new Map<CityId, number[]>()
  for (const edge of Object.values(world.edges)) {
    const from = world.cities[edge.from]
    const to = world.cities[edge.to]
    if (from === undefined || to === undefined) continue

    const a = cityPoint(from)
    const b = cityPoint(to)
    const forward = Math.atan2(b.z - a.z, b.x - a.x)

    const outbound = roadAngles.get(edge.from) ?? []
    outbound.push(forward)
    roadAngles.set(edge.from, outbound)

    const inbound = roadAngles.get(edge.to) ?? []
    inbound.push(forward + Math.PI)
    roadAngles.set(edge.to, inbound)
  }

  // Сортировка по идентификатору, а не порядок ключей объекта: у Рязани два
  // предприятия, и второе расходится с первым по углу. Порядок обхода задаёт,
  // кто из них выбирает место первым, — он обязан быть одинаковым между
  // сессиями, иначе завод переезжает после перезагрузки сохранения.
  const byCity = new Map<CityId, IndustryId[]>()
  for (const id of (Object.keys(roster) as IndustryId[]).sort()) {
    const industry = world.industries[id]
    if (industry === undefined) continue
    const list = byCity.get(industry.cityId) ?? []
    list.push(id)
    byCity.set(industry.cityId, list)
  }

  for (const [cityIdOfGroup, ids] of byCity) {
    const city = world.cities[cityIdOfGroup]
    // Предприятие в неизвестном городе — дыра в данных, и симуляция роняет на
    // ней старт партии (см. createInitialState). Рендеру падать незачем:
    // остальная карта важнее одного завода.
    if (city === undefined) continue

    const at = cityPoint(city)
    const padRadius = cityPadReach(city)
    const taken = [...(roadAngles.get(cityIdOfGroup) ?? [])]
    const neighbours: Neighbour[] = []

    for (const id of ids) {
      const industry = world.industries[id]
      const site = SITES[industry.type]
      // Тип без описанной формы — не повод ронять карту: расширение
      // IndustryType в срезах 5–6 не должно требовать одновременной правки
      // рендера, иначе новые типы будут добавляться со страхом.
      if (site === undefined) continue

      const rng = Rng.forKey(id)

      // Лучший из кандидатов по расстоянию до дорог и до соседей по городу.
      // Бросков всегда PLACEMENT_CANDIDATES — см. комментарий к константе.
      let angle = 0
      let bestGap = -1
      for (let candidate = 0; candidate < PLACEMENT_CANDIDATES; candidate++) {
        const guess = rng.range(0, TWO_PI)
        let gap = Math.PI
        for (const busy of taken) {
          gap = Math.min(gap, arcBetween(guess, busy))
        }
        if (gap > bestGap) {
          bestGap = gap
          angle = guess
        }
      }
      taken.push(angle)

      const scale = rng.range(SITE_SCALE_MIN, SITE_SCALE_MAX)
      const yawJitter = rng.range(-SITE_YAW_JITTER, SITE_YAW_JITTER)

      const length = site.length * scale
      const width = site.width * scale

      // Отодвигаем так, чтобы за пятно застройки вышел ЛЮБОЙ угол площадки:
      // центр = радиус пятна + половина диагонали + просвет. Считать по половине
      // длины было бы дешевле на километр, но площадка ещё и довёрнута
      // (SITE_YAW_JITTER), и её угол лезет дальше, чем торец. Дальше расстояние
      // может подрасти, если на этом луче уже стоит сосед.
      const reach = Math.hypot(length, width) / 2
      const distance = clearOfNeighbours(
        angle,
        padRadius + reach + SITE_CLEARANCE,
        reach,
        neighbours,
      )
      neighbours.push({ angle, distance, radius: reach })

      const centerX = at.x + Math.cos(angle) * distance
      const centerZ = at.z + Math.sin(angle) * distance

      // Длинной осью от города: площадка «растёт» из города вдоль подъездной
      // дороги, а не стоит к нему боком. Знак — см. шапку partMatrix.
      const yaw = -angle + yawJitter

      const owner = sites.length
      sites.push(id)

      // Плита площадки заполняет всю толщу от рельефа до уровня застройки:
      // повисшая над землёй плита дала бы щель, а вкопанная — z-fighting с
      // подложкой.
      boxes.matrices.push(
        partMatrix(
          centerX,
          centerZ,
          yaw,
          0,
          YARD_TOP / 2,
          0,
          length,
          YARD_TOP,
          width,
          0,
        ),
      )
      boxes.slots.push({ owner, tone: 0, role: 'площадка' })

      // Ограда — четыре звена по краю плиты. Стоят на плите, а не рядом:
      // площадка непрозрачна и срезала бы им низ.
      const fence = FENCE_THICKNESS * scale
      const railY = YARD_TOP + (FENCE_HEIGHT * scale) / 2
      const rails: [number, number, number, number][] = [
        [0, -(width - fence) / 2, length, fence],
        [0, (width - fence) / 2, length, fence],
        [-(length - fence) / 2, 0, fence, width - fence * 2],
        [(length - fence) / 2, 0, fence, width - fence * 2],
      ]
      for (const [railX, railZ, railWidth, railDepth] of rails) {
        boxes.matrices.push(
          partMatrix(
            centerX,
            centerZ,
            yaw,
            railX,
            railY,
            railZ,
            railWidth,
            FENCE_HEIGHT * scale,
            railDepth,
            0,
          ),
        )
        boxes.slots.push({ owner, tone: 0, role: 'ограда' })
      }

      // Тон детали — её доля от самой высокой на площадке. Тот же приём, что в
      // CityMesh: один признак закодирован и формой, и тоном, поэтому силуэт
      // читается даже там, где его съел туман.
      let peak = 0
      for (const part of site.parts) {
        peak = Math.max(peak, partTop(part))
      }

      for (const part of site.parts) {
        const tone = peak > 0 ? partTop(part) / peak : 1
        const slot: Slot = { owner, tone, role: 'корпус' }

        if (part.kind === 'коробка') {
          boxes.matrices.push(
            partMatrix(
              centerX,
              centerZ,
              yaw,
              part.x * scale,
              YARD_TOP + ((part.base ?? 0) + part.height / 2) * scale,
              part.z * scale,
              part.width * scale,
              part.height * scale,
              part.depth * scale,
              0,
            ),
          )
          boxes.slots.push(slot)
          continue
        }

        const radius = part.radius * scale
        const height = part.height * scale
        const group = part.kind === 'конус' ? cones : cylinders
        const lying = part.kind === 'цилиндр' && part.lying === true

        group.matrices.push(
          partMatrix(
            centerX,
            centerZ,
            yaw,
            part.x * scale,
            // Лежащее тело опирается на бок, а не на торец: центр поднят на
            // радиус, а его собственная высота уходит в длину вдоль X.
            YARD_TOP + (lying ? radius : height / 2),
            part.z * scale,
            radius,
            height,
            radius,
            lying ? Math.PI / 2 : 0,
          ),
        )
        group.slots.push(slot)
      }
    }
  }

  return { sites, boxes, cylinders, cones }
}

// ─── Цвет состояния ────────────────────────────────────────────────────────

/**
 * Загрузка, с которой начинается тревога.
 *
 * Нижний конец шкалы не выдуман: IDLE_UTILIZATION — это порог, ниже которого
 * САМА СИМУЛЯЦИЯ считает предприятие стоящим и начинает копить ему простой.
 * Верхний конец — половина паспортной мощности: завод, который тянет меньше
 * половины, уже узкое место сети, даже если формально работает. Между ними
 * ограда наливается акцентом плавно, поэтому игрок видит, что цепочка ПОДХОДИТ
 * к обрыву, а не только сам обрыв.
 */
const ALARM_FROM = 0.5

/**
 * Доля тона детали в цвете корпуса; остальное даёт загрузка.
 *
 * Четверти хватает, чтобы внутри одной площадки читался объём (труба светлее
 * корпуса), и мало, чтобы этот разброс спорил с главным сообщением — работает
 * завод или стоит.
 */
const TONE_SHARE = 0.25

/**
 * Постоянная времени сглаживания, секунды.
 *
 * Загрузка пересчитывается каждый тик, а тиков на скорости ×5 проходит до
 * двадцати пяти в секунду. Завод, у которого склад полон ровно наполовину,
 * скачет между «работает» и «стоит» несколько раз в секунду — и карта начинает
 * мигать. Сглаживание по кадрам, а не по тикам: оно живёт только в рендере,
 * симуляция остаётся дискретной и детерминированной.
 */
const ALARM_SMOOTHING = 0.35

/** Ниже этого движения цвет считается устоявшимся и буфер не трогается. */
const SMOOTHING_EPSILON = 0.002

const BODY_DARK = new Color(palette.buildingLow)
const BODY_LIT = new Color(palette.buildingHigh)
const YARD_COLOR = new Color(palette.terrainEdge)
const FENCE_CALM = new Color(palette.buildingLow)
const FENCE_ALARM = new Color(palette.accentDim)
const scratchColor = new Color()

const clamp01 = (value: number): number =>
  value < 0 ? 0 : value > 1 ? 1 : value

/** Тревога по загрузке: 0 — завод тянет, 1 — встал. */
function alarmOf(life: number): number {
  return clamp01((ALARM_FROM - life) / (ALARM_FROM - IDLE_UTILIZATION))
}

function colorOf(slot: Slot, life: number): Color {
  switch (slot.role) {
    // Земля не меняется. Промышленная площадка — такая же подложка, как пятно
    // города, и мигать ей нечем.
    case 'площадка':
      return YARD_COLOR
    case 'ограда':
      return scratchColor.lerpColors(FENCE_CALM, FENCE_ALARM, alarmOf(life))
    default:
      return scratchColor.lerpColors(
        BODY_DARK,
        BODY_LIT,
        TONE_SHARE * slot.tone + (1 - TONE_SHARE) * life,
      )
  }
}

function paintGroup(
  mesh: InstancedMesh,
  group: Group,
  life: Float32Array,
): void {
  for (let i = 0; i < group.slots.length; i++) {
    const slot = group.slots[i]
    mesh.setColorAt(i, colorOf(slot, life[slot.owner]))
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
}

/**
 * Целевая загрузка предприятия для отрисовки, 0..1.
 *
 * Нулевой tick — особый случай, и он не «всё стоит». utilization описывает
 * ПОСЛЕДНИЙ отработанный тик, а до первого шага симуляции такого тика не было
 * (об этом прямо сказано в data/industries.ts). Показывать в этот момент
 * остановленным весь округ значило бы открывать партию картиной разрухи, которой
 * в мире нет: заводы работали и до 1994 года, у них лежит вчерашняя смена.
 *
 * Битая загрузка из повреждённого сохранения даёт ноль, а не NaN: NaN
 * просачивается сквозь сравнения и заражает сглаживание навсегда — тот же
 * предохранитель, что в world/speed.ts.
 */
function lifeTarget(state: GameState, id: IndustryId): number {
  const industry = state.world.industries[id]
  if (industry === undefined) return 0
  if (state.tick === 0) return 1
  return Number.isFinite(industry.utilization)
    ? clamp01(industry.utilization)
    : 0
}

// ─── Компонент ─────────────────────────────────────────────────────────────

/**
 * Подписка на СОСТАВ промышленности, а не на её состояние.
 *
 * Реестр предприятий пересобирается каждый тик — производство возвращает новые
 * объекты, — и подписка на него перестраивала бы всю геометрию по нескольку раз
 * в секунду. Селектор сводит мир к тому, от чего геометрия действительно
 * зависит: какие предприятия есть, какого они типа и в каком городе. Значения —
 * строки, поэтому useShallow сравнивает их ПО ЗНАЧЕНИЮ, и компонент
 * перерисовывается только при появлении или исчезновении предприятия.
 */
function selectRoster(store: GameStore): Record<string, string> {
  const roster: Record<string, string> = {}
  for (const industry of Object.values(store.state.world.industries)) {
    roster[industry.id] = `${industry.type}@${industry.cityId}`
  }
  return roster
}

export function Industries(): JSX.Element {
  const roster = useGameStore(useShallow(selectRoster))

  // Города и дороги читаются разовым снимком, а не подпиской. Их геометрия за
  // партию не меняется, а население — меняется, и подписка на него пересобирала
  // бы всю расстановку за каждым выросшим горожанином. Предприятие, ползающее по
  // карте вслед за ростом города, — дефект хуже любого пересечения; про запас,
  // который это оплачивает, сказано выше, у SITE_CLEARANCE.
  const layout = useMemo(
    () => buildLayout(roster, useGameStore.getState().state.world),
    [roster],
  )

  const boxRef = useRef<InstancedMesh>(null)
  const cylinderRef = useRef<InstancedMesh>(null)
  const coneRef = useRef<InstancedMesh>(null)

  /**
   * Три группы одним массивом — собранным ОДИН раз на макет, а не в кадре.
   *
   * Раньше и этот массив, и массив мешей писались литералами прямо в useFrame,
   * то есть две короткоживущие ссылки на каждый кадр (шестьдесят в секунду,
   * причём даже на замершей карте — литералы вычислялись ДО раннего выхода).
   * Правило шапки проекта запрещает создавать объекты в цикле кадра без
   * оговорок, и оговорки «мелочь» здесь нет: это ровно тот мусор, который потом
   * ищут по подёргиваниям.
   */
  const groups = useMemo(
    () => [layout.boxes, layout.cylinders, layout.cones],
    [layout],
  )

  /**
   * Сами меши тем же приёмом: массив живёт всю жизнь компонента, а useLayoutEffect
   * раскладывает в него ссылки, когда R3F их проставит. Собирать его из
   * boxRef.current в кадре было бы тем же литералом.
   */
  const meshes = useRef<(InstancedMesh | null)[]>([null, null, null])

  /** Сглаженная загрузка по предприятиям — то, что реально видно на карте. */
  const lifeRef = useRef<Float32Array>(new Float32Array(0))

  useLayoutEffect(() => {
    meshes.current[0] = boxRef.current
    meshes.current[1] = cylinderRef.current
    meshes.current[2] = coneRef.current

    const state = useGameStore.getState().state
    const life = new Float32Array(layout.sites.length)
    for (let i = 0; i < layout.sites.length; i++) {
      // Стартуем сразу на цели, без анимации: при монтировании сцены заводы
      // должны появиться в своём настоящем состоянии, а не разгораться из нуля.
      life[i] = lifeTarget(state, layout.sites[i])
    }
    lifeRef.current = life

    for (let m = 0; m < meshes.current.length; m++) {
      const mesh = meshes.current[m]
      const group = groups[m]
      if (mesh === null || group.matrices.length === 0) continue

      for (let i = 0; i < group.matrices.length; i++) {
        mesh.setMatrixAt(i, group.matrices[i])
      }
      mesh.instanceMatrix.needsUpdate = true
      paintGroup(mesh, group, life)

      // Без пересчёта габаритов отсечение по пирамиде видимости считает их по
      // исходному примитиву в начале координат, и вся промышленность исчезает,
      // стоит увести камеру от нуля.
      mesh.computeBoundingSphere()
    }
  }, [layout, groups])

  useFrame((_, delta) => {
    const life = lifeRef.current
    if (life.length !== layout.sites.length) return

    const state = useGameStore.getState().state

    // Экспонента, а не линейный шаг: сглаживание не должно зависеть от частоты
    // кадров. Дельта зажата — вкладка, вернувшаяся из фона, приносит секунды, и
    // без зажима первый же кадр после возврата дал бы скачок.
    const step = 1 - Math.exp(-Math.min(delta, 0.25) / ALARM_SMOOTHING)

    let moved = false
    for (let i = 0; i < life.length; i++) {
      const target = lifeTarget(state, layout.sites[i])
      const remaining = target - life[i]

      // Хвост экспоненты доводим до цели одним шагом. Проверять нужно именно
      // ОСТАТОК, а не величину шага: на коротком кадре шаг сам по себе мал даже
      // при огромном остатке, и проверка шага телепортировала бы цвет в цель.
      if (Math.abs(remaining) <= SMOOTHING_EPSILON) {
        if (life[i] !== target) {
          life[i] = target
          moved = true
        }
        continue
      }

      life[i] += remaining * step
      moved = true
    }

    // Стоящая на паузе карта не должна каждый кадр перезаливать буфер цветов.
    if (!moved) return

    for (let m = 0; m < meshes.current.length; m++) {
      const mesh = meshes.current[m]
      const group = groups[m]
      if (mesh === null || group.slots.length === 0) continue
      paintGroup(mesh, group, life)
    }
  })

  /**
   * Дев-хук: какие силуэты В САМОМ ДЕЛЕ стоят на карте.
   *
   * Тот же довод, что у __plechoBuildings и __plechoCities: юнит-тест по
   * устройству не отвечает на вопрос «а смонтирован ли меш» — он сам зовёт
   * проверяемую функцию. Здесь число инстансов берётся с живого InstancedMesh, а
   * состав деталей — из таблицы SITES, и сквозной тест может спросить, чем
   * лесозаготовка отличается от нефтебазы, не вглядываясь в пиксели.
   *
   * В продакшен-сборке ветка вырезается целиком: import.meta.env.DEV — константа
   * этапа сборки.
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return

    const dev = globalThis as unknown as { __plechoIndustries?: unknown }
    const world = useGameStore.getState().state.world

    dev.__plechoIndustries = () => ({
      sites: layout.sites.map((id) => {
        const type = world.industries[id]?.type
        const site = type === undefined ? undefined : SITES[type]
        return {
          id,
          type: type ?? null,
          parts: site?.parts.length ?? 0,
          // Верх силуэта в собственных осях площадки, км: главное число для
          // опознания типа с общего плана.
          top:
            site === undefined
              ? 0
              : site.parts.reduce((peak, part) => Math.max(peak, partTop(part)), 0),
          round:
            site === undefined
              ? 0
              : site.parts.filter((part) => part.kind !== 'коробка').length,
        }
      }),
      boxes: boxRef.current?.count ?? 0,
      cylinders: cylinderRef.current?.count ?? 0,
      cones: coneRef.current?.count ?? 0,
    })

    return () => {
      delete dev.__plechoIndustries
    }
  }, [layout])

  return (
    <group>
      {/*
        Три материала различаются только шероховатостью, и цвет у всех белый:
        instanceColor не заменяет цвет материала, а УМНОЖАЕТСЯ на него, и любой
        оттенок здесь притушил бы всю шкалу состояния разом. Emissive нет ни у
        одного — светятся в этой сцене только машины.

        Тени включены на всех трёх сетках сразу: отбрасывают их корпуса, а
        принимает площадка, и разводить эти роли по отдельным InstancedMesh ради
        двух флагов не стоит ни одного лишнего вызова отрисовки. Колонны и трубы
        в карте теней всё равно превращаются в кашу — тексель покрывает здесь
        около четырёхсот метров, — но крупные корпуса читаются, и промышленность
        стоит на земле так же, как застройка, а не лежит на ней наклейкой.
      */}
      {layout.boxes.matrices.length > 0 && (
        <instancedMesh
          ref={boxRef}
          // null! — идиома R3F: геометрия и материал приходят детьми, здесь
          // значимо только третье значение, число экземпляров.
          args={[null!, null!, layout.boxes.matrices.length]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="#ffffff" roughness={0.85} metalness={0} />
        </instancedMesh>
      )}

      {layout.cylinders.matrices.length > 0 && (
        <instancedMesh
          ref={cylinderRef}
          args={[null!, null!, layout.cylinders.matrices.length]}
          castShadow
          receiveShadow
        >
          <cylinderGeometry args={[1, 1, 1, ROUND_SEGMENTS]} />
          {/* Металл резервуаров чуть глаже бетона: разница в блике почти не
              видна, но она есть ровно там, где два тела стоят рядом. */}
          <meshStandardMaterial color="#ffffff" roughness={0.7} metalness={0.08} />
        </instancedMesh>
      )}

      {layout.cones.matrices.length > 0 && (
        <instancedMesh
          ref={coneRef}
          args={[null!, null!, layout.cones.matrices.length]}
          castShadow
          receiveShadow
        >
          <cylinderGeometry args={[TAPER_RATIO, 1, 1, ROUND_SEGMENTS]} />
          <meshStandardMaterial color="#ffffff" roughness={0.9} metalness={0} />
        </instancedMesh>
      )}
    </group>
  )
}
