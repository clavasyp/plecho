import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Симуляция обязана работать в чистом Node — тестируем её именно так,
    // без jsdom. Если для интерфейса понадобится DOM, заведём отдельный проект.
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // e2e живёт в Playwright, у него свой раннер
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
  },
})
