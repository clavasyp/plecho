/**
 * Корень приложения — только композиция.
 *
 * Здесь нет и не должно быть игровой логики: App заводит игровой цикл, ставит
 * холст со сценой и кладёт поверх слой интерфейса. Всё остальное решают
 * симуляция (src/sim), сцена (src/render) и панели (src/ui).
 */

import { Canvas } from '@react-three/fiber'
import { useGameLoop } from './app/loop'
import { Scene } from './render/Scene'
import { TimeControls } from './ui/TimeControls'
import './App.css'

export default function App() {
  // Единственное место, где заводится цикл: он живёт ровно столько же, сколько
  // приложение, и не должен перезапускаться от перерисовок.
  useGameLoop()

  return (
    <>
      <div className="scene">
        {/*
          На холсте — только то, что относится к контексту рендера целиком.
          Камеру, свет, туман и постпроцессинг настраивает Scene: там им место,
          и там их видно все сразу.

          dpr ограничен двойкой: на ретине честный devicePixelRatio означает
          вчетверо больше пикселей ради разницы, которую на тёмной сцене
          с блумом не разглядеть, — а тиков за кадр нужно успевать до десяти.
        */}
        <Canvas shadows dpr={[1, 2]}>
          <Scene />
        </Canvas>
      </div>

      <div className="ui-layer">
        <TimeControls />
      </div>
    </>
  )
}
