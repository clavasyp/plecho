import { useMemo, useState } from 'react'
import type { JSX } from 'react'
import { useGameStore } from '../app/store'
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
 * Сейчас клик отправляет единственную машину игрока в выбранный город. Это
 * временное поведение среза 1: в срезе 4 отсюда вырастет назначение на линию,
 * а сам слой останется — он про «указать на город», а не про «поехать».
 */

/** Радиус цели, км. Заметно больше застройки: целиться нужно в город, не в дом. */
const PICK_RADIUS = 16

export function CityPicker(): JSX.Element {
  const cities = useGameStore((s) => s.state.world.cities)
  const dispatchTo = useGameStore((s) => s.dispatchTo)
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
            dispatchTo(point.id)
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
          */}
          <meshBasicMaterial
            transparent
            depthWrite={false}
            color={palette.accent}
            opacity={hovered === point.id ? 0.18 : 0}
          />
        </mesh>
      ))}
    </group>
  )
}
