/**
 * Адаптер к Gemini — БЕЗ ЕДИНОГО НАСТОЯЩЕГО ЗАПРОСА.
 *
 * Тест, ходящий в сеть, — это не тест: он зависит от чужого сервиса, от денег на
 * счету и от того, есть ли у запускающего ключ. Здесь подменяется fetch, и
 * проверяется ровно то, за что отвечает файл: что без ключа он молчит, что ключ
 * уходит заголовком, что любая беда превращается в null, и что после отказа
 * поставщика он не долбится дальше.
 *
 * КЛЮЧ В ТЕСТЕ ПОДДЕЛЬНЫЙ И ЗАДАЁТСЯ ЯВНО. Полагаться на то, что у запускающего
 * нет .env, нельзя: у автора он как раз есть, и «проверка без ключа» молча
 * превратилась бы в проверку с ключом.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInitialState } from '../../sim/state'
import { companyId } from '../../sim/types'
import {
  GEMINI_ENDPOINT,
  MIN_REQUEST_GAP_MS,
  REQUEST_TIMEOUT_MS,
  askGemini,
  hasGeminiKey,
  resetGeminiThrottle,
} from './gemini'
import { snapshotFor } from './prompt'

const KEY = 'поддельный-ключ'
const ENV = 'VITE_GEMINI_API_KEY'

const SNAPSHOT = snapshotFor(createInitialState(1), companyId('magistral'))

/** Ответ Gemini в его настоящей форме: текст лежит в частях кандидата. */
function reply(text: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
  } as unknown as Response
}

function refusal(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
  } as unknown as Response
}

const PLAN = '{"thought":"Беру человека.","commands":[{"kind":"нанять-водителя"}]}'

beforeEach(() => {
  // Пауза между запросами живёт в модуле и переживает отдельный тест: без
  // сброса первый же тест испортил бы следующий за собой.
  resetGeminiThrottle()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('ключ', () => {
  it('без ключа — сразу null и ни одного запроса', async () => {
    vi.stubEnv(ENV, '')
    const fetchSpy = vi.fn(async () => reply(PLAN))
    vi.stubGlobal('fetch', fetchSpy)

    expect(hasGeminiKey()).toBe(false)
    await expect(askGemini(SNAPSHOT, 'осторожный')).resolves.toBeNull()
    // Запрос без ключа вернул бы 400 и красную строку в консоли на каждый
    // игровой месяц у каждого, кто просто запустил игру из репозитория.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('пробелы вместо ключа — это отсутствие ключа', async () => {
    vi.stubEnv(ENV, '   ')
    const fetchSpy = vi.fn(async () => reply(PLAN))
    vi.stubGlobal('fetch', fetchSpy)

    expect(hasGeminiKey()).toBe(false)
    await expect(askGemini(SNAPSHOT, null)).resolves.toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('ключ уходит заголовком, а не в адресе', async () => {
    vi.stubEnv(ENV, KEY)
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => reply(PLAN))
    vi.stubGlobal('fetch', fetchSpy)

    await askGemini(SNAPSHOT, 'нишевый')

    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe(GEMINI_ENDPOINT)
    // Адреса попадают в логи прокси, в историю и в отчёты об ошибках — ключ из
    // них потом не вынуть.
    expect(url).not.toContain(KEY)
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY)
  })
})

describe('ответ', () => {
  it('разбирается в план', async () => {
    vi.stubEnv(ENV, KEY)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply(PLAN)),
    )

    const plan = await askGemini(SNAPSHOT, 'агрессивный')
    expect(plan?.commands).toEqual([{ kind: 'нанять-водителя' }])
    expect(plan?.thought).toBe('Беру человека.')
  })

  it('мусор вместо JSON — null, а не исключение', async () => {
    vi.stubEnv(ENV, KEY)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply('извините, я языковая модель')),
    )

    await expect(askGemini(SNAPSHOT, null)).resolves.toBeNull()
  })

  it('пустой ответ без кандидатов — null', async () => {
    vi.stubEnv(ENV, KEY)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response,
      ),
    )

    await expect(askGemini(SNAPSHOT, null)).resolves.toBeNull()
  })

  it('обрыв связи — null, а не исключение', async () => {
    vi.stubEnv(ENV, KEY)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )

    await expect(askGemini(SNAPSHOT, null)).resolves.toBeNull()
  })
})

describe('частота и лимиты', () => {
  it('второй запрос подряд не уходит — промежуток не выдержан', async () => {
    vi.stubEnv(ENV, KEY)
    const fetchSpy = vi.fn(async () => reply(PLAN))
    vi.stubGlobal('fetch', fetchSpy)

    await askGemini(SNAPSHOT, null)
    await askGemini(SNAPSHOT, null)

    // Цикл, который на каждом кадре решает, что пора спросить, — главный способ
    // сжечь квоту за минуту.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(MIN_REQUEST_GAP_MS).toBeGreaterThan(0)

    resetGeminiThrottle()
    await askGemini(SNAPSHOT, null)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('после отказа по лимиту не долбится дальше', async () => {
    vi.stubEnv(ENV, KEY)
    const fetchSpy = vi.fn(async () => refusal(429))
    vi.stubGlobal('fetch', fetchSpy)

    await expect(askGemini(SNAPSHOT, null)).resolves.toBeNull()
    await expect(askGemini(SNAPSHOT, null)).resolves.toBeNull()

    // Долбиться в закрытую квоту — это либо квота в ноль, либо бан по адресу.
    // Партия в это время идёт на скриптовых конкурентах и ничего не теряет.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('молчащий сервер обрывается по таймауту', async () => {
    vi.stubEnv(ENV, KEY)
    vi.useFakeTimers()

    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new Error('aborted')),
            )
          }),
      ),
    )

    const pending = askGemini(SNAPSHOT, null)
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS)

    // Пока запрос висит, конкурент не получает решения ни от модели, ни от
    // скрипта: канал обязан освобождаться сам.
    await expect(pending).resolves.toBeNull()
  })
})
