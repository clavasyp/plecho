/**
 * Раннер — БЕЗ СЕТИ И БЕЗ КЛЮЧА.
 *
 * Модель подменяется функцией, а стор берётся НАСТОЯЩИЙ. Это осознанно: раннер
 * ровно тем и занят, что кладёт решения в состояние через стор, и подделка стора
 * проверяла бы подделку. Заодно так видно всю цепочку целиком — план ложится в
 * очередь команд, а следующий тик применяет его теми же правилами, что и ход
 * игрока.
 *
 * ЧАСЫ ПЕРЕВОДЯТСЯ РУКАМИ, а не прогоняются тиками. Раннер смотрит на игровой
 * ДЕНЬ, и гонять по девяносто шесть тиков ради каждой проверки значило бы
 * измерять скорость симуляции вместо поведения раннера. Один настоящий тик перед
 * переводом часов всё же проходит — он разбирает очередь команд, как в игре.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInitialState } from '../../sim/state'
import { TICKS_PER_DAY, companyId } from '../../sim/types'
import type { CompanyId } from '../../sim/types'
import { useGameStore } from '../store'
import type { ModelPlan } from './prompt'
import { ASK_INTERVAL_TICKS, createRivalRunner } from './runner'

const SEED = 20260808
const RIVAL: CompanyId = companyId('magistral')
const PLAYER: CompanyId = companyId('player')

const HIRE: ModelPlan = {
  commands: [{ kind: 'нанять-водителя' }],
  thought: 'Беру человека под цистерну.',
}

/** Компании, которых ведёт раннер: все, кроме игрока. */
function rivals(): CompanyId[] {
  const state = useGameStore.getState().state
  return (Object.keys(state.companies) as CompanyId[]).filter(
    (id) => id !== state.playerId,
  )
}

function companyOf(id: CompanyId) {
  return useGameStore.getState().state.companies[id]
}

/**
 * Прожить один настоящий тик и перевести часы вперёд.
 *
 * Тик нужен ради очереди: раннер не принимает нового решения, пока прежнее не
 * разобрано, — то же правило, по которому молчит скриптовый конкурент.
 */
function jump(ticks: number): void {
  useGameStore.getState().advance(1)
  const state = useGameStore.getState().state
  useGameStore.setState({ state: { ...state, tick: state.tick + ticks }, prev: state })
}

const jumpDay = () => jump(TICKS_PER_DAY)

beforeEach(() => {
  const fresh = createInitialState(SEED)
  // Партия с нуля перед каждой проверкой: стор — синглтон, и мир из прошлого
  // теста иначе доезжал бы в следующий.
  useGameStore.setState({ state: fresh, prev: fresh, speed: 0 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('кто ведёт компанию', () => {
  it('без ключа раннер не забирает никого', () => {
    const ask = vi.fn(async () => HIRE)
    const runner = createRivalRunner({ enabled: false, ask })

    runner.poll()
    jumpDay()
    runner.poll()

    // Компании остаются за скриптом, и тик ведёт их сам: игра без ключа обязана
    // быть полной, а не «игрой без конкурентов».
    for (const id of rivals()) expect(companyOf(id).controller).toBe('скрипт')
    expect(ask).not.toHaveBeenCalled()
  })

  it('выключенный раннер возвращает скрипту чужих подопечных', () => {
    useGameStore.getState().setController(RIVAL, 'модель')
    expect(companyOf(RIVAL).controller).toBe('модель')

    createRivalRunner({ enabled: false, ask: vi.fn(async () => null) }).poll()

    // Компания, помеченная моделью, которую никто не ведёт, замерла бы навсегда:
    // фаза решений в тике намеренно её не трогает.
    expect(companyOf(RIVAL).controller).toBe('скрипт')
  })

  it('с ключом забирает всех конкурентов и никогда игрока', () => {
    createRivalRunner({ enabled: true, ask: vi.fn(async () => null) }).poll()

    for (const id of rivals()) expect(companyOf(id).controller).toBe('модель')
    // Игрок — это тот, кто решает сам. Подставить ему команду отсюда значило бы
    // сыграть за него.
    expect(companyOf(PLAYER).controller).toBe('человек')
  })

  it('забранный конкурент не ходит в тот же миг', () => {
    const runner = createRivalRunner({ enabled: true, ask: vi.fn(async () => null) })
    runner.poll()

    // Фора в один ход — ровно та, которой в этом срезе быть не должно: соседи
    // под скриптом решают в конце игровых суток.
    for (const id of rivals()) expect(companyOf(id).thinking).toHaveLength(0)
  })
})

describe('запасной путь', () => {
  it('модель промолчала — ход берётся у скрипта и помечается честно', async () => {
    const ask = vi.fn(async () => null)
    const runner = createRivalRunner({ enabled: true, ask })

    runner.poll()
    jumpDay()
    runner.poll()
    await runner.whenIdle()

    expect(ask).toHaveBeenCalled()

    for (const id of rivals()) {
      const feed = companyOf(id).thinking
      expect(feed.length).toBeGreaterThan(0)

      const last = feed[feed.length - 1]
      // ЧЕСТНАЯ ОТМЕТКА — половина ценности всей затеи: тихая подмена модели
      // скриптом обесценила бы ленту рассуждений целиком.
      expect(last.fromModel).toBe(false)
      expect(last.text.length).toBeGreaterThan(0)
    }
  })

  it('упавшая модель не роняет раннер', async () => {
    const ask = vi.fn(async () => {
      throw new Error('adapter exploded')
    })
    const runner = createRivalRunner({ enabled: true, ask })

    runner.poll()
    jumpDay()
    expect(() => runner.poll()).not.toThrow()
    await runner.whenIdle()

    // Упавший раннер остановил бы конкурентов до перезапуска игры.
    const feed = companyOf(RIVAL).thinking
    expect(feed[feed.length - 1].fromModel).toBe(false)
  })
})

describe('ответ модели', () => {
  it('доезжает до состояния и применяется правилами игрока', async () => {
    const ask = vi.fn(async () => HIRE)
    const runner = createRivalRunner({ enabled: true, ask })

    runner.poll()
    jumpDay()
    runner.poll()
    await runner.whenIdle()

    const before = companyOf(RIVAL)
    // Команда лежит В СОСТОЯНИИ, а не применена на месте: разбирает её фаза
    // команд на ближайшем тике.
    expect(before.pendingCommands).toEqual(HIRE.commands)

    const last = before.thinking[before.thinking.length - 1]
    expect(last.fromModel).toBe(true)
    expect(last.text).toBe(HIRE.thought)

    const staff = Object.keys(before.drivers).length
    useGameStore.getState().advance(1)

    const after = companyOf(RIVAL)
    expect(Object.keys(after.drivers).length).toBe(staff + 1)
    // Очередь чистится тиком целиком — команда это разовое предложение.
    expect(after.pendingCommands).toEqual([])
  })

  it('мусор из модели отбрасывается, а ход не теряется', async () => {
    const ask = vi.fn(async () => ({
      commands: [
        { kind: 'построить', cityId: 'atlantis', type: 'терминал' },
      ] as ModelPlan['commands'],
      thought: 'Строю в Атлантиде.',
    }))
    const runner = createRivalRunner({ enabled: true, ask })

    runner.poll()
    jumpDay()
    runner.poll()
    await runner.whenIdle()

    useGameStore.getState().advance(1)

    const company = companyOf(RIVAL)
    // Незаконная команда отброшена симуляцией — построек не прибавилось, денег
    // не убавилось, очередь пуста.
    expect(Object.keys(company.buildings)).toHaveLength(0)
    expect(company.pendingCommands).toEqual([])
  })
})

describe('частота', () => {
  it('второй запрос не выпускается, пока не вернулся первый', async () => {
    let release: (plan: ModelPlan | null) => void = () => {}
    const ask = vi.fn(
      (): Promise<ModelPlan | null> =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const runner = createRivalRunner({ enabled: true, ask })

    runner.poll()
    jumpDay()
    runner.poll()

    // Трое конкурентов доходят до своего месяца в один и тот же день. Выпусти их
    // разом — три запроса уйдут пачкой, чтобы получить отказ по лимиту все три.
    expect(ask).toHaveBeenCalledTimes(1)
    expect(runner.isBusy()).toBe(true)

    release(null)
    await runner.whenIdle()
    expect(runner.isBusy()).toBe(false)

    // Назавтра спрашивает следующий: канал растаскивает пачку сам собой.
    jumpDay()
    runner.poll()
    expect(ask).toHaveBeenCalledTimes(2)

    release(null)
    await runner.whenIdle()
  })

  it('модель спрашивается раз в игровой месяц, а решения принимаются ежедневно', async () => {
    const ask = vi.fn(async () => null)
    const runner = createRivalRunner({ enabled: true, ask })

    runner.poll()

    // Четверо суток подряд: за это время каждый из трёх конкурентов успевает
    // спросить модель по разу, и больше ни один не спрашивает.
    for (let day = 0; day < 4; day++) {
      jumpDay()
      runner.poll()
      await runner.whenIdle()
    }

    expect(ask).toHaveBeenCalledTimes(rivals().length)

    // Решения при этом принимаются КАЖДЫЕ СУТКИ — иначе конкурент под моделью
    // ходил бы в тридцать раз реже соседа под скриптом.
    expect(companyOf(RIVAL).thinking.length).toBeGreaterThan(1)

    // Прошёл месяц — модель спрашивают снова.
    jump(ASK_INTERVAL_TICKS)
    runner.poll()
    await runner.whenIdle()

    expect(ask).toHaveBeenCalledTimes(rivals().length + 1)
  })

  it('игроку решения не подставляются никогда', async () => {
    const runner = createRivalRunner({ enabled: true, ask: vi.fn(async () => HIRE) })

    runner.poll()
    for (let day = 0; day < 3; day++) {
      jumpDay()
      runner.poll()
      await runner.whenIdle()
    }

    expect(companyOf(PLAYER).thinking).toHaveLength(0)
    expect(companyOf(PLAYER).pendingCommands).toEqual([])
  })
})
