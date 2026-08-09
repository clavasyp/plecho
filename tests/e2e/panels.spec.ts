import { expect, test } from '@playwright/test'

/**
 * Панель города: главный диагностический инструмент игры.
 *
 * Проверяется не вёрстка, а то, что панель вообще появляется по выбору города
 * и показывает состояние его предприятий. Компонент уже один раз оказался
 * написан и не смонтирован — тест закрывает именно это.
 */
test('выбор города открывает панель с состоянием предприятий', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(2500)

  // Рязань: там и НПЗ, и ЦБК — на ней видно сразу оба состояния.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __plechoSelect?: (id: string) => void
    }
    w.__plechoSelect?.('ryazan')
  })
  await page.waitForTimeout(600)

  const text = (await page.locator('.ui-layer').textContent()) ?? ''
  expect(text, 'панель показывает выбранный город').toContain('Рязань')

  await page.screenshot({ path: 'tests/e2e/screenshots/city-panel.png' })
})
