/**
 * Редактор линий — главный экран среза 3.
 *
 * До линий игрок отправлял разовые рейсы, а погрузка была автоматической: машина
 * брала что дают и сдавала где примут. Оптимизировать было нечего. Здесь игрок
 * впервые принимает НАСТОЯЩЕЕ решение — проектирует замкнутое кольцо остановок с
 * указанием, что на каждой грузить и что выгружать, то есть задаёт поток груза
 * по своей сети. Всё остальное в игре обслуживает это одно решение.
 *
 * ПАНЕЛЬ КРУПНЕЕ ПРОЧИХ И ЭТО НАМЕРЕННО. TimeControls, CityPanel и CompanyPanel —
 * индикаторы: на них смотрят, их не трогают. Здесь работают руками: набирают
 * кольцо, перебирают грузы, двигают остановки. Такой экран не может быть узкой
 * колонкой; он занимает правый нижний угол, растёт вверх и прокручивается внутри
 * себя. Закрывается тремя способами: крестиком, повторным нажатием кнопки вызова
 * и Escape.
 *
 * РЕЖИМ ДОБАВЛЕНИЯ ВИДЕН ВСЕГДА, КОГДА ВКЛЮЧЁН. Остановки набираются кликами по
 * городам на карте, и это означает, что один и тот же жест в разные моменты
 * делает разное — самый неприятный вид интерфейса, какой бывает. Лечится
 * единственным способом: режим включается явной кнопкой, кнопка горит акцентом,
 * над списком висит полоса «кликайте города», а Escape гасит режим раньше, чем
 * закрывает панель. Пока режим включён, клик по городу НЕ открывает карточку
 * города: выбор гасится сразу же (см. эффект подписки ниже), и жест значит ровно
 * одно — «добавить остановку».
 *
 * ПРАВКИ ПРИМЕНЯЮТСЯ СРАЗУ, кнопки «сохранить» нет. Линия — живой объект, машины
 * на ней работают прямо во время правки, и промежуточное состояние здесь
 * законно: store.createLine прямо разрешает линию из одной остановки, потому что
 * игрок собирает кольцо по одной. Форма, которую нужно заполнить целиком, прежде
 * чем увидеть результат, отняла бы главное — возможность смотреть на подсказку о
 * порожнем плече ПОКА проектируешь. Опасность алиасинга закрыта в сторе:
 * updateLine копирует остановки поимённо (copyStops), поэтому массивы,
 * собранные здесь, не становятся общими с состоянием игры.
 *
 * СПИСОК ГРУЗОВ — ТОЛЬКО ТО, ЧТО ЗДЕСЬ РЕАЛЬНО ЕСТЬ. Шесть переключателей, из
 * которых в этом городе имеют смысл один-два, — это не выбор, а угадайка: игрок
 * отмечает «мука» в Смоленске, где мельницы нет, и узнаёт об ошибке через сутки
 * порожнего пробега. Поэтому строки собираются из типов местных предприятий
 * (ui/lineDraft.ts), а отмеченный, но невозможный здесь груз остаётся в списке
 * зачёркнутым — молча вычистить чужое решение нельзя, спрятать его тоже нельзя.
 *
 * АКЦЕНТ ТРАТИТСЯ НА ТРИ ВЕЩИ, и все три — «здесь теряются деньги»: порожнее
 * плечо кольца, итог порожнего пробега за круг и включённый режим добавления
 * (последнее — потому что от него зависит смысл следующего клика). Отмеченные
 * переключатели берут приглушённый тёплый: их на экране десятки, и полноценным
 * акцентом они забили бы единственное сообщение, ради которого срез затевался.
 *
 * Стили заданы прямо в разметке — по той же причине, что и в соседних панелях:
 * источник цветов ровно один (render/palette.ts), а общий слой оформления
 * появится, когда у панелей найдётся действительно общее.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, JSX } from 'react'

import { useGameStore } from '../app/store'
import { palette } from '../render/palette'
import type {
  CargoType,
  CityId,
  Industry,
  IndustryId,
  Line,
  LineId,
  Stop,
  Vehicle,
} from '../sim/types'
import {
  describeRing,
  fmtKm,
  fmtMoney,
  fmtShare,
  legFrom,
  loadSlots,
  unloadSlots,
} from './lineDraft'
import type { CargoSlot, Leg } from './lineDraft'
import { useLineSelection } from './lineSelection'
import { useSelection } from './selection'

/** Моноширинный стек — для чисел, как в панели компании. */
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/**
 * Пустая запись линий — общая на модуль.
 *
 * Селектор zustand сравнивает результат по ссылке, и `?? {}` прямо в селекторе
 * означал бы новый объект на каждый вызов, то есть бесконечную перерисовку.
 */
const NO_LINES: Record<LineId, Line> = {}

/** Тот же цвет палитры, но полупрозрачный. Копия из TimeControls, см. там же. */
function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16)
  const r = (value >> 16) & 0xff
  const g = (value >> 8) & 0xff
  const b = value & 0xff
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

const ACCENT_WASH = withAlpha(palette.accent, 0.14)
/** Заливка отмеченного переключателя — вдвое слабее акцентной. */
const DIM_WASH = withAlpha(palette.accent, 0.07)

/**
 * «1 остановка», «2 остановки», «5 остановок».
 *
 * Копия правила из CompanyPanel, и это тот же осознанный долг, что и с withAlpha
 * рядом: общего слоя интерфейса в проекте пока нет, а заводить его ради двух
 * панелей значит проектировать вслепую. Панель с «5 остановка» выглядит
 * черновиком, и это дороже небольшого дублирования.
 */
function plural(count: number, one: string, few: string, many: string): string {
  const hundreds = count % 100
  if (hundreds >= 11 && hundreds <= 14) return many
  const units = count % 10
  if (units === 1) return one
  if (units >= 2 && units <= 4) return few
  return many
}

// ─── Стили ─────────────────────────────────────────────────────────────────

const launcherStyle = (hovered: boolean): CSSProperties => ({
  position: 'fixed',
  right: 16,
  bottom: 16,
  zIndex: 10,

  height: 30,
  padding: '0 12px',
  display: 'flex',
  alignItems: 'center',
  gap: 8,

  background: hovered ? ACCENT_WASH : palette.panel,
  border: `1px solid ${hovered ? palette.accent : palette.panelBorder}`,
  borderRadius: 6,
  color: hovered ? palette.accent : palette.text,

  font: `12px/1 ${MONO}`,
  letterSpacing: '0.04em',
  cursor: 'pointer',
  transition: 'color 120ms, border-color 120ms, background-color 120ms',
})

const panelStyle: CSSProperties = {
  position: 'fixed',
  /*
   * Правый нижний угол. Верхние заняты (время слева, карточка города справа),
   * нижний левый — панелью компании. Растёт панель ВВЕРХ, в пустоту, а не
   * упирается в край окна, — тот же довод, что и у панели компании.
   */
  right: 16,
  bottom: 16,
  zIndex: 11,

  display: 'flex',
  flexDirection: 'column',
  /*
   * Ширина заметно больше прочих панелей: в строке остановки помещаются номер,
   * город, кнопки перестановки и удаления, а под ней — два ряда переключателей
   * с названиями грузов. В 296 пикселях карточки города это всё сложилось бы в
   * лесенку из переносов.
   */
  width: 420,
  maxHeight: 'calc(100vh - 32px)',
  boxSizing: 'border-box',

  background: palette.panel,
  border: `1px solid ${palette.panelBorder}`,
  borderRadius: 6,
  color: palette.text,

  // Рабочий экран, но всё же приборная доска: выделение текста мышью здесь
  // только мешает, особенно когда мимо панели тащат камеру.
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
  color: palette.text,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const captionStyle: CSSProperties = {
  fontSize: 9,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: palette.textDim,
  lineHeight: 1,
}

/** Прокручивается только тело: заголовок и подвал обязаны быть на месте всегда. */
const bodyStyle: CSSProperties = {
  flex: '1 1 auto',
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
}

const sectionStyle: CSSProperties = {
  padding: '10px 12px',
  borderBottom: `1px solid ${palette.panelBorder}`,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  lineHeight: 1.2,
}

/**
 * Кнопка панели. Форма от кнопок скорости в TimeControls — там же и разбор
 * того, почему активное состояние берёт акцент, а спокойное молчит.
 */
function buttonStyle(
  active: boolean,
  hovered: boolean,
  extra?: CSSProperties,
): CSSProperties {
  return {
    height: 24,
    padding: '0 8px',
    flex: '0 0 auto',

    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',

    background: active ? ACCENT_WASH : 'transparent',
    border: `1px solid ${active ? palette.accent : palette.panelBorder}`,
    borderRadius: 4,
    color: active ? palette.accent : hovered ? palette.text : palette.textDim,

    font: `11px/1 ${MONO}`,
    letterSpacing: '0.03em',
    cursor: 'pointer',
    transition: 'color 120ms, border-color 120ms, background-color 120ms',
    ...extra,
  }
}

/**
 * Недоступная кнопка перестановки (крайняя остановка кольца).
 *
 * Гасится прозрачностью и курсором, а не исчезает: пропадающая кнопка сдвигает
 * соседние, и ряд кнопок у первой остановки оказался бы не такой, как у всех
 * прочих. Ряд должен стоять на месте.
 */
const DISABLED: CSSProperties = { opacity: 0.35, cursor: 'default' }

/**
 * Переключатель груза.
 *
 * Отмеченный берёт приглушённый тёплый, а не акцент: их на экране бывает
 * полтора десятка, и полным акцентом они забили бы предупреждение о порожнем
 * плече — единственное, ради чего в этой панели вообще есть тёплый цвет.
 *
 * Невозможный здесь груз (отмечен, но в городе его никто не даёт и не берёт)
 * зачёркнут. Зачёркивание, а не цвет: строка обязана читаться как «это не
 * работает» и в скриншоте, и человеком, который цвет не различает.
 */
function slotStyle(slot: CargoSlot, hovered: boolean): CSSProperties {
  const broken = slot.who === null
  return {
    height: 22,
    padding: '0 7px',
    display: 'flex',
    alignItems: 'center',
    gap: 5,

    background: slot.chosen ? DIM_WASH : 'transparent',
    border: `1px solid ${
      slot.chosen ? palette.accentDim : palette.panelBorder
    }`,
    borderRadius: 3,
    color: slot.chosen
      ? palette.text
      : hovered
        ? palette.text
        : palette.textDim,

    // Семейство наследуется отдельным свойством, а не через сокращение `font`:
    // в сокращении «inherit» встало бы на место названия шрифта и превратилось
    // бы в несуществующее семейство. Названия грузов — слова, и набраны они
    // должны быть тем же шрифтом, что остальной текст, а не моноширинным.
    fontFamily: 'inherit',
    fontSize: 11,
    lineHeight: 1,
    textDecoration: broken && slot.chosen ? 'line-through' : 'none',
    cursor: 'pointer',
    transition: 'color 120ms, border-color 120ms, background-color 120ms',
  }
}

const inputStyle: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  height: 24,
  padding: '0 8px',

  background: 'transparent',
  border: `1px solid ${palette.panelBorder}`,
  borderRadius: 4,
  color: palette.text,
  font: `11px/1 ${MONO}`,
  outline: 'none',
}

// ─── Части разметки ────────────────────────────────────────────────────────

/**
 * Ряд переключателей одного направления остановки.
 *
 * Пустой ряд — законное состояние остановки (транзит без работы), и вместо
 * пустоты пишется словами почему: пустое место читается как «не загрузилось».
 */
function SlotRow({
  label,
  slots,
  onToggle,
}: {
  label: string
  slots: CargoSlot[]
  onToggle: (cargo: CargoType) => void
}): JSX.Element {
  const [hovered, setHovered] = useState<CargoType | null>(null)

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
      <span
        style={{
          ...captionStyle,
          width: 62,
          flex: '0 0 auto',
          paddingTop: 6,
          letterSpacing: '0.06em',
        }}
      >
        {label}
      </span>

      {slots.length === 0 ? (
        <span style={{ fontSize: 10, color: palette.textDim, paddingTop: 6 }}>
          здесь нечего
        </span>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {slots.map((slot) => (
            <button
              key={slot.cargo}
              type="button"
              onClick={() => onToggle(slot.cargo)}
              onMouseEnter={() => setHovered(slot.cargo)}
              onMouseLeave={() => setHovered(null)}
              style={slotStyle(slot, hovered === slot.cargo)}
              aria-pressed={slot.chosen}
              title={
                slot.who === null
                  ? `${slot.cargo}: в этом городе никто`
                  : `${slot.cargo}: ${slot.who}`
              }
            >
              {slot.cargo}
              {/*
                Кто именно даёт или принимает груз — мелким рядом с названием.
                Без этого «мука» в Туле и «мука» в Москве выглядят одинаково,
                хотя означают ровно противоположные вещи: там комбинат, здесь
                потребление.
              */}
              <span style={{ fontSize: 9, color: palette.textDim }}>
                {slot.who ?? 'никто'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Плечо между остановками — то место, где живёт главный урок игры.
 *
 * Порожнее плечо получает акцент, полосу слева и слово «ПОРОЖНЯКОМ» вразрядку,
 * а под ним стоит причина: «в Туле не производят: зерно». Показать это ЗДЕСЬ, в
 * момент проектирования, несравнимо полезнее, чем в отчёте через десять игровых
 * суток: там это уже потраченное топливо, а тут ещё решение.
 */
function LegRow({ leg }: { leg: Leg }): JSX.Element {
  const empty = leg.cargo === null

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        margin: '2px 0 2px 10px',
        paddingLeft: 8,
        borderLeft: `2px solid ${empty ? palette.accent : palette.panelBorder}`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 6,
          fontSize: 10,
          color: empty ? palette.accent : palette.textDim,
        }}
      >
        <span style={{ fontFamily: MONO }}>{fmtKm(leg.km)}</span>
        <span style={{ letterSpacing: empty ? '0.08em' : '0.02em' }}>
          {empty ? 'ПОРОЖНЯКОМ' : leg.cargo}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            color: palette.textDim,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          → {leg.to}
        </span>
      </div>

      {empty && leg.reason !== null && (
        <div style={{ fontSize: 9, color: palette.textDim }}>{leg.reason}</div>
      )}
    </div>
  )
}

/** Карточка остановки: город, перестановка, удаление и два ряда переключателей. */
function StopCard({
  index,
  total,
  stop,
  name,
  industries,
  onToggle,
  onMove,
  onRemove,
}: {
  index: number
  total: number
  stop: Stop
  name: string
  industries: Record<IndustryId, Industry>
  onToggle: (index: number, kind: 'load' | 'unload', cargo: CargoType) => void
  onMove: (index: number, delta: number) => void
  onRemove: (index: number) => void
}): JSX.Element {
  const [hovered, setHovered] = useState<string | null>(null)

  // Списки считаются на каждый тик вместе с перерисовкой панели. Это десяток
  // предприятий и шесть грузов — дешевле, чем запоминать их и следить за
  // устареванием.
  const load = loadSlots(industries, stop)
  const unload = unloadSlots(industries, stop)

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '7px 8px',
        border: `1px solid ${palette.panelBorder}`,
        borderRadius: 4,
      }}
    >
      <div style={rowStyle}>
        <span
          style={{
            width: 16,
            flex: '0 0 auto',
            fontFamily: MONO,
            fontSize: 10,
            color: palette.textDim,
          }}
        >
          {index + 1}
        </span>
        <span
          style={{
            flex: '1 1 auto',
            fontSize: 13,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name}
        </span>

        {/*
          Перестановка остановок нужна ровно потому, что кольцо — это ПОРЯДОК.
          Одни и те же четыре города, переставленные местами, дают разное число
          порожних плеч, и правка порядка обязана стоить одно нажатие, а не
          пересборку линии заново.
        */}
        <button
          type="button"
          onClick={() => onMove(index, -1)}
          onMouseEnter={() => setHovered('up')}
          onMouseLeave={() => setHovered(null)}
          style={buttonStyle(false, hovered === 'up', {
            width: 22,
            padding: 0,
            ...(index === 0 ? DISABLED : null),
          })}
          disabled={index === 0}
          title="Выше по кольцу"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={() => onMove(index, 1)}
          onMouseEnter={() => setHovered('down')}
          onMouseLeave={() => setHovered(null)}
          style={buttonStyle(false, hovered === 'down', {
            width: 22,
            padding: 0,
            ...(index === total - 1 ? DISABLED : null),
          })}
          disabled={index === total - 1}
          title="Ниже по кольцу"
        >
          ↓
        </button>
        <button
          type="button"
          onClick={() => onRemove(index)}
          onMouseEnter={() => setHovered('del')}
          onMouseLeave={() => setHovered(null)}
          style={buttonStyle(false, hovered === 'del', { width: 22, padding: 0 })}
          title="Убрать остановку"
          aria-label="Убрать остановку"
        >
          ×
        </button>
      </div>

      {/*
        Выгрузка стоит ВЫШЕ погрузки — тем же порядком, каким их выполняет фаза
        прибытия (sim/logistics/loading.ts). Порядок на экране должен совпадать
        с порядком в мире, иначе игрок строит в голове неверную модель: приехал,
        отдал, взял, поехал.
      */}
      <SlotRow
        label="выгрузить"
        slots={unload}
        onToggle={(cargo) => onToggle(index, 'unload', cargo)}
      />
      <SlotRow
        label="грузить"
        slots={load}
        onToggle={(cargo) => onToggle(index, 'load', cargo)}
      />
    </div>
  )
}

// ─── Панель ────────────────────────────────────────────────────────────────

export function LineEditor(): JSX.Element {
  const open = useLineSelection((store) => store.open)
  const selectedId = useLineSelection((store) => store.line)
  const adding = useLineSelection((store) => store.adding)
  const toggleEditor = useLineSelection((store) => store.toggleEditor)
  const closeEditor = useLineSelection((store) => store.closeEditor)
  const selectLine = useLineSelection((store) => store.selectLine)
  const toggleAdding = useLineSelection((store) => store.toggleAdding)

  /*
   * Селекторы возвращают только СТАБИЛЬНЫЕ ссылки — записи состояния как они
   * есть. Собирать в селекторе массив или объект нельзя: zustand v5 сравнивает
   * результат по ссылке, и новый объект на каждом вызове означает бесконечную
   * перерисовку. Всё производное считается ниже, в useMemo.
   */
  const playerId = useGameStore((store) => store.state.playerId)
  const lines = useGameStore(
    (store) => store.state.companies[store.state.playerId]?.lines ?? NO_LINES,
  )
  const vehicles = useGameStore((store) => store.state.vehicles)
  const cities = useGameStore((store) => store.state.world.cities)
  const industries = useGameStore((store) => store.state.world.industries)
  const edges = useGameStore((store) => store.state.world.edges)
  const updateLine = useGameStore((store) => store.updateLine)
  const deleteLine = useGameStore((store) => store.deleteLine)
  const assignVehicle = useGameStore((store) => store.assignVehicle)

  const [draftName, setDraftName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)

  const line: Line | undefined =
    selectedId === null ? undefined : lines[selectedId]

  /**
   * Добавить остановку в конец кольца.
   *
   * Состояние читается из стора через getState, а не берётся из замыкания:
   * обработчик живёт в подписке, которая переживает десятки перерисовок, и
   * захваченная линия к моменту клика будет уже прошлой.
   *
   * Новая остановка приходит ПУСТОЙ — ни погрузки, ни выгрузки. Соблазн
   * подставить «что тут есть» велик и вреден: молча исправленная линия ничему не
   * учит (тот же довод в шапке loading.ts), а редактор в ту же секунду покажет
   * это плечо порожним и назовёт причину.
   */
  const addStop = useCallback((cityId: CityId) => {
    const lineId = useLineSelection.getState().line
    if (lineId === null) return

    const game = useGameStore.getState()
    const target = game.state.companies[game.state.playerId]?.lines[lineId]
    if (target === undefined) return

    game.updateLine(lineId, [
      ...target.stops,
      { nodeId: cityId, unload: [], load: [] },
    ])
  }, [])

  /*
   * Клик по карте в режиме добавления. Подписка на чужой store вместо общего
   * обработчика — потому что слой кликабельных городов (render/CityPicker.tsx)
   * знает ровно одно действие: «выбрать город». Это правильно — указание на
   * объект не должно зависеть от того, что открыто в панелях, — а редактор
   * доопределяет смысл жеста у себя и только пока сам этого хочет.
   *
   * Выбор гасится сразу же. Иначе один клик значил бы два действия: добавил
   * остановку И открыл карточку города поверх редактора. Заодно исчезает
   * переключение выбора (повторный клик по тому же городу), и город можно
   * поставить в кольцо дважды — узловая база, куда заезжают и туда, и обратно.
   */
  useEffect(() => {
    if (!adding) return
    return useSelection.subscribe((store, prev) => {
      const city = store.city
      if (city === null || city === prev.city) return
      useSelection.getState().clear()
      addStop(city)
    })
  }, [adding, addStop])

  /*
   * Escape гасит СНАЧАЛА режим, и только потом закрывает панель. Порядок не
   * косметический: режим — это состояние, в котором следующий клик по карте
   * означает не то, что обычно, и выходить из него нужно первым же нажатием.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const store = useLineSelection.getState()
      if (store.adding) store.setAdding(false)
      else if (store.open) store.closeEditor()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Линию удалили (отсюда же или из другого места) — возвращаемся к списку.
  // Показывать редактор несуществующей линии нельзя, а снимать выбор прямо в
  // рендере — тем более.
  useEffect(() => {
    if (selectedId !== null && lines[selectedId] === undefined) {
      useLineSelection.getState().selectLine(null)
    }
  }, [selectedId, lines])

  // Подтверждение удаления не переживает смену линии: иначе взведённая кнопка
  // ждала бы игрока уже на другой линии.
  useEffect(() => setConfirmDelete(false), [selectedId])

  /** Парк игрока. Машины конкурента в списке назначения не появляются никогда. */
  const fleet = useMemo(
    () => Object.values(vehicles).filter((v) => v.ownerId === playerId),
    [vehicles, playerId],
  )

  /**
   * Машина, по которой считаются рубли за порожний круг.
   *
   * Сначала своя, с этой линии: расход у каждой машины свой, и правильный ответ
   * даёт та, что по кольцу и поедет. Если линия пустая — любая из парка, чтобы
   * цена порожнего плеча была видна ДО назначения машин, когда её ещё можно
   * исправить бесплатно.
   */
  const sample: Vehicle | null = useMemo(() => {
    if (line === undefined) return null
    return fleet.find((v) => v.lineId === line.id) ?? fleet[0] ?? null
  }, [fleet, line])

  /*
   * Разбор кольца пересчитывается вместе с панелью, то есть каждый тик. Это
   * десяток городов и шесть плеч, на которых считается кратчайший путь, —
   * заметно дешевле, чем городить кэш и потом искать, почему подсказка отстаёт
   * на одну правку.
   */
  const report = useMemo(
    () =>
      line === undefined
        ? null
        : describeRing(line, cities, industries, edges, sample),
    [line, cities, industries, edges, sample],
  )

  const onCreate = useCallback(() => {
    const game = useGameStore.getState()
    const company = game.state.companies[game.state.playerId]
    const count = company === undefined ? 0 : Object.keys(company.lines).length

    const name = draftName.trim()
    const id = game.createLine(name === '' ? `Кольцо ${count + 1}` : name, [])
    setDraftName('')

    // Новая линия сразу открывается в режиме добавления: линия без остановок не
    // делает ничего, и заставлять игрока нажимать ещё одну кнопку, чтобы начать
    // работать, значит ставить обряд между ним и его же намерением.
    const selection = useLineSelection.getState()
    selection.selectLine(id)
    selection.setAdding(true)
  }, [draftName])

  const onToggleCargo = useCallback(
    (index: number, kind: 'load' | 'unload', cargo: CargoType) => {
      if (line === undefined) return

      const stops = line.stops.map((stop, i) => {
        if (i !== index) return stop

        const list = kind === 'load' ? stop.load : stop.unload
        // ПОРЯДОК В СПИСКЕ ПОГРУЗКИ — ЭТО ПРИОРИТЕТ (см. findPickup): новый груз
        // дописывается в конец, то есть «если ничего из прежнего не нашлось».
        // Так добавление второго варианта не меняет поведение линии по первому.
        const next = list.includes(cargo)
          ? list.filter((item) => item !== cargo)
          : [...list, cargo]

        return kind === 'load'
          ? { ...stop, load: next }
          : { ...stop, unload: next }
      })

      updateLine(line.id, stops)
    },
    [line, updateLine],
  )

  const onMoveStop = useCallback(
    (index: number, delta: number) => {
      if (line === undefined) return
      const target = index + delta
      if (target < 0 || target >= line.stops.length) return

      const stops = [...line.stops]
      const moved = stops[index]
      stops[index] = stops[target]
      stops[target] = moved
      updateLine(line.id, stops)
    },
    [line, updateLine],
  )

  const onRemoveStop = useCallback(
    (index: number) => {
      if (line === undefined) return
      updateLine(
        line.id,
        line.stops.filter((_, i) => i !== index),
      )
    },
    [line, updateLine],
  )

  const onDelete = useCallback(() => {
    if (line === undefined) return
    deleteLine(line.id)
    // Машины удалённой линии остаются в парке и встают без задания — это решение
    // стора, и оно правильное: терять машины в один клик нельзя.
    useLineSelection.getState().selectLine(null)
  }, [deleteLine, line])

  const lineIds = useMemo(() => Object.keys(lines) as LineId[], [lines])

  // ─── Свёрнутое состояние ─────────────────────────────────────────────────

  if (!open) {
    return (
      <button
        type="button"
        onClick={toggleEditor}
        onMouseEnter={() => setHovered('launcher')}
        onMouseLeave={() => setHovered(null)}
        style={launcherStyle(hovered === 'launcher')}
        title="Линии компании"
      >
        линии
        <span style={{ color: palette.textDim }}>{lineIds.length}</span>
      </button>
    )
  }

  // ─── Список линий ────────────────────────────────────────────────────────

  if (line === undefined) {
    return (
      <div style={panelStyle}>
        <div style={headerStyle}>
          <div style={titleStyle}>линии компании</div>
          <button
            type="button"
            onClick={closeEditor}
            onMouseEnter={() => setHovered('close')}
            onMouseLeave={() => setHovered(null)}
            style={{
              ...buttonStyle(false, hovered === 'close', {
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

        <div style={bodyStyle}>
          <div style={sectionStyle}>
            {lineIds.length === 0 ? (
              /*
                Пустой список — не пробел, а состояние начала партии, и сказать
                об этом надо словами. Первую сеть проектирует игрок: готового
                кольца ему не дали намеренно (см. state.ts).
              */
              <div style={{ fontSize: 11, color: palette.textDim }}>
                линий нет. Линия — это замкнутое кольцо остановок: машина идёт по
                нему без остановки, и после последней остановки едет к первой.
              </div>
            ) : (
              lineIds.map((id) => {
                const item = lines[id]
                const onLine = fleet.filter((v) => v.lineId === id).length
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => selectLine(id)}
                    onMouseEnter={() => setHovered(id)}
                    onMouseLeave={() => setHovered(null)}
                    style={{
                      ...buttonStyle(false, hovered === id, {
                        height: 34,
                        justifyContent: 'flex-start',
                        gap: 8,
                      }),
                      // Название линии — слово, а не показание прибора.
                      fontFamily: 'inherit',
                      fontSize: 12,
                    }}
                  >
                    <span
                      style={{
                        flex: '1 1 auto',
                        textAlign: 'left',
                        color: palette.text,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.name}
                    </span>
                    <span style={{ fontFamily: MONO, fontSize: 10 }}>
                      {item.stops.length}{' '}
                      {plural(
                        item.stops.length,
                        'остановка',
                        'остановки',
                        'остановок',
                      )}
                    </span>
                    <span
                      style={{
                        fontFamily: MONO,
                        fontSize: 10,
                        // Линия без машин не возит ничего — это единственное
                        // состояние строки списка, которое стоит подсветить.
                        color: onLine === 0 ? palette.accentDim : palette.text,
                      }}
                    >
                      {onLine} {plural(onLine, 'машина', 'машины', 'машин')}
                    </span>
                  </button>
                )
              })
            )}
          </div>

          <div style={sectionStyle}>
            <div style={captionStyle}>новая линия</div>
            <div style={rowStyle}>
              <input
                type="text"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onCreate()
                }}
                placeholder="название"
                style={inputStyle}
              />
              <button
                type="button"
                onClick={onCreate}
                onMouseEnter={() => setHovered('create')}
                onMouseLeave={() => setHovered(null)}
                style={buttonStyle(false, hovered === 'create')}
                title="Завести линию и начать набирать остановки"
              >
                создать
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ─── Правка линии ────────────────────────────────────────────────────────

  const stops = line.stops
  const legs = report?.legs ?? []
  const emptyKm = report?.emptyKm ?? 0
  const assigned = fleet.filter((v) => v.lineId === line.id)

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <button
          type="button"
          onClick={() => selectLine(null)}
          onMouseEnter={() => setHovered('back')}
          onMouseLeave={() => setHovered(null)}
          style={buttonStyle(false, hovered === 'back', {
            width: 22,
            padding: 0,
          })}
          title="Ко всем линиям"
          aria-label="Ко всем линиям"
        >
          ‹
        </button>

        <div style={{ ...titleStyle, flex: '1 1 auto' }}>{line.name}</div>

        <button
          type="button"
          onClick={closeEditor}
          onMouseEnter={() => setHovered('close')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...buttonStyle(false, hovered === 'close', {
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
        Полоса режима. Висит НАД списком остановок и занимает всю ширину: игрок
        должен наткнуться на неё взглядом раньше, чем щёлкнет по карте.
      */}
      {adding && (
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
          режим добавления: кликайте города на карте — они станут остановками.
          Esc — выйти
        </div>
      )}

      <div style={bodyStyle}>
        <div style={sectionStyle}>
          <div style={{ ...rowStyle, justifyContent: 'space-between' }}>
            <span style={captionStyle}>кольцо</span>
            <button
              type="button"
              onClick={toggleAdding}
              onMouseEnter={() => setHovered('add')}
              onMouseLeave={() => setHovered(null)}
              style={buttonStyle(adding, hovered === 'add')}
              aria-pressed={adding}
              title="Добавлять остановки кликом по городам"
            >
              {adding ? 'добавление включено' : '+ остановка с карты'}
            </button>
          </div>

          {stops.length === 0 ? (
            <div style={{ fontSize: 11, color: palette.textDim }}>
              остановок нет. Включите добавление и кликните по городу на карте.
            </div>
          ) : (
            stops.map((stop, index) => {
              // Плечо ищется по индексу остановки, а не берётся по её номеру:
              // недостижимая остановка из объезда выпадает, и плечей бывает
              // меньше, чем остановок (см. legFrom).
              const leg = report === null ? null : legFrom(report, index)

              return (
                <div key={`${stop.nodeId}-${index}`}>
                  <StopCard
                    index={index}
                    total={stops.length}
                    stop={stop}
                    name={cities[stop.nodeId]?.name ?? stop.nodeId}
                    industries={industries}
                    onToggle={onToggleCargo}
                    onMove={onMoveStop}
                    onRemove={onRemoveStop}
                  />
                  {/*
                    Плечо рисуется ПОСЛЕ каждой остановки, включая последнюю:
                    замыкающее плечо — такое же плечо, как остальные, и прячется
                    порожний пробег чаще всего именно в нём. Кольцо, а не
                    отрезок, — решение из docs/КОНЦЕПТ.md §3–4, и интерфейс
                    обязан показывать его целиком.
                  */}
                  {leg !== null && <LegRow leg={leg} />}
                </div>
              )
            })
          )}

        </div>

        {/*
          Беды всего кольца — отдельным блоком и ВЫШЕ чисел круга. Причина не в
          вёрстке: «остановок меньше двух» и «между ними нет дорог» означают, что
          считать нечего вовсе, и показывать их внутри блока с итогами значило бы
          прятать самое важное там, где итогов ещё нет.

          Текст берётся у разбора кольца, а не пишется здесь во второй раз:
          повторить формулировку в интерфейсе — верный способ однажды поменять
          правило в одном месте, а слова в другом.
        */}
        {report !== null && report.warnings.length > 0 && (
          <div style={sectionStyle}>
            {report.warnings.map((warning) => (
              <div
                key={warning}
                style={{
                  padding: '4px 6px',
                  borderLeft: `2px solid ${palette.accent}`,
                  color: palette.accent,
                  fontSize: 10,
                  lineHeight: 1.35,
                }}
              >
                {warning}
              </div>
            ))}
          </div>
        )}

        {/* ─── Итог круга ─────────────────────────────────────────────── */}
        {report !== null && legs.length > 0 && (
          <div style={sectionStyle}>
            <div style={captionStyle}>круг</div>

            <div style={{ ...rowStyle, justifyContent: 'space-between' }}>
              <span style={{ fontSize: 11, color: palette.textDim }}>
                длина
              </span>
              <span style={{ fontFamily: MONO, fontSize: 12 }}>
                {fmtKm(report.totalKm)}
              </span>
            </div>

            <div style={{ ...rowStyle, justifyContent: 'space-between' }}>
              <span style={{ fontSize: 11, color: palette.textDim }}>
                порожняком
              </span>
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 12,
                  color: emptyKm > 0 ? palette.accent : palette.text,
                }}
              >
                {fmtKm(emptyKm)} · {fmtShare(report.emptyShare)}
              </span>
            </div>

            {/*
              ГЛАВНАЯ СТРОКА ВСЕГО СРЕЗА: порожний пробег, выраженный в рублях.
              Порожнее плечо жжёт ровно столько же топлива, сколько гружёное, и
              не приносит ничего — до этого среза метрика была числом в отчёте,
              здесь она становится деньгами, и притом ещё до того, как их
              потратили. Считает distanceCost — та же функция, которой расход
              списывает симуляция.
            */}
            {emptyKm > 0 && report.emptyCost !== null && (
              <div
                style={{
                  padding: '5px 7px',
                  borderLeft: `2px solid ${palette.accent}`,
                  background: ACCENT_WASH,
                  color: palette.accent,
                  fontSize: 11,
                  lineHeight: 1.35,
                }}
              >
                каждый круг сжигает {fmtMoney(report.emptyCost)} впустую —
                топливо и обслуживание на порожних плечах
              </div>
            )}

            {/*
              Похвала приглушённая и одной строкой. Собранное кольцо — это
              нормальное состояние работающей сети, а не достижение: подсветить
              его акцентом значило бы сравнять «всё хорошо» с «плечо идёт
              пустым», а тёплый цвет в этой игре означает ровно одно — сюда надо
              смотреть.
            */}
            {emptyKm === 0 && (
              <div style={{ fontSize: 10, color: palette.textDim }}>
                ни одного порожнего плеча — кольцо собрано
              </div>
            )}
          </div>
        )}

        {/* ─── Парк линии ─────────────────────────────────────────────── */}
        <div style={sectionStyle}>
          <div style={{ ...rowStyle, justifyContent: 'space-between' }}>
            <span style={captionStyle}>машины</span>
            <span
              style={{ fontFamily: MONO, fontSize: 10, color: palette.textDim }}
            >
              {assigned.length} на линии
            </span>
          </div>

          {fleet.length === 0 ? (
            <div style={{ fontSize: 11, color: palette.textDim }}>
              машин в парке нет
            </div>
          ) : (
            fleet.map((vehicle) => {
              // Отдельная константа, а не обращение к полю в каждом сравнении:
              // так сужение типа работает в ветке ниже без приведений.
              const on = vehicle.lineId
              const here = on === line.id
              return (
                <div key={vehicle.id} style={rowStyle}>
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: 11,
                      color: here ? palette.text : palette.textDim,
                    }}
                  >
                    {vehicle.id}
                  </span>
                  <span
                    style={{
                      flex: '1 1 auto',
                      fontSize: 10,
                      color: palette.textDim,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {/*
                      Истина о принадлежности машины — ПОЛЕ МАШИНЫ, а не список в
                      линии: так же считает и фаза диспетчеризации (см.
                      groupByLine). Список в Line существует ради одного —
                      порядка выезда.
                    */}
                    {here
                      ? 'на этой линии'
                      : on !== null
                        ? `на линии «${lines[on]?.name ?? on}»`
                        : 'без линии'}
                  </span>
                  <button
                    type="button"
                    onClick={() => assignVehicle(vehicle.id, here ? null : line.id)}
                    onMouseEnter={() => setHovered(`v-${vehicle.id}`)}
                    onMouseLeave={() => setHovered(null)}
                    style={buttonStyle(false, hovered === `v-${vehicle.id}`)}
                    title={
                      here
                        ? 'Снять с линии: машина встанет без задания'
                        : 'Поставить на линию'
                    }
                  >
                    {here ? 'снять' : 'поставить'}
                  </button>
                </div>
              )
            })
          )}
        </div>

        {/* ─── Удаление ───────────────────────────────────────────────── */}
        <div style={{ ...sectionStyle, borderBottom: 'none' }}>
          {/*
            Удаление в два нажатия. Линия — это работа на несколько минут, а
            промах мимо соседней кнопки стоит одного пикселя; подтверждение
            здесь дешевле любого «отменить», которого в игре нет.
          */}
          <button
            type="button"
            onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
            onMouseEnter={() => setHovered('delete')}
            onMouseLeave={() => setHovered(null)}
            style={buttonStyle(confirmDelete, hovered === 'delete', {
              height: 26,
            })}
            title="Удалить линию. Машины останутся в парке"
          >
            {confirmDelete ? 'удалить линию — нажмите ещё раз' : 'удалить линию'}
          </button>
        </div>
      </div>
    </div>
  )
}
