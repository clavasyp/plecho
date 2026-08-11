/**
 * Содержимое канваса: камера, свет, туман, подложка, постпроцессинг и слои
 * карты.
 *
 * Компонент намеренно НЕ подписан на игровое состояние. Он рендерит <Roads/>,
 * <Cities/>, <Industries/>, <Lines/> и <Vehicles/>, и если бы он
 * перерисовывался на каждом тике, то тянул бы за собой их всех — включая
 * перестройку застройки и дорожной сети.
 * Города нужны Scene ровно один раз, чтобы вписать карту в кадр, поэтому они
 * читаются разовым getState() вместо подписки: это не обход контракта, а его
 * прямое следствие — камера настраивается однажды, а не каждый тик.
 *
 * ЭТОТ ФАЙЛ — СПИСОК ТОГО, ЧТО ВООБЩЕ ВИДНО В ИГРЕ. Дважды подряд компонент
 * оказывался написан, покрыт тестами и не смонтирован ни в одну сцену: в срезе
 * 1 так пропал поиск пути, в срезе 2 — три панели интерфейса. Юнит-тесты при
 * этом оставались зелёными, потому что проверяли модуль, а не его присутствие
 * в кадре. Отсюда правило: НОВЫЙ СЛОЙ КАРТЫ ПОЯВЛЯЕТСЯ ЗДЕСЬ В ТОМ ЖЕ КОММИТЕ,
 * ЧТО И ЕГО ФАЙЛ, а доказывает его видимость сквозной тест в tests/e2e.
 *
 * КАМЕРА. Ортографическая: перспектива на карте округа врёт — дальний город
 * оказывается мельче ближнего, хотя оба одинаково важны, — и ломает главное
 * свойство изометрии, одинаковый масштаб по всему кадру. Классический
 * изометрический ракурс (45° по горизонтали, 35.264° по вертикали) получается
 * сам собой, если поставить камеру на диагональ куба: направление (1,1,1) даёт
 * азимут ровно 45°, а подъём arctg(1/√2) = 35.264°. Ничего вычислять не нужно —
 * достаточно нормировать диагональ.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { ComponentRef, JSX } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { MapControls, OrthographicCamera } from '@react-three/drei'
import {
  Bloom,
  EffectComposer,
  Noise,
  ToneMapping,
  Vignette,
} from '@react-three/postprocessing'
import { BlendFunction, HueSaturationEffect, ToneMappingMode } from 'postprocessing'
import { clock } from '../app/loop'
import { useGameStore } from '../app/store'
import type { CityId } from '../sim/types'
import { fogRange, lighting, palette, postFx } from './palette'
import { atmosphere, atmosphereInto } from './sky'
import { Buildings, ServicePosts } from './BuildingMesh'
import { HOME_CITY } from '../sim/state'
import { Cities, cityPadReach, cityPoint } from './CityMesh'
import { CityPicker } from './CityPicker'
import { Industries } from './IndustryMesh'
import { layers as sceneLayers } from './layers'
import { Lines } from './LineMesh'
import { usePixelFloor } from './pixelFloor'
import { Roads } from './RoadMesh'
import { Vehicles } from './VehicleMesh'
import { Weather } from './Weather'

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
 * Кадр, под который подбирались числа тумана, км по вертикали экрана.
 *
 * Шестьсот километров округа плюс запас на поля — тот вид, на котором fogRange
 * выглядел правильно. Здесь это ЕДИНИЦА ИЗМЕРЕНИЯ, а не размер карты: туман
 * растягивается пропорционально тому, во сколько раз нынешний кадр шире этого.
 * Разбор — там, где значение применяется.
 */
const REFERENCE_SPAN_KM = 700

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

/**
 * Насколько можно отдалиться и приблизиться относительно СТАРТОВОГО кадра.
 *
 * Отдаление считается от стартового вида, а тот показывает край игрока, а не
 * всю страну (разбор — у START_SPAN_KM). Значит запаса на отдаление нужно
 * ровно столько, чтобы с него выйти на карту целиком — и ни капли больше.
 *
 * Стартовый кадр — 2400 км поперёк, страна с полями тумана — около 7000.
 * Отношение даёт 0.34. Прежние 0.12 позволяли отъехать втрое дальше нужного, и
 * там уже не было ничего: ромб подложки посреди пустого кадра и полсотни
 * наложившихся подписей.
 */
const ZOOM_OUT_LIMIT = 0.34
const ZOOM_IN_LIMIT = 16

/**
 * Что видно в первом кадре партии, километров поперёк.
 *
 * КАМЕРА ОТКРЫВАЕТСЯ НА КРАЕ ИГРОКА, А НЕ НА ВСЕЙ СТРАНЕ, и это решение, а не
 * настройка. Карта стала пять тысяч километров поперёк; вписанная в кадр
 * целиком, она даёт четыре километра на пиксель — дорога шириной в полкилометра
 * становится тоньше пикселя и исчезает вовсе, город в двадцать километров
 * превращается в пять точек. Первый кадр игры оказывался списком подписей на
 * пустом фоне, и ровно так он и выглядел на снимке.
 *
 * Тысяча двести километров — это ЦФО с запасом на соседей: Петербург и Казань
 * на краях, Москва в середине. Ровно тот мир, в котором игрок проводит первые
 * часы с одной машиной. Вся страна никуда не девается — до неё можно отдалиться
 * колесом, и это становится наградой за рост, а не стартовым экраном.
 */
const START_SPAN_KM = 1200

/** Насколько можно увести центр обзора за пределы карты, км. */
const PAN_MARGIN = 140

/**
 * Сторона подложки, км.
 *
 * Должна быть заведомо больше и КАРТЫ, и дальности тумана, иначе край подложки
 * попадёт в кадр раньше, чем растворится, и мир получит видимую границу.
 *
 * Четырёх тысяч хватало на карту округа в 600 км. Страна — 3700 км поперёк, и
 * при отдалении край подложки резал первый кадр диагональю: ровная линия
 * поперёк экрана там, где земля просто кончается. Восемь тысяч — это карта плюс
 * дальность тумана с двух сторон.
 */
const GROUND_SIZE = 8000

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

/**
 * Дев-подмена игрового времени для сцены. null — время идёт своим ходом.
 *
 * Модульная переменная, а не состояние React: её читает useFrame, и любая
 * запись в состояние перерисовывала бы дерево ради одного числа — тот же довод,
 * что у `clock.alpha` в app/loop.ts. Хук, который её ставит, заводится только в
 * разработке; в продакшене значение навсегда остаётся null.
 */
const timeOverride: { tick: number | null } = { tick: null }

/** Очередь обновления атмосферы в кадре. Разбор — у самого useFrame. */
const SKY_PRIORITY = -1

type Framing = {
  center: { x: number; z: number }
  /** Размах карты по осям мира, км. */
  width: number
  depth: number
}

/** Прямоугольник, в который укладывается вся карта. */
function frameCities(): Framing {
  const cities = Object.values(useGameStore.getState().state.world.cities)

  if (cities.length === 0) {
    return { center: { x: 0, z: 0 }, width: 600, depth: 600 }
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
    /*
     * ПРЯМОУГОЛЬНИК, А НЕ КВАДРАТ, и это пришлось переделать при переходе на
     * карту страны.
     *
     * Прежде здесь бралась бо́льшая из сторон: «при повороте на 45° карта всё
     * равно разворачивается в ромб, и считать по одной стороне проще». На карте
     * округа это было почти правдой — ЦФО укладывается в квадрат. Страна не
     * укладывается: от Пскова до Кемерова 3600 км по долготе против 1900 по
     * широте. Квадрат по большей стороне вписывал в кадр вдвое больше пустоты,
     * чем карты, города сбивались в угол, а половина экрана оставалась голой
     * подложкой — ровно то, что видно на первом же снимке.
     */
    width: maxX - minX,
    depth: maxZ - minZ,
  }
}

export function Scene(): JSX.Element {
  const size = useThree((state) => state.size)
  const gl = useThree((state) => state.gl)

  const framing = useMemo(frameCities, [])

  /** Где игрок начинает партию — центр стартового кадра. */
  const home = useMemo(() => {
    const city = useGameStore.getState().state.world.cities[HOME_CITY]
    return city === undefined
      ? framing.center
      : (({ x, z }) => ({ x, z }))(cityPoint(city))
  }, [framing])

  const view = useMemo(() => {
    /*
     * РАЗМАХ РОМБА НА ЭКРАНЕ, точно.
     *
     * Изометрия отображает точку мира как screen_x = (x − z)/√2 и
     * screen_y = (x + z)/√6. Значит прямоугольник W×Д превращается в ромб
     * шириной (W + Д)/√2 и высотой (W + Д)/√6 — обе стороны зависят от СУММЫ,
     * а не от большей из них. Прежняя формула брала квадрат по большей стороне
     * и потому на вытянутой карте промахивалась вдвое.
     */
    const spread = Math.min(
      framing.width + framing.depth,
      START_SPAN_KM * 2,
    )
    const spanX = spread / Math.SQRT2
    const spanY = spread / Math.sqrt(6)

    const zoom =
      Math.min(size.width / spanX, size.height / spanY) / FRAME_MARGIN

    return {
      zoom,
      minZoom: zoom * ZOOM_OUT_LIMIT,
      maxZoom: zoom * ZOOM_IN_LIMIT,
      position: [
        home.x + CAMERA_DISTANCE * ISO,
        CAMERA_DISTANCE * ISO,
        home.z + CAMERA_DISTANCE * ISO,
      ] as [number, number, number],
    }
  }, [framing, home, size.width, size.height])

  // Vector3, а не литерал массива: новый массив на каждом рендере R3F считает
  // изменившимся значением и сбрасывал бы панораму пользователя при каждом
  // изменении размера окна.
  const target = useMemo(
    () => new THREE.Vector3(home.x, 0, home.z),
    [home],
  )

  /*
   * Цель ключевого света — отдельный объект сцены, который каждый кадр
   * переставляется в точку, на которую смотрит камера. Объект, а не вектор:
   * three требует у DirectionalLight именно Object3D, и он обязан быть в сцене,
   * иначе его матрица не обновится.
   */
  const shadowTarget = useMemo(() => new THREE.Object3D(), [])

  /*
   * ЕДИНСТВЕННОЕ МЕСТО, ГДЕ ПИКСЕЛЬНЫЙ ПОЛ УЗНАЁТ РАЗМЕР КАДРА.
   *
   * Уникум общий на все ленты карты (дороги, свои линии, чужие), и обновлять
   * его из каждой значило бы делать одну и ту же работу трижды за кадр. Разбор
   * самого приёма — в render/pixelFloor.ts.
   */
  usePixelFloor()

  useFrame(() => {
    const focus = controls.current?.target
    if (focus === undefined) return
    if (
      shadowTarget.position.x === focus.x &&
      shadowTarget.position.z === focus.z
    ) {
      return
    }
    shadowTarget.position.set(focus.x, 0, focus.z)
    shadowTarget.updateMatrixWorld()
  })

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

  /*
   * ─── СВЕТ ВЕДЁТ ВРЕМЯ ────────────────────────────────────────────────────
   *
   * Всё, что ниже, служит одному: время в игре должно быть ВИДНО. Расчёт
   * лежит в render/sky.ts и от сцены не зависит вовсе; здесь только раздача
   * посчитанных чисел по объектам Three.
   *
   * ПОЧЕМУ ЭТО useFrame, А НЕ ПОДПИСКА НА СОСТОЯНИЕ. Scene намеренно не
   * подписан на игру (шапка файла): подписка на тик тянула бы за собой
   * перестройку всех слоёв карты по нескольку раз в секунду. Вдобавок свет
   * обязан ехать ПЛАВНО, а тик — это пятнадцать игровых минут разом; между
   * тиками цвет доводит та же доля `clock.alpha`, по которой едут машины.
   *
   * ПОЧЕМУ ЗНАЧЕНИЯ ПИШУТСЯ КАЖДЫЙ КАДР, А НЕ ТОЛЬКО ПРИ ИЗМЕНЕНИИ ТИКА.
   * Свойства в JSX ниже остаются на месте, и R3F возвращает их при любой
   * перерисовке компонента — например, при изменении размера окна. Пропусти
   * кадр «потому что время не изменилось» — и на паузе в полночь сцена
   * молча вернулась бы к полудню из палитры. Расчёт стоит десятков операций,
   * запись — двух десятков полей; экономить тут нечего.
   */
  const scene = useThree((state) => state.scene)

  /*
   * Камера нужна тут ради ОДНОГО поля — зума: по нему считается, сколько
   * километров влезло в кадр, а от этого зависит туман. Берётся действующая
   * камера сцены, а не ссылка на свой <OrthographicCamera>: makeDefault
   * означает, что рисует именно она, и спрашивать надо того, кто рисует.
   */
  const camera = useThree((state) => state.camera) as THREE.OrthographicCamera

  const keyRef = useRef<THREE.DirectionalLight>(null)
  const fillRef = useRef<THREE.DirectionalLight>(null)
  const ambientRef = useRef<THREE.AmbientLight>(null)
  const groundRef = useRef<THREE.MeshStandardMaterial>(null)

  /**
   * Грейд эпохи: 1994 выцветшее, 2030 насыщенное.
   *
   * Эффект создаётся руками и вставляется в цепочку через <primitive>, а не
   * обёрткой <HueSaturation/>. Причина не в красоте: обёртки из
   * @react-three/postprocessing собирают аргументы конструктора через
   * JSON.stringify своих пропсов, и ref на живой эффект попал бы в эту
   * сериализацию вместе со всем графом рендерера. Свой экземпляр даёт прямой
   * доступ к насыщенности из кадра и не зависит от внутренностей обёртки.
   */
  const grade = useMemo(
    () => new HueSaturationEffect({ saturation: atmosphere.saturation }),
    [],
  )

  useEffect(() => () => grade.dispose(), [grade])

  /*
   * ПРИОРИТЕТ −1 — ЭТО ПОРЯДОК ЧТЕНИЯ, А НЕ УСКОРЕНИЕ.
   *
   * Буфер `atmosphere` читают и другие слои карты — ночные окна городов
   * (CityMesh) и фары (VehicleMesh) — из своих useFrame. R3F вызывает
   * подписчиков по возрастанию приоритета, а при равном — в порядке подписки,
   * то есть СНАЧАЛА ДЕТЕЙ: layout-эффекты в React срабатывают снизу вверх.
   * С приоритетом по умолчанию слои света читали бы прошлый кадр — расхождение
   * невидимое, но ровно того сорта, что потом полдня ищут. Отрицательное
   * значение ставит хозяина буфера первым и не включает ручную отрисовку:
   * счётчик ручного режима в R3F поднимают только положительные приоритеты
   * (`priority > 0` в его subscribe), и рендером по-прежнему командует
   * EffectComposer.
   */
  useFrame(() => {
    const { state, prev } = useGameStore.getState()

    // Тик берётся ровно тот же, по которому интерполируются машины
    // (VehicleMesh.tsx): рассвет обязан идти вместе с миром, а не ступеньками
    // по пятнадцать игровых минут.
    const raw = clock.alpha
    const alpha = raw < 0 ? 0 : raw > 1 ? 1 : raw
    const played = prev.tick + (state.tick - prev.tick) * alpha

    const sky = atmosphereInto(
      atmosphere,
      timeOverride.tick ?? played,
      state.startYear,
    )

    // Фон канваса и туман — из ОДНОГО значения. Разъехаться они не могут по
    // построению (см. поле `air` в sky.ts), и это ровно та ошибка, о которой
    // предупреждает комментарий у <color attach="background"> ниже.
    const background = scene.background
    if (background instanceof THREE.Color) {
      background.setRGB(sky.air.r, sky.air.g, sky.air.b, THREE.SRGBColorSpace)
    }

    const fog = scene.fog
    if (fog !== null) {
      fog.color.setRGB(sky.air.r, sky.air.g, sky.air.b, THREE.SRGBColorSpace)
      if (fog instanceof THREE.Fog) {
        /*
         * ТУМАН ЕДЕТ ЗА ЗУМОМ, И ЭТО НЕ УКРАШЕНИЕ, А УСЛОВИЕ ЧИТАЕМОСТИ КАРТЫ.
         *
         * Числа fogRange (400…1400) подбирались под округ в 600 км, и в шапке
         * CAMERA_DISTANCE прямо записано: «отодвинь камеру на 1200 — и вся
         * карта окажется в молоке». Камеру не отодвигали — отодвинули КАРТУ:
         * страна вчетверо шире округа, и на общем плане дальний край кадра
         * уходил в туман на 61%, то есть половина России растворялась в дымке
         * ровно тогда, когда игрок хотел её увидеть. Замер прибором:
         * федеральная лента давала контраст 0.008 при уровне зерна 0.012 —
         * дорога была слабее шума.
         *
         * Правило простое: ТУМАН МЕРИТСЯ КАДРОМ, А НЕ КИЛОМЕТРАМИ. Ближняя и
         * дальняя границы отсчитываются от расстояния до цели камеры и
         * растягиваются вместе с тем, сколько километров влезло в экран.
         * Тогда перепад дымки от переднего края кадра к дальнему одинаков на
         * любом зуме — те самые 20%, ради которых туман и заводился, — и он
         * больше не зависит от того, насколько велика карта.
         *
         * Суточная и сезонная часть при этом целиком остаётся за sky.ts: здесь
         * масштабируется то, что оттуда пришло, а не подменяется.
         */
        const span = size.height / camera.zoom
        const scale = span / REFERENCE_SPAN_KM
        fog.near = CAMERA_DISTANCE - (CAMERA_DISTANCE - sky.fogNear) * scale
        fog.far = CAMERA_DISTANCE + (sky.fogFar - CAMERA_DISTANCE) * scale
      }
    }

    const key = keyRef.current
    if (key !== null) {
      key.color.setRGB(sky.key.r, sky.key.g, sky.key.b, THREE.SRGBColorSpace)
      key.intensity = sky.keyIntensity
      // Направление единичное, вынос прежний: карта теней строится вокруг
      // позиции источника, и менять её длину значило бы менять охват теней.
      key.position.set(
        sky.keyDirection.x * KEY_LIGHT_DISTANCE,
        sky.keyDirection.y * KEY_LIGHT_DISTANCE,
        sky.keyDirection.z * KEY_LIGHT_DISTANCE,
      )
    }

    const fill = fillRef.current
    if (fill !== null) {
      fill.color.setRGB(sky.fill.r, sky.fill.g, sky.fill.b, THREE.SRGBColorSpace)
      fill.intensity = sky.fillIntensity
      fill.position.set(
        sky.fillDirection.x * KEY_LIGHT_DISTANCE,
        sky.fillDirection.y * KEY_LIGHT_DISTANCE,
        sky.fillDirection.z * KEY_LIGHT_DISTANCE,
      )
    }

    const ambient = ambientRef.current
    if (ambient !== null) {
      ambient.color.setRGB(
        sky.ambient.r,
        sky.ambient.g,
        sky.ambient.b,
        THREE.SRGBColorSpace,
      )
      ambient.intensity = sky.ambientIntensity
    }

    const ground = groundRef.current
    if (ground !== null) {
      ground.color.setRGB(
        sky.ground.r,
        sky.ground.g,
        sky.ground.b,
        THREE.SRGBColorSpace,
      )
    }

    grade.saturation = sky.saturation
  }, SKY_PRIORITY)

  /**
   * Подмена игрового времени и снятие показаний со сцены — только в разработке.
   *
   * НУЖНО РОВНО ДЛЯ ОДНОГО, как и наводка камеры выше: доказать сквозным
   * тестом, что время ВИДНО. Проверить это иначе нечем. Юнит-тест доказывает
   * форму кривой, но не то, что кривая куда-то подключена, — а именно так
   * дважды и терялись целые слои (см. шапку файла). Скриншот же полудня и
   * полуночи требует дождаться нужного часа: партия начинается 1 января в
   * 00:00, и до июльского полудня симуляции пришлось бы отработать
   * семнадцать тысяч тиков.
   *
   * Подмена живёт ТОЛЬКО в рендере и в состояние не пишет ничего: игра при
   * ней идёт своим ходом, меняется лишь то, какое время рисует сцена.
   *
   * __plechoSky читает ЖИВЫЕ объекты Three, а не результат расчёта. Это
   * принципиально: тест обязан подтверждать, что числа доехали до света,
   * тумана и материала подложки, — повторный вызов чистой функции подтвердил
   * бы только сам себя.
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return

    const dev = globalThis as unknown as {
      __plechoSky?: unknown
      __plechoTime?: unknown
    }

    dev.__plechoTime = (tick: number | null): void => {
      timeOverride.tick = tick
    }

    dev.__plechoSky = () => {
      const background = scene.background
      const fog = scene.fog
      const key = keyRef.current
      const fill = fillRef.current
      const ambient = ambientRef.current
      const ground = groundRef.current

      return {
        background:
          background instanceof THREE.Color ? background.getHexString() : null,
        fog: fog === null ? null : fog.color.getHexString(),
        fogFar: fog instanceof THREE.Fog ? fog.far : null,

        key: key === null ? null : key.color.getHexString(),
        keyIntensity: key === null ? null : key.intensity,
        keyDirection:
          key === null
            ? null
            : {
                x: key.position.x / KEY_LIGHT_DISTANCE,
                y: key.position.y / KEY_LIGHT_DISTANCE,
                z: key.position.z / KEY_LIGHT_DISTANCE,
              },

        fill: fill === null ? null : fill.color.getHexString(),
        fillIntensity: fill === null ? null : fill.intensity,

        ambient: ambient === null ? null : ambient.color.getHexString(),
        ambientIntensity: ambient === null ? null : ambient.intensity,

        ground: ground === null ? null : ground.color.getHexString(),
        saturation: grade.saturation,

        sun: atmosphere.sun,
        daylight: atmosphere.daylight,
        twilight: atmosphere.twilight,
        winter: atmosphere.winter,
      }
    }

    return () => {
      timeOverride.tick = null
      delete dev.__plechoSky
      delete dev.__plechoTime
    }
  }, [grade, scene])

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

    // Полуразмах по большей оси: панорама ограничивается одинаково по обеим,
    // и брать надо ту сторону, по которой карта длиннее.
    const limit = Math.max(framing.width, framing.depth) / 2 + PAN_MARGIN

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

  /**
   * Наводка камеры из консоли и из e2e — только в разработке.
   *
   * НУЖНА РОВНО ДЛЯ ОДНОГО: доказать снимком экрана, что машины на карте
   * действительно РАЗЛИЧАЮТСЯ. На кадре по умолчанию вся карта округа влезает в
   * экран, и сцеп в девять километров занимает там около десятка пикселей — на
   * таком снимке не видно ни разницы классов, ни того, горит ли кабина, и
   * сквозной тест выродился бы в «что-то нарисовалось». Кадрировать же камеру
   * мышью из теста нельзя по той же причине, по которой из него не кликают по
   * сцене (разбор — в шапке ui/selection.ts): колесо и перетаскивание считаются
   * в экранных координатах, а они зависят от разрешения и от текущего зума.
   *
   * Зум задаётся КРАТНОСТЬЮ к вписанному кадру, а не абсолютным числом: сам
   * вписанный кадр зависит от размера окна, и абсолютное значение означало бы
   * разный охват на разных экранах. Пределы те же, что у колеса мыши, —
   * инструмент отладки не должен показывать то, чего игрок увидеть не может.
   *
   * В продакшен-сборке ветка не выполняется: import.meta.env.DEV — константа
   * этапа сборки.
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return

    const dev = globalThis as unknown as { __plechoLook?: unknown }

    dev.__plechoLook = (id: string, factor = 1): void => {
      const orbit = controls.current
      if (orbit === null) return

      const city = useGameStore.getState().state.world.cities[id as CityId]
      if (city === undefined) return

      const point = cityPoint(city)
      const camera = orbit.object as THREE.OrthographicCamera

      orbit.target.set(point.x, 0, point.z)
      camera.position.set(
        point.x + CAMERA_DISTANCE * ISO,
        CAMERA_DISTANCE * ISO,
        point.z + CAMERA_DISTANCE * ISO,
      )
      camera.zoom = THREE.MathUtils.clamp(
        view.zoom * factor,
        view.minZoom,
        view.maxZoom,
      )
      camera.updateProjectionMatrix()
      orbit.update()
    }

    return () => {
      delete dev.__plechoLook
    }
  }, [view])

  /**
   * ДЕВ-ХУК: СКОЛЬКО ПИКСЕЛЕЙ КАДРА ЗАНИМАЕТ ЛЕНТА ДОРОГИ.
   *
   * ЗАЧЕМ ОН ВООБЩЕ ЕСТЬ. Это единственный прибор проекта, который спрашивает
   * НАРИСОВАННЫЙ КАДР, а не состояние и не буферы. Разница принципиальная:
   * __plechoRoads показывает, что лежит в атрибутах, но ничего не знает о том,
   * попала ли лента хоть в один пиксель. А именно там проект уже дважды терял
   * картинку — зимой полотно совпало с землёй до последнего разряда, и на карте
   * страны лента оказалась тоньше пикселя. Оба раза все тесты были зелёными.
   *
   * КАК МЕРИТ. Ширина на полувысоте — то же, чем меряют линию в оптике:
   *
   *   1. Середина ребра переводится в пиксели кадрового буфера проекцией самой
   *      камеры. Это не то, что проверяется, — это то, ГДЕ смотреть.
   *   2. Строится экранное направление поперёк ленты: та же точка, отодвинутая
   *      на километр по нормали к ребру, проецируется второй раз. Считать угол
   *      руками нельзя — изометрия растягивает диагонали по-разному.
   *   3. Вдоль этого направления снимается профиль яркости, фон берётся
   *      медианой краёв профиля, и от ОСИ в обе стороны считается, докуда
   *      отклонение от фона держится выше половины осевого.
   *
   * Полувысота, а не «отличается от фона»: край ленты размывается сглаживанием
   * и постпроцессингом, порог по абсолютной разнице зависел бы от того, на
   * сколько именно дорога темнее земли, и в разные сезоны мерил бы разное.
   *
   * СЧЁТ ИДЁТ НЕПРЕРЫВНЫМ ХОДОМ ОТ ОСИ, А НЕ ПЕРЕБОРОМ ВСЕГО ПРОФИЛЯ, и это
   * второй заход: первый считал ВСЕ отсчёты, отклонившиеся от фона, и потому
   * складывал в одно число ленту и всё, что случайно попало в четырнадцать
   * пикселей вокруг неё — соседнюю дорогу, площадку города, чужой след. На
   * общем плане, где под Москвой сходится полсети, он давал на отдалённой
   * камере ЧЕТЫРЕ пикселя против ТРЁХ на приближённой, то есть показывал
   * ровно обратное правде. Ось ленты по построению лежит в нуле профиля;
   * непрерывный ход от неё мерит саму ленту и ничего кроме.
   *
   * ЧТО ЗНАЧИТ ВОЗВРАТ. `width` — ширина в пикселях буфера, `contrast` — пиковое
   * отклонение от фона в долях яркости. Ноль в контрасте означает «ленты в этом
   * месте на экране нет вовсе», и это отдельный, самый важный исход: он не
   * отличим от «дорога не нарисована» и не должен быть отличим.
   *
   * ЧИТАЕТ ХОЛСТ НАПРЯМУЮ, и это возможно только потому, что в разработке
   * включено сохранение кадрового буфера (App.tsx). В собранной игре ветка
   * вырезается целиком вместе с флагом.
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return

    const dev = globalThis as unknown as { __plechoRibbonWidth?: unknown }

    /**
     * Во сколько раз отойти от края городского пятна, прежде чем мерить.
     *
     * Два с половиной. Начиналось с полутора, и это оказалось мало: замер
     * упирался в САМУЮ КРОМКУ московского пятна, где лежат и тень площадки, и
     * крайние корпуса, и прибор давал контраст 0.0006 там, где на снимке
     * дорога видна отчётливо. padReach описывает диск застройки, а вокруг него
     * есть ещё промзона у въезда, площадки терминалов и собственная тень
     * города; запас должен покрывать их все.
     */
    const PAD_CLEARANCE = 2.5

    dev.__plechoRibbonWidth = (
      edgeId: string,
      /*
       * Сколько пикселей профиля снимать в каждую сторону от оси.
       *
       * Спрашивается снаружи, потому что зависит от зума: на приближённой
       * камере лента шире тридцати пикселей, и при коротком размахе за «фон»
       * взялось бы её же полотно — прибор показал бы ширину, близкую к нулю,
       * ровно там, где лента крупнее всего. Правило простое: размах должен
       * быть заметно больше ожидаемой ленты.
       */
      REACH = 14,
    ): {
      width: number
      contrast: number
      at: { x: number; y: number }
      profile: number[]
    } | null => {
      const camera = controls.current?.object as
        | THREE.OrthographicCamera
        | undefined
      if (camera === undefined) return null

      const world = useGameStore.getState().state.world
      const edge = world.edges[edgeId as keyof typeof world.edges]
      if (edge === undefined) return null

      const from = world.cities[edge.from]
      const to = world.cities[edge.to]
      if (from === undefined || to === undefined) return null

      const a = cityPoint(from)
      const b = cityPoint(to)

      const dx = b.x - a.x
      const dz = b.z - a.z
      const length = Math.hypot(dx, dz)
      if (length === 0) return null

      // Нормаль к ребру в плоскости карты — то же направление, вдоль которого
      // лента набирает ширину в RoadMesh.
      const nx = -dz / length
      const nz = dx / length

      const y = sceneLayers.roadFederal

      const canvas = gl.domElement
      const width = canvas.width
      const height = canvas.height

      /** Мировая точка → пиксель кадрового буфера. */
      const toPixel = (point: THREE.Vector3): { x: number; y: number } => {
        const ndc = point.clone().project(camera)
        return {
          x: (ndc.x * 0.5 + 0.5) * width,
          y: (1 - (ndc.y * 0.5 + 0.5)) * height,
        }
      }

      /*
       * МЕРИМ НЕ СЕРЕДИНУ РЕБРА, А ТУ ЕГО ТОЧКУ, ЧТО БЛИЖЕ К ЦЕНТРУ ЭКРАНА И
       * ПРИ ЭТОМ ЛЕЖИТ ВНЕ ЗАСТРОЙКИ ОБОИХ ГОРОДОВ. Оба условия выяснены
       * замером, оба стоили красного теста.
       *
       * Середина — очевидный выбор и негодный: на приближённой камере она
       * уезжает за край кадра (у М-2 это 91 км от Москвы, то есть под тысячу
       * пикселей на предельном зуме), и прибор возвращал «не знаю» ровно там,
       * где лента крупнее всего.
       *
       * Обрезка ДОЛЕЙ («не ближе пятнадцати процентов к городу») тоже негодна:
       * пятнадцать процентов от М-2 — это 27 км, а пятно Москвы простирается на
       * 28. Прибор честно наводился на дорогу и мерил городскую площадку,
       * выдавая на шестнадцатикратном зуме контраст 0.008 — то есть «дороги
       * нет» там, где она во весь экран. Отступ обязан считаться в километрах и
       * от РАЗМЕРА КОНКРЕТНОГО ГОРОДА, а он у Москвы и Тобольска отличается
       * впятеро.
       */
      const clearA = cityPadReach(from) * PAD_CLEARANCE
      const clearB = cityPadReach(to) * PAD_CLEARANCE
      // Ребро короче суммы двух пятен — мерить негде, дорога целиком под
      // застройкой. Это не поломка прибора, это свойство карты.
      if (clearA + clearB >= length) return null

      const pa = toPixel(new THREE.Vector3(a.x, y, a.z))
      const pb = toPixel(new THREE.Vector3(b.x, y, b.z))
      const screenSpan =
        (pb.x - pa.x) * (pb.x - pa.x) + (pb.y - pa.y) * (pb.y - pa.y)
      const raw =
        screenSpan === 0
          ? 0.5
          : ((width / 2 - pa.x) * (pb.x - pa.x) +
              (height / 2 - pa.y) * (pb.y - pa.y)) /
            screenSpan
      const share = Math.min(
        1 - clearB / length,
        Math.max(clearA / length, raw),
      )

      const at = new THREE.Vector3(a.x + dx * share, y, a.z + dz * share)
      const side = new THREE.Vector3(at.x + nx, y, at.z + nz)

      const center = toPixel(at)
      const off = toPixel(side)

      const stepX = off.x - center.x
      const stepY = off.y - center.y
      const stepLength = Math.hypot(stepX, stepY)
      // Километр поперёк ленты не даёт на экране и тысячной пикселя — камера
      // отодвинута немыслимо далеко или ребро вырождено. Мерить нечего.
      if (stepLength < 1e-6) return null

      const ux = stepX / stepLength
      const uy = stepY / stepLength

      // Середина ребра ушла за пределы кадра — прибор обязан сказать «не знаю»,
      // а не вернуть ноль, который читался бы как «дорога невидима».
      if (
        center.x < REACH ||
        center.y < REACH ||
        center.x > width - REACH ||
        center.y > height - REACH
      ) {
        return null
      }

      const scratch = document.createElement('canvas')
      scratch.width = 2 * REACH + 1
      scratch.height = 2 * REACH + 1
      const ctx = scratch.getContext('2d', { willReadFrequently: true })
      if (ctx === null) return null

      const originX = Math.round(center.x) - REACH
      const originY = Math.round(center.y) - REACH
      ctx.drawImage(
        canvas,
        originX,
        originY,
        scratch.width,
        scratch.height,
        0,
        0,
        scratch.width,
        scratch.height,
      )
      const image = ctx.getImageData(0, 0, scratch.width, scratch.height).data

      /** Яркость пикселя профиля на отсчёте t от оси, 0..1. */
      const luminance = (t: number): number => {
        const px = Math.round(center.x + ux * t) - originX
        const py = Math.round(center.y + uy * t) - originY
        const i = (py * scratch.width + px) * 4
        return (
          (0.2126 * image[i] + 0.7152 * image[i + 1] + 0.0722 * image[i + 2]) /
          255
        )
      }

      const profile: number[] = []
      for (let t = -REACH; t <= REACH; t++) profile.push(luminance(t))

      // Фон — медиана дальних четвертей профиля. Медиана, а не среднее: в
      // дальний край может попасть чужая лента или угол площадки города, и
      // среднее уехало бы за ней, а медиана нет.
      const quarter = Math.floor(profile.length / 4)
      const rim = [
        ...profile.slice(0, quarter),
        ...profile.slice(profile.length - quarter),
      ].sort((p, q) => p - q)
      const background = rim[Math.floor(rim.length / 2)]

      /** Отклонение отсчёта t от фона. */
      const deviation = (t: number): number =>
        Math.abs(profile[t + REACH] - background)

      // Пик берётся НА ОСИ, а не по всему профилю: мерится эта лента, а не
      // самое тёмное, что оказалось поблизости.
      const peak = deviation(0)

      // Плёночное зерно в этом проекте даёт около 3/255 ≈ 0.012. Всё, что ниже
      // удвоенного зерна, — шум, а не лента.
      // Профиль и точка замера возвращаются наружу нарочно. Прибор, который
      // отдаёт только вывод, невозможно проверить: когда он показал «ленты
      // нет», надо уметь отличить исчезнувшую ленту от промаха мимо неё, а для
      // этого нужны сырые отсчёты и пиксель, в котором они сняты.
      const at2 = { x: Math.round(center.x), y: Math.round(center.y) }

      if (peak < 0.024) {
        return { width: 0, contrast: peak, at: at2, profile }
      }

      const half = peak / 2
      let covered = 1
      for (let t = 1; t <= REACH && deviation(t) >= half; t++) covered += 1
      for (let t = -1; t >= -REACH && deviation(t) >= half; t--) covered += 1

      return { width: covered, contrast: peak, at: at2, profile }
    }

    return () => {
      delete dev.__plechoRibbonWidth
    }
  }, [gl])

  // Тени включаются на самом рендерере, а <Canvas> находится в чужом файле.
  // Операция идемпотентна: если shadows уже заданы на канвасе, это пустое
  // присваивание. Layout-эффект, а не обычный, чтобы флаг встал до первого
  // кадра — иначе материалы скомпилируются без поддержки теней.
  useLayoutEffect(() => {
    gl.shadowMap.enabled = true
    gl.shadowMap.type = THREE.PCFSoftShadowMap
    gl.shadowMap.needsUpdate = true

    /*
     * ДЕВ-ХУК НА РЕНДЕРЕР: сколько геометрий, текстур и вызовов отрисовки в
     * кадре. Только в разработке, как и остальные хуки (см. app/store.ts).
     *
     * Расход памяти и число вызовов — единственные величины сцены, которые
     * нельзя ни вывести из кода, ни проверить юнит-тестом: их видно только в
     * живом браузере под нагрузкой. Без хука любой разговор о том, «жрёт ли
     * игра память», остаётся спором о впечатлениях.
     */
    if (import.meta.env.DEV) {
      ;(globalThis as unknown as { __plechoRenderer?: unknown }).__plechoRenderer =
        gl
    }
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

      {/* Значения в свойствах — ПОЛДЕНЬ И ЗАПАСНОЙ ВАРИАНТ, а не то, что видит
          игрок: цвет, силу и направление всех трёх источников каждый кадр
          задаёт время суток (useFrame выше). Оставлены они затем, чтобы свет
          был осмысленным на самом первом кадре и в тесте, где кадров нет. */}
      <ambientLight
        ref={ambientRef}
        color={lighting.ambientColor}
        intensity={lighting.ambientIntensity}
      />

      {/*
        ЦЕЛЬ КЛЮЧЕВОГО СВЕТА ЕДЕТ ЗА КАМЕРОЙ, и это не украшение.

        Камера теней у направленного света ортографическая и строится вокруг
        ЦЕЛИ источника. Пока цель стояла в мировом нуле, коробка теней накрывала
        квадрат 840×840 км вокруг Москвы — на карте округа это была вся карта, на
        карте страны это её восьмая часть: двадцать четыре города из пятидесяти
        трёх не отбрасывали тень НИКОГДА, ни в один час суток. Игрок,
        перелетевший на Урал, попадал в мир без теней и без объёма.

        Полуразмер коробки при этом НЕ увеличен: один тексель карты теней и так
        покрывает около четырёхсот метров, и растянуть её на страну значило бы
        превратить тени в шум. Правильный ответ — возить коробку с собой.
      */}
      <directionalLight
        ref={keyRef}
        color={lighting.keyColor}
        intensity={lighting.keyIntensity}
        position={keyLight}
        target={shadowTarget}
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

      <primitive object={shadowTarget} />

      {/* Заливка теней не отбрасывает: вторая карта теней стоила бы столько же,
          сколько ключевая, а дала бы только конфликтующие полутени. */}
      <directionalLight
        ref={fillRef}
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
        {/* Цвет ведёт сезон: подложка — самая большая поверхность кадра, и
            белеющая зима читается прежде всего по ней (seasonGround в
            palette.ts). palette.terrain здесь — начальное значение. */}
        <meshStandardMaterial
          ref={groundRef}
          color={palette.terrain}
          roughness={1}
          metalness={0}
        />
      </mesh>

      {/*
        Порядок монтирования слоёв повторяет порядок высот в render/layers.ts:
        подложка, дороги, линии, города с предприятиями, машины и поверх всего
        невидимые цели для мыши.

        Линии стоят сразу за дорогами и перед городами намеренно. Кольцо игрока
        — это разметка ПОВЕРХ дорожной сети, и оно обязано читаться как её
        подсветка, а не как самостоятельная трасса; при этом застройка и
        предприятия должны оставаться видны сквозь него, иначе выделенная линия
        закрывает ровно то, ради чего игрок её и разглядывает.
      */}
      <Roads />
      <Lines />
      <Cities />
      <Industries />

      {/*
        Инфраструктура среза 5. Стоит между промышленностью и машинами намеренно
        и по двум разным причинам.

        ПОСТРОЙКИ ИГРОКА — после промышленности, потому что это тот же слой мира,
        застройка у дороги, и порядок здесь ни на что не влияет, кроме порядка
        чтения файла: сначала то, что мир поставил сам, потом то, что построил
        игрок.

        РАМПЫ И ОЧЕРЕДЬ — перед машинами, и вот это уже существенно. Хвост из
        ждущих машин у рампы отвечает на вопрос «почему сеть стоит», а
        светящаяся кабина на дороге — на вопрос «что едет»; второе обязано
        рисоваться поверх первого, потому что едущая машина — главный объект
        карты, и никакая диагностика не должна её закрывать.
      */}
      <Buildings />
      <ServicePosts />

      <Vehicles />
      <Weather />
      <CityPicker />

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
        {/*
          Тональная компрессия обязана быть здесь явно.

          @react-three/postprocessing на время своего монтирования принудительно
          ставит рендереру NoToneMapping: он рассчитывает, что компрессией
          займётся сам композер. Не добавить эффект в цепочку — значит остаться
          вообще без неё, и вся сцена выходит плоской и тёмной, будто света не
          хватает. Света хватает; не хватало кривой.

          Место в цепочке — строго после Bloom и до Vignette: свечение считается
          по линейной яркости сцены, а виньетка и зерно ложатся уже на
          приведённое к экрану изображение.

          Кривая — ACES, а не AgX. AgX бережнее к пересветам, но заметно гасит
          середину, а вся сцена здесь и есть середина: тёмный рельеф под
          рассеянным светом. На ней AgX съедал остатки контраста и карта
          выглядела выцветшей.
        */}
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />

        {/*
          Грейд эпохи: девяностые выцветшие, двадцатые насыщенные.

          ПОЧЕМУ ЭПОХА — ЭФФЕКТ, А НЕ ПЕРЕКРАСКА ПАЛИТРЫ. Цвета лежат в одном
          файле и читаются восемью компонентами; пересчитывать каждый из них по
          году значило бы завести второй источник цвета — ту самую ошибку, от
          которой palette.ts и защищает. Сдвиг насыщенности всего кадра делает
          то же самое одним проходом и одинаково двигает и застройку, и акцент.

          Место в цепочке — после тональной компрессии и до виньетки. Насыщенность
          осмысленна только на приведённом к экрану изображении: до компрессии
          яркость линейная и не ограничена сверху, а виньетка и зерно — уже
          свойства объектива, они ложатся на готовый кадр последними.
        */}
        <primitive object={grade} />

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
