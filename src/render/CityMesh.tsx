/**
 * Силуэты городов.
 *
 * Город на карте — не иконка, а кластер зданий: по нему с одного взгляда
 * читается размер. Москва обязана выглядеть на порядок крупнее Орла, потому что
 * в этом весь конфликт игры — всё едет в столицу, а обратное плечо порожнее.
 * Число, если его не показать глазами, останется числом в таблице.
 *
 * Файл определяют три решения.
 *
 * ПЕРВОЕ. Силуэт считается, а не хранится, и считается от `Rng.forKey(cityId)`.
 * Math.random здесь был бы катастрофой: React перерисовывает компонент когда
 * захочет, StrictMode вообще монтирует всё дважды, — и город менял бы форму на
 * каждом ререндере. Сид от идентификатора даёт один и тот же силуэт между
 * ререндерами, сессиями и машинами разных игроков, не занимая при этом ни байта
 * в сохранении.
 *
 * ВТОРОЕ. Вертикальный масштаб преувеличен, и это сознательно. Одна единица
 * сцены — километр; самая высокая башня Москвы — 0.37 км, то есть в честном
 * масштабе на карте 600×600 км город оказался бы плоским пятном тоньше дорожной
 * ленты. Высоты подняты примерно в полсотни раз — ровно настолько, чтобы силуэт
 * читался с изометрии. Это карта-диорама, а не макет местности; то же самое
 * делает любая настольная игра, когда ставит на клетку фишку-домик.
 *
 * ТРЕТЬЕ. Все здания всех городов — один InstancedMesh. Их под семьсот, и
 * семьсот отдельных Mesh дали бы семьсот вызовов отрисовки на кадр: столько
 * сцена не выдержит вместе с постпроцессингом.
 */

import { useLayoutEffect, useMemo, useRef } from 'react'
import type { JSX } from 'react'
import * as THREE from 'three'
import { Html } from '@react-three/drei'
import { useShallow } from 'zustand/shallow'
import { useGameStore } from '../app/store'
import { Rng } from '../sim/rng'
import { CFO_ORIGIN, project } from '../sim/world/projection'
import { palette } from './palette'
import type { City } from '../sim/types'

// ─── Мир ───────────────────────────────────────────────────────────────────

/**
 * Положение города в координатах сцены, км.
 *
 * Единственное место в рендере, где выполняется переход «плоскость проекции →
 * Three.js». Смена знака у Z обязательна: север в Point2.y положительный, а в
 * Three.js горизонтальная плоскость — XZ, и без минуса карта выходит зеркальной
 * (подробный разбор — в шапке projection.ts). Функцию экспортируем, чтобы
 * RoadMesh и Scene брали положения городов отсюда: два независимых перевода
 * координат рано или поздно разъезжаются в знаке, и тогда дороги ведут не в те
 * города, а камера смотрит мимо карты.
 *
 * Экспорт не-компонента из файла с компонентом ломает Fast Refresh для этого
 * модуля — линтер об этом честно предупреждает. Размен сознательный: правка
 * силуэтов при разработке будет стоить полной перезагрузки страницы, зато
 * соглашение о знаке Z живёт в одном месте, а не в трёх.
 */
export function cityPoint(city: City): { x: number; z: number } {
  const flat = project(city.coord, CFO_ORIGIN)
  return { x: flat.x, z: -flat.y }
}

// ─── Параметры силуэта ─────────────────────────────────────────────────────
// Всё нормировано на «средний областной центр» в 300 тысяч: так в константах
// видно, что именно они описывают, а Орёл с его 289 тысячами оказывается ровно
// эталоном и служит нижней точкой отсчёта при подгонке.

/** Население опорного города. */
const REFERENCE_POPULATION = 300_000

/** Радиус застройки опорного города, км. */
const REFERENCE_RADIUS = 6

/**
 * Показатель роста радиуса от населения.
 *
 * Честная физика дала бы 0.5 (площадь пропорциональна числу жителей), но тогда
 * Москва получила бы радиус в 40 км и её пятно заняло бы пятую часть карты,
 * перекрыв Тулу с Калугой. 0.42 сжимает верх шкалы, сохраняя порядок: Москва
 * впятеро шире Орла, и этого достаточно, чтобы прочитать иерархию.
 */
const RADIUS_EXPONENT = 0.42

/** Высота самого высокого здания опорного города, км (с преувеличением). */
const REFERENCE_PEAK = 5

/** Прибавка к высоте за каждый десятикратный рост населения, км. */
const PEAK_PER_DECADE = 8

/** Число зданий опорного города. */
const REFERENCE_COUNT = 28

/**
 * Показатель роста числа зданий.
 *
 * Ниже единицы намеренно: линейный рост дал бы Москве больше тысячи коробок при
 * почти нулевом выигрыше в читаемости — на экране они всё равно сливаются в
 * массу. 0.75 держит Москву около четырёхсот, а весь мир — под семьюстами.
 */
const COUNT_EXPONENT = 0.75

/** Минимальное число зданий: из трёх коробок город не читается. */
const MIN_BUILDING_COUNT = 8

/**
 * Доля площади города, занятая зданиями.
 *
 * Из неё выводится размер коробки: side = radius * sqrt(π * coverage / count).
 * Задавать размер напрямую в километрах нельзя — тогда у Орла с его 28 зданиями
 * на маленьком пятне застройка сомкнётся в сплошную плиту, а Москва при том же
 * размере рассыплется в редкую крупу. Через плотность обе крайности исчезают
 * сами: размер подстраивается под радиус и число зданий.
 */
const BUILDING_COVERAGE = 0.45

/**
 * Смещение застройки к центру: r = radius * u^CORE_BIAS.
 *
 * При 0.5 точки легли бы равномерно по площади, и город вышел бы блином. Выше
 * 0.5 — сгущение к середине, то есть центр выше и плотнее окраин, как в любом
 * городе, выросшем вокруг одной точки.
 */
const CORE_BIAS = 0.8

/** Сколько кандидатов перебирается при выборе места под здание. */
const PLACEMENT_CANDIDATES = 6

/** Вероятность доминанты — одиночной башни выше окружающей застройки. */
const LANDMARK_CHANCE = 0.06

/** Во сколько раз доминанта выше своего расчётного роста. */
const LANDMARK_FACTOR = 1.55

/**
 * Высота площадки застройки над нулём, км.
 *
 * Выше любой дороги (см. ROAD_ELEVATION в RoadMesh): площадка должна накрывать
 * концы дорожных лент, иначе ленты торчат из города обрубками.
 */
const PAD_ELEVATION = 1

/** Насколько площадка шире самой застройки — это окраина и подъезды. */
const PAD_MARGIN = 1.3

/** Сегментов в круге площадки. Больше не нужно: круг мелкий и почти не виден. */
const PAD_SEGMENTS = 32

/** Зазор между верхом силуэта и подписью, км. */
const LABEL_CLEARANCE = 4

/** С какого населения город получает подпись полной яркости. */
const MAJOR_POPULATION = 1_000_000

// ─── Генерация ─────────────────────────────────────────────────────────────

type Silhouette = {
  /** Радиус застройки, км. */
  radius: number
  /** Потолок высоты для этого города, км. */
  peak: number
  /** Число зданий. */
  count: number
}

function silhouetteOf(city: City): Silhouette {
  const scale = city.population / REFERENCE_POPULATION

  return {
    radius: REFERENCE_RADIUS * scale ** RADIUS_EXPONENT,
    // Логарифм, а не степень: высота — самый заметный признак, и линейный рост
    // превратил бы Москву в иглу на фоне плинтусов.
    peak: REFERENCE_PEAK + PEAK_PER_DECADE * Math.log10(scale),
    count: Math.max(
      MIN_BUILDING_COUNT,
      Math.round(REFERENCE_COUNT * scale ** COUNT_EXPONENT),
    ),
  }
}

type Building = {
  x: number
  z: number
  width: number
  depth: number
  height: number
  yaw: number
}

/**
 * Здания одного города.
 *
 * Порядок обращений к ГПСЧ здесь — часть контракта: последовательность бросков
 * должна быть одинаковой при каждом вызове, иначе силуэт перестанет быть
 * стабильным. Поэтому кандидаты на место перебираются всегда все шесть, даже
 * когда победитель очевиден с первого.
 */
function buildingsOf(city: City, silhouette: Silhouette): Building[] {
  const rng = Rng.forKey(city.id)
  const { radius, peak, count } = silhouette

  // Своя ориентация уличной сетки у каждого города. Дешёвая деталь, а города
  // перестают выглядеть штампованными: коробки в Твери развёрнуты не так, как в
  // Рязани, и это заметно раньше, чем понимаешь почему.
  const grid = rng.range(0, Math.PI / 2)
  const gridCos = Math.cos(grid)
  const gridSin = Math.sin(grid)

  // Города не круглые: вытянутость вдоль сетки даёт долину реки или коридор
  // трассы, вокруг которых город и рос.
  const aspect = rng.range(0.72, 1.35)

  const side = radius * Math.sqrt((Math.PI * BUILDING_COVERAGE) / count)

  const placed: { x: number; z: number; core: number }[] = []

  for (let i = 0; i < count; i++) {
    // Наилучший из нескольких кандидатов — выборка Митчелла. Честный
    // равномерный бросок собирает здания в комки и оставляет проплешины, и глаз
    // читает это как ошибку, а не как город. Отбраковка по минимальному
    // расстоянию решала бы ту же задачу, но на плотной застройке Москвы рискует
    // не найти свободного места и зациклиться; здесь проходов ровно шесть.
    let best = { x: 0, z: 0, core: 0 }
    let bestGap = -1

    for (let candidate = 0; candidate < PLACEMENT_CANDIDATES; candidate++) {
      const angle = rng.range(0, Math.PI * 2)
      const core = rng.float() ** CORE_BIAS
      const r = radius * core

      // Эллипс в осях сетки, затем поворот сетки — порядок важен: повернуть
      // сначала значило бы растянуть уже повёрнутый эллипс по мировым осям и
      // потерять связь вытянутости с ориентацией улиц.
      const localX = Math.cos(angle) * r * aspect
      const localZ = (Math.sin(angle) * r) / aspect

      const x = localX * gridCos - localZ * gridSin
      const z = localX * gridSin + localZ * gridCos

      let gap = Infinity
      for (const other of placed) {
        const dx = other.x - x
        const dz = other.z - z
        gap = Math.min(gap, dx * dx + dz * dz)
      }

      if (gap > bestGap) {
        bestGap = gap
        best = { x, z, core }
      }
    }

    placed.push(best)
  }

  return placed.map((spot) => {
    // Ближе к центру — выше и уже, к окраине — ниже и шире: так выглядит любой
    // город, где земля в центре дороже. Даёт ровно тот колокол силуэта, ради
    // которого всё и затевалось.
    const height =
      peak *
      (0.16 + 0.84 * (1 - spot.core) ** 1.6) *
      rng.range(0.6, 1) *
      (rng.chance(LANDMARK_CHANCE) ? LANDMARK_FACTOR : 1)

    const spread = 0.82 + 0.36 * spot.core

    return {
      x: spot.x,
      z: spot.z,
      width: side * spread * rng.range(0.75, 1.3),
      depth: side * spread * rng.range(0.75, 1.3),
      height: Math.max(height, peak * 0.12),
      // Небольшой разброс относительно сетки: идеально выровненные коробки
      // выглядят как склад контейнеров, а не как застройка.
      yaw: grid + rng.range(-0.12, 0.12),
    }
  })
}

/**
 * Круглые площадки застройки под городами — одной геометрией на все города.
 *
 * Служат двум целям сразу: отделяют город от рельефа тоном и прячут концы
 * дорожных лент, которые иначе торчали бы из центра города обрубками.
 *
 * Возвращаются сырые массивы, а не готовая BufferGeometry: геометрия собирается
 * из них JSX-элементами, и тогда её удаляет сам R3F. Собери мы объект здесь,
 * освобождать пришлось бы вручную из useEffect, а в StrictMode эффект гасится и
 * запускается заново — геометрия оказалась бы удалена, но не пересоздана, и
 * площадки молча исчезли бы в режиме разработки.
 */
function buildPads(
  spots: readonly { x: number; z: number; radius: number }[],
): { positions: Float32Array; normals: Float32Array } {
  const positions = new Float32Array(spots.length * PAD_SEGMENTS * 9)
  const normals = new Float32Array(spots.length * PAD_SEGMENTS * 9)
  let offset = 0

  for (const spot of spots) {
    const r = spot.radius * PAD_MARGIN

    for (let s = 0; s < PAD_SEGMENTS; s++) {
      const a0 = (s / PAD_SEGMENTS) * Math.PI * 2
      const a1 = ((s + 1) / PAD_SEGMENTS) * Math.PI * 2

      // Порядок вершин — центр, следующая, текущая: только при нём нормаль
      // треугольника смотрит в +Y и площадка не оказывается отбракована как
      // задняя грань.
      const triangle = [
        spot.x,
        spot.z,
        spot.x + Math.cos(a1) * r,
        spot.z + Math.sin(a1) * r,
        spot.x + Math.cos(a0) * r,
        spot.z + Math.sin(a0) * r,
      ]

      for (let v = 0; v < 3; v++) {
        positions[offset] = triangle[v * 2]
        positions[offset + 1] = PAD_ELEVATION
        positions[offset + 2] = triangle[v * 2 + 1]
        normals[offset + 1] = 1
        offset += 3
      }
    }
  }

  return { positions, normals }
}

// ─── Компонент ─────────────────────────────────────────────────────────────

export function Cities(): JSX.Element {
  // useShallow, а не голый селектор: реестр городов пересобирается на каждом
  // тике вместе с состоянием, и без поверхностного сравнения компонент
  // перестраивал бы всю застройку по несколько раз в секунду. Сами объекты
  // City не меняются, поэтому сравнение по значениям верхнего уровня отсекает
  // всё лишнее.
  const cities = useGameStore(useShallow((store) => store.state.world.cities))

  const layout = useMemo(() => {
    const items = Object.values(cities).map((city) => {
      const silhouette = silhouetteOf(city)
      const at = cityPoint(city)

      return {
        city,
        at,
        silhouette,
        buildings: buildingsOf(city, silhouette),
      }
    })

    return {
      items,
      buildings: items.flatMap((item) =>
        item.buildings.map((building) => ({
          x: item.at.x + building.x,
          z: item.at.z + building.z,
          width: building.width,
          depth: building.depth,
          height: building.height,
          yaw: building.yaw,
          // Тон по высоте: высокое — светлее. Один и тот же признак кодируется
          // дважды, силуэтом и тоном, поэтому иерархия читается даже там, где
          // силуэт съеден перспективой или туманом.
          tone: Math.min(1, building.height / item.silhouette.peak),
        })),
      ),
      pads: items.map((item) => ({
        x: item.at.x,
        z: item.at.z,
        radius: item.silhouette.radius,
      })),
    }
  }, [cities])

  const pads = useMemo(() => buildPads(layout.pads), [layout.pads])

  const mesh = useRef<THREE.InstancedMesh>(null)

  useLayoutEffect(() => {
    const target = mesh.current
    if (!target) return

    const matrix = new THREE.Matrix4()
    const quaternion = new THREE.Quaternion()
    const position = new THREE.Vector3()
    const scale = new THREE.Vector3()
    const axis = new THREE.Vector3(0, 1, 0)

    const low = new THREE.Color(palette.buildingLow)
    const high = new THREE.Color(palette.buildingHigh)
    const color = new THREE.Color()

    layout.buildings.forEach((building, index) => {
      // Коробка BoxGeometry центрирована, а здание стоит на земле — отсюда
      // подъём на половину высоты.
      position.set(building.x, building.height / 2, building.z)
      quaternion.setFromAxisAngle(axis, building.yaw)
      scale.set(building.width, building.height, building.depth)

      target.setMatrixAt(index, matrix.compose(position, quaternion, scale))
      target.setColorAt(index, color.lerpColors(low, high, building.tone))
    })

    target.instanceMatrix.needsUpdate = true
    if (target.instanceColor) target.instanceColor.needsUpdate = true

    // Без этого отсечение по пирамиде видимости считает габариты по исходной
    // коробке 1×1×1 в начале координат, и вся застройка исчезает, стоит увести
    // камеру от нуля.
    target.computeBoundingSphere()
  }, [layout])

  return (
    <group>
      <mesh receiveShadow>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[pads.positions, 3]}
          />
          <bufferAttribute
            attach="attributes-normal"
            args={[pads.normals, 3]}
          />
        </bufferGeometry>
        <meshStandardMaterial
          color={palette.terrainEdge}
          roughness={1}
          metalness={0}
        />
      </mesh>

      {layout.buildings.length > 0 && (
        <instancedMesh
          ref={mesh}
          // null! — идиома R3F: геометрия и материал приходят детьми, здесь
          // важно только третье значение, число экземпляров.
          args={[null!, null!, layout.buildings.length]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[1, 1, 1]} />
          {/* Цвет материала белый специально: instanceColor не заменяет цвет
              материала, а умножается на него, и любой другой оттенок здесь
              притушил бы всю палитру зданий разом. */}
          <meshStandardMaterial color="#ffffff" roughness={0.82} metalness={0} />
        </instancedMesh>
      )}

      {layout.items.map((item) => (
        <Html
          key={item.city.id}
          center
          position={[
            item.at.x,
            item.silhouette.peak + LABEL_CLEARANCE,
            item.at.z,
          ]}
          // Подпись не должна перехватывать курсор: под ней панорамирование
          // карты, и «мёртвые» пятна вокруг городов ощущаются как поломка.
          pointerEvents="none"
          zIndexRange={[20, 0]}
          style={{
            color:
              item.city.population >= MAJOR_POPULATION
                ? palette.text
                : palette.textDim,
            font: '600 10px/1 ui-sans-serif, system-ui, "Segoe UI", sans-serif',
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            whiteSpace: 'nowrap',
            userSelect: 'none',
            // Обводка цветом фона: подпись пересекает и тёмный рельеф, и
            // светлую застройку, и читаться должна на обоих.
            textShadow: `0 0 6px ${palette.background}, 0 0 3px ${palette.background}`,
          }}
        >
          {item.city.name}
        </Html>
      ))}
    </group>
  )
}
