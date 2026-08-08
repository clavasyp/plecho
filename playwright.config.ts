import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright здесь — не столько тесты интерфейса, сколько **цикл самопроверки**.
 *
 * Агент, который пишет код, должен уметь запустить игру, посмотреть на неё,
 * прочитать консоль и починить себя без участия человека. Скриншоты
 * складываются в tests/e2e/screenshots и служат именно этому.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  reporter: [['list']],
  timeout: 30_000,

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // WebGL в headless-хроме требует программного растеризатора
        launchOptions: {
          args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'],
        },
      },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
