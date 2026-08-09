/**
 * Панель компании: деньги, порожний пробег и парк.
 *
 * Панель отвечает на три вопроса, и они НАМЕРЕННО разного веса на экране.
 *
 *   «Сколько у меня денег» — крупно: это счёт партии.
 *   «Сколько парк едет пустым» — почти так же крупно: это единственное число,
 *     по которому видно мастерство, а не удачу (docs/КОНЦЕПТ.md, раздел 4).
 *   «Где сейчас каждая машина» — мелким списком: справка, в которую заглядывают
 *     глазами, а не следят за ней непрерывно.
 *
 * Порожний пробег вынесен ОТДЕЛЬНЫМ ЧИСЛОМ, а не строкой в списке машин, ровно
 * потому, что он про парк целиком. Средний процент по компании — это то, что
 * игрок оптимизирует; процент конкретного ЗИЛа сам по себе не говорит ничего,
 * пока его не с чем сложить.
 *
 * НИ ОДНОЙ ЦИФРЫ ПАНЕЛЬ НЕ СЧИТАЕТ ПО-СВОЕМУ. Деньги берутся из состояния
 * компании, порожний пробег складывается из счётчиков loadedKm/emptyKm, которые
 * ведёт фаза прибытия (src/sim/logistics/loading.ts). Интерфейс со своей
 * формулой рано или поздно разойдётся с симуляцией — так же тихо, как когда-то
 * разошлись две формулы скорости (разбор — в шапке src/sim/world/speed.ts), и
 * найти расхождение будет нечем: обе цифры выглядят правдоподобно.
 *
 * Стили заданы прямо в разметке — по той же причине, что и в TimeControls:
 * панель единственный владелец этих правил, а источник цветов ровно один
 * (palette.ts). Общий слой стилей появится, когда панелей станет достаточно,
 * чтобы у них нашлось действительно общее.
 */

import { useMemo } from 'react'
import type { CSSProperties, JSX } from 'react'

import { useGameStore } from '../app/store'
import { palette } from '../render/palette'
import type {
  City,
  CityId,
  Edge,
  EdgeId,
  Vehicle,
  VehicleId,
} from '../sim/types'

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

/** Тонны — всегда с одним знаком: «6,0 т» и «0,4 т» одной ширины. */
function formatTons(tons: number): string {
  if (!Number.isFinite(tons)) return '—'
  return tons.toFixed(1).replace('.', ',')
}

/** Целые рубли и километры. Копейки в панели — шум: решения принимают не по ним. */
function formatInteger(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return INTEGER.format(Math.round(value))
}

/** «1 машина», «2 машины», «5 машин» — иначе панель выглядит как черновик. */
function pluralVehicles(count: number): string {
  const hundreds = count % 100
  if (hundreds >= 11 && hundreds <= 14) return 'машин'
  const units = count % 10
  if (units === 1) return 'машина'
  if (units >= 2 && units <= 4) return 'машины'
  return 'машин'
}

// ─── Разбор состояния в строки списка ──────────────────────────────────────

/**
 * Одна строка парка — уже готовая к отрисовке.
 *
 * Состояние разбирается в текст отдельно от разметки: так видно, что панель
 * умеет показать, и так же легко проверить каждый случай (машина в узле, машина
 * на ребре, битая ссылка на город) без монтирования компонента.
 */
type FleetRow = {
  id: VehicleId
  /** Что везёт. null — идёт порожней. */
  cargo: { label: string; tons: string } | null
  /** Где сейчас: «Москва → Тула» на ребре, «Тула» в узле. */
  leg: string
  /** Доля пройденного пути по текущему ребру. null — машина стоит в узле. */
  progress: string | null
  /** Конечный город маршрута. null — маршрута нет или он и так виден в leg. */
  destination: string | null
  /** Стоит в узле без задания — то есть не зарабатывает вообще ничего. */
  idle: boolean
}

/**
 * Название города по идентификатору.
 *
 * Битая ссылка отдаёт сам идентификатор, а не «???»: если в состоянии окажется
 * город, которого нет в мире, в панели должно быть видно ИМЕННО ЭТО — строка
 * «moscow-2» сразу называет виновника, а прочерк отправляет искать вслепую.
 */
function cityName(id: CityId, cities: Record<CityId, City>): string {
  return cities[id]?.name ?? id
}

function buildRow(
  vehicle: Vehicle,
  cities: Record<CityId, City>,
  edges: Record<EdgeId, Edge>,
): FleetRow {
  const cargo =
    vehicle.cargo === null
      ? null
      : {
          label: vehicle.cargo.type,
          tons: formatTons(vehicle.cargo.tons),
        }

  const route = vehicle.route
  const finalStop = route.length > 0 ? route[route.length - 1] : null

  if (vehicle.position.kind === 'узел') {
    const here = vehicle.position.nodeId
    return {
      id: vehicle.id,
      cargo,
      leg: cityName(here, cities),
      progress: null,
      // Конечная совпала с местом стоянки — маршрут доеден, показывать нечего.
      destination:
        finalStop !== null && finalStop !== here
          ? cityName(finalStop, cities)
          : null,
      idle: route.length === 0,
    }
  }

  const edge: Edge | undefined = edges[vehicle.position.edgeId]
  const fromId = vehicle.position.fromId

  // Ребро исчезло из мира или машина стоит не на своём ребре — то же правило,
  // что и в рендере (VehicleMesh): врать наугад хуже, чем честно показать, что
  // положение не разобрано.
  if (edge === undefined || (fromId !== edge.from && fromId !== edge.to)) {
    return {
      id: vehicle.id,
      cargo,
      leg: 'в пути',
      progress: null,
      destination: finalStop !== null ? cityName(finalStop, cities) : null,
      idle: false,
    }
  }

  const toId = fromId === edge.from ? edge.to : edge.from
  const raw = vehicle.position.progress
  const clamped = !Number.isFinite(raw) ? 0 : raw < 0 ? 0 : raw > 1 ? 1 : raw

  return {
    id: vehicle.id,
    cargo,
    leg: `${cityName(fromId, cities)} → ${cityName(toId, cities)}`,
    /*
     * Процент берётся из состояния как есть, без интерполяции по кадрам, в
     * отличие от положения машины на карте. Причина в разнице носителей: скачок
     * метки на экране глаз ловит как рывок, а скачок числа с 40% на 46% — это
     * просто новое показание прибора. Заводить ради него вторую копию логики
     * интерполяции (и вторую возможность разойтись с рендером) незачем.
     */
    progress: `${Math.round(clamped * 100)}%`,
    // Ближайший конец плеча уже написан в leg — повторять его справа стрелкой
    // значит занять место ничем.
    destination:
      finalStop !== null && finalStop !== toId
        ? cityName(finalStop, cities)
        : null,
    idle: false,
  }
}

/**
 * Доля порожнего пробега по парку, 0..1. null — считать пока не из чего.
 *
 * Складываются счётчики, а не усредняются проценты машин: машина, сделавшая
 * один рейс, и машина, отработавшая полгода, имеют совершенно разный вес, и
 * среднее по процентам врало бы в пользу новичков в парке.
 *
 * ВАЖНО про «пока не из чего». Сумма loadedKm + emptyKm — это пробег, УЖЕ
 * разнесённый по счетам, а разносится он только в моменты погрузки и разгрузки
 * (см. unaccountedKm в logistics/loading.ts). Пока первая машина едет первое
 * плечо, обе суммы — нули, и честный ответ здесь «нет данных», а не «0%».
 * Показать ноль означало бы поздравить игрока с идеальной работой ровно в тот
 * момент, когда он ещё ничего не сделал.
 */
function emptyShare(loadedKm: number, emptyKm: number): number | null {
  const total = loadedKm + emptyKm
  if (!Number.isFinite(total) || total <= 0) return null
  return emptyKm / total
}

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

const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  /*
   * Список ограничен по высоте и прокручивается. Парк в конце партии — это
   * десятки машин, и без потолка панель уехала бы за нижний край экрана,
   * утащив за собой самое важное: деньги и метрику, которые стоят сверху.
   */
  maxHeight: 220,
  overflowY: 'auto',
}

const rowStyle: CSSProperties = {
  padding: '6px 0',
  borderTop: `1px solid ${palette.panelBorder}`,
  lineHeight: 1.25,
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

const vehicleIdStyle: CSSProperties = {
  fontFamily: MONO,
  fontSize: 10,
  color: palette.textDim,
}

/**
 * Метка груза — тот же язык, что и на карте.
 *
 * Гружёный прицеп в сцене тёплый, порожний холодный (см. VehicleMesh). Квадрат
 * в списке повторяет ровно это правило, поэтому строку панели и метку на карте
 * не нужно связывать в уме: заливка есть — груз есть.
 */
function markerStyle(loaded: boolean): CSSProperties {
  return {
    width: 6,
    height: 6,
    borderRadius: 1,
    flex: '0 0 auto',
    // Смещение к базовой линии текста: квадрат должен стоять на строке, а не
    // висеть по её верхнему краю.
    transform: 'translateY(-1px)',
    background: loaded ? palette.accentDim : 'transparent',
    border: `1px solid ${loaded ? palette.accentDim : palette.textDim}`,
  }
}

// ─── Компонент ─────────────────────────────────────────────────────────────

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
  const vehicles = useGameStore((store) => store.state.vehicles)
  const cities = useGameStore((store) => store.state.world.cities)
  const edges = useGameStore((store) => store.state.world.edges)

  /*
   * Парк игрока, а не все машины мира. Конкурент в срезе 5 будет владеть своими
   * машинами в том же словаре, и его порожний пробег в счёте игрока не должен
   * появиться ни на километр.
   */
  const fleet = useMemo(
    () => Object.values(vehicles).filter((v) => v.ownerId === playerId),
    [vehicles, playerId],
  )

  const rows = useMemo(
    () => fleet.map((vehicle) => buildRow(vehicle, cities, edges)),
    [fleet, cities, edges],
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

      {/* ─── Парк ───────────────────────────────────────────────────── */}
      <div>
        <div style={{ ...shareRowStyle, marginBottom: 2 }}>
          <span style={captionStyle}>парк</span>
          <span style={{ ...unitStyle, fontFamily: MONO }}>
            {rows.length} {pluralVehicles(rows.length)}
          </span>
        </div>

        {rows.length === 0 ? (
          <div style={{ ...unitStyle, paddingTop: 6 }}>машин нет</div>
        ) : (
          <div style={listStyle}>
            {rows.map((row) => (
              <div key={row.id} style={rowStyle}>
                <div style={rowTopStyle}>
                  <span style={vehicleIdStyle}>{row.id}</span>
                  <span style={markerStyle(row.cargo !== null)} />
                  <span
                    style={{
                      fontSize: 12,
                      color: row.cargo === null ? palette.textDim : palette.text,
                      // Длинное название груза не должно выдавливать тоннаж за
                      // край панели.
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {row.cargo === null ? 'порожняя' : row.cargo.label}
                  </span>
                  {row.cargo !== null && (
                    <span
                      style={{
                        marginLeft: 'auto',
                        fontFamily: MONO,
                        fontSize: 12,
                        color: palette.text,
                      }}
                    >
                      {row.cargo.tons} т
                    </span>
                  )}
                </div>

                <div style={rowBottomStyle}>
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {row.leg}
                    {row.progress !== null && (
                      <span style={{ fontFamily: MONO }}> · {row.progress}</span>
                    )}
                  </span>
                  {/*
                    Справа — намерение машины: куда она в итоге едет. «Без
                    задания» стоит на том же месте не случайно: стоящая машина
                    не зарабатывает ничего, и это ровно тот же по важности факт,
                    что и её конечная точка.
                  */}
                  <span style={{ flex: '0 0 auto' }}>
                    {row.idle
                      ? 'без задания'
                      : row.destination !== null
                        ? `→ ${row.destination}`
                        : ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
