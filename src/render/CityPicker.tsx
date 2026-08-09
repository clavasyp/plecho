import { useMemo, useState } from 'react'
import type { JSX } from 'react'
import { useGameStore } from '../app/store'
import { useSelection } from '../ui/selection'
import { cityPoint } from './CityMesh'
import { layers } from './layers'
import { palette } from './palette'

/**
 * Кликабельные цели по городам.
 *
 * Отдельный слой невидимых сфер, а не обработчик на самой застройке. Причина
 * простая: застройка рисуется одним InstancedMesh на все города сразу, и по
 * попаданию пришлось бы вычислять, какому городу принадлежит инстанс, — а сфера
 * ещё и попадает по промежутку между зданиями, тогда как в силуэт нужно ещё
 * прицелиться.
 *
 * КЛИК ВЫБИРАЕТ ГОРОД, А НЕ ОТПРАВЛЯЕТ МАШИНУ. Раньше было наоборот, и это
 * оказалось прямой ошибкой: указание на объект и команда транспорту — разные
 * действия, а разделял их один и тот же жест. Промахнулся мимо города —
 * потерял рейс; захотел просто посмотреть, что там с заводом, — тоже потерял
 * рейс. Теперь клик открывает панель города (ui/CityPanel.tsx), а отправка
 * стала кнопкой внутри неё: необратимое действие требует отдельного нажатия,
 * и это правило переживёт срез 2.
 *
 * Слой при этом остался тем же, чем и был, — он про «указать на город», а не
 * про «поехать». В срезе 4 отсюда вырастет добавление остановки в линию.
 */

/** Радиус цели, км. Заметно больше застройки: целиться нужно в город, не в дом. */
const PICK_RADIUS = 16

export function CityPicker(): JSX.Element {
  const cities = useGameStore((s) => s.state.world.cities)
  const select = useSelection((s) => s.select)
  const selected = useSelection((s) => s.city)
  const [hovered, setHovered] = useState<string | null>(null)

  const points = useMemo(
    () =>
      Object.values(cities).map((city) => ({
        id: city.id,
        name: city.name,
        ...cityPoint(city),
      })),
    [cities],
  )

  return (
    <group>
      {points.map((point) => (
        <mesh
          key={point.id}
          position={[point.x, layers.vehicle, point.z]}
          onClick={(event) => {
            // Иначе один клик пройдёт насквозь и попадёт ещё и в город за ним.
            event.stopPropagation()
            // Повторный клик по выбранному городу снимает выбор — переключение
            // живёт в самом store, см. ui/selection.ts.
            select(point.id)
          }}
          onPointerOver={(event) => {
            event.stopPropagation()
            setHovered(point.id)
            document.body.style.cursor = 'pointer'
          }}
          onPointerOut={() => {
            setHovered(null)
            document.body.style.cursor = 'auto'
          }}
        >
          <sphereGeometry args={[PICK_RADIUS, 12, 8]} />
          {/*
            Невидимая, но кликабельная: depthWrite отключён, чтобы сфера не
            прятала за собой застройку и подписи. Под курсором проступает
            акцентом — единственная подсветка на карте, и она же подсказывает,
            что по городу вообще можно кликать.

            Выбранный город светится и без курсора, чуть слабее наведения.
            Панель показывает название, но не место: без отметки на карте игрок
            читает данные про «Тулу», не видя, где она, — а вся ценность
            диагностики в том, чтобы соотнести цифры с расстояниями.
          */}
          <meshBasicMaterial
            transparent
            depthWrite={false}
            color={palette.accent}
            opacity={
              hovered === point.id ? 0.18 : selected === point.id ? 0.12 : 0
            }
          />
        </mesh>
      ))}
    </group>
  )
}
