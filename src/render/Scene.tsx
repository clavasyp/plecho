/**
 * Содержимое канваса: камера, свет, туман, подложка, постпроцессинг и слои
 * карты.
 *
 * Компонент намеренно НЕ подписан на игровое состояние. Он рендерит <Roads/>,
 * <Cities/> и <Vehicles/>, и если бы он перерисовывался на каждом тике, то
 * тянул бы за собой всех троих — включая перестройку застройки и дорожной сети.
 * Города нужны Scene ровно один раз, чтобы вписать карту в кадр, поэтому они
 * читаются разовым getState() вместо подписки: это не обход контракта, а его
 * прямое следствие — камера настраивается однажды, а не каждый тик.
 *
 * КАМЕРА. Ортографическая: перспектива на карте округа врёт — дальний город
 * оказывается мельче ближнего, хотя оба одинаково важны, — и ломает главное
 * свойство изометрии, одинаковый масштаб по всему кадру. Классический
 * изометрический ракурс (45° по горизонтали, 35.264° по вертикали) получается
 * сам собой, если поставить камеру на диагональ куба: направление (1,1,1) даёт
 * азимут ровно 45°, а подъём arctg(1/√2) = 35.264°. Ничего вычислять не нужно —
 * достаточно нормировать диагональ.
 */

import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { ComponentRef, JSX } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { MapControls, OrthographicCamera } from '@react-three/drei'
import {
  Bloom,
  EffectComposer,
  Noise,
  Vignette,
} from '@react-three/postprocessing'
import { BlendFunction } from 'postprocessing'
import { useGameStore } from '../app/store'
import { fogRange, lighting, palette, postFx } from './palette'
import { Cities, cityPoint } from './CityMesh'
import { Roads } from './RoadMesh'
import { Vehicles } from './VehicleMesh'

/** Единичный вектор изометрической диагонали. */
const ISO = 1 / Math.sqrt(3)

/**
 * Удаление камеры от центра карты, км.
 *
 * Для ортографической проекции расстояние не влияет на размер объектов — но
 * влияет на туман, потому что туман считается от глубины в системе координат
 * камеры. При fogRange 400..1400 и карте в 600 км эта константа решает, какая
 * часть карты попадёт в дымку: при 500 ближний край кадра чистый, центр карты
 * тонет в тумане на десятую, дальние города — на четверть, а рельеф за ними
 * уходит в цвет фона. Отодвинь камеру на 1200 — и вся карта окажется в молоке.
 */
const CAMERA_DISTANCE = 500

/**
 * Пределы отсечения ортографической камеры, км.
 *
 * Отрицательный near — не опечатка: у ортографической проекции матрица
 * аффинная, отрицательная ближняя плоскость совершенно законна и здесь
 * необходима. Подложка тянется на километры «за спину» камеры, и при near = 0
 * она обрезалась бы ровной линией поперёк переднего плана — самый заметный
 * артефакт из возможных.
 */
const CAMERA_NEAR = -3500
const CAMERA_FAR = 5000

/** Запас вокруг карты при вписывании в кадр. */
const FRAME_MARGIN = 1.15

/** Насколько можно отдалиться и приблизиться относительно вписанного кадра. */
const ZOOM_OUT_LIMIT = 0.65
const ZOOM_IN_LIMIT = 16

/** Насколько можно увести центр обзора за пределы карты, км. */
const PAN_MARGIN = 140

/**
 * Сторона подложки, км.
 *
 * Должна быть заведомо больше дальности тумана, иначе край подложки попадёт в
 * кадр раньше, чем растворится, и мир получит видимую границу.
 */
const GROUND_SIZE = 4000

/**
 * Вынос ключевого света вдоль его направления, км.
 *
 * Направленному свету расстояние безразлично — важен только вектор, а он взят
 * из палитры без изменений. Но камера теней у такого света ортографическая и
 * строится вокруг его позиции: с исходных 340 км половина карты оказалась бы
 * позади световой плоскости и выпала из карты глубины. Вынос по тому же лучу
 * меняет ровно одно — охват теней.
 */
const KEY_LIGHT_DISTANCE = 900

/** Полуразмер камеры теней, км. Покрывает карту с запасом на пригороды. */
const SHADOW_EXTENT = 420

/** Размер карты теней. */
const SHADOW_MAP = 2048

type Framing = {
  center: { x: number; z: number }
  /** Половина стороны квадрата, в который вписаны все города, км. */
  extent: number
}

/** Прямоугольник, в который укладывается вся карта. */
function frameCities(): Framing {
  const cities = Object.values(useGameStore.getState().state.world.cities)

  if (cities.length === 0) {
    return { center: { x: 0, z: 0 }, extent: 300 }
  }

  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity

  for (const city of cities) {
    const point = cityPoint(city)
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minZ = Math.min(minZ, point.z)
    maxZ = Math.max(maxZ, point.z)
  }

  return {
    center: { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 },
    // Квадрат, а не прямоугольник: при повороте на 45° карта всё равно
    // разворачивается в ромб, и считать по одной стороне проще и честнее.
    extent: Math.max(maxX - minX, maxZ - minZ) / 2,
  }
}

export function Scene(): JSX.Element {
  const size = useThree((state) => state.size)
  const gl = useThree((state) => state.gl)

  const framing = useMemo(frameCities, [])

  const view = useMemo(() => {
    // Квадрат со стороной S, повёрнутый на 45° и наклонённый на 35.264°,
    // занимает на экране ромб шириной S·√2 и высотой S·√2/√3. Считать нужно
    // именно так: по стороне квадрата карта оставила бы половину кадра пустой,
    // а по диагонали — вылезла бы за края.
    const side = framing.extent * 2
    const spanX = side * Math.SQRT2
    const spanY = (side * Math.SQRT2) / Math.sqrt(3)

    const zoom =
      Math.min(size.width / spanX, size.height / spanY) / FRAME_MARGIN

    return {
      zoom,
      minZoom: zoom * ZOOM_OUT_LIMIT,
      maxZoom: zoom * ZOOM_IN_LIMIT,
      position: [
        framing.center.x + CAMERA_DISTANCE * ISO,
        CAMERA_DISTANCE * ISO,
        framing.center.z + CAMERA_DISTANCE * ISO,
      ] as [number, number, number],
    }
  }, [framing, size.width, size.height])

  // Vector3, а не литерал массива: новый массив на каждом рендере R3F считает
  // изменившимся значением и сбрасывал бы панораму пользователя при каждом
  // изменении размера окна.
  const target = useMemo(
    () => new THREE.Vector3(framing.center.x, 0, framing.center.z),
    [framing],
  )

  const keyLight = useMemo(() => {
    const direction = new THREE.Vector3(...lighting.keyPosition).normalize()
    return direction.multiplyScalar(KEY_LIGHT_DISTANCE)
  }, [])

  /**
   * Заливка — с противоположной стороны и низко.
   *
   * Азимут зеркалит ключевой свет, поэтому подсвечиваются ровно те грани, что у
   * ключевого в тени. Класть источник буквально под карту бессмысленно: снизу
   * освещались бы днища коробок, которых с изометрии не видно.
   */
  const fillLight = useMemo(
    () =>
      new THREE.Vector3(
        -lighting.keyPosition[0],
        lighting.keyPosition[1] * 0.35,
        -lighting.keyPosition[2],
      ),
    [],
  )

  const controls = useRef<ComponentRef<typeof MapControls>>(null)

  /**
   * Ограничение панорамирования.
   *
   * Карта конечна, а панорамирование — нет: без ограничителя карту можно увести
   * за край экрана и остаться перед пустой подложкой без единого ориентира.
   * Правим цель и сдвигаем камеру на ту же величину, иначе изменится ракурс.
   * Повторного срабатывания не боимся: после правки значения уже в пределах,
   * второй проход ничего не меняет.
   */
  const clampPan = useCallback(() => {
    const orbit = controls.current
    if (!orbit) return

    const limit = framing.extent + PAN_MARGIN

    const x = THREE.MathUtils.clamp(
      orbit.target.x,
      framing.center.x - limit,
      framing.center.x + limit,
    )
    const z = THREE.MathUtils.clamp(
      orbit.target.z,
      framing.center.z - limit,
      framing.center.z + limit,
    )

    if (x === orbit.target.x && z === orbit.target.z && orbit.target.y === 0) {
      return
    }

    orbit.object.position.x += x - orbit.target.x
    orbit.object.position.y -= orbit.target.y
    orbit.object.position.z += z - orbit.target.z
    orbit.target.set(x, 0, z)
  }, [framing])

  // Тени включаются на самом рендерере, а <Canvas> находится в чужом файле.
  // Операция идемпотентна: если shadows уже заданы на канвасе, это пустое
  // присваивание. Layout-эффект, а не обычный, чтобы флаг встал до первого
  // кадра — иначе материалы скомпилируются без поддержки теней.
  useLayoutEffect(() => {
    gl.shadowMap.enabled = true
    gl.shadowMap.type = THREE.PCFSoftShadowMap
    gl.shadowMap.needsUpdate = true
  }, [gl])

  return (
    <>
      {/* Фон канваса и цвет тумана обязаны совпадать: туман растворяет дальний
          план именно в фон, и любое расхождение проявится светлым или тёмным
          ободком по краю карты. */}
      <color attach="background" args={[palette.background]} />
      <fog attach="fog" args={[palette.fog, fogRange.near, fogRange.far]} />

      <OrthographicCamera
        makeDefault
        position={view.position}
        zoom={view.zoom}
        near={CAMERA_NEAR}
        far={CAMERA_FAR}
      />

      <MapControls
        ref={controls}
        makeDefault
        target={target}
        onChange={clampPan}
        enableDamping
        dampingFactor={0.12}
        zoomToCursor
        minZoom={view.minZoom}
        maxZoom={view.maxZoom}
        // Полярный угол — от вертикали. Верхняя граница в 75° не даёт уйти под
        // карту и увидеть её с изнанки, нижняя оставляет вид почти сверху для
        // разбора развязок. Изометрические 54.7° лежат ровно посередине, так
        // что ракурс по умолчанию не прижат к ограничителю.
        minPolarAngle={0.25}
        maxPolarAngle={1.31}
        // MapControls вешает панорамирование на левую кнопку, а вращение — на
        // правую, то есть основные жесты и так пан с зумом. Вращение оставлено,
        // но втрое медленнее обычного: изометрию не должно сбивать случайным
        // движением мыши, а осмотреть развязку с другой стороны иногда нужно.
        rotateSpeed={0.35}
      />

      <ambientLight
        color={lighting.ambientColor}
        intensity={lighting.ambientIntensity}
      />

      <directionalLight
        color={lighting.keyColor}
        intensity={lighting.keyIntensity}
        position={keyLight}
        castShadow
        shadow-mapSize-width={SHADOW_MAP}
        shadow-mapSize-height={SHADOW_MAP}
        shadow-camera-left={-SHADOW_EXTENT}
        shadow-camera-right={SHADOW_EXTENT}
        shadow-camera-top={SHADOW_EXTENT}
        shadow-camera-bottom={-SHADOW_EXTENT}
        // Ближняя и дальняя плоскости выведены из выноса света, а не подобраны:
        // сцена лежит в слое толщиной примерно в два полуразмера вокруг него.
        shadow-camera-near={KEY_LIGHT_DISTANCE - SHADOW_EXTENT * 2}
        shadow-camera-far={KEY_LIGHT_DISTANCE + SHADOW_EXTENT * 2}
        // Один тексель карты теней покрывает здесь около 400 метров, и обычного
        // bias при таком размере не хватает — тень отрывается от здания или,
        // наоборот, ползёт по его стене. Сдвиг вдоль нормали в километр
        // избавляет от обоих артефактов.
        shadow-normalBias={1}
        shadow-bias={-0.0004}
      />

      {/* Заливка теней не отбрасывает: вторая карта теней стоила бы столько же,
          сколько ключевая, а дала бы только конфликтующие полутени. */}
      <directionalLight
        color={lighting.fillColor}
        intensity={lighting.fillIntensity}
        position={fillLight}
      />

      {/* Подложка. Плоскость, а не рельеф: высоты в ЦФО ничего не решают ни в
          игре, ни в картинке, а честный рельеф стоил бы карты высот и сетки в
          сотни тысяч вершин ради еле заметных бугров. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[framing.center.x, 0, framing.center.z]}
        receiveShadow
      >
        <planeGeometry args={[GROUND_SIZE, GROUND_SIZE]} />
        <meshStandardMaterial
          color={palette.terrain}
          roughness={1}
          metalness={0}
        />
      </mesh>

      <Roads />
      <Cities />
      <Vehicles />

      {/*
        Порядок эффектов не косметика — они применяются цепочкой, и каждый
        следующий видит результат предыдущего.

        Bloom первым, потому что он читает яркость СЦЕНЫ. Поставь его после
        виньетки — и свечение фар начало бы зависеть от того, в какой части
        кадра машина: у края виньетка уже притушила бы её ниже порога, и
        единственный светящийся объект в палитре погас бы просто от
        панорамирования.

        Vignette второй: это свойство объектива, а не сцены. Она затемняет уже
        собранное изображение вместе со свечением — ровно так, как это делает
        настоящая оптика, где виньетирование происходит после того, как свет уже
        рассеялся в линзах.

        Noise последним и только последним. Зерно — это плёнка, оно ложится на
        готовый кадр. Пропусти его через Bloom — и яркие точки шума сами дали бы
        свечение, превратив равномерную фактуру в мерцающую грязь, которая к
        тому же дёргается каждый кадр.
      */}
      <EffectComposer
        // Восьмикратное сглаживание по умолчанию на карте, где почти вся
        // геометрия — прямые грани коробок, заметно дороже без видимой разницы
        // с четырёхкратным.
        multisampling={4}
      >
        <Bloom
          intensity={postFx.bloomIntensity}
          luminanceThreshold={postFx.bloomThreshold}
          luminanceSmoothing={postFx.bloomSmoothing}
          mipmapBlur
        />
        <Vignette
          offset={postFx.vignetteOffset}
          darkness={postFx.vignetteDarkness}
        />
        {/* SCREEN, а не OVERLAY: сцена почти чёрная, и любой режим, работающий
            от яркости основы, на ней вырождается в ничто. Экранное смешение
            кладёт зерно именно в тени — туда, где градиент тумана иначе идёт
            видимыми полосами. */}
        <Noise
          blendFunction={BlendFunction.SCREEN}
          opacity={postFx.noiseOpacity}
        />
      </EffectComposer>
    </>
  )
}
