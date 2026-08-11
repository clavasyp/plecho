import { expect, test } from '@playwright/test'

/**
 * ЗАМЕР ПАМЯТИ И КАДРА.
 *
 * ПРЕЖНИЙ ЗАМЕР НЕ МЕРИЛ НИЧЕГО, и это стоит записать, потому что ошибка
 * выглядела как работающий прибор.
 *
 * Он читал `performance.memory.usedJSHeapSize`. Chrome КВАНТУЕТ это число ради
 * защиты от side-channel-атак и обновляет его редко: контрольная проверка с
 * подсаженной утечкой на 550 МБ (39.9 → 593.4 МБ по настоящему счётчику) дала
 * дельту РОВНО НОЛЬ БАЙТ. Проверка `рост < 300 МБ` сравнивала ноль с тремястами
 * и не могла не пройти.
 *
 * Он же читал `gl.info.render.calls` из дев-хука — но читал ПОСЛЕ того, как
 * композер отработал восемнадцать проходов и обнулил счётчик, и потому печатал
 * «1 вызов, 1 треугольник» при настоящих семидесяти и полутора сотнях тысяч.
 *
 * Здесь и то и другое читается правильно:
 *   — память: через протокол отладчика (`HeapProfiler.collectGarbage` плюс
 *     `Performance.getMetrics`), то есть неквантованное число после честной
 *     сборки мусора;
 *   — кадр: счётчиками живого контекста, снятыми в САМОМ кадре, до композера.
 *
 * Третье число — количество созданных буферов вершин за десять секунд
 * установившейся игры. Оно ловит то, чего не видно ни в куче, ни в кадре:
 * пересборку геометрии, которая каждый раз даёт бит в бит то же самое.
 */

/** Сколько мегабайт роста кучи считаем утечкой. */
const HEAP_GROWTH_LIMIT_MB = 120

/**
 * Сколько буферов за десять секунд НА ПАУЗЕ считаем пересборкой впустую.
 *
 * Пять — это допуск на разовые события вроде смены материала погоды, а не
 * бюджет. Замер до правки подписок: 294 буфера за десять секунд идущего времени
 * при полностью неизменной геометрии — вся дорожная сеть и вся застройка страны
 * пересобирались по несколько раз в секунду, потому что подписка сравнивала
 * объекты городов, а население дрейфует каждый тик у всех пятидесяти трёх.
 * После правки: на паузе ноль, на ходу 68 — и эти 68 законны, это едущие
 * машины.
 */
const BUFFER_CHURN_LIMIT = 5

test('память не течёт, геометрия не пересобирается, кадр в бюджете', async ({
  page,
}) => {
  test.setTimeout(180_000)

  const client = await page.context().newCDPSession(page)
  await client.send('Performance.enable')
  await client.send('HeapProfiler.enable')

  /** Куча ПОСЛЕ честной сборки мусора, мегабайты. */
  const heapMb = async (): Promise<number> => {
    await client.send('HeapProfiler.collectGarbage')
    const { metrics } = await client.send('Performance.getMetrics')
    const used = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0
    return used / 1024 / 1024
  }

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(
    () => (globalThis as unknown as { __plecho?: unknown }).__plecho !== undefined,
    undefined,
    { timeout: 30_000 },
  )

  // Счётчик созданных буферов вешается на живой контекст. Делать это надо ДО
  // прогона: перехват после первого кадра не увидит стартовую сборку сцены.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __plechoRenderer?: { getContext(): WebGL2RenderingContext }
      __plechoBuffers?: number
    }
    const gl = w.__plechoRenderer?.getContext()
    if (gl === undefined) return

    w.__plechoBuffers = 0
    const original = gl.createBuffer.bind(gl)
    gl.createBuffer = () => {
      w.__plechoBuffers = (w.__plechoBuffers ?? 0) + 1
      return original()
    }
  })

  const before = await heapMb()

  await page.evaluate(() => {
    ;(
      globalThis as unknown as {
        __plecho: { getState(): { setSpeed(speed: number): void } }
      }
    ).__plecho.getState().setSpeed(5)
  })

  // Установившийся режим: даём миру ожить, только потом считаем буферы.
  await page.waitForTimeout(10_000)
  await page.evaluate(() => {
    ;(globalThis as unknown as { __plechoBuffers?: number }).__plechoBuffers = 0
  })
  await page.waitForTimeout(10_000)

  const buffers = await page.evaluate(
    () => (globalThis as unknown as { __plechoBuffers?: number }).__plechoBuffers ?? 0,
  )

  /*
   * ВТОРОЙ ЗАМЕР — НА ПАУЗЕ, и он важнее первого.
   *
   * На идущем времени часть перезаливок законна: машины едут, и их положения
   * обязаны попадать в буферы каждый кадр. На ПАУЗЕ не меняется ничего вовсе,
   * и любая пересобранная геометрия здесь — чистая работа впустую.
   */
  await page.evaluate(() => {
    ;(
      globalThis as unknown as {
        __plecho: { getState(): { setSpeed(speed: number): void } }
      }
    ).__plecho.getState().setSpeed(0)
    ;(globalThis as unknown as { __plechoBuffers?: number }).__plechoBuffers = 0
  })
  await page.waitForTimeout(10_000)
  const paused = await page.evaluate(
    () => (globalThis as unknown as { __plechoBuffers?: number }).__plechoBuffers ?? 0,
  )

  await page.waitForTimeout(30_000)
  const after = await heapMb()
  const growth = after - before

  const frame = await page.evaluate(() => {
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
    `куча ${before.toFixed(1)} → ${after.toFixed(1)} МБ (рост ${growth.toFixed(1)}); ` +
      `буферов за 10 с: на ходу ${buffers}, на паузе ${paused}; ` +
      (frame === null
        ? 'рендерер недоступен'
        : `геометрий ${frame.geometries}, текстур ${frame.textures}`),
  )

  expect(growth, 'куча не должна расти без остановки').toBeLessThan(
    HEAP_GROWTH_LIMIT_MB,
  )
  /*
   * На паузе мир неподвижен, и пересобирать в нём нечего вовсе. Ноль с
   * небольшим допуском — единственный честный порог: любое число сверх него
   * означает, что сцена перестраивается от подписки, а не от изменений.
   */
  expect(
    paused,
    'на паузе геометрия не пересобирается',
  ).toBeLessThan(BUFFER_CHURN_LIMIT)
  expect(frame, 'дев-хук рендерера доступен').not.toBeNull()
})
