/**
 * Панель узких мест — главный экран среза 5.
 *
 * Отвечает на один вопрос: ГДЕ МОЯ СЕТЬ СТОИТ. До этого среза такого вопроса не
 * существовало вовсе — погрузка была мгновенной, узлы принимали сколько угодно
 * машин разом, и единственным ответом на любую задачу было «купить ещё
 * грузовик». Теперь у сети есть пропускная способность, и у игрока впервые
 * появилась беда, которую покупкой машины не чинят: очередь. Эта панель — то
 * место, где беду видно.
 *
 * ─── ПОЧЕМУ ЗДЕСЬ РУБЛИ, А НЕ ТИКИ ────────────────────────────────────────
 *
 * «Машина ждёт 14 тиков» не сравнимо ни с ценой терминала, ни с его
 * содержанием, ни с очередью в соседнем городе — то есть не помогает принять ни
 * одного решения. Рубли сравнимы со всем сразу: «эта очередь жжёт 1 750 в
 * сутки, терминал стоит 900 в сутки» — и решение готово, считать в уме ничего
 * не надо. Ровно поэтому и сортировка по деньгам, а не по алфавиту: сверху то,
 * что дороже всего обходится, потому что панель отвечает не «где очереди», а
 * «куда бежать первым делом».
 *
 * ЧЕСТНАЯ ОГОВОРКА СТОИТ ПРЯМО В ПАНЕЛИ, а не в комментарии. Показанные рубли —
 * это ЗАРПЛАТА, уплаченная за стояние, и только она: топливо и обслуживание в
 * игре начисляются по километрам, а стоящая машина не проезжает ни метра.
 * Упущенная выручка сверху, и её панель не выдумывает — считать её нечем, а
 * вторая экономическая модель в интерфейсе разошлась бы с симуляцией молча
 * (полный разбор — в шапке ui/bottleneckReadout.ts). Из этого следует главное
 * свойство оценки окупаемости: она ЗАВЫШЕНА, и «окупится за 106 суток» читается
 * как «не дольше чем за 106».
 *
 * ─── ЧТО ПРЕВРАЩАЕТ ОТЧЁТ В ИНСТРУМЕНТ ────────────────────────────────────
 *
 * Кнопка терминала стоит В САМОЙ СТРОКЕ ГОРОДА, вместе с ценой, содержанием и
 * сроком окупаемости. Панель, которая говорит «в Туле очередь» и отправляет
 * искать Тулу на карте, экономит один клик ценой всего смысла: игрок принимает
 * решение там, где видит числа, а не там, где нашёл город.
 *
 * Название города при этом кликабельно и ОТКРЫВАЕТ КАРТОЧКУ ГОРОДА, где живут
 * остальные постройки, снос и диагноз предприятий. Разделение простое: здесь
 * ответ на «расшить это узкое место», там — на «что вообще делать с этим
 * городом».
 *
 * ─── АКЦЕНТ ───────────────────────────────────────────────────────────────
 *
 * Единственный тёплый цвет игры тратится ровно на ОДНО: деньги, которые горят
 * прямо сейчас. Ставка простоя, полоса в шапке и кнопка вызова, когда сеть
 * стоит. Всё остальное — приглушённым: подсветить каждую строку значит не
 * подсветить ничего, и настоящая пробка утонет среди мелких заминок.
 *
 * ПУСТАЯ ПАНЕЛЬ ГОВОРИТ СЛОВАМИ. Очередей нет — так и написано, вместе с тем,
 * что это значит: сеть нигде не упирается в посты, и терминал сейчас был бы
 * чистым расходом. Пустой список читался бы как «не загрузилось».
 *
 * НИ ОДНОГО ЧИСЛА ПАНЕЛЬ НЕ СЧИТАЕТ ПО-СВОЕМУ: всё приходит из
 * ui/bottleneckReadout.ts, а он зовёт симуляцию. Здесь только разметка, цвета и
 * решения о том, что показать первым.
 *
 * Стили заданы прямо в разметке — по той же причине, что и в соседних панелях:
 * источник цветов ровно один (render/palette.ts). Долг по общему слою
 * оформления (MONO, withAlpha, кнопка) к этой панели вырос до пятой копии и
 * просится в ui/theme.ts — но выносить его должен тот, кто правит все панели
 * разом, иначе получится шестая копия под другим именем.
 */

import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, JSX } from 'react'

import { useGameStore } from '../app/store'
import { palette } from '../render/palette'
import {
  RELIEF_BUILDING,
  bottleneckRows,
  bottleneckSummary,
  fmtWait,
  type BuildOffer,
  type CityQueue,
  type QueueEntry,
} from './bottleneckReadout'
import { fmtInteger, plural } from './fleetReadout'
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

const CITY_FORMS = ['город', 'города', 'городов'] as const
const VEHICLE_FORMS = ['машина', 'машины', 'машин'] as const
const POST_FORMS = ['пост', 'поста', 'постов'] as const
/** Сказуемое склоняется вместе с числом: «1 ждёт», «2 ждут». */
const WAIT_FORMS = ['ждёт', 'ждут', 'ждут'] as const

// ─── Стили ─────────────────────────────────────────────────────────────────

/**
 * Кнопка вызова свёрнутой панели.
 *
 * СВЕРХУ ПО ЦЕНТРУ — единственное свободное место на экране: верхние углы заняты
 * временем и карточкой города, нижние — панелью компании и редактором линий, а
 * низ по центру взяла кнопка парка. Заодно панель разворачивается ровно оттуда,
 * где стояла кнопка, и движение получается на месте, а не через весь кадр.
 *
 * АКЦЕНТ КНОПКА БЕРЁТ, ТОЛЬКО КОГДА ГДЕ-ТО СТОИТ ОЧЕРЕДЬ. Это и есть повод
 * оторвать игрока от карты; горящая постоянно, она перестала бы что-либо значить
 * через десять минут игры — тот же довод, что у кнопки парка.
 */
function launcherStyle(alarm: boolean, hovered: boolean): CSSProperties {
  return {
    position: 'fixed',
    left: '50%',
    top: 16,
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

/**
 * Развёрнутая панель растёт ВНИЗ ОТ ВЕРХНЕГО КРАЯ, а не занимает середину.
 *
 * Разница с панелью парка содержательная, а не вкусовая. Парк — рабочий экран,
 * за которым сидят, и карта на это время не нужна. Узкие места читают, ГЛЯДЯ НА
 * КАРТУ: игрок видит «Тула, две машины ждут» и тут же ищет глазами, как
 * перевесить кольцо. Панель шириной 460 у верхнего края оставляет свободными и
 * низ кадра, и правый край, где откроется карточка города по клику на строке.
 */
const panelStyle: CSSProperties = {
  position: 'fixed',
  left: '50%',
  top: 16,
  transform: 'translateX(-50%)',
  zIndex: 11,

  display: 'flex',
  flexDirection: 'column',
  width: 460,
  maxWidth: 'calc(100vw - 32px)',
  maxHeight: 'calc(100vh - 32px)',
  boxSizing: 'border-box',

  background: palette.panel,
  border: `1px solid ${palette.panelBorder}`,
  borderRadius: 6,
  color: palette.text,

  // Приборная доска: выделение мышью здесь только мешает, особенно когда мимо
  // панели тащат камеру.
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

/** Подпись раздела: разрядка вместо жирности, как в карточке города. */
const captionStyle: CSSProperties = {
  fontSize: 9,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: palette.textDim,
  lineHeight: 1,
}

const bodyStyle: CSSProperties = {
  flex: '1 1 auto',
  overflowY: 'auto',
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

/** Кнопка панели. Форма от кнопок парка — разбор состояний там же. */
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
      active
        ? palette.accent
        : enabled && hovered
          ? palette.text
          : palette.panelBorder
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
 * Название города — кнопка, а не заголовок: она открывает карточку города.
 *
 * Подчёркивания нет, отклик держится на цвете и левой риске: панель набрана в
 * одном кегле, и подчёркнутая строка в ней выглядела бы ссылкой из документа, а
 * не элементом приборной доски.
 */
function cityButtonStyle(hovered: boolean): CSSProperties {
  return {
    flex: '1 1 auto',
    minWidth: 0,
    textAlign: 'left',
    padding: 0,
    background: 'transparent',
    border: 'none',
    color: hovered ? palette.accent : palette.text,
    // Шрифт наследуется от панели, а не задаётся сокращением: сокращение `font`
    // требует семейство, и написать в нём `inherit` нельзя — правило целиком
    // окажется недействительным, а кнопка молча съедет на шрифт браузера.
    fontFamily: 'inherit',
    fontSize: 13,
    lineHeight: 1.2,
    letterSpacing: '0.02em',
    cursor: 'pointer',
    transition: 'color 120ms',
    ...ellipsis,
  }
}

/** Шкала занятости постов: заполнение — доля занятых, риска — граница постов. */
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

// ─── Панель ────────────────────────────────────────────────────────────────

export function BottleneckPanel(): JSX.Element {
  /*
   * ОТКРЫТОСТЬ ЖИВЁТ В useState, а не в отдельном store, — в отличие от панели
   * парка. Разница ровно в числе дверей: в парк ведут две (своя кнопка и строка
   * панели компании), и общий флаг там обязателен, иначе две копии состояния
   * разойдутся. Сюда дверь одна, и заводить общий store «на будущее» значило бы
   * положить состояние снаружи компонента без единого потребителя снаружи.
   */
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)

  /*
   * ПОДПИСКА НА ВСЁ СОСТОЯНИЕ, и это здесь правильно, хотя соседние панели
   * подписываются по одному полю. Разбор очереди смотрит на парк, на компании и
   * на постройки разом (bottleneckRows принимает GameState целиком), а очередь
   * обязана быть свежей каждый тик: панель, показывающая вчерашнюю пробку, хуже
   * отсутствующей. Узкие селекторы дали бы ровно ту же частоту перерисовки —
   * парк меняется каждый тик, — только тремя подписками вместо одной.
   */
  const state = useGameStore((store) => store.state)
  const playerId = useGameStore((store) => store.state.playerId)
  const build = useGameStore((store) => store.build)

  /*
   * Выбор города — общий store (ui/selection.ts): по клику на строке
   * открывается карточка города, и она же подсвечивает город на карте. Своей
   * идеи о выборе панель не заводит.
   */
  const selectCity = useSelection((store) => store.select)
  const selectedCity = useSelection((store) => store.city)

  /*
   * Escape закрывает панель — общая привычка для всего, что открывается поверх.
   *
   * Подписка ставится ОДИН РАЗ на всё время жизни компонента: панель
   * смонтирована всегда (в свёрнутом виде это её кнопка вызова), и
   * переподписывать обработчик на каждое открытие незачем. Поэтому же значение
   * меняется функцией от предыдущего, а не сравнением с `open`: замыкание с
   * пустым списком зависимостей помнит `open` таким, каким он был при первом
   * рендере, и проверка по нему врала бы всю партию. Возврат того же значения
   * подписчиков не будит, так что нажатие Escape при закрытой панели не стоит
   * ничего.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen((was) => (was ? false : was))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const rows = useMemo(
    () => bottleneckRows(state, playerId),
    [state, playerId],
  )
  const summary = useMemo(() => bottleneckSummary(rows), [rows])

  /*
   * Свёрнутое состояние стоит ПОСЛЕ всех хуков: React требует одинакового
   * порядка вызовов на каждом рендере, а ранний выход до useMemo менял бы их
   * число между открытой и закрытой панелью. Тот же порядок и в панели парка.
   *
   * Свёрнутая панель продолжает считать очереди — это единственная работа,
   * которую она делает, пока на неё не смотрят, и делает она её ради кнопки:
   * та обязана сообщать беду, не открывая ничего.
   */
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        onMouseEnter={() => setHovered('launcher')}
        onMouseLeave={() => setHovered(null)}
        style={launcherStyle(summary.waiting > 0, hovered === 'launcher')}
        title={
          summary.waiting > 0
            ? `Узкие места: ${summary.waiting} ${plural(
                summary.waiting,
                VEHICLE_FORMS,
              )} стоят в очереди на пост`
            : 'Узкие места: где сеть упирается в пропускную способность'
        }
      >
        узкие места
        {/*
          На кнопке либо тишина, либо цена простоя. Число машин без денег
          сообщало бы половину: две ждущие машины в разных концах карты стоят
          по-разному, и решает именно рубль в сутки.
        */}
        <span
          style={{
            color: summary.waiting > 0 ? palette.accent : palette.textDim,
          }}
        >
          {summary.waiting > 0
            ? `${fmtInteger(summary.lostPerDay)} руб/сут`
            : 'нет очередей'}
        </span>
      </button>
    )
  }

  return (
    <div style={panelStyle}>
      {/* ─── Шапка ──────────────────────────────────────────────────── */}
      <div style={headerStyle}>
        <div style={{ ...titleStyle, flex: '1 1 auto' }}>узкие места</div>

        <span style={{ ...numberStyle, color: palette.textDim }}>
          {summary.cities} {plural(summary.cities, CITY_FORMS)} ·{' '}
          {summary.waiting} {plural(summary.waiting, VEHICLE_FORMS)}
        </span>

        <button
          type="button"
          onClick={() => setOpen(false)}
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
        ПОЛОСА ГОРЯЩИХ ДЕНЕГ. Ставка простоя всей сети — единственное число,
        ради которого панель вообще открывают, и стоит оно выше любых
        подробностей. Пока очередей нет, полосы нет вовсе: панель молчит, когда
        молчать правильно.
      */}
      {summary.waiting > 0 && (
        <div
          style={{
            padding: '7px 12px',
            background: ACCENT_WASH,
            borderBottom: `1px solid ${palette.accent}`,
            color: palette.accent,
            fontSize: 11,
            lineHeight: 1.35,
            flex: '0 0 auto',
          }}
        >
          очередь жжёт {fmtInteger(summary.lostPerDay)} руб/сут — уже{' '}
          {fmtInteger(summary.lost)} руб за нынешнее стояние
          <div style={{ fontSize: 9, opacity: 0.8, marginTop: 3 }}>
            {/*
              Оговорка стоит в панели, а не в комментарии к коду: игрок обязан
              знать, что показанное — НИЖНЯЯ граница, иначе он решит, что
              очередь дешевле, чем она есть.
            */}
            это только зарплата за стояние — упущенная выручка сверху
          </div>
        </div>
      )}

      <div style={bodyStyle}>
        {rows.length === 0 ? (
          <div style={{ ...sectionStyle, borderBottom: 'none' }}>
            <span style={captionStyle}>очередей нет</span>
            {/*
              Пустая панель ГОВОРИТ СЛОВАМИ. «Ничего не найдено» читается как
              «не загрузилось»; здесь же сказано и что это значит, и что из
              этого следует, — то есть ответ на вопрос, с которым панель
              открывали.
            */}
            <div style={{ fontSize: 11, lineHeight: 1.4, color: palette.text }}>
              ни одна машина не ждёт поста: сеть нигде не упирается в
              пропускную способность.
            </div>
            <div style={{ ...dimStyle, lineHeight: 1.4 }}>
              Терминал сейчас был бы чистым расходом — {RELIEF_BUILDING} платит
              содержание каждые сутки до самого сноса. Очередь появится, когда на
              один узел выйдет больше машин, чем у него постов; тогда этот список
              и заполнится.
            </div>
          </div>
        ) : (
          rows.map((row) => (
            <QueueRow
              key={row.cityId}
              row={row}
              selected={row.cityId === selectedCity}
              hovered={hovered}
              onHover={setHovered}
              onSelect={() => selectCity(row.cityId)}
              onBuild={(type) => build(row.cityId, type)}
            />
          ))
        )}
      </div>
    </div>
  )
}

// ─── Строка города ─────────────────────────────────────────────────────────

/**
 * Один узел, в котором стоит очередь.
 *
 * Три яруса, и порядок в них не случаен. Первый — где и почём: город, посты,
 * цена простоя. Второй — кто именно стоит: без этого нельзя решить, чинится ли
 * беда перестройкой линий. Третий — чем расшить: терминал с ценой, содержанием и
 * сроком. Сверху вниз идёт от «насколько плохо» к «что делать».
 */
function QueueRow({
  row,
  selected,
  hovered,
  onHover,
  onSelect,
  onBuild,
}: {
  row: CityQueue
  selected: boolean
  hovered: string | null
  onHover: (key: string | null) => void
  onSelect: () => void
  onBuild: (type: BuildOffer['type']) => void
}): JSX.Element {
  const offer = row.offers.find((candidate) => candidate.type === RELIEF_BUILDING)

  /*
   * Шкала занятости узла. Заполнение — все машины, которые сейчас в узле при
   * деле (на постах плюс в очереди), масштаб — то же число или число постов,
   * смотря что больше. Риска стоит на границе постов, и именно она читается
   * мгновенно: всё, что вылезло за риску, — это и есть очередь.
   */
  const load = row.busy + row.waiting
  const scale = Math.max(load, row.posts, 1)

  return (
    <div
      style={{
        ...sectionStyle,
        borderLeft: `2px solid ${selected ? palette.accent : 'transparent'}`,
      }}
    >
      {/* ─── Ярус 1: где и почём ──────────────────────────────────────── */}
      <div style={rowStyle}>
        <button
          type="button"
          onClick={onSelect}
          onMouseEnter={() => onHover(`city-${row.cityId}`)}
          onMouseLeave={() => onHover(null)}
          style={cityButtonStyle(hovered === `city-${row.cityId}` || selected)}
          title={`Открыть карточку города ${row.cityName}: остальные постройки, снос и диагноз предприятий`}
        >
          {row.cityName}
        </button>

        <span style={{ ...numberStyle, color: palette.textDim }}>
          {row.posts} {plural(row.posts, POST_FORMS)} · {row.busy} на посту
        </span>
      </div>

      <div style={rowStyle}>
        {/*
          Ставка простоя — самое крупное число строки и единственное в акценте:
          это деньги, которые горят прямо сейчас. Накопленное за нынешнее
          стояние стоит рядом мельче — оно объясняет, насколько давно.
        */}
        <span
          style={{
            fontFamily: MONO,
            fontSize: 18,
            lineHeight: 1,
            color: row.lostPerDay > 0 ? palette.accent : palette.textDim,
          }}
          title="Зарплата, которую компания платит за то, что эти машины стоят в очереди. Топливо и обслуживание идут по километрам, поэтому стоящая машина их не тратит"
        >
          {fmtInteger(row.lostPerDay)}
        </span>
        <span style={{ ...dimStyle, marginRight: 'auto' }}>руб/сут</span>

        <span style={{ ...numberStyle, color: palette.textDim }}>
          уже {fmtInteger(row.lost)} руб · дольше всех {fmtWait(row.worstTicks)}
        </span>
      </div>

      <div style={trackStyle}>
        <div
          style={{
            ...fillStyle,
            width: `${(load / scale) * 100}%`,
            background: row.waiting > 0 ? palette.accent : palette.textDim,
          }}
        />
        {/* Риска на границе постов: всё, что правее, — очередь. */}
        <div style={{ ...tickStyle, left: `${(row.posts / scale) * 100}%` }} />
      </div>

      {/* ─── Ярус 2: чьи машины ───────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={rowStyle}>
          <span style={captionStyle}>
            {row.waiting} {plural(row.waiting, VEHICLE_FORMS)}{' '}
            {plural(row.waiting, WAIT_FORMS)}
          </span>
        </div>

        {row.entries.map((entry) => (
          <VehicleLine key={entry.id} entry={entry} />
        ))}
      </div>

      {/* ─── Ярус 3: чем расшить ──────────────────────────────────────── */}
      {offer !== undefined && (
        <ReliefOffer
          offer={offer}
          waiting={row.waiting}
          hovered={hovered === `build-${row.cityId}`}
          onHover={(on) => onHover(on ? `build-${row.cityId}` : null)}
          onBuild={() => onBuild(offer.type)}
        />
      )}
    </div>
  )
}

// ─── Машина в очереди ──────────────────────────────────────────────────────

/**
 * Одна ждущая машина.
 *
 * ЛИНИЯ НАЗВАНА НЕ ДЛЯ ПОЛНОТЫ КАРТИНЫ. Очередь расшивают двумя способами, и
 * выбрать между ними можно только по этой колонке: три машины ОДНОЙ линии в
 * одном узле означают, что кольцо слишком плотное и его надо разрежать или
 * разносить погрузку; три машины РАЗНЫХ линий — что узел перегружен и его надо
 * расшивать бетоном.
 *
 * ГРУЗ В КУЗОВЕ ОТЛИЧАЕТ ВЫГРУЗКУ ОТ ПОГРУЗКИ. Гружёная машина ждёт, чтобы
 * СДАТЬ, — её очередь бьёт по получателю; порожняя ждёт, чтобы ВЗЯТЬ, — её
 * очередь душит отправителя. Действия разные, а без этой пометки состояния
 * неотличимы.
 */
function VehicleLine({ entry }: { entry: QueueEntry }): JSX.Element {
  return (
    <div style={{ ...rowStyle, gap: 6, fontSize: 11 }}>
      <span style={{ ...dimStyle, fontFamily: MONO, flex: '0 0 auto' }}>
        {entry.id}
      </span>

      <span style={{ ...ellipsis, flex: '1 1 auto' }}>
        {entry.lineName ?? 'разовый рейс'}
      </span>

      <span style={{ ...dimStyle, flex: '0 0 auto' }}>
        {entry.cargo === null ? 'под погрузку' : `сдаёт ${entry.cargo}`}
      </span>

      <span
        style={{ ...numberStyle, flex: '0 0 auto', width: 54, textAlign: 'right' }}
      >
        {fmtWait(entry.queuedTicks)}
      </span>

      {/*
        Машина без водителя не жжёт зарплату — платить некому, — и вместо рублей
        честно говорит об этом. Ноль рублей в этой колонке игрок прочитал бы как
        ошибку панели, а не как «за неё никто не платит».
      */}
      <span
        style={{
          ...numberStyle,
          flex: '0 0 auto',
          width: 62,
          textAlign: 'right',
          color:
            entry.driverName === null ? palette.textDim : palette.accentDim,
        }}
        title={
          entry.driverName === null
            ? 'За рулём никого: зарплату платить некому, но пост эта машина занимает'
            : `${entry.className}, за рулём ${entry.driverName}`
        }
      >
        {entry.driverName === null
          ? 'без вод.'
          : `${fmtInteger(entry.lost)} руб`}
      </span>
    </div>
  )
}

// ─── Предложение построить ─────────────────────────────────────────────────

/**
 * Терминал прямо из строки — то, что превращает отчёт в инструмент.
 *
 * ПОЧЕМУ ИМЕННО ТЕРМИНАЛ, А НЕ ВСЯ ВИТРИНА. Панель отвечает на вопрос про ПОСТЫ,
 * а посты добавляет терминал; склад с его единственным постом очередь почти не
 * трогает, хаб решает ту же задачу втрое дороже. Показать здесь все три значило
 * бы продавать, а не советовать. Остальное — в карточке города, куда ведёт клик
 * по названию.
 *
 * КНОПКА ОСТАЁТСЯ ДОСТУПНОЙ, ДАЖЕ ЕСЛИ ТЕРМИНАЛ НЕ ОКУПАЕТСЯ. Вердикт — совет, а
 * не запрет: игрок вправе строить впрок под сеть, которой ещё нет, и решать это
 * за него панель не должна. Гаснет кнопка только там, где действие невозможно, —
 * нет денег, место занято, компания разорена.
 */
function ReliefOffer({
  offer,
  waiting,
  hovered,
  onHover,
  onBuild,
}: {
  offer: BuildOffer
  /** Машин в очереди — знаменатель для «расшивает столько-то из стольких-то». */
  waiting: number
  hovered: boolean
  onHover: (on: boolean) => void
  onBuild: () => void
}): JSX.Element {
  const pays = offer.paybackDays !== null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <button
        type="button"
        onClick={() => offer.available && onBuild()}
        onMouseEnter={() => onHover(true)}
        onMouseLeave={() => onHover(false)}
        style={buttonStyle(false, hovered, offer.available, {
          height: 'auto',
          flexDirection: 'column',
          alignItems: 'stretch',
          gap: 4,
          padding: '6px 8px',
        })}
        disabled={!offer.available}
        title={
          offer.reason ??
          `Построить ${offer.type} за ${fmtInteger(
            offer.price,
          )} руб. Содержание ${fmtInteger(
            offer.upkeepPerDay,
          )} руб/сут платится каждые сутки до самого сноса`
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
            построить {offer.type}
          </span>
          <span style={{ marginLeft: 'auto' }}>
            {fmtInteger(offer.price)} руб
          </span>
        </span>

        {/*
          ЦЕНА И СОДЕРЖАНИЕ СТОЯТ РЯДОМ, И ЭТО ГЛАВНОЕ В КНОПКЕ. Разовая цена
          решается один раз, содержание идёт каждые сутки до самого сноса — без
          него терминал выглядел бы разовой покупкой, которая никогда не бывает
          лишней, и никакого решения бы не осталось.
        */}
        <span
          style={{
            display: 'flex',
            gap: 10,
            flexWrap: 'wrap',
            fontSize: 10,
            color: palette.textDim,
          }}
        >
          <span>
            +{offer.posts} {plural(offer.posts, POST_FORMS)}
          </span>
          <span>содержание {fmtInteger(offer.upkeepPerDay)} руб/сут</span>
          {/*
            «Расшивает 3 из 5» честнее, чем «+3 поста»: три поста при пяти
            ждущих машинах снимают очередь не целиком, и узнать об этом игрок
            должен ДО того, как заплатит, а не после.
          */}
          <span>
            расшивает {offer.relieved} из {waiting}
          </span>
        </span>
      </button>

      {/*
        Вердикт — отдельной строкой под кнопкой, а не в подсказке: это и есть
        ответ на вопрос «стоит ли», и прятать его под наведение мыши значило бы
        спрятать половину панели.

        ПРИЧИНА ОТКАЗА ВЫТЕСНЯЕТ ВЕРДИКТ, а не приписывается к нему. «Не хватает
        65 000 руб» — ответ на вопрос, который у игрока есть прямо сейчас;
        рассуждение об окупаемости — на тот, до которого он ещё не дошёл, и
        печатать их вместе значит заставить выбирать, что читать.
      */}
      {offer.reason !== null ? (
        <span style={{ ...dimStyle, color: palette.accentDim }}>
          {offer.reason}
        </span>
      ) : (
        <span
          style={{
            fontSize: 10,
            lineHeight: 1.35,
            color: pays ? palette.text : palette.textDim,
          }}
        >
          {offer.verdict}
          {pays && (
            <span style={{ color: palette.textDim }}>
              {' '}
              — экономия {fmtInteger(offer.savedPerDay)} минус содержание{' '}
              {fmtInteger(offer.upkeepPerDay)} = {fmtInteger(offer.netPerDay)}{' '}
              руб/сут
            </span>
          )}
        </span>
      )}
    </div>
  )
}
