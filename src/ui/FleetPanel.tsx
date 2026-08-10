/**
 * Панель парка — главный рабочий экран среза 4.
 *
 * До этого среза машина в игре была одна и безликая: «купить ЗИЛ» в панели
 * компании и строка в списке. Здесь у техники появляются класс, прицеп,
 * водитель и возраст, а вместе с ними — четыре решения, которых в игре не было:
 * что купить, под что специализировать, кого посадить за руль и когда списать.
 * Все четыре принимаются про ОДНУ машину и требуют видеть её целиком, поэтому
 * панель устроена как «список слева, карточка справа», а не как четыре
 * отдельных диалога.
 *
 * ─── ГЛАВНОЕ ПРАВИЛО КОМПОНОВКИ: ИЗНОС И РУБЛИ ЗА КИЛОМЕТР СТОЯТ РЯДОМ ──────
 *
 * Решение «пора списывать» невозможно принять ни по одному из этих чисел
 * поодиночке. «Износ 73%» ничего не советует — много это или мало, зависит от
 * класса и от груза. «Обслуживание 9,7 руб/км» не говорит, вырастет ли оно ещё.
 * Вместе они и есть решение, и потому в строке списка они стоят одной парой в
 * правой колонке, а в карточке — двумя крупными числами рядом, под общей
 * шкалой с риской порога списания. Порог считает ui/fleetReadout.ts теми же
 * функциями симуляции; здесь он только нарисован.
 *
 * Рядом с ними — вторая пара: ВСЕ переменные расходы на километр против потолка
 * выручки на километр (m·t, левая граница главного инварианта игры). Две
 * полоски на общем масштабе отвечают на вопрос «отбивает ли она себя» без
 * вычитания в уме — тот же приём, что у потоков в панели компании.
 *
 * ─── ЧТО СЧИТАЕТСЯ ЗАМЕТНЫМ ─────────────────────────────────────────────────
 *
 * Акцент — единственный тёплый цвет игры — тратится здесь ровно на
 * ОСТАНОВЛЕННЫЕ ДЕНЬГИ: сломанная машина, машина без водителя и износ выше
 * порога списания. Всё это одно и то же по сути: техника есть, зарплата идёт,
 * выручки нет. Приглушённый тёплый достаётся тому, что деньги пока не
 * останавливает, но остановит (нет прицепа, просрочено ТО). Всё прочее —
 * обычным текстом: подсветить каждую характеристику значит не подсветить
 * ничего.
 *
 * НЕДОСТУПНОЕ НЕ ПРЯЧЕТСЯ. Техника, которая ещё не выпускается или не по
 * деньгам, остаётся в списке с ценой и причиной: копить невозможно на то, чего
 * не видно, а «в 2000-м появится двадцатитонник» — это половина плана на первые
 * годы партии. Тот же довод для прицепов, которые класс не тянет.
 *
 * НИ ОДНОГО ЧИСЛА ПАНЕЛЬ НЕ СЧИТАЕТ ПО-СВОЕМУ. Всё приходит из fleetReadout, а
 * он зовёт симуляцию и справочники. Здесь только разметка, цвета и решения о
 * том, что показать первым.
 *
 * ─── ДВЕ ДВЕРИ И ОДНО СОСТОЯНИЕ ────────────────────────────────────────────
 *
 * Панель сворачивается в СВОЮ кнопку вызова, как редактор линий, и та же панель
 * открывается из панели компании — из строки «столько-то машин не возит».
 * Дверей две потому, что и поводов два: «пойду посмотрю парк» и «мне только что
 * сказали, что парк стоит». Состояние при этом ОДНО и живёт в
 * ui/fleetSelection.ts: заведи каждая дверь свой флаг — и панели легли бы одна
 * на другую, а закрывались бы двумя нажатиями.
 *
 * Свёрнутая панель остаётся смонтированной и продолжает считать сводку по
 * парку — она нужна самой кнопке вызова, которая загорается акцентом, когда в
 * парке есть остановленные деньги. Это единственная работа, которую панель
 * делает, пока на неё не смотрят.
 *
 * Стили заданы прямо в разметке — по той же причине, что и в соседних панелях:
 * источник цветов ровно один (render/palette.ts). Долг по общему слою
 * оформления (MONO, withAlpha, кнопка) к этой панели вырос до четвёртой копии и
 * просится в ui/theme.ts — но выносить его должен тот, кто правит все панели
 * разом, иначе получится пятая копия под другим именем.
 */

import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, JSX } from 'react'

import { useGameStore } from '../app/store'
import { palette } from '../render/palette'
import { dateFromTick } from '../sim/time'
import type {
  Driver,
  DriverId,
  Line,
  LineId,
  TrailerType,
  Vehicle,
  VehicleId,
} from '../sim/types'
import { useFleetPanel } from './fleetSelection'
import {
  classOffers,
  driverRows,
  fleetRows,
  fleetSummary,
  fmtInteger,
  fmtRate,
  fmtShare,
  fmtTons,
  payrollPerDay,
  plural,
  trailerOffers,
  type DriverRow,
  type FleetRow,
} from './fleetReadout'

/** Моноширинный стек — только для чисел, как в соседних панелях. */
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/** Тот же цвет палитры, но полупрозрачный. Копия из TimeControls, см. там же. */
function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16)
  const r = (value >> 16) & 0xff
  const g = (value >> 8) & 0xff
  const b = value & 0xff
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

const ACCENT_WASH = withAlpha(palette.accent, 0.14)
const DIM_WASH = withAlpha(palette.accent, 0.07)

const VEHICLE_FORMS = ['машина', 'машины', 'машин'] as const
const DRIVER_FORMS = ['водитель', 'водителя', 'водителей'] as const
/** Сказуемое склоняется вместе с числом: «1 стоит», «2 стоят». */
const STALL_FORMS = ['стоит', 'стоят', 'стоят'] as const

/**
 * Пустые записи — константы на модуль.
 *
 * `?? {}` прямо в селекторе возвращал бы новый объект на каждый вызов, zustand
 * считал бы его изменившимся и перерисовывал бы панель бесконечно.
 */
const NO_LINES: Record<LineId, Line> = {}
const NO_DRIVERS: Record<DriverId, Driver> = {}

/**
 * Порог, с которого износ начинает тревожить, — доля пути до списания.
 *
 * Величина ДЛЯ ГЛАЗА, а не игровое правило: сам порог списания у каждого класса
 * свой и считается в fleetReadout, здесь только момент, когда число меняет
 * цвет. Две трети пути до порога — это ещё рабочая машина, но уже та, под
 * которую пора планировать замену.
 */
const WEAR_WARNING = 0.66

// ─── Цвета по смыслу ───────────────────────────────────────────────────────

/**
 * Цвет износа: спокойный — приглушённый тёплый — акцент.
 *
 * Ступени считаются НЕ ОТ САМОГО ИЗНОСА, а от его доли до порога списания:
 * 70% ресурса у ЗИЛа означает «ещё работает», а у тягача — «уже в убыток».
 * Красить оба одинаково значило бы врать про решение, ради которого панель и
 * написана.
 *
 * Цвет не единственный носитель смысла: рядом стоит шкала с риской порога, и
 * та же информация выражена длиной. Метрика, читаемая только по оттенку, не
 * читается ни в скриншоте, ни половиной людей.
 */
function wearColor(wear: number, threshold: number | null): string {
  if (threshold === null || threshold <= 0) {
    return wear >= WEAR_WARNING ? palette.accentDim : palette.text
  }
  const share = wear / threshold
  if (share >= 1) return palette.accent
  if (share >= WEAR_WARNING) return palette.accentDim
  return palette.text
}

/** Цвет метки простоя. Остановленные деньги — акцент, будущие потери — тёплый. */
function troubleColor(trouble: FleetRow['trouble']): string {
  if (trouble === 'сломана' || trouble === 'без водителя') return palette.accent
  return palette.accentDim
}

// ─── Стили ─────────────────────────────────────────────────────────────────

/**
 * Кнопка вызова свёрнутой панели.
 *
 * СНИЗУ ПО ЦЕНТРУ — единственное свободное место на экране: слева внизу панель
 * компании, справа внизу кнопка редактора линий, оба верхних угла заняты
 * временем и карточкой города. Заодно кнопка стоит там же, откуда развернётся
 * сама панель: движение получается на месте, а не через весь кадр.
 *
 * АКЦЕНТ КНОПКА БЕРЁТ ТОЛЬКО ПРИ ОСТАНОВЛЕННЫХ ДЕНЬГАХ — когда в парке есть
 * сломанная машина или машина без водителя. Это единственное, ради чего стоит
 * тянуть игрока со свёрнутой панели; горящая постоянно, она перестала бы
 * что-либо значить через десять минут игры.
 */
function launcherStyle(alarm: boolean, hovered: boolean): CSSProperties {
  return {
    position: 'fixed',
    left: '50%',
    bottom: 16,
    transform: 'translateX(-50%)',
    zIndex: 10,

    height: 30,
    padding: '0 12px',
    display: 'flex',
    alignItems: 'center',
    gap: 8,

    background: alarm ? ACCENT_WASH : palette.panel,
    border: `1px solid ${
      alarm ? palette.accent : hovered ? palette.text : palette.panelBorder
    }`,
    borderRadius: 6,
    color: alarm ? palette.accent : palette.text,

    font: `12px/1 ${MONO}`,
    letterSpacing: '0.04em',
    cursor: 'pointer',
    transition: 'color 120ms, border-color 120ms, background-color 120ms',
  }
}

const panelStyle: CSSProperties = {
  position: 'fixed',
  /*
   * ПО ЦЕНТРУ ЭКРАНА, а не в углу. Все четыре угла заняты (время, карточка
   * города, панель компании, редактор линий), но дело не только в этом: парк —
   * не индикатор, на который поглядывают, а экран, за которым сидят. Такой
   * экран занимает середину кадра и закрывается, когда работа сделана.
   */
  left: '50%',
  top: '50%',
  transform: 'translate(-50%, -50%)',
  zIndex: 12,

  display: 'flex',
  flexDirection: 'column',
  width: 760,
  maxWidth: 'calc(100vw - 32px)',
  maxHeight: 'calc(100vh - 32px)',
  boxSizing: 'border-box',

  background: palette.panel,
  border: `1px solid ${palette.panelBorder}`,
  borderRadius: 6,
  color: palette.text,

  // Рабочий экран, но всё же приборная доска: выделение мышью тут только мешает.
  userSelect: 'none',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: '10px 12px',
  borderBottom: `1px solid ${palette.panelBorder}`,
  flex: '0 0 auto',
}

const titleStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.2,
  letterSpacing: '0.02em',
}

const captionStyle: CSSProperties = {
  fontSize: 9,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: palette.textDim,
  lineHeight: 1,
}

/** Прокручивается только тело: заголовок обязан быть на месте всегда. */
const bodyStyle: CSSProperties = {
  flex: '1 1 auto',
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
}

const columnsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  flexWrap: 'wrap',
}

const leftColumnStyle: CSSProperties = {
  flex: '1 1 400px',
  minWidth: 320,
  borderRight: `1px solid ${palette.panelBorder}`,
  display: 'flex',
  flexDirection: 'column',
}

const rightColumnStyle: CSSProperties = {
  flex: '1 1 300px',
  minWidth: 300,
  display: 'flex',
  flexDirection: 'column',
}

const sectionStyle: CSSProperties = {
  padding: '9px 12px',
  borderBottom: `1px solid ${palette.panelBorder}`,
  display: 'flex',
  flexDirection: 'column',
  gap: 7,
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  lineHeight: 1.2,
}

const dimStyle: CSSProperties = {
  fontSize: 10,
  color: palette.textDim,
}

const numberStyle: CSSProperties = {
  fontFamily: MONO,
  fontSize: 11,
}

const ellipsis: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/**
 * Кнопка панели. Форма от кнопок редактора линий — там же и разбор того,
 * почему активное состояние берёт акцент, а спокойное молчит.
 *
 * НЕДОСТУПНАЯ КНОПКА ГАСНЕТ, А НЕ ИСЧЕЗАЕТ. Пропавшая кнопка сдвигает соседние
 * и прячет цену — то есть цель, к которой игрок копит.
 */
function buttonStyle(
  active: boolean,
  hovered: boolean,
  enabled = true,
  extra?: CSSProperties,
): CSSProperties {
  return {
    height: 24,
    padding: '0 8px',
    flex: '0 0 auto',

    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,

    background: active ? ACCENT_WASH : 'transparent',
    border: `1px solid ${
      active ? palette.accent : enabled && hovered ? palette.text : palette.panelBorder
    }`,
    borderRadius: 4,
    color: !enabled
      ? palette.textDim
      : active
        ? palette.accent
        : hovered
          ? palette.text
          : palette.textDim,

    font: `11px/1 ${MONO}`,
    letterSpacing: '0.03em',
    cursor: enabled ? 'pointer' : 'default',
    opacity: enabled ? 1 : 0.55,
    transition: 'color 120ms, border-color 120ms, background-color 120ms',
    ...extra,
  }
}

/**
 * Строка списка — кнопка, а не div: она выбирает машину, то есть управляет
 * панелью, и обязана быть доступна с клавиатуры.
 *
 * ВЫБОР ОБОЗНАЧЕН ЛЕВОЙ РИСКОЙ, а не заливкой во всю ширину: акцента в панели
 * уже два законных потребителя (поломка и износ выше порога), и третий,
 * занимающий целую строку, забил бы оба.
 */
function listRowStyle(selected: boolean, hovered: boolean): CSSProperties {
  return {
    display: 'block',
    width: '100%',
    padding: '6px 8px 6px 8px',
    textAlign: 'left',
    borderTop: `1px solid ${palette.panelBorder}`,
    borderRight: 'none',
    borderBottom: 'none',
    borderLeft: `2px solid ${selected ? palette.accent : 'transparent'}`,
    background: selected ? DIM_WASH : 'transparent',
    color: 'inherit',
    font: 'inherit',
    lineHeight: 1.25,
    cursor: 'pointer',
    transition: 'border-color 120ms, background-color 120ms',
    opacity: hovered || selected ? 1 : 0.92,
  }
}

/** Шкала: подложка панели, заполнение — доля. Тоньше, чем в панели компании. */
const trackStyle: CSSProperties = {
  position: 'relative',
  height: 4,
  borderRadius: 2,
  background: palette.panelBorder,
  overflow: 'hidden',
}

const fillStyle: CSSProperties = {
  height: '100%',
  borderRadius: 2,
  transition: 'width 240ms, background-color 240ms',
}

/** Риска порога. Цвет — фон панели: видна и на подложке, и поверх заполнения. */
const tickStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  width: 1,
  background: palette.panel,
}

// ─── Мелкие части разметки ─────────────────────────────────────────────────

/** Пара «подпись — значение» в колонку. Из таких собраны обе карточки. */
function Stat({
  label,
  value,
  color,
  size = 18,
  title,
}: {
  label: string
  value: string
  color?: string
  size?: number
  title?: string
}): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} title={title}>
      <span style={captionStyle}>{label}</span>
      <span
        style={{
          fontFamily: MONO,
          fontSize: size,
          lineHeight: 1,
          color: color ?? palette.text,
        }}
      >
        {value}
      </span>
    </div>
  )
}

/** Метка простоя: слово, а не только цвет. Читается и в скриншоте. */
function TroubleTag({ trouble }: { trouble: FleetRow['trouble'] }): JSX.Element | null {
  if (trouble === null) return null
  return (
    <span
      style={{
        flex: '0 0 auto',
        fontSize: 10,
        letterSpacing: '0.04em',
        color: troubleColor(trouble),
      }}
    >
      {trouble}
    </span>
  )
}

// ─── Панель ────────────────────────────────────────────────────────────────

export function FleetPanel(): JSX.Element {
  /*
   * Открытость — в общем store, а не в useState: ту же панель открывает панель
   * компании, и разбор, почему так, — в шапке ui/fleetSelection.ts.
   */
  const open = useFleetPanel((store) => store.open)
  const togglePanel = useFleetPanel((store) => store.togglePanel)
  const closePanel = useFleetPanel((store) => store.closePanel)


  /*
   * Подписки узкие и по одному полю — как в соседних панелях. Примитивы
   * (деньги, тик) не будят панель без нужды; парк и штат возвращаются ссылками
   * на части состояния и обновляются каждый тик, и это правильно: износ,
   * усталость и положение машин обязаны быть свежими.
   */
  const playerId = useGameStore((store) => store.state.playerId)
  const money = useGameStore(
    (store) => store.state.companies[store.state.playerId]?.money ?? 0,
  )
  const bankrupt = useGameStore(
    (store) => store.state.companies[store.state.playerId]?.bankrupt ?? false,
  )
  const year = useGameStore(
    (store) => dateFromTick(store.state.tick, store.state.startYear).year,
  )

  const vehicles = useGameStore((store) => store.state.vehicles)
  const cities = useGameStore((store) => store.state.world.cities)
  const edges = useGameStore((store) => store.state.world.edges)
  const lines = useGameStore(
    (store) => store.state.companies[store.state.playerId]?.lines ?? NO_LINES,
  )
  const drivers = useGameStore(
    (store) => store.state.companies[store.state.playerId]?.drivers ?? NO_DRIVERS,
  )

  const buyVehicle = useGameStore((store) => store.buyVehicle)
  const buyTrailer = useGameStore((store) => store.buyTrailer)
  const assignDriver = useGameStore((store) => store.assignDriver)
  const hireDriver = useGameStore((store) => store.hireDriver)
  const fireDriver = useGameStore((store) => store.fireDriver)
  const serviceVehicle = useGameStore((store) => store.serviceVehicle)
  const repairVehicle = useGameStore((store) => store.repairVehicle)

  const [chosen, setChosen] = useState<VehicleId | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [confirmFire, setConfirmFire] = useState<DriverId | null>(null)

  /*
   * Escape закрывает панель. Единственная горячая клавиша здесь: панель не
   * переопределяет смысл кликов по карте, в отличие от редактора линий, и
   * поэтому обходится без разбора «а что сейчас значит этот жест».
   *
   * Подписка ставится один раз на всё время жизни компонента, а состояние
   * читается из store в момент нажатия: панель смонтирована всегда, и
   * переподписывать обработчик на каждое открытие незачем.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const store = useFleetPanel.getState()
      if (store.open) store.closePanel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /*
   * Парк игрока, а не все машины мира: конкурент владеет своими машинами в том
   * же словаре, и в панели парка игрока им делать нечего.
   */
  const fleet = useMemo(
    () => Object.values(vehicles).filter((v) => v.ownerId === playerId),
    [vehicles, playerId],
  )

  const rows = useMemo(
    () => fleetRows(fleet, { cities, edges, lines, drivers }),
    [fleet, cities, edges, lines, drivers],
  )

  const summary = useMemo(() => fleetSummary(rows), [rows])
  const staff = useMemo(() => driverRows(drivers, vehicles), [drivers, vehicles])
  const payroll = useMemo(() => payrollPerDay(staff), [staff])

  const offers = useMemo(
    () => classOffers(year, money, bankrupt),
    [year, money, bankrupt],
  )

  /*
   * Выбранная машина. Не находится в парке (продали, ещё не купили) — берётся
   * первая: карточка справа не должна оставаться пустой, пока в парке есть хоть
   * одна машина, иначе половина панели выглядит сломанной.
   */
  const current: FleetRow | null =
    rows.find((row) => row.id === chosen) ?? rows[0] ?? null
  const currentVehicle: Vehicle | undefined =
    current === null ? undefined : vehicles[current.id]

  const trailers = useMemo(
    () =>
      currentVehicle === undefined
        ? []
        : trailerOffers(currentVehicle, money, bankrupt),
    [currentVehicle, money, bankrupt],
  )

  // Подтверждение увольнения не переживает смену машины и не висит вечно на
  // взводе: иначе взведённая кнопка ждала бы игрока уже на другом человеке.
  useEffect(() => setConfirmFire(null), [current?.id])

  /**
   * Остановленные деньги: сломанные машины и машины без водителя.
   *
   * Сумма именно этих двух счётчиков, а не всех бед: без прицепа и с
   * просроченным ТО техника всё-таки ездит и зарабатывает, а эти две — нет.
   */
  const stalled = summary.broken + summary.driverless

  /*
   * Свёрнутое состояние. Стоит ПОСЛЕ всех хуков и не раньше: React требует
   * одинакового порядка вызовов на каждом рендере, а ранний выход до useMemo
   * менял бы их число между открытой и закрытой панелью. Тот же порядок и в
   * редакторе линий.
   */
  if (!open) {
    return (
      <button
        type="button"
        onClick={togglePanel}
        onMouseEnter={() => setHovered('launcher')}
        onMouseLeave={() => setHovered(null)}
        style={launcherStyle(stalled > 0, hovered === 'launcher')}
        title={
          stalled > 0
            ? 'Парк: есть машины, которые стоят и не зарабатывают'
            : 'Парк: покупка машин и прицепов, водители, ТО и ремонт'
        }
      >
        парк
        {/*
          На кнопке либо размер парка, либо беда. Беда вытесняет размер, а не
          дописывается к нему: «4 · 1 стоит» пришлось бы читать, а прочитать
          кнопку игрок должен боковым зрением.
        */}
        <span style={{ color: stalled > 0 ? palette.accent : palette.textDim }}>
          {stalled > 0
            ? `${stalled} ${plural(stalled, STALL_FORMS)}`
            : summary.count}
        </span>
      </button>
    )
  }

  return (
    <div style={panelStyle}>
      {/* ─── Шапка ──────────────────────────────────────────────────── */}
      <div style={headerStyle}>
        <div style={{ ...titleStyle, flex: '1 1 auto' }}>парк компании</div>

        <span style={{ ...numberStyle, color: palette.textDim }}>
          {summary.count} {plural(summary.count, VEHICLE_FORMS)} ·{' '}
          {staff.length} {plural(staff.length, DRIVER_FORMS)}
        </span>

        <button
          type="button"
          onClick={closePanel}
          onMouseEnter={() => setHovered('close')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...buttonStyle(false, hovered === 'close', true, {
              width: 22,
              padding: 0,
              border: 'none',
            }),
            font: `16px/1 ${MONO}`,
          }}
          aria-label="Закрыть"
          title="Закрыть (Esc)"
        >
          ×
        </button>
      </div>

      {/*
        ПОЛОСА ОСТАНОВЛЕННЫХ ДЕНЕГ. Стоит над всем содержимым и во всю ширину:
        сломанная машина и машина без водителя — это парк, который получает
        зарплату и не возит ничего, и заметить это игрок обязан раньше, чем
        начнёт разглядывать характеристики. Пока всё работает, полосы нет вовсе
        — панель молчит, когда молчать правильно.
      */}
      {stalled > 0 && (
        <div
          style={{
            padding: '7px 12px',
            background: ACCENT_WASH,
            borderBottom: `1px solid ${palette.accent}`,
            color: palette.accent,
            fontSize: 11,
            lineHeight: 1.3,
            flex: '0 0 auto',
          }}
        >
          {/*
            Счёт стоит ПОСЛЕ слова, а не перед ним: «сломано: 2» согласуется с
            любым числом, а «2 сломано» пришлось бы склонять третьим набором
            форм ради строки, которая появляется раз в партию.
          */}
          стоят и проедают зарплату —{' '}
          {[
            summary.broken > 0 ? `сломано: ${summary.broken}` : null,
            summary.driverless > 0
              ? `без водителя: ${summary.driverless}`
              : null,
          ]
            .filter((part) => part !== null)
            .join(' · ')}
        </div>
      )}

      <div style={bodyStyle}>
        <div style={columnsStyle}>
          {/* ─── Список машин ───────────────────────────────────────── */}
          <div style={leftColumnStyle}>
            <div style={{ ...sectionStyle, gap: 0, padding: '9px 0 0' }}>
              <div style={{ ...rowStyle, padding: '0 12px 6px' }}>
                <span style={captionStyle}>машины</span>
                <span
                  style={{
                    ...numberStyle,
                    marginLeft: 'auto',
                    color: palette.textDim,
                  }}
                  title="Износ и обслуживание, рубли за километр. Два числа одного решения: когда списывать"
                >
                  износ · руб/км
                </span>
              </div>

              {rows.length === 0 ? (
                <div style={{ ...dimStyle, padding: '0 12px 9px' }}>
                  машин нет. Купите тягач ниже — прицеп и водителя к нему
                  подбирают отдельно.
                </div>
              ) : (
                <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                  {rows.map((row) => (
                    <VehicleRow
                      key={row.id}
                      row={row}
                      selected={current?.id === row.id}
                      hovered={hovered === `v-${row.id}`}
                      onHover={(on) => setHovered(on ? `v-${row.id}` : null)}
                      onPick={() => setChosen(row.id)}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* ─── Покупка машины ──────────────────────────────────── */}
            <div style={{ ...sectionStyle, borderBottom: 'none' }}>
              <div style={rowStyle}>
                <span style={captionStyle}>купить машину</span>
                <span
                  style={{
                    ...numberStyle,
                    marginLeft: 'auto',
                    color: palette.textDim,
                  }}
                >
                  {fmtInteger(money)} руб
                </span>
              </div>

              {offers.map((offer) => (
                <ClassOffer
                  key={offer.id}
                  offer={offer}
                  hovered={hovered === `c-${offer.id}`}
                  onHover={(on) => setHovered(on ? `c-${offer.id}` : null)}
                  onBuy={() => buyVehicle(offer.id)}
                />
              ))}

              {/*
                Тягач приезжает голым, и сказать об этом надо ДО покупки, а не
                после: игрок, купивший машину и обнаруживший, что она не едет и
                не грузится, решит, что игра сломана.
              */}
              <div style={dimStyle}>
                машина приезжает без прицепа и без водителя: это отдельные
                решения и отдельные деньги
              </div>
            </div>
          </div>

          {/* ─── Карточка машины ────────────────────────────────────── */}
          <div style={rightColumnStyle}>
            {current === null || currentVehicle === undefined ? (
              <div style={{ ...sectionStyle, borderBottom: 'none' }}>
                <span style={dimStyle}>машина не выбрана</span>
              </div>
            ) : (
              <VehicleCard
                row={current}
                trailers={trailers}
                staff={staff}
                hovered={hovered}
                onHover={setHovered}
                onService={() => serviceVehicle(current.id)}
                onRepair={() => repairVehicle(current.id)}
                onTrailer={(trailer) => buyTrailer(current.id, trailer)}
                onSeat={(driverId) => assignDriver(driverId, current.id)}
                onUnseat={(driverId) => assignDriver(driverId, null)}
              />
            )}
          </div>
        </div>

        {/* ─── Штат ──────────────────────────────────────────────────── */}
        <div style={{ ...sectionStyle, borderBottom: 'none' }}>
          <div style={rowStyle}>
            <span style={captionStyle}>водители</span>
            <span
              style={{ ...numberStyle, color: palette.textDim }}
              title="Зарплата идёт и в рейсе, и на стоянке, и на обязательном отдыхе. Лишний человек убыточен сам по себе"
            >
              фонд {fmtInteger(payroll)} руб/сут
            </span>

            <button
              type="button"
              onClick={hireDriver}
              onMouseEnter={() => setHovered('hire')}
              onMouseLeave={() => setHovered(null)}
              style={buttonStyle(false, hovered === 'hire', !bankrupt, {
                marginLeft: 'auto',
              })}
              disabled={bankrupt}
              title={
                bankrupt
                  ? 'Компания разорена: нанимать некого и не на что'
                  : 'Нанять водителя. Он придёт в резерв — за руль его сажают отдельно'
              }
            >
              нанять
            </button>
          </div>

          {staff.length === 0 ? (
            <div style={dimStyle}>
              водителей нет: без человека за рулём машина не тронется с места
            </div>
          ) : (
            staff.map((man) => (
              <DriverLine
                key={man.id}
                man={man}
                target={current}
                hovered={hovered}
                onHover={setHovered}
                confirmFire={confirmFire === man.id}
                onSeat={() =>
                  current !== null && assignDriver(man.id, current.id)
                }
                onUnseat={() => assignDriver(man.id, null)}
                onFire={() => {
                  if (confirmFire === man.id) {
                    fireDriver(man.id)
                    setConfirmFire(null)
                  } else {
                    setConfirmFire(man.id)
                  }
                }}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Строка машины ─────────────────────────────────────────────────────────

/**
 * Одна машина в списке.
 *
 * Три яруса, и порядок в них не случаен. Первый — чем машина является (класс) и
 * во что обходится (износ и рубли за километр). Второй — из чего она собрана:
 * прицеп, водитель, линия; отсутствие любого из трёх и есть причина простоя.
 * Третий — что делает прямо сейчас. Сверху вниз идёт от «стоит ли её держать» к
 * «где она», то есть от редких решений к частым взглядам.
 */
function VehicleRow({
  row,
  selected,
  hovered,
  onHover,
  onPick,
}: {
  row: FleetRow
  selected: boolean
  hovered: boolean
  onHover: (on: boolean) => void
  onPick: () => void
}): JSX.Element {
  const worn = row.writeOffWear !== null && row.wear >= row.writeOffWear

  return (
    <button
      type="button"
      onClick={onPick}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={listRowStyle(selected, hovered)}
      aria-pressed={selected}
      title={[
        `${row.className} ${row.id}`,
        `Износ ${fmtShare(row.wear)}, обслуживание ${fmtRate(
          row.maintenancePerKm,
        )} руб/км при паспортных ${fmtRate(row.basePerKm)}.`,
        row.writeOffWear === null
          ? 'До конца ресурса машина окупает себя.'
          : `Расходы догонят выручку на износе ${fmtShare(row.writeOffWear)} — после этого машина не отбивает даже идеальный рейс.`,
        `Пробег ${fmtInteger(row.odometer)} км, после ТО ${fmtInteger(
          row.kmSinceService,
        )} км.`,
      ].join('\n')}
    >
      {/* Ярус 1: что это и во что обходится */}
      <div style={{ ...rowStyle, gap: 6 }}>
        <span style={{ ...dimStyle, fontFamily: MONO, flex: '0 0 auto' }}>
          {row.id}
        </span>
        <span style={{ ...ellipsis, fontSize: 12, flex: '1 1 auto' }}>
          {row.className}
        </span>

        <span
          style={{
            ...numberStyle,
            flex: '0 0 auto',
            color: wearColor(row.wear, row.writeOffWear),
          }}
        >
          {fmtShare(row.wear)}
        </span>
        <span
          style={{
            ...numberStyle,
            flex: '0 0 auto',
            width: 62,
            textAlign: 'right',
            // Ставка обслуживания греется вместе с износом: это одно число,
            // разложенное на причину и следствие.
            color: wearColor(row.wear, row.writeOffWear),
          }}
        >
          {fmtRate(row.maintenancePerKm)}
        </span>
      </div>

      {/* Ярус 2: из чего собрана */}
      <div style={{ ...rowStyle, gap: 6, marginTop: 3 }}>
        <span
          style={{
            ...dimStyle,
            flex: '0 0 auto',
            color: row.trailer === null ? palette.accentDim : palette.textDim,
          }}
        >
          {row.trailer ?? 'без прицепа'}
        </span>
        <span style={{ ...dimStyle, flex: '0 0 auto' }}>·</span>
        <span
          style={{
            ...dimStyle,
            ...ellipsis,
            flex: '1 1 auto',
            color: row.driverId === null ? palette.accent : palette.textDim,
          }}
        >
          {row.driverName ?? 'без водителя'}
        </span>
        <span style={{ ...dimStyle, ...ellipsis, flex: '0 1 auto' }}>
          {row.lineName ?? 'вне линий'}
        </span>
      </div>

      {/* Ярус 3: что делает сейчас */}
      <div style={{ ...rowStyle, gap: 6, marginTop: 3, fontSize: 11 }}>
        <span
          style={{
            ...ellipsis,
            flex: '1 1 auto',
            color: row.cargo === null ? palette.textDim : palette.text,
          }}
        >
          {row.leg}
          {row.progress !== null && (
            <span style={{ fontFamily: MONO, color: palette.textDim }}>
              {' · '}
              {fmtShare(row.progress)}
            </span>
          )}
        </span>

        {row.cargo === null ? (
          <span style={{ ...dimStyle, flex: '0 0 auto' }}>
            {row.idle ? '' : 'порожняя'}
          </span>
        ) : (
          <span style={{ ...numberStyle, flex: '0 0 auto' }}>
            {row.cargo.type} {fmtTons(row.cargo.tons)} т
          </span>
        )}

        {/*
          Метка простоя стоит последней и одна: у сломанного тягача без прицепа
          и без водителя загорелись бы три подряд, и не была бы прочитана ни
          одна. Какая именно причина главная — решает fleetReadout.
        */}
        <TroubleTag trouble={row.trouble} />
        {worn && (
          <span
            style={{ flex: '0 0 auto', fontSize: 10, color: palette.accent }}
            title="Расходы на километр обогнали выручку: машина не окупается даже в идеальном кольце"
          >
            пора списывать
          </span>
        )}
      </div>
    </button>
  )
}

// ─── Карточка машины ───────────────────────────────────────────────────────

function VehicleCard({
  row,
  trailers,
  staff,
  hovered,
  onHover,
  onService,
  onRepair,
  onTrailer,
  onSeat,
  onUnseat,
}: {
  row: FleetRow
  trailers: ReturnType<typeof trailerOffers>
  staff: DriverRow[]
  hovered: string | null
  onHover: (key: string | null) => void
  onService: () => void
  onRepair: () => void
  onTrailer: (trailer: TrailerType) => void
  onSeat: (driver: DriverId) => void
  onUnseat: (driver: DriverId) => void
}): JSX.Element {
  /*
   * Общий масштаб двух полосок — расходов и потолка выручки. Единица в
   * знаменателе не «на всякий случай»: у машины из битого сейва оба числа могут
   * оказаться нулевыми, и ширина вышла бы NaN.
   */
  const scale = Math.max(row.costPerKm, row.revenuePerKm, 1)
  const unprofitable = row.costPerKm >= row.revenuePerKm

  return (
    <>
      {/* ─── Износ и рубли за километр ─────────────────────────────── */}
      <div style={sectionStyle}>
        <div style={rowStyle}>
          <span style={{ ...titleStyle, fontSize: 13, ...ellipsis }}>
            {row.className}
          </span>
          <span
            style={{ ...dimStyle, fontFamily: MONO, marginLeft: 'auto' }}
          >
            {row.id}
          </span>
        </div>

        {/*
          ДВА ЧИСЛА ОДНОГО РЕШЕНИЯ, И ОНИ СТОЯТ РЯДОМ. Порознь ни одно из них не
          советует ничего: разбор — в шапке файла и в ui/fleetReadout.ts.
        */}
        <div style={{ display: 'flex', gap: 18, alignItems: 'flex-end' }}>
          <Stat
            label="износ"
            value={fmtShare(row.wear)}
            color={wearColor(row.wear, row.writeOffWear)}
            title={`Ресурс тратится километрами и быстрее на плохой дороге. Пробег ${fmtInteger(
              row.odometer,
            )} км`}
          />
          <Stat
            label="обслуживание"
            value={`${fmtRate(row.maintenancePerKm)} руб/км`}
            color={wearColor(row.wear, row.writeOffWear)}
            size={16}
            title={`Паспортная ставка класса ${fmtRate(
              row.basePerKm,
            )} руб/км. Разница — это и есть цена возраста`}
          />
        </div>

        {/*
          Шкала износа с РИСКОЙ ПОРОГА СПИСАНИЯ. Порог у каждого класса свой
          (у ЗИЛа около 0.73, у тягача около 0.52), поэтому шкала без риски
          обманывала бы: одинаковые проценты у разных машин означают разное.
        */}
        <div style={trackStyle}>
          <div
            style={{
              ...fillStyle,
              width: `${row.wear * 100}%`,
              background: wearColor(row.wear, row.writeOffWear),
            }}
          />
          {row.writeOffWear !== null && (
            <div style={{ ...tickStyle, left: `${row.writeOffWear * 100}%` }} />
          )}
        </div>

        <div style={{ ...rowStyle, ...dimStyle }}>
          <span>
            {row.writeOffWear === null
              ? 'окупается до конца ресурса'
              : `порог списания ${fmtShare(row.writeOffWear)}`}
          </span>
          <span style={{ marginLeft: 'auto', fontFamily: MONO }}>
            после ТО {fmtInteger(row.kmSinceService)} км
          </span>
        </div>

        {/* ─── Километр в рублях ─────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ ...rowStyle, ...dimStyle }}>
            <span>расходы на км</span>
            <span style={{ marginLeft: 'auto', fontFamily: MONO }}>
              {fmtRate(row.costPerKm)} из {fmtRate(row.revenuePerKm)} руб
            </span>
          </div>

          <div style={trackStyle}>
            <div
              style={{
                ...fillStyle,
                width: `${(row.revenuePerKm / scale) * 100}%`,
                background: palette.textDim,
              }}
            />
          </div>
          {/*
            Расходы — тёплые, выручка — холодная: тот же язык, что и на карте и
            в панели компании. В полный акцент расходы уходят, только когда
            обгоняют выручку, то есть когда полоска и так длиннее.
          */}
          <div style={trackStyle}>
            <div
              style={{
                ...fillStyle,
                width: `${(row.costPerKm / scale) * 100}%`,
                background: unprofitable ? palette.accent : palette.accentDim,
              }}
            />
          </div>

          <span style={dimStyle}>
            {unprofitable
              ? 'километр стоит дороже, чем приносит с полным кузовом'
              : 'потолок выручки — полный кузов на нейтральном грузе'}
          </span>
        </div>

        {/* ─── Работы ───────────────────────────────────────────────── */}
        <div style={{ ...rowStyle, gap: 6 }}>
          <button
            type="button"
            onClick={onService}
            onMouseEnter={() => onHover('service')}
            onMouseLeave={() => onHover(null)}
            style={buttonStyle(
              row.serviceDue,
              hovered === 'service',
              row.kmSinceService > 0,
              { flex: '1 1 auto' },
            )}
            disabled={row.kmSinceService <= 0}
            title={
              row.kmSinceService <= 0
                ? 'ТО только что проведено'
                : 'Плановое ТО обнуляет счётчик пробега, но НЕ возвращает ресурс: износ необратим'
            }
          >
            <span>ТО</span>
            <span style={{ marginLeft: 'auto' }}>
              {fmtInteger(row.serviceCost)} руб
            </span>
          </button>

          <button
            type="button"
            onClick={onRepair}
            onMouseEnter={() => onHover('repair')}
            onMouseLeave={() => onHover(null)}
            style={buttonStyle(
              row.brokenDown,
              hovered === 'repair',
              row.brokenDown,
              { flex: '1 1 auto' },
            )}
            disabled={!row.brokenDown}
            title={
              row.brokenDown
                ? 'Машина стоит до ремонта. Поломка в пути дороже: это эвакуатор и работа в поле'
                : 'Машина цела — ремонтировать нечего'
            }
          >
            <span>ремонт</span>
            <span style={{ marginLeft: 'auto' }}>
              {row.brokenDown ? `${fmtInteger(row.repairCost)} руб` : '—'}
            </span>
          </button>
        </div>
      </div>

      {/* ─── Прицеп ──────────────────────────────────────────────────── */}
      <div style={sectionStyle}>
        <div style={rowStyle}>
          <span style={captionStyle}>прицеп</span>
          <span
            style={{ ...dimStyle, marginLeft: 'auto', ...ellipsis }}
            title="Грузы, которые машина может взять прямо сейчас"
          >
            {row.trailer === null
              ? 'нет — груз не взять'
              : row.carries.join(', ')}
          </span>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {trailers.map((offer) => (
            <button
              key={offer.trailer}
              type="button"
              onClick={() => offer.available && onTrailer(offer.trailer)}
              onMouseEnter={() => onHover(`t-${offer.trailer}`)}
              onMouseLeave={() => onHover(null)}
              style={buttonStyle(
                offer.current,
                hovered === `t-${offer.trailer}`,
                offer.available,
                {
                  height: 'auto',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 3,
                  padding: '5px 7px',
                  width: 'calc(50% - 2px)',
                },
              )}
              disabled={!offer.available}
              title={
                offer.reason ??
                `Поставить ${offer.trailer} за ${fmtInteger(
                  offer.price,
                )} руб. Старый прицеп списывается без возврата денег`
              }
            >
              <span style={{ display: 'flex', gap: 6, width: '100%' }}>
                <span style={{ fontFamily: 'inherit' }}>{offer.trailer}</span>
                <span style={{ marginLeft: 'auto' }}>
                  {offer.current ? 'стоит' : fmtInteger(offer.price)}
                </span>
              </span>
              {/*
                СПИСОК ГРУЗОВ ВАЖНЕЕ ЦЕНЫ: прицепы дёшевы намеренно, решение не
                «накопить ли», а «под что специализировать машину». Цистерна
                возит два груза из шести, зерновоз — один.
              */}
              <span
                style={{
                  ...dimStyle,
                  fontSize: 9,
                  fontFamily: 'inherit',
                  textAlign: 'left',
                  width: '100%',
                  ...ellipsis,
                }}
              >
                {offer.fits ? offer.cargo.join(', ') : (offer.reason ?? '')}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* ─── Кто за рулём ────────────────────────────────────────────── */}
      <div style={{ ...sectionStyle, borderBottom: 'none' }}>
        <div style={rowStyle}>
          <span style={captionStyle}>за рулём</span>
          <span
            style={{
              ...dimStyle,
              marginLeft: 'auto',
              color: row.driverId === null ? palette.accent : palette.textDim,
            }}
          >
            {row.driverName ?? 'никого — машина не тронется'}
          </span>
        </div>

        {row.driverId !== null && (
          <button
            type="button"
            onClick={() => row.driverId !== null && onUnseat(row.driverId)}
            onMouseEnter={() => onHover('unseat')}
            onMouseLeave={() => onHover(null)}
            style={buttonStyle(false, hovered === 'unseat')}
            title="Отправить водителя в резерв. Машина встанет, зарплата останется"
          >
            в резерв
          </button>
        )}

        {row.driverId === null && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {staff.filter((man) => man.vehicleId === null).length === 0 ? (
              <span style={dimStyle}>
                свободных водителей нет — наймите внизу или снимите с другой
                машины
              </span>
            ) : (
              staff
                .filter((man) => man.vehicleId === null)
                .map((man) => (
                  <button
                    key={man.id}
                    type="button"
                    onClick={() => onSeat(man.id)}
                    onMouseEnter={() => onHover(`s-${man.id}`)}
                    onMouseLeave={() => onHover(null)}
                    style={{
                      ...buttonStyle(false, hovered === `s-${man.id}`),
                      fontFamily: 'inherit',
                    }}
                    title={`Навык ${fmtShare(man.skill)}, ${fmtInteger(
                      man.wagePerDay,
                    )} руб/сут`}
                  >
                    {man.name}
                  </button>
                ))
            )}
          </div>
        )}
      </div>
    </>
  )
}

// ─── Строка класса в витрине ───────────────────────────────────────────────

/**
 * Класс техники к покупке.
 *
 * Характеристики стоят НА КНОПКЕ вместе с ценой, а не в подсказке: выбор класса
 * — решение на десятки часов игры, и принимать его вслепую игрок не должен.
 * Показаны те четыре величины, которые в этой игре что-то решают:
 * грузоподъёмность (она же выручка за километр), расход, обслуживание и год.
 */
function ClassOffer({
  offer,
  hovered,
  onHover,
  onBuy,
}: {
  offer: ReturnType<typeof classOffers>[number]
  hovered: boolean
  onHover: (on: boolean) => void
  onBuy: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => offer.available && onBuy()}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={buttonStyle(false, hovered, offer.available, {
        height: 'auto',
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 4,
        padding: '7px 8px',
      })}
      disabled={!offer.available}
      title={
        offer.reason ??
        `Купить ${offer.name} за ${fmtInteger(offer.price)} руб. Приедет без прицепа и без водителя`
      }
    >
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span
          style={{
            fontFamily: 'inherit',
            fontSize: 12,
            color: offer.available ? palette.text : palette.textDim,
          }}
        >
          {offer.name}
        </span>
        <span style={{ marginLeft: 'auto' }}>{fmtInteger(offer.price)} руб</span>
      </span>

      <span
        style={{
          display: 'flex',
          gap: 10,
          flexWrap: 'wrap',
          fontSize: 10,
          color: palette.textDim,
        }}
      >
        <span>{fmtInteger(offer.capacity)} т</span>
        <span>{fmtInteger(offer.cruiseKmh)} км/ч</span>
        <span>{fmtInteger(offer.fuelPer100Km)} л/100</span>
        <span>обсл {fmtRate(offer.maintenancePerKm)}</span>
        {/*
          Рубль за километр против рубля выручки — единственная пара, по которой
          классы сравнимы между собой: у тягача и расходы, и тариф другие, и
          «двадцать тонн против шести» само по себе не говорит ничего.
        */}
        <span
          title="Расходы на километр против потолка выручки на километр у новой машины"
          style={{ fontFamily: MONO }}
        >
          {fmtRate(offer.costPerKm)} / {fmtRate(offer.revenuePerKm)}
        </span>
      </span>

      {offer.reason !== null && (
        <span
          style={{
            fontSize: 10,
            fontFamily: 'inherit',
            textAlign: 'left',
            color: offer.released ? palette.textDim : palette.accentDim,
          }}
        >
          {offer.reason}
        </span>
      )}
    </button>
  )
}

// ─── Строка водителя ───────────────────────────────────────────────────────

/**
 * Человек в штате.
 *
 * Четыре величины и все четыре — деньги. Навык режет расход топлива и риск
 * поломки; допуски открывают грузы, без которых цепочка не поедет вовсе;
 * усталость ставит потолок суточного пробега; ставка платится каждый день,
 * включая тот, когда человек сидит в резерве.
 *
 * ЗАПРЕЩЁННЫЕ ГРУЗЫ НАПИСАНЫ СЛОВАМИ, а не выведены игроком из отсутствия
 * допуска. «Без ДОПОГ» — это знание про игру; «не повезёт: нефть, топливо» —
 * это ответ на вопрос, который у игрока действительно есть.
 */
function DriverLine({
  man,
  target,
  hovered,
  onHover,
  confirmFire,
  onSeat,
  onUnseat,
  onFire,
}: {
  man: DriverRow
  target: FleetRow | null
  hovered: string | null
  onHover: (key: string | null) => void
  confirmFire: boolean
  onSeat: () => void
  onUnseat: () => void
  onFire: () => void
}): JSX.Element {
  const atWheel = man.vehicleId !== null
  const here = target !== null && man.vehicleId === target.id

  return (
    <div style={{ ...rowStyle, gap: 8, flexWrap: 'wrap' }}>
      <span style={{ ...ellipsis, fontSize: 12, flex: '1 1 130px' }}>
        {man.name}
      </span>

      <span
        style={{ ...numberStyle, flex: '0 0 auto', width: 44 }}
        title="Навык: растёт с пробегом, режет расход топлива и риск поломки"
      >
        {fmtShare(man.skill)}
      </span>

      <span
        style={{
          ...dimStyle,
          flex: '0 0 auto',
          width: 96,
          // Допуск — это доступ к целым цепочкам мира, а не прибавка к
          // эффективности. Отсутствие допусков не подсвечивается: у новичка их
          // нет по умолчанию, и оранжевый горел бы на каждой второй строке.
          color: man.licenses.length === 0 ? palette.textDim : palette.text,
        }}
      >
        {man.licenses.length === 0 ? 'без допусков' : man.licenses.join(' + ')}
      </span>

      <span
        style={{
          ...numberStyle,
          flex: '0 0 auto',
          width: 52,
          // Обязательный отдых — не беда, а режим: машина стоит по закону.
          // Поэтому приглушённый тёплый, а не акцент.
          color: man.resting ? palette.accentDim : palette.textDim,
        }}
        title={
          man.resting
            ? 'Обязательный отдых: машина стоит, пока водитель не восстановится'
            : 'Усталость: копится за рулём, снимается на стоянке'
        }
      >
        {man.resting ? 'отдых' : fmtShare(man.fatigue)}
      </span>

      <span
        style={{ ...numberStyle, flex: '0 0 auto', width: 70, textAlign: 'right' }}
        title="Зарплата за игровые сутки. Платится и в рейсе, и в резерве"
      >
        {fmtInteger(man.wagePerDay)}
      </span>

      <span style={{ ...dimStyle, ...ellipsis, flex: '1 1 120px' }}>
        {man.seat ?? 'в резерве'}
        {man.denied.length > 0 && (
          <span style={{ color: palette.textDim }}>
            {' · не повезёт: '}
            {man.denied.join(', ')}
          </span>
        )}
      </span>

      <div style={{ display: 'flex', gap: 4, flex: '0 0 auto' }}>
        {atWheel ? (
          <button
            type="button"
            onClick={onUnseat}
            onMouseEnter={() => onHover(`d-off-${man.id}`)}
            onMouseLeave={() => onHover(null)}
            style={buttonStyle(false, hovered === `d-off-${man.id}`)}
            title="Отправить в резерв: машина встанет, зарплата останется"
          >
            в резерв
          </button>
        ) : (
          <button
            type="button"
            onClick={onSeat}
            onMouseEnter={() => onHover(`d-on-${man.id}`)}
            onMouseLeave={() => onHover(null)}
            style={buttonStyle(false, hovered === `d-on-${man.id}`, target !== null)}
            disabled={target === null}
            title={
              target === null
                ? 'Сначала выберите машину в списке'
                : `Посадить за ${target.className} ${target.id}`
            }
          >
            за руль
          </button>
        )}

        {/*
          Увольнение в два нажатия. Настоящая цена решения не в пособии (его
          нет), а в том, что машина под уволенным встанет, — и промах мимо
          соседней кнопки стоил бы кольца.
        */}
        <button
          type="button"
          onClick={onFire}
          onMouseEnter={() => onHover(`d-fire-${man.id}`)}
          onMouseLeave={() => onHover(null)}
          style={buttonStyle(confirmFire, hovered === `d-fire-${man.id}`)}
          title="Уволить. Его машина останется в парке и встанет без водителя"
        >
          {confirmFire ? 'ещё раз' : 'уволить'}
        </button>
      </div>

      {here && (
        <span style={{ ...dimStyle, flex: '0 0 auto', color: palette.accentDim }}>
          выбранная машина
        </span>
      )}
    </div>
  )
}
