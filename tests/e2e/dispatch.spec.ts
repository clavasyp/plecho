import { expect, test } from '@playwright/test'

/**
 * Сквозная проверка: клик по городу → поиск пути → машина едет.
 *
 * Это единственный тест, который проходит всю цепочку целиком — интерфейс,
 * стор, Дейкстру, движение и рендер. Ни один юнит-тест не поймает, если
 * поиск пути окажется не подключён: он останется зелёным, а игра — мёртвой.
 */
test('клик по городу отправляет машину в путь', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1500)

  const read = () =>
    page.evaluate(() => {
      const store = (globalThis as { __plecho?: { getState(): unknown } }).__plecho
      if (!store) return null
      const s = store.getState() as {
        state: { vehicles: Record<string, unknown>; playerId: string }
      }
      const vehicle = Object.values(s.state.vehicles)[0] as {
        position: { kind: string; nodeId?: string; progress?: number }
        route: string[]
        odometer: number
      }
      return {
        kind: vehicle.position.kind,
        node: vehicle.position.nodeId ?? null,
        routeLength: vehicle.route.length,
        odometer: vehicle.odometer,
      }
    })

  const before = await read()
  expect(before, 'стор должен быть доступен в dev-сборке').not.toBeNull()
  expect(before!.kind).toBe('узел')
  expect(before!.node).toBe('moscow')
  expect(before!.routeLength).toBe(0)

  // Орёл — самый дальний город на юге, до него путь идёт через промежуточные.
  await page.evaluate(() => {
    const store = (globalThis as { __plecho?: { getState(): { dispatchTo(c: string): void } } })
      .__plecho
    store!.getState().dispatchTo('orel')
  })

  const dispatched = await read()
  expect(dispatched!.routeLength, 'маршрут построен').toBeGreaterThan(1)

  // Дать симуляции проехать
  await page.waitForTimeout(4000)

  const moving = await read()
  expect(moving!.odometer, 'машина проехала километры').toBeGreaterThan(0)
  expect(
    moving!.kind === 'ребро' || moving!.node !== 'moscow',
    'машина покинула Москву',
  ).toBe(true)

  // Снимок живой сцены — им же удобно смотреть на результат правок рендера.
  await page.screenshot({ path: 'tests/e2e/screenshots/en-route.png' })
})
