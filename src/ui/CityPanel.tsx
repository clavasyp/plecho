/**
 * Панель выбранного города — окно диагностики.
 *
 * Открывается кликом по городу (render/CityPicker.tsx) и отвечает на один
 * вопрос: ПОЧЕМУ ЗДЕСЬ НИЧЕГО НЕ ПРОИСХОДИТ. Мир в «ПЛЕЧЕ» не выдаёт заданий —
 * он просто останавливается там, куда игрок не доехал, и без этой панели
 * «завод задыхается без вывоза» и «завод стоит без сырья» выглядят на карте
 * совершенно одинаково. Сам диагноз считается в ui/cityReadout.ts; здесь только
 * разметка и решения о том, что показать первым.
 *
 * ЧИСЛА ЖИВЫЕ. Панель подписана на состояние и пересчитывается каждый тик.
 * Склад, тающий на глазах, — это и есть обратная связь; снимок, замерший на
 * момент открытия, врал бы уже через минуту наблюдения.
 *
 * ПАНЕЛЬ НЕ ЗАГОРАЖИВАЕТ КАРТУ. Узкая колонка у правого края, панель времени
 * при этом остаётся у левого — середина кадра, где игрок и смотрит на дороги,
 * свободна. Закрывается тремя способами: крестиком, Escape и повторным кликом
 * по тому же городу.
 *
 * СТИЛЬ. Цвета только из palette.ts, разметка по образцу ui/TimeControls.tsx.
 * Акцент — единственный тёплый цвет игры — тратится РОВНО на две вещи:
 * остановившееся предприятие и прерванное снабжение города. Оба означают «мир
 * встал и ждёт машину». Всё прочее передаётся текстом и приглушённостью:
 * соблазн подсветить каждый пустой склад велик, но на старте партии пусты все
 * склады сразу, и панель превратилась бы в сплошной оранжевый, в котором
 * настоящая авария уже не читается.
 *
 * ─── СРЕЗ 5: ИНФРАСТРУКТУРА ────────────────────────────────────────────────
 *
 * Панель перестала быть только окном диагностики: внизу появился раздел, где
 * СТРОЯТ. Это единственное место в игре, где ставят терминал, склад и хаб, и
 * стоит оно именно здесь по той же причине, по которой здесь стоит диагноз
 * предприятий, — решение принимается ПРО ГОРОД, и принимать его надо там, где
 * видно, что с городом происходит.
 *
 * ЦЕНА И СОДЕРЖАНИЕ СТОЯТ РЯДОМ, ВСЕГДА. Разовая цена решается один раз,
 * содержание идёт каждые сутки до самого сноса, и именно оно делает
 * строительство РЕШЕНИЕМ, а не накоплением: терминал, поставленный там, где
 * очереди нет, тихо съедает прибыль. Показать цену без содержания значило бы
 * продать игроку бесплатный улучшайзер.
 *
 * ОЧЕРЕДЬ ПОКАЗАНА ЗДЕСЬ ПРИГЛУШЁННЫМ ТЁПЛЫМ, А НЕ АКЦЕНТОМ. Полный акцент в
 * этой панели занят и разобран выше — «мир встал и ждёт машину», — а очередь
 * это обратное: машина стоит и ждёт мир. Обе беды настоящие, но выкрасить их
 * одинаково значит потерять различие, ради которого панель и написана. Полным
 * акцентом очередь горит в своей панели (ui/BottleneckPanel.tsx), где она —
 * единственный предмет разговора; здесь она объясняет, зачем тут кнопка.
 *
 * СНОС В ДВА НАЖАТИЯ, потому что груз со склада при сносе ПРОПАДАЕТ (разбор — в
 * demolishBuilding, sim/economy/buildings.ts). Предупредить об остатке обязан
 * интерфейс, а не симуляция, и предупреждение это стоит прямо на кнопке.
 *
 * ЧУЖИЕ ПОСТРОЙКИ ВИДНЫ И НЕ УПРАВЛЯЮТСЯ. Показывать их нужно ровно затем,
 * чтобы игрок не искал объяснения тому, чего не происходит: терминал конкурента
 * не добавляет ему ни одного поста (посты считаются по владельцу — см.
 * logistics/service.ts), и без этой строки город с чужим хабом выглядел бы как
 * город, где что-то сломалось.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, JSX } from 'react'

import { useGameStore } from '../app/store'
import { palette } from '../render/palette'
import type { BuildingId, BuildingType, IndustryId } from '../sim/types'
import {
  cityQueue,
  fmtWait,
  foreignBuildings,
  ownBuildings,
  type BuildOffer,
  type BuildingView,
  type CityQueue,
  type ForeignBuilding,
} from './bottleneckReadout'
import {
  citySupplyStatus,
  cityStockLines,
  describeIndustry,
  fmtDays,
  fmtPopulation,
  fmtTons,
} from './cityReadout'
import type { IndustryView, StockLine } from './cityReadout'
import { fmtInteger, plural } from './fleetReadout'
import { useSelection } from './selection'

/** Моноширинный стек — тот же, что в панели времени. Обоснование там же. */
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/**
 * Тот же цвет палитры, но полупрозрачный.
 *
 * Копия функции из TimeControls, и это осознанный долг: общего слоя оформления
 * в проекте пока нет, а заводить его ради двух панелей — значит проектировать
 * его вслепую. Третья панель станет поводом вынести MONO, withAlpha и стиль
 * кнопки в ui/theme.ts; до тех пор дублирование дешевле неверной абстракции.
 * Важно другое: числа цветов не копируются — источник по-прежнему palette.ts.
 */
function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16)
  const r = (value >> 16) & 0xff
  const g = (value >> 8) & 0xff
  const b = value & 0xff
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** Заливка тревожного блока: акцент, приглушённый до подложки. */
const ACCENT_WASH = withAlpha(palette.accent, 0.12)

// ─── Стили ─────────────────────────────────────────────────────────────────

const panelStyle: CSSProperties = {
  position: 'fixed',
  top: 16,
  right: 16,
  zIndex: 10,

  display: 'flex',
  flexDirection: 'column',
  /**
   * Ширина фиксированная и умеренная. Панель открывается поверх карты, а карта
   * — главное, на что игрок смотрит: город он выбирает глазами, а не по списку.
   * 296 пикселей хватает на самую длинную строку («пиломатериалы 12/30 т») и
   * оставляют карту читаемой даже на ноутбучном экране.
   */
  width: 296,
  boxSizing: 'border-box',
  // Десять предприятий в один город не поставить, но панель обязана пережить и
  // такой сценарий, не уехав за нижний край экрана.
  maxHeight: 'calc(100vh - 32px)',
  overflowY: 'auto',

  background: palette.panel,
  border: `1px solid ${palette.panelBorder}`,
  borderRadius: 6,
  color: palette.text,
  fontFamily: MONO,

  // Как и панель времени: это приборная доска, выделение текста здесь только
  // мешает — особенно при перетаскивании камеры мимо панели.
  userSelect: 'none',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 8,
  padding: '10px 12px',
  borderBottom: `1px solid ${palette.panelBorder}`,
}

const nameStyle: CSSProperties = {
  fontSize: 15,
  lineHeight: 1.2,
  color: palette.text,
  letterSpacing: '0.02em',
}

const subtitleStyle: CSSProperties = {
  marginTop: 3,
  fontSize: 11,
  lineHeight: 1.2,
  color: palette.textDim,
}

const sectionStyle: CSSProperties = {
  padding: '9px 12px',
  borderBottom: `1px solid ${palette.panelBorder}`,
  display: 'flex',
  flexDirection: 'column',
  gap: 7,
}

/**
 * Заголовок раздела.
 *
 * Разрядка вместо жирности и кегля: панель узкая, и любой второй по силе
 * шрифтовой приём начал бы спорить с названием города. Разрядка читается как
 * «служебная надпись» и не тянет взгляд.
 */
const sectionTitleStyle: CSSProperties = {
  fontSize: 9,
  letterSpacing: '0.14em',
  color: palette.textDim,
  textTransform: 'uppercase',
}

const rowStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
}

const rowHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
  fontSize: 11,
  lineHeight: 1,
}

/** Колонка «вход»/«выход». Фиксированная, чтобы названия грузов стояли в ряд. */
const rowLabelStyle: CSSProperties = {
  width: 34,
  flex: '0 0 auto',
  fontSize: 9,
  letterSpacing: '0.06em',
  color: palette.textDim,
}

const barRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  // Отступ ровно под ширину колонки «вход» плюс зазор: шкала начинается там же,
  // где название груза, и все шкалы панели выстраиваются по одной вертикали.
  paddingLeft: 40,
}

const barTrackStyle: CSSProperties = {
  flex: '1 1 auto',
  height: 3,
  borderRadius: 2,
  background: palette.panelBorder,
  overflow: 'hidden',
}

const footerStyle: CSSProperties = {
  padding: '10px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}

/** Правая колонка «сколько суток до беды». Ширина фиксирована — числа в столбик. */
function noteStyle(urgent: boolean): CSSProperties {
  return {
    width: 46,
    flex: '0 0 auto',
    textAlign: 'right',
    fontSize: 9,
    lineHeight: 1,
    color: urgent ? palette.text : palette.textDim,
  }
}

/** Кнопка отправки. Форма от кнопок скорости, ширина — во всю панель. */
function dispatchButtonStyle(hovered: boolean): CSSProperties {
  return {
    height: 28,
    padding: '0 10px',

    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',

    background: hovered ? ACCENT_WASH : 'transparent',
    border: `1px solid ${hovered ? palette.accent : palette.panelBorder}`,
    borderRadius: 4,
    color: hovered ? palette.accent : palette.textDim,

    font: `11px/1 ${MONO}`,
    letterSpacing: '0.04em',
    cursor: 'pointer',
    transition: 'color 120ms, border-color 120ms, background-color 120ms',
  }
}

/** Склонения для раздела инфраструктуры. Панель с «3 пост» выглядит черновиком. */
const POST_FORMS = ['пост', 'поста', 'постов'] as const
const VEHICLE_FORMS = ['машина', 'машины', 'машин'] as const
const WAIT_FORMS = ['ждёт', 'ждут', 'ждут'] as const

/**
 * Кнопка раздела инфраструктуры: витрина построек и снос.
 *
 * Форма от кнопки отправки выше, но с двумя отличиями, и оба содержательные.
 *
 *   ВЫСОТА СВОБОДНАЯ: на кнопке живут две строки — название с ценой и
 *   характеристики с содержанием. Цена без содержания продавала бы игроку
 *   бесплатный улучшайзер, а вторая строка в подсказке была бы спрятана ровно
 *   от того, кто ещё не знает, что её надо искать.
 *
 *   НЕДОСТУПНАЯ ГАСНЕТ, А НЕ ИСЧЕЗАЕТ — то же правило, что в витрине техники:
 *   пропавшая кнопка прячет цену, то есть цель, к которой игрок копит.
 */
function offerButtonStyle(
  enabled: boolean,
  hovered: boolean,
  extra?: CSSProperties,
): CSSProperties {
  return {
    padding: '6px 8px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 3,

    background: 'transparent',
    border: `1px solid ${
      enabled && hovered ? palette.accent : palette.panelBorder
    }`,
    borderRadius: 4,
    color: enabled ? palette.textDim : palette.textDim,

    font: `11px/1.2 ${MONO}`,
    letterSpacing: '0.03em',
    textAlign: 'left',
    cursor: enabled ? 'pointer' : 'default',
    opacity: enabled ? 1 : 0.55,
    transition: 'color 120ms, border-color 120ms, background-color 120ms',
    ...extra,
  }
}

/** Мелкая кнопка в строке построенного: снос. */
function smallButtonStyle(hovered: boolean, armed: boolean): CSSProperties {
  return {
    height: 20,
    padding: '0 6px',
    flex: '0 0 auto',

    display: 'flex',
    alignItems: 'center',

    background: armed ? ACCENT_WASH : 'transparent',
    border: `1px solid ${
      armed ? palette.accent : hovered ? palette.text : palette.panelBorder
    }`,
    borderRadius: 3,
    color: armed ? palette.accent : hovered ? palette.text : palette.textDim,

    font: `9px/1 ${MONO}`,
    letterSpacing: '0.04em',
    cursor: 'pointer',
    transition: 'color 120ms, border-color 120ms, background-color 120ms',
  }
}

function closeButtonStyle(hovered: boolean): CSSProperties {
  return {
    width: 20,
    height: 20,
    flex: '0 0 auto',

    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',

    background: 'transparent',
    border: 'none',
    padding: 0,
    color: hovered ? palette.text : palette.textDim,

    /*
     * Знак умножения U+00D7, а не «✕» (U+2715) и не «✖».
     *
     * В панели времени значок паузы пришлось собирать из двух полосок: «⏸» и
     * «❚» лежат в редких блоках юникода и на части систем приезжают из
     * шрифта-фолбэка другого кегля. Здесь этой опасности нет — U+00D7 входит в
     * Latin-1 и есть в любом шрифте, у которого вообще есть цифры.
     */
    font: `16px/1 ${MONO}`,
    cursor: 'pointer',
    transition: 'color 120ms',
  }
}

/**
 * Блок состояния — единственное место панели, где тратится акцент.
 *
 * Тревога получает всё сразу: тёплый цвет, подложку и полосу слева. Всё
 * остальное — только полосу и приглушённый текст, потому что «завод снижает
 * темп» и «завод стоит» обязаны различаться с одного взгляда. Если тревожно
 * выглядит любое отклонение, игрок перестаёт различать что-либо вообще.
 */
function statusStyle(alarm: boolean): CSSProperties {
  return {
    padding: '4px 6px',
    borderLeft: `2px solid ${alarm ? palette.accent : palette.panelBorder}`,
    background: alarm ? ACCENT_WASH : 'transparent',
    color: alarm ? palette.accent : palette.textDim,
    fontSize: 10,
    lineHeight: 1.35,
    letterSpacing: '0.02em',
  }
}

// ─── Части разметки ────────────────────────────────────────────────────────

/**
 * Строка склада: название, тоннаж, шкала заполнения и запас времени.
 *
 * Шкала нужна не вместо чисел, а вместе с ними. Число отвечает на «сколько», а
 * шкала — на «много это или мало», и второе читается боковым зрением за
 * четверть секунды, тогда как «118 из 120» приходится сравнивать в уме.
 */
function StockRow({
  label,
  line,
}: {
  label?: string
  line: StockLine
}): JSX.Element {
  const fill =
    line.capacity > 0 ? Math.min(1, Math.max(0, line.tons / line.capacity)) : 0

  return (
    <div style={rowStyle}>
      <div style={rowHeadStyle}>
        <span style={rowLabelStyle}>{label ?? ''}</span>
        <span style={{ flex: '1 1 auto', color: palette.textDim }}>
          {line.cargo}
        </span>
        <span style={{ color: palette.text }}>
          {fmtTons(line.tons)}/{fmtTons(line.capacity)} т
        </span>
      </div>

      <div style={barRowStyle}>
        <div style={barTrackStyle}>
          {/*
            Заливка идёт приглушённым цветом текста, а не акцентом, даже когда
            склад забит под завязку: причина остановки уже сказана словами выше,
            и дублировать её вторым оранжевым пятном значит удвоить шум ради
            нуля новой информации.

            Переход по ширине — линейный и короткий. Склад меняется каждый тик
            на доли процента, и без сглаживания шкала дёргается пять раз в
            секунду; с плавной же кривой она выглядела бы анимацией, которой
            на приборной панели не место.
          */}
          <div
            style={{
              width: `${fill * 100}%`,
              height: '100%',
              background: palette.textDim,
              transition: 'width 200ms linear',
            }}
          />
        </div>
        <span style={noteStyle(line.urgent)}>{line.note}</span>
      </div>
    </div>
  )
}

/** Карточка одного предприятия: загрузка, причина, склады. */
function IndustryCard({ view }: { view: IndustryView }): JSX.Element {
  const stopped = view.status === 'стоит'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={rowHeadStyle}>
        <span style={{ flex: '1 1 auto', fontSize: 12, color: palette.text }}>
          {view.type}
        </span>
        {/*
          Загрузка — факт ПОСЛЕДНЕГО тика, а не прогноз. На нулевом тике партии
          она честно равна нулю: тика ещё не было, показывать нечего. Через
          пятнадцать игровых минут (доли секунды реального времени) значение
          становится осмысленным, поэтому городить отдельное состояние «данных
          пока нет» незачем.
        */}
        <span
          style={{
            fontSize: 12,
            color: stopped ? palette.accent : palette.text,
          }}
        >
          {Math.round(view.utilization * 100)}%
        </span>
      </div>

      {/*
        Причина стоит СРАЗУ под названием, выше складов. Порядок не случаен:
        игрок открывает панель с вопросом «почему стоит», и ответ обязан
        встретить его первым. Склады ниже — это уже уточнение, «насколько плохо».
      */}
      {view.reasons.length > 0 && (
        <div style={statusStyle(stopped)}>
          {/*
            Каждая причина отдельной строкой, а не через разделитель. Их бывает
            две сразу — «склад полон» и «нет сырья», — и склеенные в строку они
            переносятся посреди фразы, превращаясь в кашу именно там, где нужна
            максимальная ясность. Два коротких предложения в столбик читаются
            как список дел, чем они и являются.
          */}
          {view.reasons.map((reason) => (
            <div key={reason}>{reason}</div>
          ))}
        </div>
      )}

      {view.inputs.map((line) => (
        <StockRow key={line.cargo} label="вход" line={line} />
      ))}
      {view.output !== null && (
        <StockRow key={view.output.cargo} label="выход" line={view.output} />
      )}

      {/*
        Потеря мощности от долгого простоя показывается, только когда она есть.
        Вечная строка «мощность 100%» — шум: она никогда не меняется и приучает
        глаз пропускать ровно то место, где однажды появится «60%».
      */}
      {view.factor < 1 && (
        <div style={{ fontSize: 9, color: palette.textDim, paddingLeft: 40 }}>
          мощность {Math.round(view.factor * 100)}% — простой{' '}
          {fmtDays(view.idleDays)} сут
        </div>
      )}
    </div>
  )
}

// ─── Инфраструктура ────────────────────────────────────────────────────────

/**
 * Строка очереди над витриной построек.
 *
 * ОБЪЯСНЯЕТ, ЗАЧЕМ ТУТ КНОПКА. Без неё раздел выглядит магазином улучшений, в
 * котором покупают на всякий случай; с ней — ответом на видимую беду. Пока
 * очереди нет, строка честно говорит и это: «постов хватает» — тоже ответ, и он
 * означает «не трать деньги».
 *
 * Приглушённый тёплый, а не акцент: полный акцент в этой панели занят
 * остановившимся предприятием и прерванным снабжением — разбор в шапке файла.
 */
function QueueNote({ queue }: { queue: CityQueue }): JSX.Element {
  if (queue.waiting === 0) {
    return (
      <div style={{ fontSize: 10, color: palette.textDim, lineHeight: 1.35 }}>
        {/*
          Число постов вынесено в отдельное предложение, а не вставлено в
          сказуемое: «1 пост справляются» — это черновик, а согласовывать глагол
          ради строки, которую видно в каждом городе, дороже, чем разбить фразу.
        */}
        очереди нет — постов хватает
        {queue.busy > 0 && ` · занято ${queue.busy} из ${queue.posts}`}
      </div>
    )
  }

  return (
    <div
      style={{
        padding: '4px 6px',
        borderLeft: `2px solid ${palette.accentDim}`,
        color: palette.accentDim,
        fontSize: 10,
        lineHeight: 1.35,
        letterSpacing: '0.02em',
      }}
      title="Зарплата, которую компания платит за то, что машины стоят в очереди на пост"
    >
      {queue.waiting} {plural(queue.waiting, VEHICLE_FORMS)}{' '}
      {plural(queue.waiting, WAIT_FORMS)} поста · дольше всех{' '}
      {fmtWait(queue.worstTicks)}
      <div style={{ fontFamily: MONO }}>
        {fmtInteger(queue.lostPerDay)} руб/сут зарплаты за стояние
      </div>
    </div>
  )
}

/**
 * Построенное — с ценой содержания и кнопкой сноса.
 *
 * СНОС В ДВА НАЖАТИЯ И С НАЗВАННЫМ ОСТАТКОМ. Груз со склада при сносе пропадает
 * (разбор — в demolishBuilding), денег снос не возвращает, и обе новости игрок
 * обязан узнать ДО нажатия, а не после. Одно нажатие взводит кнопку и печатает
 * предупреждение, второе сносит.
 */
function BuildingRow({
  building,
  armed,
  hovered,
  onHover,
  onDemolish,
}: {
  building: BuildingView
  armed: boolean
  hovered: boolean
  onHover: (on: boolean) => void
  onDemolish: () => void
}): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ ...rowHeadStyle, gap: 6 }}>
        <span style={{ flex: '1 1 auto', fontSize: 11, color: palette.text }}>
          {building.type}
        </span>
        <span style={{ fontSize: 9, color: palette.textDim }}>
          {fmtInteger(building.upkeepPerDay)} руб/сут
        </span>
        <button
          type="button"
          onClick={onDemolish}
          onMouseEnter={() => onHover(true)}
          onMouseLeave={() => onHover(false)}
          style={smallButtonStyle(hovered, armed)}
          title="Снести. Денег снос не возвращает, а груз со склада пропадает"
        >
          {armed ? 'ещё раз' : 'снести'}
        </button>
      </div>

      <div style={{ fontSize: 9, color: palette.textDim, fontFamily: MONO }}>
        +{building.posts} {plural(building.posts, POST_FORMS)}
        {building.storage > 0 &&
          ` · склад ${fmtTons(building.stored)}/${fmtTons(building.storage)} т`}
      </div>

      {/*
        Предупреждение появляется только на взведённой кнопке и только когда
        терять действительно есть что. Вечная строка «при сносе груз пропадёт»
        приучила бы глаз её пропускать ровно к тому дню, когда на складе будут
        лежать четыреста тонн.
      */}
      {armed && building.stored > 0 && (
        <div style={{ fontSize: 9, color: palette.accent, lineHeight: 1.35 }}>
          на складе {fmtTons(building.stored)} т —{' '}
          {building.cargo.map((line) => line.type).join(', ')}: при сносе
          пропадёт
        </div>
      )}
    </div>
  )
}

/**
 * Постройка к покупке.
 *
 * ЧТО НА КНОПКЕ. Первая строка — что и почём, вторая — что даёт и во что
 * обходится каждые сутки. Третья появляется только у терминала и только тогда,
 * когда есть что сказать про окупаемость: вердикт считает bottleneckReadout по
 * нынешней очереди, и в городе без очереди он говорит ровно то, что нужно
 * сказать, — «будет только проедать прибыль».
 *
 * ВЕРДИКТ НЕ ЗАПРЕЩАЕТ СТРОИТЬ. Игрок вправе ставить склад под сеть, которой
 * ещё нет, и решать это за него панель не должна; гаснет кнопка только там, где
 * действие невозможно.
 */
function OfferButton({
  offer,
  hovered,
  onHover,
  onBuild,
}: {
  offer: BuildOffer
  hovered: boolean
  onHover: (on: boolean) => void
  onBuild: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => offer.available && onBuild()}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={offerButtonStyle(offer.available, hovered)}
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
            fontSize: 11,
            color: offer.available ? palette.text : palette.textDim,
          }}
        >
          {offer.type}
        </span>
        <span style={{ marginLeft: 'auto' }}>{fmtInteger(offer.price)}</span>
      </span>

      <span style={{ display: 'flex', gap: 8, fontSize: 9 }}>
        <span>
          +{offer.posts} {plural(offer.posts, POST_FORMS)}
        </span>
        {offer.storage > 0 && <span>{fmtInteger(offer.storage)} т</span>}
        <span style={{ marginLeft: 'auto' }}>
          {fmtInteger(offer.upkeepPerDay)} руб/сут
        </span>
      </span>

      {/*
        Причина отказа вытесняет вердикт: «не хватает 65 000 руб» — это ответ на
        вопрос, который у игрока есть прямо сейчас, а рассуждение об
        окупаемости — на тот, до которого он ещё не дошёл.
      */}
      <span
        style={{
          fontSize: 9,
          lineHeight: 1.3,
          fontFamily: 'inherit',
          color: offer.reason !== null ? palette.accentDim : palette.textDim,
        }}
      >
        {offer.reason ?? offer.verdict}
      </span>
    </button>
  )
}

/** Чужие постройки: видны, но не управляются. */
function ForeignNote({
  buildings,
}: {
  buildings: readonly ForeignBuilding[]
}): JSX.Element | null {
  if (buildings.length === 0) return null

  return (
    <div style={{ fontSize: 9, color: palette.textDim, lineHeight: 1.35 }}>
      {/*
        Названо словами, что чужие посты — чужие. Иначе игрок, увидевший в городе
        хаб, будет искать, куда делись его шесть постов, и не найдёт: посты
        считаются по владельцу постройки.
      */}
      чужое в городе: {buildings.map((b) => `${b.ownerName} — ${b.type}`).join(', ')}.
      Постов вам не добавляет
    </div>
  )
}

// ─── Панель ────────────────────────────────────────────────────────────────

export function CityPanel(): JSX.Element | null {
  const selected = useSelection((store) => store.city)
  const clear = useSelection((store) => store.clear)

  /*
   * Селекторы возвращают только СТАБИЛЬНЫЕ ссылки: сам город, запись
   * предприятий, запись машин. Собирать в селекторе объект или массив нельзя —
   * zustand v5 сравнивает результат по ссылке, и новый объект на каждом вызове
   * означает бесконечную перерисовку. Всё производное считается ниже, в useMemo.
   */
  const city = useGameStore((store) =>
    selected === null ? undefined : store.state.world.cities[selected],
  )
  const industries = useGameStore((store) => store.state.world.industries)
  const vehicles = useGameStore((store) => store.state.vehicles)
  const playerId = useGameStore((store) => store.state.playerId)
  const dispatchTo = useGameStore((store) => store.dispatchTo)

  /*
   * РАЗДЕЛ ИНФРАСТРУКТУРЫ БЕРЁТ СОСТОЯНИЕ ЦЕЛИКОМ, в отличие от селекторов выше.
   * Очередь, посты и оценка окупаемости считаются по парку, компаниям и
   * постройкам разом (bottleneckRows принимает GameState), и разбирать это на
   * три подписки значило бы получить ту же частоту перерисовки — парк меняется
   * каждый тик — тремя способами вместо одного.
   */
  const state = useGameStore((store) => store.state)
  const build = useGameStore((store) => store.build)
  const demolish = useGameStore((store) => store.demolish)

  const [hoveredDispatch, setHoveredDispatch] = useState(false)
  const [hoveredClose, setHoveredClose] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)
  /** Взведённая кнопка сноса. Снос в два нажатия — груз со склада пропадает. */
  const [confirmDemolish, setConfirmDemolish] = useState<BuildingId | null>(null)

  /*
   * Escape закрывает панель — общая привычка для всего, что открывается поверх.
   *
   * Слушатель висит всегда, даже когда панели нет: вешать его условно значило бы
   * поставить хук после раннего возврата, чего React не допускает. Стоит это
   * одного сравнения строк на нажатие клавиши, а clear при пустом выборе не
   * меняет состояние и никого не будит.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      clear()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [clear])

  const stockLines = useMemo(
    () => (city === undefined ? [] : cityStockLines(city)),
    [city],
  )

  const supply = useMemo(
    () => (city === undefined ? null : citySupplyStatus(city)),
    [city],
  )

  const industryViews = useMemo(() => {
    if (selected === null) return []
    return (Object.keys(industries) as IndustryId[])
      .map((id) => industries[id])
      .filter((industry) => industry.cityId === selected)
      .map(describeIndustry)
  }, [industries, selected])

  /**
   * Машина игрока и её отношение к этому городу.
   *
   * Показывается ради одного: клик по городу больше НЕ отправляет машину, и
   * игроку нужен способ убедиться, что нажатие кнопки что-то изменило. Заодно
   * «в кузове мука» — половина решения о том, куда вообще ехать.
   */
  const vehicleHint = useMemo(() => {
    const vehicle = Object.values(vehicles).find((v) => v.ownerId === playerId)
    if (vehicle === undefined) return null

    // Последний узел маршрута — конечная точка. Промежуточные машина проезжает
    // насквозь, и объявлять её «едущей в Тверь» на транзите было бы враньём.
    if (vehicle.route.at(-1) === selected) return 'машина уже едет сюда'

    if (vehicle.cargo !== null) {
      return `в кузове ${vehicle.cargo.type}, ${fmtTons(vehicle.cargo.tons)} т`
    }
    return 'машина порожняя'
  }, [vehicles, playerId, selected])

  /*
   * Очередь, посты и витрина построек этого города. Считается каждый тик — так и
   * надо: игрок смотрит на панель ровно затем, чтобы увидеть, стоят ли машины
   * ПРЯМО СЕЙЧАС, а замерший снимок соврал бы через минуту наблюдения.
   */
  const queue = useMemo(
    () => (selected === null ? null : cityQueue(state, playerId, selected)),
    [state, playerId, selected],
  )

  const mine = useMemo(
    () => (selected === null ? [] : ownBuildings(state, playerId, selected)),
    [state, playerId, selected],
  )

  const theirs = useMemo(
    () =>
      selected === null ? [] : foreignBuildings(state, playerId, selected),
    [state, playerId, selected],
  )

  /*
   * Взведённая кнопка сноса не переживает смену города и не висит вечно: иначе
   * она ждала бы игрока уже на другой постройке, а второе нажатие снесло бы не
   * то, что он собирался. Тот же приём, что у увольнения в панели парка.
   */
  useEffect(() => setConfirmDemolish(null), [selected])

  const onDispatch = useCallback(() => {
    if (selected !== null) dispatchTo(selected)
  }, [dispatchTo, selected])

  const onBuild = useCallback(
    (type: BuildingType) => {
      if (selected !== null) build(selected, type)
    },
    [build, selected],
  )

  /**
   * Снос в два нажатия: первое взводит, второе сносит.
   *
   * Настоящая цена решения не в деньгах — их снос не возвращает вовсе, — а в
   * том, что груз со склада пропадает. Промах мимо соседней кнопки стоил бы
   * четырёхсот тонн, которые кто-то вёз сюда полдня.
   */
  const onDemolish = useCallback(
    (id: BuildingId) => {
      if (confirmDemolish === id) {
        demolish(id)
        setConfirmDemolish(null)
      } else {
        setConfirmDemolish(id)
      }
    },
    [confirmDemolish, demolish],
  )

  // Ничего не выбрано — панели нет. Город, которого не оказалось в мире
  // (сценарий, старый сейв), ведёт себя так же: снимать выбор прямо в рендере
  // нельзя, а показывать пустую рамку незачем.
  if (selected === null || city === undefined || supply === null) return null


  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <div>
          <div style={nameStyle}>{city.name}</div>
          <div style={subtitleStyle}>
            {city.profile} · {fmtPopulation(city.population)} жителей
          </div>
        </div>

        <button
          type="button"
          onClick={clear}
          onMouseEnter={() => setHoveredClose(true)}
          onMouseLeave={() => setHoveredClose(false)}
          style={closeButtonStyle(hoveredClose)}
          aria-label="Закрыть"
          title="Закрыть (Esc)"
        >
          ×
        </button>
      </div>

      <div style={sectionStyle}>
        <div style={sectionTitleStyle}>склад города</div>
        {stockLines.map((line) => (
          <StockRow key={line.cargo} line={line} />
        ))}
        {/*
          Строка снабжения никогда не тревожная — обоснование в citySupplyStatus.
          Коротко: в срезе 2 она была бы оранжевой у всех городов и всё время.
        */}
        <div style={statusStyle(false)}>{supply}</div>
      </div>

      {/*
        Город без предприятий — не пробел в данных, а роль. Москва в срезе 2
        намеренно чистый спрос (обоснование — в шапке data/industries.ts), и
        панель обязана сказать это словами: пустое место читается как «ещё не
        загрузилось».
      */}
      <div style={sectionStyle}>
        <div style={sectionTitleStyle}>предприятия</div>

        {industryViews.length === 0 ? (
          <div style={{ fontSize: 10, color: palette.textDim }}>
            производства нет — только потребление
          </div>
        ) : (
          industryViews.map((view) => <IndustryCard key={view.id} view={view} />)
        )}
      </div>

      {/*
        ─── Инфраструктура ────────────────────────────────────────────────

        Порядок разделов сверху вниз: что в городе есть → что с ним не так →
        что с этим делать. Строительство обязано стоять последним, потому что
        оно ОТВЕТ: решать, нужен ли здесь терминал, игрок должен, уже увидев
        очередь и задыхающийся без вывоза завод, а не до того.
      */}
      {queue !== null && (
        <div style={sectionStyle}>
          <div style={rowHeadStyle}>
            <span style={{ ...sectionTitleStyle, flex: '1 1 auto' }}>
              инфраструктура
            </span>
            <span style={{ fontSize: 10, color: palette.textDim }}>
              {queue.posts} {plural(queue.posts, POST_FORMS)}
            </span>
          </div>

          <QueueNote queue={queue} />

          {mine.map((building) => (
            <BuildingRow
              key={building.id}
              building={building}
              armed={confirmDemolish === building.id}
              hovered={hovered === `dem-${building.id}`}
              onHover={(on) =>
                setHovered(on ? `dem-${building.id}` : null)
              }
              onDemolish={() => onDemolish(building.id)}
            />
          ))}

          {/*
            НЕДОСТУПНОЕ НЕ ПРЯЧЕТСЯ, а гаснет и называет причину: строка «не
            хватает 65 000 руб» — это цель, к которой копят, и убрать её значит
            отнять у игрока план. То же правило, что в витрине техники.

            ИСКЛЮЧЕНИЕ РОВНО ОДНО — УЖЕ ПОСТРОЕННОЕ. Оно стоит строкой выше, со
            своим содержанием и кнопкой сноса, и повторять его погашенной
            строкой «уже построен» значит занять треть узкой панели тем, что
            игрок только что прочитал. Правило существует ради ЦЕЛИ, которой
            игрок ещё не достиг; достигнутая целью быть перестала.
          */}
          {queue.offers
            .filter((offer) => !offer.built)
            .map((offer) => (
              <OfferButton
                key={offer.type}
                offer={offer}
                hovered={hovered === `buy-${offer.type}`}
                onHover={(on) => setHovered(on ? `buy-${offer.type}` : null)}
                onBuild={() => onBuild(offer.type)}
              />
            ))}

          <ForeignNote buildings={theirs} />
        </div>
      )}

      <div style={footerStyle}>
        <button
          type="button"
          onClick={onDispatch}
          onMouseEnter={() => setHoveredDispatch(true)}
          onMouseLeave={() => setHoveredDispatch(false)}
          style={dispatchButtonStyle(hoveredDispatch)}
          title={`Отправить машину в город ${city.name}`}
        >
          отправить машину
        </button>

        {vehicleHint !== null && (
          <div
            style={{
              fontSize: 9,
              color: palette.textDim,
              textAlign: 'center',
              lineHeight: 1,
            }}
          >
            {vehicleHint}
          </div>
        )}
      </div>
    </div>
  )
}
