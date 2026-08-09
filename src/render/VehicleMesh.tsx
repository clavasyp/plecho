/**
 * Машины на карте.
 *
 * Здесь стык двух разных частот. Симуляция шагает редко — один тик это 15
 * игровых минут, и на ×1 их проходит несколько в секунду. Экран обновляется 60
 * раз в секунду. Если рисовать машину там, где её оставил последний тик, она
 * будет прыгать заметными скачками: на федеральной трассе за тик проезжается
 * около двадцати километров, то есть десятки пикселей.
 *
 * Поэтому позиция каждый кадр интерполируется между двумя снимками состояния —
 * `prev` и `state` из стора — по доле `clock.alpha`, которую крутит игровой
 * цикл. Симуляция при этом остаётся дискретной и детерминированной:
 * интерполяция живёт только в рендере и ни на что не влияет.
 *
 * ГЛАВНОЕ ПРАВИЛО ЭТОГО ФАЙЛА: `alpha` читается напрямую из мутируемого объекта
 * `clock` внутри `useFrame`, а состояние — через `useGameStore.getState()`.
 * Ни то, ни другое не подписано на React. Подписка на величину, меняющуюся
 * каждый кадр, означала бы перерисовку дерева компонентов 60 раз в секунду —
 * это дороже, чем вся отрисовка сцены вместе взятая. Компонент рендерится
 * ровно тогда, когда меняется ёмкость буфера инстансов, то есть почти никогда.
 *
 * Инстансинг: машин со временем сотни, и все они одинаковой формы. Два
 * `InstancedMesh` (тягач и прицеп) — это два вызова отрисовки на весь парк
 * вместо двух на машину.
 */

import { useFrame } from '@react-three/fiber'
import { useRef } from 'react'
import type { JSX } from 'react'
import { Color, DynamicDrawUsage, Matrix4, Quaternion, Vector3 } from 'three'
import type { InstancedMesh } from 'three'

import { clock } from '../app/loop'
import { useGameStore } from '../app/store'
import type { GameStore } from '../app/store'
import type {
  City,
  CityId,
  GameState,
  Point2,
  VehicleId,
  VehiclePosition,
} from '../sim/types'
import { CFO_ORIGIN, project } from '../sim/world/projection'
import { layers } from './layers'
import { palette } from './palette'

// ─── Форма машины ──────────────────────────────────────────────────────────

/**
 * Габариты в километрах — то есть заведомо неправдоподобные.
 *
 * Настоящая фура при масштабе «единица = километр» имеет длину 0.018 и на карте
 * шириной 600 не видна вовсе. Машина здесь не модель, а метка: размер выбран из
 * читаемости, а не из паспорта. Девять километров сцепа — это несколько
 * десятков пикселей на рабочем зуме (достаточно, чтобы различить тягач и
 * прицеп и понять, куда машина едет) и при этом двадцатая часть плеча
 * Москва — Тула, так что метка не съедает дорогу, на которой стоит.
 *
 * Детализировать форму бессмысленно: в изометрии с высоты видны только
 * пропорции и силуэт. Два бруска разной длины читаются как тягач с прицепом,
 * а всё, что мельче, превращается в кашу.
 */
const CAB = { length: 3, width: 2.2, height: 2.4 } as const
const TRAILER = { length: 5.6, width: 2.4, height: 2.8 } as const

/** Просвет в сцепке. Без него два бруска сливаются в один и смысл теряется. */
const COUPLING_GAP = 0.4

const RIG_LENGTH = CAB.length + COUPLING_GAP + TRAILER.length

/**
 * Подъём над плоскостью дорог. Дороги и машины лежат на одной высоте, и без
 * зазора грани мерцают Z-конфликтом на пологих углах камеры.
 */
const GROUND_CLEARANCE = layers.vehicle

/**
 * Смещения частей относительно точки машины.
 *
 * Локальная ось +X — «вперёд», сцеп отцентрован по своей точке: тягач уходит
 * вперёд, прицеп назад. Матрицы считаются один раз на модуль, потому что
 * относительно машины они постоянны — в кадре остаётся одно умножение на часть
 * вместо сборки матрицы с нуля.
 */
const CAB_OFFSET = new Matrix4().makeTranslation(
  RIG_LENGTH / 2 - CAB.length / 2,
  GROUND_CLEARANCE + CAB.height / 2,
  0,
)
const TRAILER_OFFSET = new Matrix4().makeTranslation(
  TRAILER.length / 2 - RIG_LENGTH / 2,
  GROUND_CLEARANCE + TRAILER.height / 2,
  0,
)

// ─── Признак груза ─────────────────────────────────────────────────────────

/**
 * Цвет прицепа: тёплый — груз, холодный — порожняк.
 *
 * ПОЧЕМУ РАЗНИЦА ЖИВЁТ В ПРИЦЕПЕ, А НЕ В КАБИНЕ. Кабина — это «машина», её
 * задача одна: быть искрой, по которой глаз находит транспорт на карте. Прицеп —
 * это «кузов», и вопрос «что в кузове» ему принадлежит буквально. Заодно
 * сохраняется читаемость направления: яркая кабина впереди, тёмный прицеп
 * сзади — если бы гружёная машина светилась целиком, сцеп на общем плане снова
 * слился бы в оранжевое пятно без носа и хвоста.
 *
 * ПОЧЕМУ ТЕМПЕРАТУРА, А НЕ ЯРКОСТЬ. Яркость уже занята: ею разведены кабина и
 * прицеп. Третья ступень яркости на том же силуэте не прочиталась бы — на
 * рабочем зуме прицеп занимает считаные пиксели, и «чуть темнее» от «чуть
 * светлее» там не отличить. Оттенок же различается мгновенно именно потому, что
 * тёплый цвет в этой сцене ровно один и глаз натренирован его выхватывать.
 *
 * Светлота обоих цветов почти совпадает (accentDim и buildingHigh отличаются по
 * относительной яркости на единицы процентов), поэтому силуэт машины не
 * меняется вовсе — меняется только температура. Стилевой замок цел: тёплое
 * по-прежнему одно, и теперь оно означает не «здесь машина», а «здесь работа».
 * Порожний парк на карте буквально остывает — та же мысль, что и в проценте
 * порожнего пробега в панели компании, только видимая без единой цифры.
 *
 * Цвета — объекты Three, а не строки: setColorAt принимает Color, и разбор
 * шестнадцатеричной строки в кадре был бы аллокацией на каждую машину.
 */
const TRAILER_LOADED = new Color(palette.accentDim)
const TRAILER_EMPTY = new Color(palette.buildingHigh)

/**
 * Ёмкость буфера инстансов растёт ступенями.
 *
 * Размер буфера задаётся в конструкторе `InstancedMesh` и на лету не меняется:
 * смена ёмкости — это пересоздание объекта. Ступень в 128 машин означает, что
 * покупка каждой следующей машины НЕ пересобирает буфер, а пересборка случается
 * раз на сотню машин за партию. Память смешная: 128 инстансов это 8 КБ матриц.
 */
const CAPACITY_STEP = 128

// ─── Геометрия положения ───────────────────────────────────────────────────

/**
 * Спроецированные точки городов.
 *
 * Кэш модульный, а не через `useMemo`: координаты города — статические данные,
 * за партию они не меняются ни разу, тогда как объект состояния пересобирается
 * каждый тик. Любая мемоизация «от состояния» пересчитывала бы проекцию десяти
 * городов впустую по несколько раз в секунду.
 */
const projectedCities = new Map<CityId, Point2>()

function cityPoint(id: CityId, cities: Record<CityId, City>): Point2 | null {
  const cached = projectedCities.get(id)
  if (cached !== undefined) return cached

  const city = cities[id]
  if (city === undefined) return null

  const point = project(city.coord, CFO_ORIGIN)
  projectedCities.set(id, point)
  return point
}

/**
 * Положение машины на игровой плоскости и её курс, если он известен.
 *
 * Структура мутируемая и существует в двух экземплярах на весь модуль. Это не
 * преждевременная оптимизация: при трёхстах машинах и 60 кадрах аллокация двух
 * объектов на машину дала бы 36 тысяч короткоживущих объектов в секунду —
 * ровно тот мусор, из-за которого сборщик даёт заметные подёргивания картинки.
 */
type Placement = {
  x: number
  y: number
  /** Курс в радианах на плоскости карты: 0 — на восток, π/2 — на север. */
  heading: number
  /** В узле машина стоит, и брать направление неоткуда. */
  hasHeading: boolean
  /** false, если положение не удалось разрешить: такую машину не рисуем. */
  valid: boolean
}

const currentPlacement: Placement = {
  x: 0,
  y: 0,
  heading: 0,
  hasHeading: false,
  valid: false,
}
const previousPlacement: Placement = {
  x: 0,
  y: 0,
  heading: 0,
  hasHeading: false,
  valid: false,
}

/**
 * Разложить `VehiclePosition` в точку на плоскости.
 *
 * На ребре важен `fromId`: ребро ненаправленное, одно и то же «moscow-tula»
 * обслуживает оба направления, и без учёта того, откуда выехали, половина парка
 * поехала бы задом наперёд. Целевой город — тот конец ребра, который не
 * совпадает с `fromId`.
 */
function resolvePlacement(
  position: VehiclePosition | undefined,
  world: GameState['world'],
  out: Placement,
): void {
  out.valid = false
  out.hasHeading = false
  if (position === undefined) return

  if (position.kind === 'узел') {
    const point = cityPoint(position.nodeId, world.cities)
    if (point === null) return
    out.x = point.x
    out.y = point.y
    out.valid = true
    return
  }

  const edge = world.edges[position.edgeId]
  if (edge === undefined) return

  // Машина обязана стоять на одном из концов своего ребра. Если это не так —
  // рассинхронизация состояния, и рисовать наугад хуже, чем не рисовать: в
  // пропущенной машине баг видно, в машине посреди поля — нет.
  if (position.fromId !== edge.from && position.fromId !== edge.to) return
  const toId = position.fromId === edge.from ? edge.to : edge.from

  const from = cityPoint(position.fromId, world.cities)
  const to = cityPoint(toId, world.cities)
  if (from === null || to === null) return

  // Зажим на случай, если движение успело выйти за конец ребра до фазы прибытия.
  const t = position.progress < 0 ? 0 : position.progress > 1 ? 1 : position.progress

  out.x = from.x + (to.x - from.x) * t
  out.y = from.y + (to.y - from.y) * t
  // Проекция аффинная, поэтому направление ребра постоянно по всей его длине и
  // считается один раз по концам, а не по соседним кадрам.
  out.heading = Math.atan2(to.y - from.y, to.x - from.x)
  out.hasHeading = true
  out.valid = true
}

const TWO_PI = Math.PI * 2

/**
 * Интерполяция углов по кратчайшей дуге.
 *
 * Обычный lerp на курсах ломается там, где угол переходит через ±π: машина,
 * поворачивающая с −170° на 170°, крутанулась бы на 340° в обратную сторону.
 * Разворот на перекрёстке — как раз тот случай, когда это видно.
 */
function lerpAngle(from: number, to: number, t: number): number {
  const delta = ((((to - from + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI
  return from + delta * t
}

// ─── Многоразовые объекты для матриц ───────────────────────────────────────
// Те же соображения, что и с Placement: в кадре не должно быть ни одной
// аллокации.

const Y_AXIS = new Vector3(0, 1, 0)
const UNIT_SCALE = new Vector3(1, 1, 1)
const rigPosition = new Vector3()
const rigRotation = new Quaternion()
const rigMatrix = new Matrix4()
const partMatrix = new Matrix4()

/**
 * Буфер матриц обновляется каждый кадр — драйверу об этом лучше сказать явно,
 * иначе он разместит его в памяти, оптимизированной под статику.
 */
function markDynamic(mesh: InstancedMesh): void {
  mesh.instanceMatrix.setUsage(DynamicDrawUsage)
}

/** Ёмкость буфера под текущий размер парка, округлённая вверх до ступени. */
const selectCapacity = (store: GameStore): number => {
  const count = Object.keys(store.state.vehicles).length
  return Math.max(1, Math.ceil(count / CAPACITY_STEP)) * CAPACITY_STEP
}

export function Vehicles(): JSX.Element {
  const capacity = useGameStore(selectCapacity)

  const cabRef = useRef<InstancedMesh>(null)
  const trailerRef = useRef<InstancedMesh>(null)

  /**
   * Последний известный курс каждой машины.
   *
   * Нужен ровно для одного случая: машина стоит в городе, и направление взять
   * неоткуда ни в одном из двух снимков. Без памяти о курсе весь простаивающий
   * парк развернулся бы на восток — стоянка выглядела бы строем, а выезд
   * начинался бы с мгновенного разворота.
   */
  const headingsRef = useRef<Map<VehicleId, number>>(new Map())

  useFrame(() => {
    const cab = cabRef.current
    const trailer = trailerRef.current
    if (cab === null || trailer === null) return

    // Прямое чтение стора вместо хука: см. шапку файла.
    const { state, prev } = useGameStore.getState()

    const raw = clock.alpha
    const alpha = raw < 0 ? 0 : raw > 1 ? 1 : raw

    const headings = headingsRef.current
    const vehicles = Object.values(state.vehicles)
    // Настоящий размер буфера, а не значение из рендера: между тиком, добавившим
    // машину, и перерисовкой компонента проходит кадр-другой, и в этом окне
    // машин может оказаться больше, чем мест.
    const limit = cab.instanceMatrix.count

    let drawn = 0
    for (const vehicle of vehicles) {
      if (drawn >= limit) break

      resolvePlacement(vehicle.position, state.world, currentPlacement)
      if (!currentPlacement.valid) continue

      // Машины может не быть в prev — её только что купили или она появилась
      // после загрузки сохранения. Интерполировать не от чего, ставим сразу на
      // место: любой другой вариант дал бы бросок через полкарты за один тик.
      resolvePlacement(prev.vehicles[vehicle.id]?.position, prev.world, previousPlacement)

      let x = currentPlacement.x
      let y = currentPlacement.y
      if (previousPlacement.valid) {
        x = previousPlacement.x + (currentPlacement.x - previousPlacement.x) * alpha
        y = previousPlacement.y + (currentPlacement.y - previousPlacement.y) * alpha
      }

      const remembered = headings.get(vehicle.id)
      const to = currentPlacement.hasHeading
        ? currentPlacement.heading
        : previousPlacement.hasHeading
          ? previousPlacement.heading
          : (remembered ?? 0)
      const from = previousPlacement.hasHeading
        ? previousPlacement.heading
        : (remembered ?? to)
      const heading = lerpAngle(from, to, alpha)
      headings.set(vehicle.id, heading)

      // Y в Three.js — вверх, а наш север (Point2.y) уходит в Z СО СМЕНОЙ ЗНАКА,
      // иначе карта выйдет зеркальной. Подробный разбор — в шапке projection.ts.
      rigPosition.set(x, 0, -y)
      // Поворот вокруг вертикали на курс: локальная +X ложится ровно на
      // направление движения именно при таком знаке, потому что Z инвертирован.
      rigRotation.setFromAxisAngle(Y_AXIS, heading)
      rigMatrix.compose(rigPosition, rigRotation, UNIT_SCALE)

      partMatrix.multiplyMatrices(rigMatrix, CAB_OFFSET)
      cab.setMatrixAt(drawn, partMatrix)
      partMatrix.multiplyMatrices(rigMatrix, TRAILER_OFFSET)
      trailer.setMatrixAt(drawn, partMatrix)

      /*
       * Цвет прицепа пишется по тому же индексу и в том же проходе, что и его
       * матрица, — иначе при пропуске машины с неразобранным положением цвета
       * съехали бы на один инстанс и часть парка врала бы про свой груз.
       *
       * Груз берётся из ТЕКУЩЕГО снимка без интерполяции, в отличие от
       * положения. Погрузка происходит мгновенно и только в узле: смешивать
       * «наполовину гружёную» машину не с чем, и промежуточного состояния у неё
       * нет. Порога по тоннам здесь нет намеренно — фаза прибытия гарантирует,
       * что незначимый остаток в кузове превращается в null (TONS_EPSILON в
       * logistics/loading.ts), и второй порог в рендере разошёлся бы с первым.
       */
      trailer.setColorAt(drawn, vehicle.cargo === null ? TRAILER_EMPTY : TRAILER_LOADED)

      drawn++
    }

    // Лишние инстансы не рисуются, а не прячутся нулевым масштабом: count
    // отсекает их до вершинного шейдера.
    cab.count = drawn
    trailer.count = drawn
    cab.instanceMatrix.needsUpdate = true
    trailer.instanceMatrix.needsUpdate = true

    /*
     * Буфер цветов создаётся Three лениво, при первом setColorAt, поэтому
     * проверка на null — не перестраховка, а единственный способ его увидеть.
     *
     * Заливка отправляется целиком каждый кадр, а не по изменению. Сравнивать
     * не с чем: в буфере лежат float32, а константы — обычные числа, и
     * округление при записи делает точное сравнение бесполезным. Держать ради
     * этого третий массив с признаками не стоит того — цвета это три числа на
     * инстанс против тридцати двух у двух матриц, которые и так уходят на
     * видеокарту каждый кадр. Usage выставляется тут же по той же причине, по
     * которой markDynamic делает это для матриц.
     */
    const colors = trailer.instanceColor
    if (colors !== null) {
      if (colors.usage !== DynamicDrawUsage) colors.setUsage(DynamicDrawUsage)
      colors.needsUpdate = true
    }

    // Машины выбывают редко (продажа, банкротство), но карта курсов не должна
    // расти вечно. Сверка размеров дешевле полного обхода и срабатывает только
    // после реальной убыли парка.
    if (headings.size > vehicles.length) {
      for (const id of headings.keys()) {
        if (!(id in state.vehicles)) headings.delete(id)
      }
    }
  })

  return (
    <>
      {/*
        Тягач — единственное по-настоящему светящееся тело в сцене. Свечение выше
        порога блума (0.55 в postFx), поэтому на карте машина видна как искра
        даже там, где сама коробка занимает несколько пикселей. Это и есть
        стилевой замок: глаз ищет оранжевое и всегда находит транспорт.

        frustumCulled выключен у обеих частей: отсечение по пирамиде видимости
        считается по геометрии инстанса, а не по разбросу инстансов, и весь парк
        исчезал бы разом, стоило камере отвести взгляд от начала координат.

        Тени машины не отбрасывают намеренно. Карта теней растянута на весь
        округ — сотни километров, — и девятикилометровый сцеп занял бы в ней
        считаные тексели: получилась бы не тень, а дрожащее пятно. Своё место в
        кадре машина держит свечением, а не тенью.
      */}
      <instancedMesh
        ref={cabRef}
        args={[undefined, undefined, capacity]}
        frustumCulled={false}
        onUpdate={markDynamic}
      >
        <boxGeometry args={[CAB.length, CAB.height, CAB.width]} />
        <meshStandardMaterial
          color={palette.accent}
          emissive={palette.accent}
          emissiveIntensity={1.15}
          roughness={0.45}
          metalness={0.05}
        />
      </instancedMesh>

      {/*
        Прицеп темнее кабины — два одинаково ярких бруска на общем плане
        сливаются в оранжевое пятно, а тёмный прицеп за яркой кабиной сразу
        читается как направление движения.

        ЦВЕТ МАТЕРИАЛА НЕ ЗАДАН НАМЕРЕННО. По умолчанию он белый, то есть
        единица умножения, — а настоящий цвет приходит по-инстансно из палитры
        (TRAILER_LOADED и TRAILER_EMPTY выше). Задай мы здесь оттенок, он
        домножился бы на инстансный и увёл бы оба цвета из палитры сразу.

        СВЕЧЕНИЯ У ПРИЦЕПА БОЛЬШЕ НЕТ, и это не потеря, а следствие правила.
        Emissive — свойство материала, одно на все инстансы: его нельзя погасить
        для порожней машины и оставить гружёной. Тёплое свечение поверх
        холодного прицепа замывало бы ровно ту разницу температур, ради которой
        всё затевалось. Заодно замок становится честнее прежнего: светится
        только акцент, а акцент здесь — кабина. Прицеп остаётся видимым за счёт
        ключевого света и заливки, его светлота от смены цвета не меняется.
      */}
      <instancedMesh
        ref={trailerRef}
        args={[undefined, undefined, capacity]}
        frustumCulled={false}
        onUpdate={markDynamic}
      >
        <boxGeometry args={[TRAILER.length, TRAILER.height, TRAILER.width]} />
        <meshStandardMaterial roughness={0.6} metalness={0.05} />
      </instancedMesh>
    </>
  )
}
