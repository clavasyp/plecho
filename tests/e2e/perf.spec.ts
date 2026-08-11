import { expect, test } from '@playwright/test'

/**
 * ЗАМЕР РАСХОДА ПАМЯТИ И КАДРА — временный, для разбора жалобы «жрёт кучу
 * оперативки». Не утверждение о том, как должно быть: пороги здесь заведомо
 * щедрые, задача файла — напечатать ЧИСЛА, по которым можно решать.
 */
test('сколько игра ест памяти и как держит кадр', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(
    () => (globalThis as unknown as { __plecho?: unknown }).__plecho !== undefined,
    undefined,
    { timeout: 30_000 },
  )

  const snapshot = async (label: string) => {
    const heap = await page.evaluate(() => {
      const perf = performance as unknown as {
        memory?: { usedJSHeapSize: number; totalJSHeapSize: number }
      }
      return {
        used: perf.memory?.usedJSHeapSize ?? 0,
        total: perf.memory?.totalJSHeapSize ?? 0,
      }
    })

    const three = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __plechoRenderer?: {
          info: {
            memory: { geometries: number; textures: number }
            render: { calls: number; triangles: number }
          }
        }
      }
      const info = w.__plechoRenderer?.info
      return info === undefined
        ? null
        : {
            geometries: info.memory.geometries,
            textures: info.memory.textures,
            calls: info.render.calls,
            triangles: info.render.triangles,
          }
    })

    // eslint-disable-next-line no-console
    console.log(
      `${label}: куча ${(heap.used / 1024 / 1024).toFixed(1)} МБ из ` +
        `${(heap.total / 1024 / 1024).toFixed(1)} МБ` +
        (three === null
          ? ' (рендерер не выставлен наружу)'
          : `; геометрий ${three.geometries}, текстур ${three.textures}, ` +
            `вызовов отрисовки ${three.calls}, треугольников ${three.triangles}`),
    )

    return heap
  }

  const first = await snapshot('сразу после загрузки')

  // Пятикратная скорость на минуту реального времени — обычный игровой режим.
  await page.evaluate(() => {
    ;(
      globalThis as unknown as {
        __plecho: { getState(): { setSpeed(speed: number): void } }
      }
    ).__plecho.getState().setSpeed(5)
  })

  const frames: number[] = []
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(10_000)
    const heap = await snapshot(`через ${(i + 1) * 10} с на ×5`)
    frames.push(heap.used)
  }

  const grown = (frames[frames.length - 1] - first.used) / 1024 / 1024
  // eslint-disable-next-line no-console
  console.log(`прирост кучи за минуту игры: ${grown.toFixed(1)} МБ`)

  // Порог заведомо щедрый: ловим утечку, а не колебания сборщика мусора.
  expect(grown, 'куча не должна расти без остановки').toBeLessThan(300)
})
