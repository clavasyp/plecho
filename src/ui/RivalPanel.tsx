/**
 * Панель соперников — лицо среза 6.
 *
 * Отвечает на один вопрос: КТО ЕЩЁ ЕЗДИТ ПО ЭТИМ ДОРОГАМ И ЧЕГО ОН ХОЧЕТ.
 *
 * ─── ЗАЧЕМ ЛЕНТА РАССУЖДЕНИЙ, И ПОЧЕМУ ОНА ЗДЕСЬ ГЛАВНАЯ ───────────────────
 *
 * Конкурент без видимых мотивов не читается как соперник — он читается как шум
 * в экономике. Груз, который вчера лежал на элеваторе, сегодня кем-то вывезен;
 * ставка на плече просела; в Туле встал чужой терминал. Всё это можно заметить
 * и без панели, но объяснить — нельзя, а необъяснимые события игрок относит не к
 * противнику, а к неудаче. Соперничество начинается ровно в тот момент, когда за
 * событием виден МОТИВ: «ухожу с длинного плеча, оно меня разорило».
 *
 * Отсюда раскладка: список контор занимает узкую колонку слева, а лента —
 * всё остальное место. Список отвечает на «кто впереди» одним взглядом; лента
 * требует чтения, и ей отданы и ширина, и высота, и право прокручиваться.
 *
 * ─── ПОМЕТКА ОБ ИСТОЧНИКЕ НЕ ПРЯЧЕТСЯ ─────────────────────────────────────
 *
 * У каждой записи стоит, кто её подумал: МОДЕЛЬ или СКРИПТ (Thought.fromModel).
 * Соблазн спрятать пометку велик — «модельные» рассуждения выглядят солиднее, а
 * запасной путь портит впечатление. Но игра, которая выдаёт скрипт за модель,
 * обманывает игрока насчёт того, что в ней есть, и обман этот вскрывается на
 * первом же отключённом интернете. Честная пометка стоит дешевле: она превращает
 * запасной путь из позора в устройство — видно, что игра работает без сети и что
 * конкурент не замирает, когда канал молчит.
 *
 * По той же причине в шапке соперника стоит, КТО ЕГО ВЕДЁТ сейчас
 * (Company.controller), и сколько записей ленты пришло от модели: одно с другим
 * не совпадает — компанию может вести модель, а конкретный ответ подставить
 * скрипт, когда канал не отозвался.
 *
 * ─── ЧТО ПРО СОПЕРНИКА ПОКАЗЫВАЕТСЯ, А ЧТО НЕТ ────────────────────────────
 *
 * Правило и его разбор — в шапке ui/rivalReadout.ts, здесь коротко: показывается
 * то, что видно с обочины. Машины, прицепы, кольца, города, бетон, гружёный и
 * порожний пробег, банкротство. ОСТАТКА НА ЧУЖОМ СЧЕТУ НЕТ: в строке конкурента
 * стоит ВЛОЖЕНО — прайсовая цена его парка и построек. Оговорка об этом
 * напечатана в самой панели, а не оставлена в комментарии: игрок должен
 * понимать, что за число он сравнивает со своим.
 *
 * ─── ИГРОК В ТОМ ЖЕ СПИСКЕ ────────────────────────────────────────────────
 *
 * И по тем же полям. Список, где соперники меряются одной меркой, а игрок
 * другой, не отвечает на вопрос, ради которого открыт. Ленты у игрока при этом
 * нет и быть не может — он и есть тот, кто решает, — поэтому его строка не
 * кнопка: кнопка, которая ничего не открывает, хуже её отсутствия.
 *
 * НИ ОДНОГО ЧИСЛА ПАНЕЛЬ НЕ СЧИТАЕТ ПО-СВОЕМУ: всё приходит из
 * ui/rivalReadout.ts, а он берёт цены у справочников и доли у счётчиков
 * симуляции. Здесь только разметка, цвета и решения о том, что показать первым.
 *
 * Стили заданы прямо в разметке — по той же причине, что и в соседних панелях:
 * источник цветов ровно один (render/palette.ts). Долг по общему слою оформления
 * (MONO, withAlpha, кнопка) вырос до шестой копии и просится в ui/theme.ts, но
 * выносить его должен тот, кто правит все панели разом, иначе получится седьмая
 * копия под другим именем.
 */

import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, JSX } from 'react'

import { useGameStore } from '../app/store'
import { palette } from '../render/palette'
import type { CityId, CompanyId } from '../sim/types'
import { fmtInteger, fmtShare, plural } from './fleetReadout'
import {
  networkOf,
  rivalRows,
  rivalSummary,
  thoughtFeed,
  type RivalRow,
} from './rivalReadout'
import { useSelection } from './selection'

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

const COMPANY_FORMS = ['контора', 'конторы', 'контор'] as const
const VEHICLE_FORMS = ['машина', 'машины', 'машин'] as const
const LINE_FORMS = ['кольцо', 'кольца', 'колец'] as const
const CITY_FORMS = ['город', 'города', 'городов'] as const
const ENTRY_FORMS = ['запись', 'записи', 'записей'] as const

// ─── Стили ─────────────────────────────────────────────────────────────────

/**
 * Кнопка вызова свёрнутой панели.
 *
 * СПРАВА ОТ ЧАСОВ, а не под ними. Все шесть привычных якорей экрана заняты:
 * время слева вверху, узкие места по центру вверху, карточка города справа
 * вверху, компания слева внизу, парк по центру внизу, линии справа внизу.
 * Свободного угла не осталось, и выбор был между «под часами» и «рядом с
 * часами». Рядом — потому что у панели времени ЖЁСТКАЯ ширина (172, и это
 * обосновано в её собственном стиле: дата пишется словом и по содержимому
 * панель дёргалась бы), а высота у неё переменная: любая новая строка в часах
 * положила бы одну панель на другую, и заметили бы это не сразу.
 *
 * АКЦЕНТ КНОПКА БЕРЁТ, ТОЛЬКО КОГДА СОПЕРНИК ОБОШЁЛ ИГРОКА ПО ДОЛЕ РЫНКА. Это
 * единственное событие, ради которого стоит отрывать взгляд от карты; горящая
 * постоянно, кнопка перестала бы значить что-либо через десять минут игры — тот
 * же довод, что у кнопок парка и узких мест.
 */
const TIME_CONTROLS_RIGHT_EDGE = 16 + 172
const LAUNCHER_GAP = 8

function launcherStyle(alarm: boolean, hovered: boolean): CSSProperties {
  return {
    position: 'fixed',
    left: TIME_CONTROLS_RIGHT_EDGE + LAUNCHER_GAP,
    top: 16,
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
    color: alarm ? palette.accent : hovered ? palette.text : palette.textDim,

    font: `11px/1 ${MONO}`,
    cursor: 'pointer',
    userSelect: 'none',
    transition: 'color 120ms, border-color 120ms, background-color 120ms',
  }
}

/**
 * Панель по центру экрана и КРУПНАЯ.
 *
 * Лента рассуждений — это текст, который читают, а не показание прибора, на
 * которое поглядывают: ей нужны и ширина строки, и высота на десяток записей.
 * Прижатая к краю колонка в 280 пикселей превратила бы каждую мысль в четыре
 * строки переносов, и лента перестала бы читаться — а вместе с ней исчез бы
 * единственный способ понять мотивы соперника.
 *
 * Отсюда же и центр: это ЭКРАН, ЗА КОТОРЫЙ САДЯТСЯ, как панель парка, а не
 * индикатор, за которым следят краем глаза. Закрывается он, когда прочитано.
 */
const panelStyle: CSSProperties = {
  position: 'fixed',
  left: '50%',
  top: '50%',
  transform: 'translate(-50%, -50%)',
  zIndex: 11,

  display: 'flex',
  flexDirection: 'column',
  width: 700,
  maxWidth: 'calc(100vw - 32px)',
  maxHeight: 'calc(100vh - 32px)',
  boxSizing: 'border-box',

  background: palette.panel,
  border: `1px solid ${palette.panelBorder}`,
  borderRadius: 6,
  color: palette.text,
  userSelect: 'none',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '9px 12px',
  borderBottom: `1px solid ${palette.panelBorder}`,
  flex: '0 0 auto',
}

const titleStyle: CSSProperties = {
  fontSize: 11,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: palette.text,
  lineHeight: 1,
}

const captionStyle: CSSProperties = {
  fontSize: 10,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: palette.textDim,
  lineHeight: 1,
}

const numberStyle: CSSProperties = {
  fontFamily: MONO,
  fontSize: 11,
  color: palette.text,
}

const dimStyle: CSSProperties = {
  fontSize: 10,
  color: palette.textDim,
}

const ellipsis: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/** Две колонки: слева кто есть, справа — что он думает. */
const bodyStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  minHeight: 0,
  flex: '1 1 auto',
}

const listStyle: CSSProperties = {
  width: 244,
  flex: '0 0 auto',
  borderRight: `1px solid ${palette.panelBorder}`,
  overflowY: 'auto',
}

const feedColumnStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  minHeight: 0,
  flex: '1 1 auto',
}

/** Шкала доли рынка: подложка панели, заполнение — доля от всего пробега. */
const trackStyle: CSSProperties = {
  height: 3,
  borderRadius: 2,
  background: palette.panelBorder,
  overflow: 'hidden',
}

const fillStyle: CSSProperties = {
  height: '100%',
  borderRadius: 2,
  // Доля меняется медленно, поэтому переход не «анимация», а защита от
  // подёргивания на каждом тике.
  transition: 'width 240ms, background-color 240ms',
}

function closeButtonStyle(hovered: boolean): CSSProperties {
  return {
    width: 22,
    height: 22,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    background: 'transparent',
    border: 'none',
    color: hovered ? palette.text : palette.textDim,
    font: `16px/1 ${MONO}`,
    cursor: 'pointer',
    transition: 'color 120ms',
  }
}

// ─── Компонент ─────────────────────────────────────────────────────────────

export function RivalPanel(): JSX.Element {
  /*
   * ОТКРЫТОСТЬ ЖИВЁТ В useState, как в панели узких мест: дверь сюда одна — своя
   * кнопка вызова. Общий store нужен там, где дверей две (панель парка
   * открывается ещё и из панели компании); заводить его «на будущее» значило бы
   * положить состояние снаружи компонента без единого потребителя снаружи.
   */
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)
  /** Чья лента открыта. null — ещё не выбирали, покажем сильнейшего соперника. */
  const [chosen, setChosen] = useState<CompanyId | null>(null)

  /*
   * ПОДПИСКА НА ВСЁ СОСТОЯНИЕ, и это здесь правильно, хотя соседние панели
   * подписываются по одному полю: разбор смотрит на компании, на парк и на
   * города разом, а доля рынка и лента обязаны быть свежими каждый тик. Узкие
   * селекторы дали бы ту же частоту перерисовки — парк меняется каждый тик, —
   * только тремя подписками вместо одной.
   */
  const state = useGameStore((store) => store.state)

  /*
   * Выбор города — общий store (ui/selection.ts): клик по городу в чужой сети
   * открывает его карточку и подсвечивает город на карте. Своей идеи о выборе
   * панель не заводит.
   */
  const selectCity = useSelection((store) => store.select)

  /*
   * Escape закрывает панель — общая привычка для всего, что открывается поверх.
   * Подписка ставится один раз: панель смонтирована всегда (в свёрнутом виде это
   * её кнопка), а значение меняется функцией от предыдущего, потому что замыкание
   * с пустым списком зависимостей помнит `open` таким, каким он был при первом
   * рендере.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen((was) => (was ? false : was))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const rows = useMemo(() => rivalRows(state), [state])
  const summary = useMemo(() => rivalSummary(rows), [rows])

  /*
   * Кого показываем в ленте. Выбранного игроком, если он ещё в списке; иначе —
   * сильнейшего соперника, то есть первую строку не-игрока (список отсортирован
   * по доле рынка). Панель, открывшаяся с пустой лентой, потребовала бы клика
   * прежде, чем показать хоть что-то, — а открывают её ради ленты.
   */
  const rivals = useMemo(() => rows.filter((row) => !row.isPlayer), [rows])
  const currentId =
    chosen !== null && rivals.some((row) => row.id === chosen)
      ? chosen
      : (rivals[0]?.id ?? null)
  const current = rows.find((row) => row.id === currentId) ?? null

  const feed = useMemo(
    () =>
      currentId === null
        ? []
        : thoughtFeed(state.companies[currentId], state.startYear),
    [currentId, state],
  )

  const network = useMemo(
    () =>
      currentId === null
        ? { lines: [], cities: [] }
        : networkOf(state, currentId),
    [currentId, state],
  )

  /*
   * Свёрнутое состояние стоит ПОСЛЕ всех хуков: React требует одинакового числа
   * вызовов на каждом рендере, а ранний выход до useMemo менял бы их порядок
   * между открытой и закрытой панелью. Тот же порядок и в соседних панелях.
   *
   * Свёрнутая панель продолжает считать доли — это её единственная работа, пока
   * на неё не смотрят, и делает она её ради кнопки: та обязана сообщать, что
   * соперник вышел вперёд, не открывая ничего.
   */
  if (!open) {
    const alarm = summary.leader !== null

    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        onMouseEnter={() => setHovered('launcher')}
        onMouseLeave={() => setHovered(null)}
        style={launcherStyle(alarm, hovered === 'launcher')}
        title={
          alarm
            ? `${summary.leader?.name} возит больше вас: доля ${fmtShare(
                summary.leader?.share ?? null,
              )} против ваших ${fmtShare(summary.playerShare)}`
            : 'Соперники: кто на карте, где работает и о чём думает'
        }
      >
        соперники
        <span style={{ color: alarm ? palette.accent : palette.textDim }}>
          {alarm
            ? `впереди ${summary.leader?.name}`
            : `${summary.alive} ${plural(summary.alive, COMPANY_FORMS)}`}
        </span>
      </button>
    )
  }

  return (
    <div style={panelStyle}>
      {/* ─── Шапка ──────────────────────────────────────────────────── */}
      <div style={headerStyle}>
        <div style={{ ...titleStyle, flex: '1 1 auto' }}>соперники</div>

        <span style={{ ...numberStyle, color: palette.textDim }}>
          {rows.length} {plural(rows.length, COMPANY_FORMS)} · доля по гружёному
          пробегу
        </span>

        <button
          type="button"
          onClick={() => setOpen(false)}
          onMouseEnter={() => setHovered('close')}
          onMouseLeave={() => setHovered(null)}
          style={closeButtonStyle(hovered === 'close')}
          aria-label="Закрыть"
          title="Закрыть (Esc)"
        >
          ×
        </button>
      </div>

      {/*
        ОГОВОРКА О ВИДИМОСТИ СТОИТ В ПАНЕЛИ, А НЕ В КОММЕНТАРИИ К КОДУ. Игрок
        сравнивает своё «вложено» с чужим и обязан знать, что это за число и
        почему рядом нет чужого счёта. Без этой строки колонка читалась бы как
        деньги конкурента, и вся честность разбора обернулась бы враньём в
        интерфейсе.
      */}
      <div
        style={{
          padding: '7px 12px',
          borderBottom: `1px solid ${palette.panelBorder}`,
          fontSize: 10,
          lineHeight: 1.4,
          color: palette.textDim,
          flex: '0 0 auto',
        }}
      >
        видно то, что видно с обочины: машины, кольца, города и бетон. Остаток на
        чужом счету — коммерческая тайна, поэтому в списке стоит{' '}
        <span style={{ color: palette.text }}>вложено</span> — прайсовая цена
        парка и построек, без учёта износа.
      </div>

      <div style={bodyStyle}>
        {/* ─── Кто есть на карте ────────────────────────────────────── */}
        <div style={listStyle}>
          {rows.map((row) => (
            <CompanyRow
              key={row.id}
              row={row}
              playerShare={summary.playerShare}
              selected={row.id === currentId}
              hovered={hovered === `company-${row.id}`}
              onHover={(on) => setHovered(on ? `company-${row.id}` : null)}
              onSelect={() => setChosen(row.id)}
            />
          ))}
        </div>

        {/* ─── Что он думает ────────────────────────────────────────── */}
        <div style={feedColumnStyle}>
          {current === null ? (
            <div style={{ padding: 12, fontSize: 11, lineHeight: 1.4 }}>
              соперников на карте нет — партия идёт в одиночку.
            </div>
          ) : (
            <>
              <RivalHeader row={current} />

              <Network
                lines={network.lines}
                cities={network.cities}
                onCity={selectCity}
                hovered={hovered}
                onHover={setHovered}
              />

              <Feed entries={feed} name={current.name} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Строка компании ───────────────────────────────────────────────────────

/**
 * Одна контора в списке.
 *
 * СТРОКА ИГРОКА НЕ КНОПКА. У него нет ленты и быть не может — он и есть тот, кто
 * решает; кнопка, которая ничего не открывает, обманывает ожидание и учит не
 * доверять остальным. Отличает его при этом не оформление строки, а
 * двухбуквенная пометка «вы» в акценте: искать себя в списке из четырёх контор
 * игрок не должен, а заливать ради этого целую строку — значит потратить
 * единственный тёплый цвет игры на то, что и так подписано.
 *
 * АКЦЕНТ В ШКАЛЕ ДОЛИ ДОСТАЁТСЯ ТОЛЬКО ТОМУ, КТО ВОЗИТ БОЛЬШЕ ИГРОКА. Это
 * единственная тревога, которую панель умеет сообщить, и подсветить каждую
 * строку значило бы не подсветить ни одной.
 */
function CompanyRow({
  row,
  playerShare,
  selected,
  hovered,
  onHover,
  onSelect,
}: {
  row: RivalRow
  playerShare: number | null
  selected: boolean
  hovered: boolean
  onHover: (on: boolean) => void
  onSelect: () => void
}): JSX.Element {
  const ahead =
    !row.isPlayer &&
    !row.bankrupt &&
    row.share !== null &&
    (playerShare === null || row.share > playerShare)

  const barColor = row.bankrupt
    ? palette.panelBorder
    : ahead
      ? palette.accent
      : row.isPlayer
        ? palette.text
        : palette.textDim

  const body = (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span
          style={{
            ...ellipsis,
            fontSize: 12,
            flex: '1 1 auto',
            color: row.bankrupt
              ? palette.textDim
              : selected
                ? palette.accent
                : palette.text,
            textDecoration: row.bankrupt ? 'line-through' : 'none',
          }}
        >
          {row.name}
        </span>

        {row.isPlayer ? (
          <span style={{ ...dimStyle, color: palette.accent, flex: '0 0 auto' }}>
            вы
          </span>
        ) : (
          <span style={{ ...dimStyle, flex: '0 0 auto' }}>
            {row.bankrupt ? 'разорена' : (row.personality ?? 'без характера')}
          </span>
        )}
      </div>

      <div
        style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}
        title={
          row.share === null
            ? 'Доля рынка: никто ещё не проехал ни одного гружёного километра'
            : `Доля рынка по гружёному пробегу: ${fmtInteger(
                row.loadedKm,
              )} км с грузом. Тонно-километров в игре не считается — сколько тонн было в кузове на каждом километре, состояние не помнит`
        }
      >
        <span
          style={{
            fontFamily: MONO,
            fontSize: 15,
            lineHeight: 1,
            color: row.share === null ? palette.textDim : barColor,
          }}
        >
          {fmtShare(row.share)}
        </span>
        <span style={{ ...dimStyle, marginRight: 'auto' }}>доля</span>

        <span style={{ ...numberStyle, color: palette.textDim, fontSize: 10 }}>
          {row.fleet} {plural(row.fleet, VEHICLE_FORMS)} · {row.lines}{' '}
          {plural(row.lines, LINE_FORMS)}
        </span>
      </div>

      <div style={trackStyle}>
        <div
          style={{
            ...fillStyle,
            width: `${(row.share ?? 0) * 100}%`,
            background: barColor,
          }}
        />
      </div>

      {/*
        Нижний ярус ПЕРЕНОСИТСЯ ПО СЛОВАМ. Колонка узкая (244), а строк здесь до
        трёх, и любая из них может отсутствовать: у соперника нет счёта, у игрока
        нет стоящих машин, порожний пробег пропадает до первого рейса. Ряд с
        переносом переживает любое сочетание; ряд без переноса выдавил бы одно из
        значений за край ровно в той партии, где оно важно.
      */}
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          flexWrap: 'wrap',
          columnGap: 8,
          rowGap: 3,
        }}
      >
        <span style={dimStyle}>
          вложено{' '}
          <span style={{ fontFamily: MONO, color: palette.text }}>
            {fmtInteger(row.invested)}
          </span>
        </span>

        {/*
          ПОРОЖНИЙ ПРОБЕГ СОПЕРНИКА ПОКАЗЫВАЕТСЯ, И ЭТО ЗАКОННО: гружёная фура
          отличима от порожней с той же обочины, с которой видно саму фуру (на
          карте это ровно то же самое — прицеп красится по грузу). Заодно это
          единственная в панели мерка МАСТЕРСТВА: доля рынка говорит, кто
          крупнее, а порожняк — кто возит лучше.
        */}
        {row.empty !== null && (
          <span style={dimStyle}>
            порожняк{' '}
            <span style={{ fontFamily: MONO, color: palette.text }}>
              {fmtShare(row.empty)}
            </span>
          </span>
        )}

        {/*
          НА СЧЕТУ — ТОЛЬКО У ИГРОКА, и это не оформление, а следствие разбора:
          у остальных строк money равен null, потому что чужой счёт снаружи не
          виден (ui/rivalReadout.ts). Своё же игрок видит здесь потому, что
          сравнивать вложение с остатком имеет смысл только у себя.
        */}
        {row.money !== null && (
          <span style={dimStyle}>
            на счету{' '}
            <span
              style={{
                fontFamily: MONO,
                color: row.money < 0 ? palette.accent : palette.text,
              }}
            >
              {fmtInteger(row.money)}
            </span>
          </span>
        )}

        {/*
          Стоящие машины — единственная беда соперника, которую игроку
          показывают: грузовик у обочины виден с той же обочины, что и едущий.
        */}
        {row.money === null && row.stalled > 0 && (
          <span style={{ ...dimStyle, color: palette.accentDim }}>
            {row.stalled} {plural(row.stalled, VEHICLE_FORMS)} стоит
          </span>
        )}
      </div>
    </>
  )

  const frame: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 5,
    width: '100%',
    padding: '8px 10px 9px',
    boxSizing: 'border-box',
    textAlign: 'left',
    borderTop: `1px solid ${palette.panelBorder}`,
    borderRight: 'none',
    borderBottom: 'none',
    // Выбор обозначен левой риской, как в списке линий панели компании:
    // заливка акцентом на всю ширину превратила бы колонку в оранжевую полосу.
    borderLeft: `2px solid ${selected ? palette.accent : 'transparent'}`,
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
  }

  if (row.isPlayer) {
    return <div style={frame}>{body}</div>
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={{ ...frame, cursor: 'pointer', opacity: hovered || selected ? 1 : 0.92 }}
      aria-pressed={selected}
      title={`Читать ленту рассуждений: ${row.name}`}
    >
      {body}
    </button>
  )
}

// ─── Шапка соперника ───────────────────────────────────────────────────────

/**
 * Кто перед нами и кто им управляет.
 *
 * ДВЕ РАЗНЫЕ ЧЕСТНОСТИ СТОЯТ РЯДОМ И НЕ ПОДМЕНЯЮТ ДРУГ ДРУГА. «Ведёт модель» —
 * это про то, кто отвечает за компанию сейчас (Company.controller). «Столько-то
 * записей из стольких-то от модели» — про то, что игрок в этой ленте читает.
 * Совпадать они не обязаны: канал может отвалиться на одном ответе из десяти, и
 * тогда компанию по-прежнему ведёт модель, а конкретную мысль подставил скрипт.
 */
function RivalHeader({ row }: { row: RivalRow }): JSX.Element {
  const byModel =
    row.thoughts === 0
      ? 'модель ещё ничего не сказала'
      : `${row.fromModel} из ${row.thoughts} ${plural(
          row.thoughts,
          ENTRY_FORMS,
        )} от модели`

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        padding: '9px 12px',
        borderBottom: `1px solid ${palette.panelBorder}`,
        flex: '0 0 auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ ...ellipsis, fontSize: 13, flex: '1 1 auto' }}>
          {row.name}
        </span>
        <span style={{ ...dimStyle, flex: '0 0 auto' }}>
          {row.personality ?? 'без характера'}
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
          flexWrap: 'wrap',
          fontSize: 10,
          color: palette.textDim,
        }}
      >
        <span
          title={
            row.controller === 'модель'
              ? 'Решения этой конторы запрашиваются у языковой модели. Не дозвонились или ответ не разобран — ход подставляет скрипт, и запись в ленте это скажет'
              : 'Решения этой конторы принимает скриптовая эвристика игры. Так работает партия без ключа, без сети и в прогоне баланса'
          }
        >
          ведёт{' '}
          <span style={{ color: palette.text }}>
            {row.controller === 'модель' ? 'модель' : 'скрипт'}
          </span>
        </span>

        <span>{byModel}</span>

        {row.bankrupt && (
          <span style={{ color: palette.textDim }}>
            контора закрыта — партия для неё окончена
          </span>
        )}
      </div>
    </div>
  )
}

// ─── Где он работает ───────────────────────────────────────────────────────

/**
 * Сеть соперника: кольца, города и бетон.
 *
 * ЭТО ОТВЕТ НА «КУДА ОН ЛЕЗЕТ», а не чужой редактор линий. Названы города по
 * порядку обхода и грузы, которые кольцо берёт, — то, из чего игрок решает,
 * драться за направление или уходить в свободное. Что именно соперник грузит на
 * третьей остановке, к этому решению ничего не добавляет.
 *
 * ГОРОД КЛИКАБЕЛЕН и открывает карточку города: «он работает в Туле» без
 * возможности посмотреть Тулу — это сообщение, за которым надо идти искать город
 * на карте руками.
 */
function Network({
  lines,
  cities,
  onCity,
  hovered,
  onHover,
}: {
  lines: ReturnType<typeof networkOf>['lines']
  cities: ReturnType<typeof networkOf>['cities']
  onCity: (city: CityId) => void
  hovered: string | null
  onHover: (key: string | null) => void
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '9px 12px',
        borderBottom: `1px solid ${palette.panelBorder}`,
        flex: '0 0 auto',
        maxHeight: 168,
        overflowY: 'auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ ...captionStyle, flex: '1 1 auto' }}>где работает</span>
        <span style={{ ...numberStyle, fontSize: 10, color: palette.textDim }}>
          {lines.length} {plural(lines.length, LINE_FORMS)} · {cities.length}{' '}
          {plural(cities.length, CITY_FORMS)}
        </span>
      </div>

      {lines.length === 0 ? (
        <div style={{ fontSize: 11, lineHeight: 1.4, color: palette.text }}>
          {/*
            Пустое место ГОВОРИТ СЛОВАМИ: отсутствие колец у соперника — это не
            «не загрузилось», а состояние, из которого следует вывод. Направления
            пока свободны, и это ровно та новость, ради которой стоит смотреть.
          */}
          колец пока нет — он ещё выбирает направление.
        </div>
      ) : (
        lines.map((line) => (
          <div
            key={line.id}
            style={{ display: 'flex', flexDirection: 'column', gap: 3 }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ ...ellipsis, fontSize: 11, flex: '1 1 auto' }}>
                {line.name}
              </span>
              <span
                style={{
                  ...numberStyle,
                  fontSize: 10,
                  flex: '0 0 auto',
                  color:
                    line.vehicles === 0 ? palette.accentDim : palette.textDim,
                }}
              >
                {line.vehicles === 0
                  ? 'без машин'
                  : `${line.vehicles} ${plural(line.vehicles, VEHICLE_FORMS)}`}
              </span>
            </div>

            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'baseline',
                gap: 4,
                fontSize: 10,
                color: palette.textDim,
              }}
            >
              {line.cities.map((city, index) => (
                <span key={`${line.id}-${city.id}-${index}`}>
                  {index > 0 && <span style={{ paddingRight: 4 }}>→</span>}
                  <CityLink
                    id={city.id}
                    name={city.name}
                    building={
                      cities.find((entry) => entry.id === city.id)?.building ??
                      null
                    }
                    hovered={hovered === `city-${line.id}-${index}`}
                    onHover={(on) =>
                      onHover(on ? `city-${line.id}-${index}` : null)
                    }
                    onSelect={() => onCity(city.id)}
                  />
                </span>
              ))}

              {line.cargo.length > 0 && (
                <span style={{ paddingLeft: 4 }}>· {line.cargo.join(', ')}</span>
              )}
            </div>
          </div>
        ))
      )}

      {/*
        Города, где у соперника только бетон и ни одной остановки. Терминал без
        кольца — это заявка на будущее плечо, и увидеть её игрок должен раньше,
        чем оно откроется.
      */}
      {cities.some((city) => city.building !== null) && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
            fontSize: 10,
            color: palette.textDim,
          }}
        >
          <span>его бетон:</span>
          {cities
            .filter((city) => city.building !== null)
            .map((city) => (
              <span key={`concrete-${city.id}`}>
                <CityLink
                  id={city.id}
                  name={city.name}
                  building={city.building}
                  hovered={hovered === `concrete-${city.id}`}
                  onHover={(on) => onHover(on ? `concrete-${city.id}` : null)}
                  onSelect={() => onCity(city.id)}
                />
              </span>
            ))}
        </div>
      )}
    </div>
  )
}

/** Название города — кнопка: открывает карточку и подсвечивает город на карте. */
function CityLink({
  id,
  name,
  building,
  hovered,
  onHover,
  onSelect,
}: {
  id: CityId
  name: string
  building: string | null
  hovered: boolean
  onHover: (on: boolean) => void
  onSelect: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={{
        padding: 0,
        background: 'transparent',
        border: 'none',
        borderBottom: `1px dotted ${
          building === null ? palette.panelBorder : palette.accentDim
        }`,
        color: hovered ? palette.text : palette.textDim,
        font: 'inherit',
        cursor: 'pointer',
        transition: 'color 120ms',
      }}
      title={
        building === null
          ? `Открыть карточку города ${name}`
          : `В городе ${name} стоит его ${building}`
      }
      data-city={id}
    >
      {name}
    </button>
  )
}

// ─── Лента рассуждений ─────────────────────────────────────────────────────

/**
 * Главное содержимое панели.
 *
 * Занимает всю оставшуюся высоту и прокручивается сама: остальные разделы
 * фиксированы по высоте именно ради этого. Свежее сверху — мысль, объясняющая то,
 * что происходит на карте прямо сейчас, не должна требовать прокрутки.
 */
function Feed({
  entries,
  name,
}: {
  entries: ReturnType<typeof thoughtFeed>
  name: string
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 120,
        flex: '1 1 auto',
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          ...captionStyle,
          padding: '9px 12px 6px',
          position: 'sticky',
          top: 0,
          background: palette.panel,
        }}
      >
        лента рассуждений
      </div>

      {entries.length === 0 ? (
        <div
          style={{
            padding: '0 12px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <div style={{ fontSize: 11, lineHeight: 1.4, color: palette.text }}>
            {name} ещё ничего не решал.
          </div>
          {/*
            Пустая лента ГОВОРИТ СЛОВАМИ и называет срок. Молчащий соперник
            выглядит как несработавшая фича; названный срок превращает его в
            ожидание — игрок знает, когда посмотреть снова.
          */}
          <div style={{ ...dimStyle, lineHeight: 1.4 }}>
            Решения принимаются раз в игровые сутки, первое — в конце первых.
            Дальше здесь будет видно, зачем он строит кольца и почему бросает.
          </div>
        </div>
      ) : (
        entries.map((entry) => (
          <div
            key={entry.key}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              padding: '7px 12px 8px',
              borderTop: `1px solid ${palette.panelBorder}`,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span
                style={{
                  ...numberStyle,
                  fontSize: 10,
                  color: palette.textDim,
                  flex: '1 1 auto',
                }}
              >
                {entry.when}
              </span>

              {/*
                ПОМЕТКА ИСТОЧНИКА — СЛОВОМ, А НЕ ЦВЕТОМ И НЕ ЗНАЧКОМ. Разница
                между «подумала модель» и «подставил скрипт» существенна для
                доверия ко всему, что игрок читает ниже, а сведения, выраженные
                одним оттенком, не читаются ни в скриншоте, ни половиной людей.
                Акцент пометка не берёт: она обязана быть ЧИТАЕМОЙ, а не громкой,
                иначе панель начнёт хвалиться моделью вместо того, чтобы честно
                отчитываться.
              */}
              <span
                style={{
                  ...dimStyle,
                  flex: '0 0 auto',
                  color: entry.fromModel ? palette.text : palette.textDim,
                }}
                title={
                  entry.fromModel
                    ? 'Это рассуждение вернула языковая модель вместе с командами'
                    : 'Модель не ответила или ответ не разобран — ход и объяснение подставил скриптовый конкурент. Игра продолжается без сети'
                }
              >
                {entry.fromModel ? 'модель' : 'скрипт'}
              </span>
            </div>

            <div style={{ fontSize: 12, lineHeight: 1.45, color: palette.text }}>
              {entry.text}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
