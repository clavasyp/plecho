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
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, JSX } from 'react'

import { useGameStore } from '../app/store'
import { palette } from '../render/palette'
import type { IndustryId } from '../sim/types'
import {
  citySupplyStatus,
  cityStockLines,
  describeIndustry,
  fmtDays,
  fmtPopulation,
  fmtTons,
} from './cityReadout'
import type { IndustryView, StockLine } from './cityReadout'
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

  const [hoveredDispatch, setHoveredDispatch] = useState(false)
  const [hoveredClose, setHoveredClose] = useState(false)

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

  const onDispatch = useCallback(() => {
    if (selected !== null) dispatchTo(selected)
  }, [dispatchTo, selected])

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
