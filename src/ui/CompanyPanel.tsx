/**
 * Панель компании: деньги, суточный итог, порожний пробег, линии и парк.
 *
 * Панель отвечает на пять вопросов, и они НАМЕРЕННО разного веса на экране.
 *
 *   «Сколько у меня денег» — крупно: это счёт партии.
 *   «Куда идёт счёт» — следом и почти так же крупно: суточный итог.
 *   «Сколько парк едет пустым» — крупно: единственное число, по которому видно
 *     мастерство, а не удачу (docs/КОНЦЕПТ.md, раздел 4).
 *   «Какая линия виновата» — списком: порожняк и экономика каждого кольца.
 *   «Сколько машин стоит и почему» — одной строкой и дверью в панель парка.
 *
 * ПАРК ПЕРЕЕХАЛ В СВОЮ ПАНЕЛЬ (ui/FleetPanel.tsx), и здесь от него осталась
 * ровно одна строка. Причина не в тесноте. В срезе 4 у машины появились класс,
 * прицеп, водитель и возраст, и список «где сейчас каждая машина» перестал
 * отвечать на главный вопрос про парк — им стало «что с этой машиной делать».
 * Ответ требует износа рядом со ставкой обслуживания, цен ТО и ремонта, списка
 * прицепов с грузами и штата с допусками; в колонку шириной 268 пикселей это не
 * складывается, а главное — не должно: панель компании это ПРИБОРНАЯ ДОСКА, на
 * которую смотрят не отрываясь от карты, а парк — рабочий экран, за который
 * садятся. Две копии одного списка в двух панелях разошлись бы при первой же
 * правке, поэтому здесь остался итог, а не выжимка.
 *
 * Итог при этом не декоративный: он называет ОСТАНОВЛЕННЫЕ ДЕНЬГИ — сломанные
 * машины и машины без водителя. Это те же деньги, что и убыток в суточном
 * итоге, только ещё не потраченные, и увидеть их игрок должен здесь, не открывая
 * ничего.
 *
 * ПОЧЕМУ СУТОЧНЫЙ ИТОГ СТОИТ ВТОРЫМ, СРАЗУ ПОД ДЕНЬГАМИ. Прибыль в тайкуне —
 * это ПОТОК, а не остаток на счету, и растущие деньги при убыточной сети —
 * обычное дело в начале партии: игрок проедает стартовый капитал и узнаёт об
 * этом в день, когда тот кончился. Поэтому убыток обязан быть виден раньше, чем
 * его последствия: он берёт акцент и стоит выше всего остального, что панель
 * умеет показать. Отсрочка до банкротства печатается тут же — не «у вас
 * проблемы», а «столько-то суток осталось».
 *
 * Порожний пробег показан ДВАЖДЫ и по-разному, и это не дублирование. Сверху —
 * по парку целиком: то, что игрок оптимизирует. В списке линий — по каждому
 * кольцу: то, чем он это чинит. Среднее по компании говорит, что беда есть;
 * строка линии говорит, где именно.
 *
 * НИ ОДНОЙ ЦИФРЫ ПАНЕЛЬ НЕ СЧИТАЕТ ПО-СВОЕМУ. Деньги и суточные потоки берутся
 * из состояния компании, порожний пробег складывается из счётчиков
 * loadedKm/emptyKm, которые ведёт фаза движения, экономика кольца собирается в
 * ui/lineEconomy.ts из формул симуляции. Интерфейс со своей формулой рано или
 * поздно разойдётся с симуляцией — так же тихо, как когда-то разошлись две
 * формулы скорости (разбор — в шапке src/sim/world/speed.ts), и найти
 * расхождение будет нечем: обе цифры выглядят правдоподобно.
 *
 * Стили заданы прямо в разметке — по той же причине, что и в TimeControls:
 * панель единственный владелец этих правил, а источник цветов ровно один
 * (palette.ts). Общий слой стилей появится, когда панелей станет достаточно,
 * чтобы у них нашлось действительно общее.
 */

import { useMemo, useState } from 'react'
import type { CSSProperties, JSX } from 'react'

import { useGameStore } from '../app/store'
import { BANKRUPTCY_GRACE_DAYS } from '../data/operating'
import { palette } from '../render/palette'
import { buildGraph } from '../sim/world/graph'
import type { Driver, DriverId, Line, LineId } from '../sim/types'
import { fleetRows, fleetSummary } from './fleetReadout'
import { useFleetPanel } from './fleetSelection'
import {
  emptyShare,
  fleetByLine,
  noFleet,
  planLines,
  type LinePlan,
} from './lineEconomy'
import { useLineSelection } from './lineSelection'

/**
 * Моноширинный стек — только для ЦИФР.
 *
 * В TimeControls моноширинной набрана вся панель, потому что там всё —
 * показания приборов. Здесь половина содержимого это названия городов и грузов,
 * а русский текст моноширинным шрифтом читается заметно хуже и занимает больше
 * места, которого в списке машин и так нет. Поэтому шрифт разделён по смыслу:
 * колонки чисел не должны дёргать ширину, слова — должны читаться.
 */
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/**
 * Пороги мастерства по порожнему пробегу.
 *
 * Взяты не с потолка: 15% — планка хорошего игрока из концепта, выше 40%
 * начинается работа в убыток по смыслу («почти половина километров не
 * оплачена»). Между ними — рабочая зона, в которой и живёт большая часть партии.
 *
 * Числа держатся здесь, а не в симуляции, сознательно: это оценка ДЛЯ ГЛАЗА, а
 * не игровое правило. Ни одна механика от них не зависит, и симуляция про них
 * знать не должна — иначе завтра появится соблазн начислять штраф «за плохой
 * показатель», и метрика перестанет быть честным зеркалом.
 */
const EMPTY_SHARE_GOOD = 0.15
const EMPTY_SHARE_BAD = 0.4

/**
 * Форматирование чисел с группировкой разрядов.
 *
 * Экземпляр один на модуль: создание Intl.NumberFormat стоит заметно дороже
 * самого форматирования, а панель перерисовывается на каждом тике.
 */
const INTEGER = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 })

/** Целые рубли и километры. Копейки в панели — шум: решения принимают не по ним. */
function formatInteger(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return INTEGER.format(Math.round(value))
}

/**
 * Число со знаком: «+12 400», «-4 200», «0».
 *
 * Знак ставится сам, а не берётся у форматтера: Intl печатает минус только у
 * отрицательных, и колонка итогов дёргалась бы на один знак при каждом переходе
 * через ноль. Плюс у прибыли к тому же читается как утверждение, а не как
 * отсутствие минуса.
 */
function formatSigned(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const rounded = Math.round(value)
  if (rounded === 0) return '0'
  return `${rounded > 0 ? '+' : '-'}${INTEGER.format(Math.abs(rounded))}`
}

/**
 * Русское склонение по числу. «1 машина», «2 машины», «5 машин» — иначе панель
 * выглядит как черновик.
 */
function plural(count: number, forms: readonly [string, string, string]): string {
  const hundreds = count % 100
  if (hundreds >= 11 && hundreds <= 14) return forms[2]
  const units = count % 10
  if (units === 1) return forms[0]
  if (units >= 2 && units <= 4) return forms[1]
  return forms[2]
}

const VEHICLE_FORMS = ['машина', 'машины', 'машин'] as const
const LINE_FORMS = ['линия', 'линии', 'линий'] as const
const DAY_FORMS = ['сутки', 'суток', 'суток'] as const
/* Сказуемые склоняются вместе с числом: «1 машина не возит», «2 машины не возят». */
const CARRY_FORMS = ['не возит', 'не возят', 'не возят'] as const
const NEED_FORMS = ['требует', 'требуют', 'требуют'] as const

// ─── Разбор состояния ──────────────────────────────────────────────────────
//
// Разбор парка в строки переехал в ui/fleetReadout.ts вместе с самим списком
// машин: панель компании берёт оттуда только сводку (fleetSummary), а панель
// парка — те же строки целиком. Двух разборов одного парка быть не должно.

/**
 * Цвет числа по зоне.
 *
 * Одна и та же оранжевая линия палитры, три ступени нагрева: спокойный светлый
 * — приглушённый тёплый — акцент. Хорошая работа НЕ тянет взгляд: панель молчит,
 * пока всё в порядке, и загорается, только когда парк возит воздух. Это тот же
 * стилевой замок, что и на карте, — акцент достаётся тому, на что нужно
 * смотреть, и никому больше.
 *
 * Цвет при этом не единственный носитель смысла: рядом стоит шкала, у которой
 * та же информация выражена длиной. Метрика, читаемая только по оттенку, не
 * читается ни в скриншоте, ни половиной людей.
 */
function shareColor(share: number): string {
  if (share < EMPTY_SHARE_GOOD) return palette.text
  if (share < EMPTY_SHARE_BAD) return palette.accentDim
  return palette.accent
}

/**
 * Цвет итога: убыток — акцент, прибыль — обычный текст.
 *
 * Прибыль НЕ подсвечивается ничем, и это принципиально. Зелёный «хорошо» рядом с
 * оранжевым «плохо» — это второй акцент, то есть конец стилевого замка ради
 * информации, которая и так читается по знаку числа. Панель обязана молчать,
 * пока всё в порядке.
 */
function profitColor(profit: number): string {
  return profit < 0 ? palette.accent : palette.text
}

// ─── Стили ─────────────────────────────────────────────────────────────────

const panelStyle: CSSProperties = {
  position: 'fixed',
  /*
   * Нижний левый угол. Верхние заняты: слева время (TimeControls), справа
   * карточка выбранного города. Нижний край выбран не по остаточному принципу —
   * панель компании всегда на экране и растёт вниз списком машин, и привязка к
   * низу означает, что растёт она ВВЕРХ, в пустоту, а не упирается в край
   * окна. Привязать её под панелью времени было бы хуже: отступ пришлось бы
   * считать от чужой высоты, и первая же строка, добавленная в TimeControls,
   * положила бы одну панель на другую.
   */
  bottom: 16,
  left: 16,
  zIndex: 10,

  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: '12px 14px',
  /*
   * Ширина фиксированная. В панели живут строки разной длины («Москва →
   * Нижний Новгород» против «Тула»), и по содержимому она меняла бы размер на
   * каждом рейсе. Ширины хватает на самое длинное плечо графа при 11px.
   */
  width: 268,
  boxSizing: 'border-box',
  /*
   * Потолок высоты. Разделов в панели стало пять, и на невысоком экране она
   * упёрлась бы в верхний край и вылезла за него вместе с деньгами — то есть
   * ровно тем, ради чего она есть. Внутренние списки прокручиваются сами, этот
   * потолок нужен на случай, когда даже свёрнутых разделов больше, чем места.
   */
  maxHeight: 'calc(100vh - 32px)',
  overflowY: 'auto',

  background: palette.panel,
  border: `1px solid ${palette.panelBorder}`,
  borderRadius: 6,
  color: palette.text,

  // Панель — приборная доска: выделение мышью здесь только мешает, особенно
  // когда мимо неё тащат камеру.
  userSelect: 'none',
}

/** Подпись раздела. Мелкая и разреженная — заголовок, а не содержание. */
const captionStyle: CSSProperties = {
  fontSize: 10,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: palette.textDim,
  lineHeight: 1,
}

const moneyRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
  lineHeight: 1,
}

const moneyStyle: CSSProperties = {
  fontFamily: MONO,
  fontSize: 30,
  letterSpacing: '-0.01em',
}

const unitStyle: CSSProperties = {
  fontSize: 11,
  color: palette.textDim,
}

const shareRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 8,
  lineHeight: 1,
}

const shareStyle: CSSProperties = {
  fontFamily: MONO,
  fontSize: 22,
}

/** Шкала: подложка панели, заполнение — доля порожнего пробега от всей длины. */
const barTrackStyle: CSSProperties = {
  position: 'relative',
  height: 4,
  borderRadius: 2,
  background: palette.panelBorder,
  overflow: 'hidden',
}

const barFillStyle: CSSProperties = {
  height: '100%',
  borderRadius: 2,
  // Заполнение ползёт вслед за метрикой, а не прыгает: метрика меняется редко
  // (только на погрузке и разгрузке), и без перехода это выглядит как сбой.
  transition: 'width 240ms, background-color 240ms',
}

/**
 * Риска порога на шкале.
 *
 * Цвет — фон панели, самый тёмный в палитре: риска обязана быть видна и на
 * подложке шкалы, и поверх заполнения, которое её перекроет.
 */
const tickStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  width: 1,
  background: palette.panel,
}

/**
 * Шкала потока: выручка и расходы двумя полосками на ОДНОЙ длине.
 *
 * Общий масштаб — вся суть приёма. Две шкалы, каждая со своим максимумом,
 * показали бы обе полными и не сказали бы ничего; на общем масштабе длиннее та,
 * которой больше, и вопрос «съедают ли расходы выручку» решается взглядом, без
 * вычитания в уме. Полоски тоньше метрики порожнего пробега (3 против 4) —
 * иллюстрация к числу, а не самостоятельный прибор.
 */
const flowTrackStyle: CSSProperties = {
  height: 3,
  borderRadius: 2,
  background: palette.panelBorder,
  overflow: 'hidden',
}

const flowFillStyle: CSSProperties = {
  height: '100%',
  borderRadius: 2,
  transition: 'width 240ms, background-color 240ms',
}

/**
 * Предупреждение о банкротстве.
 *
 * Стоит вплотную к суточному итогу и в акценте: это не украшение отчёта, а
 * обратный отсчёт. Рамки и заливки нет намеренно — плашка-баннер в углу карты
 * читалась бы как ошибка приложения, а не как состояние компании.
 */
const alarmStyle: CSSProperties = {
  marginTop: 6,
  fontSize: 11,
  lineHeight: 1.2,
  color: palette.accent,
}

/** Список линий короче списка машин: линий у игрока единицы, машин — десятки. */
const lineListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  maxHeight: 168,
  overflowY: 'auto',
}

/**
 * Строка линии — кнопка, а не div.
 *
 * Строка выбирает линию (та же выбранная линия подсвечивается на карте), то
 * есть это управляющий элемент, и он обязан быть доступен с клавиатуры и
 * озвучен экранным диктором. Стили гасят всё, что браузер рисует кнопке по
 * умолчанию.
 *
 * ВЫБОР ОБОЗНАЧЕН ЛЕВОЙ РИСКОЙ, а не заливкой строки. Заливка акцентом на всю
 * ширину превратила бы список в оранжевую полосу — при том, что акцента в
 * панели уже два законных потребителя (убыток и порожний пробег выше нормы).
 * Риска занимает два пикселя и не спорит ни с чем.
 */
function lineRowStyle(selected: boolean, hovered: boolean): CSSProperties {
  return {
    display: 'block',
    width: '100%',
    padding: '6px 0 6px 8px',
    textAlign: 'left',
    borderTop: `1px solid ${palette.panelBorder}`,
    borderRight: 'none',
    borderBottom: 'none',
    borderLeft: `2px solid ${selected ? palette.accent : 'transparent'}`,
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    lineHeight: 1.25,
    cursor: 'pointer',
    // Наведение подсвечивает только текст названия (см. ниже), поэтому здесь
    // остаётся один переход рамки — им и держится ощущение отклика.
    transition: 'border-color 120ms',
    opacity: hovered ? 1 : 0.92,
  }
}

/**
 * Кнопка, открывающая панель парка.
 *
 * Полная ширина и своя строка — потому что это единственная дверь к четырём
 * решениям среза (покупка, прицеп, водитель, списание), и искать её в списке
 * игрок не должен. Справа на ней стоит СОСТОЯНИЕ парка, а не только его размер:
 * кнопка «парк · 1 стоит» сообщает беду, не открывая ничего.
 *
 * Акцент кнопка берёт ровно тогда, когда в парке есть остановленные деньги.
 * Гореть постоянно она не должна — это обычная дверь, а не тревога.
 */
function fleetButtonStyle(alarm: boolean, hovered: boolean): CSSProperties {
  return {
    width: '100%',
    height: 26,
    marginTop: 8,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 8px',
    boxSizing: 'border-box',

    background: 'transparent',
    border: `1px solid ${
      alarm ? palette.accent : hovered ? palette.text : palette.panelBorder
    }`,
    borderRadius: 4,
    color: alarm ? palette.accent : hovered ? palette.text : palette.textDim,

    font: `11px/1 ${MONO}`,
    cursor: 'pointer',
    transition: 'color 120ms, border-color 120ms',
  }
}

const rowTopStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
}

const rowBottomStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 8,
  fontSize: 11,
  color: palette.textDim,
}

// ─── Компонент ─────────────────────────────────────────────────────────────

/**
 * Пустой реестр линий.
 *
 * Константа, а не литерал в селекторе: `?? {}` возвращал бы новый объект на
 * каждый вызов, zustand считал бы его изменившимся значением и перерисовывал бы
 * панель на каждом тике — вместе с поиском путей по всем линиям.
 */
const NO_LINES: Record<LineId, Line> = {}
const NO_DRIVERS: Record<DriverId, Driver> = {}

/** Подсказка к строке линии — вся арифметика потолка в одном месте. */
function planTitle(name: string, plan: LinePlan): string {
  if (plan.broken) {
    return `${name}: кольцо не собирается — меньше двух остановок или между ними нет дорог.`
  }

  const planned = Math.round((plan.emptyShare ?? 0) * 100)

  return [
    `${name}: круг ${formatInteger(plan.ringKm)} км, порожним ${planned}% по замыслу.`,
    `Выручка ${formatInteger(plan.revenue)} − расходы ${formatInteger(
      plan.costs,
    )} = ${formatSigned(plan.profit)} руб за круг.`,
    'Это ПОТОЛОК: полный кузов, груз всегда есть, скорость крейсерская. Факт бывает только хуже, поэтому отрицательный потолок означает, что линия убыточна всегда.',
  ].join('\n')
}

export function CompanyPanel(): JSX.Element {
  /*
   * Подписки узкие и по одному полю — как в TimeControls. Деньги и имя компании
   * возвращаются примитивами, поэтому перерисовка от них случается только при
   * реальном изменении; машины, города и дороги возвращаются ссылками на части
   * состояния, и панель обновляется вместе с ними каждый тик. Так и надо:
   * положение машин в списке обязано быть свежим.
   */
  const playerId = useGameStore((store) => store.state.playerId)
  const companyName = useGameStore(
    (store) => store.state.companies[store.state.playerId]?.name ?? '',
  )
  const money = useGameStore(
    (store) => store.state.companies[store.state.playerId]?.money ?? 0,
  )
  /*
   * Потоки — тоже примитивы, и подписка на них ведёт себя так же. Величины
   * скользящие (dayWindow в economy/operating.ts), поэтому меняются каждый тик,
   * и это ровно то, что нужно: суточный итог обязан быть свежим.
   */
  const dailyRevenue = useGameStore(
    (store) => store.state.companies[store.state.playerId]?.dailyRevenue ?? 0,
  )
  const dailyCosts = useGameStore(
    (store) => store.state.companies[store.state.playerId]?.dailyCosts ?? 0,
  )
  const daysInDebt = useGameStore(
    (store) => store.state.companies[store.state.playerId]?.daysInDebt ?? 0,
  )
  const bankrupt = useGameStore(
    (store) => store.state.companies[store.state.playerId]?.bankrupt ?? false,
  )
  /*
   * Линии возвращаются ссылкой, и ссылка эта СТАБИЛЬНА между тиками: фаза
   * расходов пересобирает запись компании, но объект lines оставляет прежним.
   * Значит, тяжёлый пересчёт экономики колец ниже случается только тогда, когда
   * игрок действительно правит сеть.
   */
  const lines = useGameStore(
    (store) => store.state.companies[store.state.playerId]?.lines ?? NO_LINES,
  )

  const vehicles = useGameStore((store) => store.state.vehicles)
  const cities = useGameStore((store) => store.state.world.cities)
  const edges = useGameStore((store) => store.state.world.edges)
  /*
   * Штат нужен панели ради одной строки: сводка парка называет машины БЕЗ
   * ВОДИТЕЛЯ, а имя человека за рулём лежит у него, не у машины. Подписка
   * стабильна по ссылке между тиками, пока никто не устал и не подрос в навыке.
   */
  const drivers = useGameStore(
    (store) => store.state.companies[store.state.playerId]?.drivers ?? NO_DRIVERS,
  )

  /*
   * Выбранная линия живёт в отдельном store (ui/lineSelection.ts): это «на что
   * игрок смотрит», а не «что в мире происходит». Панель и карта берут её
   * оттуда вдвоём, поэтому клик по строке подсвечивает кольцо на карте, а не
   * заводит вторую, свою идею о выборе.
   */
  const selectedLine = useLineSelection((store) => store.line)
  const selectLine = useLineSelection((store) => store.selectLine)

  const [hoveredLine, setHoveredLine] = useState<LineId | null>(null)
  const [hoveredFleet, setHoveredFleet] = useState(false)

  /*
   * Парк ОТКРЫВАЕТСЯ ОТСЮДА, НО НЕ РИСУЕТСЯ ЗДЕСЬ. Сама панель смонтирована в
   * App.tsx и сворачивается в собственную кнопку; общий у них один флаг в
   * ui/fleetSelection.ts. Нарисуй панель компании парк у себя — и в игре
   * оказались бы две панели, каждая со своим мнением о том, открыта ли она;
   * выглядят они одинаково, так что игрок узнал бы об этом, закрыв одну и
   * увидев под ней вторую.
   *
   * Кнопка ниже поэтому ПЕРЕКЛЮЧАТЕЛЬ, а не «открыть»: панель закрывает собой
   * середину экрана, эта кнопка остаётся видна в левом нижнем углу, и нажатие
   * на неё при открытом парке обязано что-то значить.
   */
  const fleetOpen = useFleetPanel((store) => store.open)
  const toggleFleet = useFleetPanel((store) => store.togglePanel)

  /*
   * Парк игрока, а не все машины мира. Конкурент в срезе 5 будет владеть своими
   * машинами в том же словаре, и его порожний пробег в счёте игрока не должен
   * появиться ни на километр.
   */
  const fleet = useMemo(
    () => Object.values(vehicles).filter((v) => v.ownerId === playerId),
    [vehicles, playerId],
  )

  /*
   * Сводка парка. Строки собирает тот же модуль, что и панель парка, а не своя
   * копия разбора: панель компании из них берёт только счётчики бед, но брать
   * их обязана из одного места с той панелью, которую откроет игрок. Две
   * сводки по одному парку однажды разошлись бы, и доверия не было бы ни одной.
   */
  const fleetState = useMemo(
    () => fleetSummary(fleetRows(fleet, { cities, edges, lines, drivers })),
    [fleet, cities, edges, lines, drivers],
  )

  /*
   * Потолок кольца — самое дорогое, что делает панель: поиск путей по всем
   * плечам всех линий. Зависимости здесь только от сети и от самих линий,
   * поэтому за партию он пересчитывается ровно столько раз, сколько игрок
   * правил линии, а не по пять раз в секунду.
   */
  const plans = useMemo(
    () => planLines(buildGraph(edges), lines),
    [edges, lines],
  )

  /* А вот парк линии обязан быть свежим — его считаем каждый тик, одним
     проходом по машинам. */
  const fleets = useMemo(
    () => fleetByLine(vehicles, playerId),
    [vehicles, playerId],
  )

  const lineRows = useMemo(
    () =>
      (Object.keys(lines) as LineId[]).map((id) => ({
        line: lines[id],
        plan: plans[id],
        fleet: fleets[id] ?? noFleet(),
      })),
    [lines, plans, fleets],
  )

  const mileage = useMemo(() => {
    let loadedKm = 0
    let emptyKm = 0
    for (const vehicle of fleet) {
      // Битые счётчики из старого сохранения не должны отравить сумму: NaN,
      // попавший в метрику, делает её NaN навсегда и молча.
      if (Number.isFinite(vehicle.loadedKm)) loadedKm += vehicle.loadedKm
      if (Number.isFinite(vehicle.emptyKm)) emptyKm += vehicle.emptyKm
    }
    return { loadedKm, emptyKm, share: emptyShare(loadedKm, emptyKm) }
  }, [fleet])

  const share = mileage.share
  const totalKm = mileage.loadedKm + mileage.emptyKm

  /*
   * Суточный итог. Разность считается здесь, а не берётся из состояния, потому
   * что её там нет: в Company лежат два потока, и вычитание — это показ, а не
   * правило. Оба слагаемых при этом чужие, свои формулы панель не заводит.
   */
  const profit = dailyRevenue - dailyCosts

  /*
   * Общий масштаб двух полосок. Единица в знаменателе — не «на всякий случай»:
   * в первые тики партии оба потока нулевые, и без неё ширина вышла бы NaN.
   */
  const flowMax = Math.max(dailyRevenue, dailyCosts, 1)
  const flowWidth = (value: number): number =>
    Number.isFinite(value) && value > 0 ? (value / flowMax) * 100 : 0

  /*
   * Обратный отсчёт до банкротства. daysInDebt копится по 1/96 за тик, поэтому
   * округляем ВВЕРХ: «через 0 суток» при живой компании выглядело бы ошибкой, а
   * запас в неполные сутки у игрока есть всегда.
   */
  const graceLeft = Math.max(
    0,
    Math.ceil(BANKRUPTCY_GRACE_DAYS - (Number.isFinite(daysInDebt) ? daysInDebt : 0)),
  )
  const alarm = bankrupt
    ? 'компания разорена — партия окончена'
    : daysInDebt > 0
      ? `в минусе: банкротство через ${graceLeft} ${plural(graceLeft, DAY_FORMS)}`
      : null

  /*
   * Остановленные деньги: машины, которые физически не могут работать. Сломанная
   * стоит до ремонта, машина без водителя не тронется с места — и обе получают
   * зарплату (водитель в резерве оплачивается полностью, см. payrollPerTick).
   * Сумма двух счётчиков, а не число «больных» машин: без прицепа и с
   * просроченным ТО техника всё-таки ездит.
   */
  const stalled = fleetState.broken + fleetState.driverless

  return (
    <div style={panelStyle}>
      {/* ─── Деньги ─────────────────────────────────────────────────── */}
      <div>
        <div style={{ ...captionStyle, marginBottom: 6 }}>{companyName}</div>
        <div style={moneyRowStyle}>
          {/*
            Долг — единственный случай, когда деньги берут акцент. Отрицательный
            баланс это не «плохое число», а конец партии на горизонте, и он
            обязан быть замечен раньше, чем игрок откроет отчёт.
          */}
          <span
            style={{
              ...moneyStyle,
              color: money < 0 ? palette.accent : palette.text,
            }}
          >
            {formatInteger(money)}
          </span>
          <span style={unitStyle}>руб</span>
        </div>
      </div>

      {/* ─── Суточный итог ──────────────────────────────────────────── */}
      <div
        title={`Итог последних суток: выручка ${formatInteger(
          dailyRevenue,
        )} − расходы ${formatInteger(dailyCosts)} = ${formatSigned(
          profit,
        )} руб.\nСкользящее окно в сутки: показывает поток, а не остаток на счету — растущие деньги при убыточной сети обычное дело в начале партии.`}
      >
        {/*
          ОТКУДА БЕРУТСЯ ЭТИ ДВА ЧИСЛА. Расходы кладёт в окно фаза расходов, а
          выручку — тот, кто её начисляет, то есть фаза прибытия, и класть она
          обязана ЧЕРЕЗ creditRevenue (sim/economy/operating.ts). Прибавить рубли
          к money напрямую, минуя эту функцию, — ошибка бесшумная: деньги на
          счету растут правильно, а суточный итог показывает одни расходы, и
          панель выглядит сломанной, хотя сломан стык.
        */}
        <div style={{ ...shareRowStyle, marginBottom: 6 }}>
          <span style={captionStyle}>за сутки</span>
          <span style={{ ...unitStyle, fontSize: 10 }}>
            {profit < 0 ? 'убыток' : 'прибыль'}
          </span>
        </div>

        <div style={{ ...shareRowStyle, marginBottom: 6 }}>
          <span style={{ ...shareStyle, color: profitColor(profit) }}>
            {formatSigned(profit)}
          </span>
          {/*
            Слагаемые стоят рядом с итогом мелким шрифтом, а не под ним
            строками: игроку нужен ответ «сколько теряю», а разбор «на чём» —
            только когда ответ его не устроил.
          */}
          <span style={{ ...unitStyle, fontFamily: MONO }}>
            {formatInteger(dailyRevenue)} / {formatInteger(dailyCosts)}
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={flowTrackStyle}>
            <div
              style={{
                ...flowFillStyle,
                width: `${flowWidth(dailyRevenue)}%`,
                background: palette.textDim,
              }}
            />
          </div>
          {/*
            Расходы — тёплые, выручка — холодная. Тот же язык, что и на карте, где
            гружёный прицеп тёплый, а порожний холодный: тёплое означает «здесь
            деньги двигаются». В акцент расходы уходят только когда обгоняют
            выручку, то есть когда полоска и так длиннее.
          */}
          <div style={flowTrackStyle}>
            <div
              style={{
                ...flowFillStyle,
                width: `${flowWidth(dailyCosts)}%`,
                background: profit < 0 ? palette.accent : palette.accentDim,
              }}
            />
          </div>
        </div>

        {alarm !== null && <div style={alarmStyle}>{alarm}</div>}
      </div>

      {/* ─── Порожний пробег ────────────────────────────────────────── */}
      <div
        title={
          share === null
            ? 'Порожний пробег: пока нет закрытых плеч'
            : `Порожний пробег: ${Math.round(share * 100)}% (${formatInteger(
                mileage.emptyKm,
              )} из ${formatInteger(totalKm)} км)`
        }
      >
        <div style={{ ...shareRowStyle, marginBottom: 6 }}>
          <span style={captionStyle}>порожний пробег</span>
          <span style={{ ...unitStyle, fontSize: 10 }}>
            норма до {Math.round(EMPTY_SHARE_GOOD * 100)}%
          </span>
        </div>

        <div style={{ ...shareRowStyle, marginBottom: 6 }}>
          <span
            style={{
              ...shareStyle,
              color: share === null ? palette.textDim : shareColor(share),
            }}
          >
            {share === null ? '—' : `${Math.round(share * 100)}%`}
          </span>
          <span style={{ ...unitStyle, fontFamily: MONO }}>
            {share === null
              ? 'нет закрытых плеч'
              : `${formatInteger(mileage.emptyKm)} / ${formatInteger(totalKm)} км`}
          </span>
        </div>

        <div style={barTrackStyle}>
          <div
            style={{
              ...barFillStyle,
              width: `${(share ?? 0) * 100}%`,
              background: share === null ? 'transparent' : shareColor(share),
            }}
          />
          {/*
            Риски на порогах. Шкала от нуля до сотни, а не «до сорока с
            запасом»: проценты сравнивают с сотней, и растянутая шкала врала бы
            глазу вдвое там, где число говорит правду.
          */}
          <div style={{ ...tickStyle, left: `${EMPTY_SHARE_GOOD * 100}%` }} />
          <div style={{ ...tickStyle, left: `${EMPTY_SHARE_BAD * 100}%` }} />
        </div>
      </div>

      {/* ─── Линии ──────────────────────────────────────────────────── */}
      <div>
        <div style={{ ...shareRowStyle, marginBottom: 2 }}>
          <span style={captionStyle}>линии</span>
          <span style={{ ...unitStyle, fontFamily: MONO }}>
            {lineRows.length} {plural(lineRows.length, LINE_FORMS)}
          </span>
        </div>

        {lineRows.length === 0 ? (
          <div style={{ ...unitStyle, paddingTop: 6 }}>линий нет</div>
        ) : (
          <div style={lineListStyle}>
            {lineRows.map(({ line, plan, fleet }) => {
              const chosen = line.id === selectedLine
              const fact = fleet.emptyShare

              return (
                <button
                  key={line.id}
                  type="button"
                  onClick={() => selectLine(line.id)}
                  onMouseEnter={() => setHoveredLine(line.id)}
                  onMouseLeave={() => setHoveredLine(null)}
                  style={lineRowStyle(chosen, hoveredLine === line.id)}
                  aria-pressed={chosen}
                  title={planTitle(line.name, plan)}
                >
                  <div style={rowTopStyle}>
                    <span
                      style={{
                        fontSize: 12,
                        color: chosen ? palette.accent : palette.text,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {line.name}
                    </span>
                    {/*
                      Линия без машин — не мелочь и не «ещё не настроил»: она
                      занимает место в сети и не везёт ничего. Поэтому строка не
                      молчит, а называет это словами, приглушённым тёплым.
                    */}
                    <span
                      style={{
                        marginLeft: 'auto',
                        flex: '0 0 auto',
                        fontFamily: MONO,
                        fontSize: 11,
                        color:
                          fleet.count === 0
                            ? palette.accentDim
                            : palette.textDim,
                      }}
                    >
                      {fleet.count === 0
                        ? 'без машин'
                        : `${fleet.count} ${plural(fleet.count, VEHICLE_FORMS)}`}
                    </span>
                  </div>

                  <div style={rowBottomStyle}>
                    {/*
                      Слева ФАКТ, справа ЗАМЫСЕЛ, и путать их нельзя. Порожний
                      пробег — то, как эти машины ездили на самом деле; итог
                      круга — потолок, посчитанный по кольцу (разбор в
                      ui/lineEconomy.ts). У линии, которая ещё не проехала ни
                      километра, слева честный прочерк, а справа уже есть ответ:
                      именно ради него потолок и считается.
                    */}
                    <span>
                      порожняк{' '}
                      <span
                        style={{
                          fontFamily: MONO,
                          color:
                            fact === null ? palette.textDim : shareColor(fact),
                        }}
                      >
                        {fact === null ? '—' : `${Math.round(fact * 100)}%`}
                      </span>
                    </span>

                    <span
                      style={{
                        flex: '0 0 auto',
                        fontFamily: MONO,
                        color: plan.broken
                          ? palette.textDim
                          : profitColor(plan.profit),
                      }}
                    >
                      {plan.broken
                        ? 'не достроена'
                        : `круг ${formatSigned(plan.profit)}`}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* ─── Парк ───────────────────────────────────────────────────── */}
      <div>
        <div style={{ ...shareRowStyle, marginBottom: 2 }}>
          <span style={captionStyle}>парк</span>
          <span style={{ ...unitStyle, fontFamily: MONO }}>
            {fleetState.count} {plural(fleetState.count, VEHICLE_FORMS)}
          </span>
        </div>

        {/*
          ОДНА СТРОКА ВМЕСТО СПИСКА, и она про деньги, а не про машины. «Две
          машины стоят» — это зарплата, которая идёт, и выручка, которой нет;
          понять это можно, не открывая ничего. Всё остальное про парк —
          износ, прицепы, водители, покупка — живёт в панели парка, потому что
          требует места и внимания, которых у приборной доски нет.
        */}
        {fleetState.count === 0 ? (
          <div style={{ ...unitStyle, paddingTop: 6 }}>машин нет</div>
        ) : (
          <div
            style={{
              ...shareRowStyle,
              paddingTop: 6,
              fontSize: 11,
              color: stalled > 0 ? palette.accent : palette.textDim,
            }}
          >
            <span>
              {stalled > 0
                ? `${stalled} ${plural(stalled, VEHICLE_FORMS)} ${plural(
                    stalled,
                    CARRY_FORMS,
                  )}`
                : 'все машины при деле'}
            </span>
            {/*
              Просроченное ТО — не остановленные деньги, а растущий счёт, и
              потому стоит справа приглушённым: это напоминание, а не тревога.
            */}
            {fleetState.serviceDue > 0 && (
              <span style={{ ...unitStyle, color: palette.accentDim }}>
                {fleetState.serviceDue} на ТО
              </span>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={toggleFleet}
          onMouseEnter={() => setHoveredFleet(true)}
          onMouseLeave={() => setHoveredFleet(false)}
          style={fleetButtonStyle(stalled > 0, hoveredFleet)}
          aria-expanded={fleetOpen}
          title={
            stalled > 0
              ? 'Открыть парк: есть машины, которые стоят и не зарабатывают'
              : 'Открыть парк: покупка машин и прицепов, водители, ТО и ремонт'
          }
        >
          <span>{fleetOpen ? 'закрыть парк' : 'открыть парк'}</span>
          <span>
            {fleetState.troubled > 0
              ? `${fleetState.troubled} ${plural(
                  fleetState.troubled,
                  NEED_FORMS,
                )} внимания`
              : `${fleetState.count} ${plural(fleetState.count, VEHICLE_FORMS)}`}
          </span>
        </button>
      </div>
    </div>
  )
}
