import { expect, test } from '@playwright/test'

/**
 * Дымовой тест — база цикла самопроверки.
 *
 * Проверяет ровно три вещи: страница поднялась, WebGL-контекст создан, консоль
 * чистая. Этого достаточно, чтобы поймать подавляющее большинство поломок
 * сцены, и это дёшево гонять после каждого изменения рендера.
 */

test('страница загружается без ошибок в консоли', async ({ page }) => {
  const errors: string[] = []

  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(err.message))

  await page.goto('/')
  await page.waitForLoadState('networkidle')

  expect(errors).toEqual([])
})

test('WebGL-контекст доступен', async ({ page }) => {
  await page.goto('/')

  const hasWebGL = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    const gl =
      canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    return gl !== null
  })

  expect(hasWebGL).toBe(true)
})

test('снимок экрана сохраняется', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await page.screenshot({
    path: 'tests/e2e/screenshots/current.png',
    fullPage: false,
  })
})
