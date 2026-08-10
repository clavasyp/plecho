/**
 * Связка: кто, когда и о чём спрашивает модель.
 *
 * ЗДЕСЬ СХОДЯТСЯ ДВА ВРЕМЕНИ. Игровое — тик за тиком, синхронно и
 * детерминированно. Реальное — сеть, которая отвечает когда захочет и иногда не
 * отвечает вовсе. Раннер живёт на границе и устроен так, чтобы второе никогда не
 * задерживало первое: poll() синхронный, запросы выпускаются и забываются, а
 * пришедший ответ кладётся не в тик, а В СОСТОЯНИЕ — в очередь команд компании
 * (deliverPlan в app/store.ts). Разберёт её фаза команд на ближайшем тике,
 * проверит теми же правилами, что и ход игрока, и незаконное отбросит.
 *
 * ОДИН ХОЗЯИН У КОМПАНИИ. Фаза решений в тике (runAi в sim/tick.ts) ведёт только
 * компании со скриптом и намеренно не трогает помеченные моделью. Значит раннер,
 * забравший конкурента себе, обязан сказать об этом состоянию (setController) и
 * дальше отвечать за него ЦЕЛИКОМ — включая те дни, когда модель не спрашивается.
 * Иначе конкурент под моделью получал бы решение раз в игровой месяц, а его сосед
 * под скриптом — каждые сутки, и «характеры играют по-разному» превратилось бы в
 * «под моделью играть невыгодно».
 *
 * ОТСЮДА ДВА РАЗНЫХ РИТМА, И ЭТО ГЛАВНОЕ УСТРОЙСТВО ФАЙЛА:
 *
 *   РЕШЕНИЕ — РАЗ В ИГРОВЫЕ СУТКИ, ровно как у скриптового конкурента. Всё, на
 *   что смотрит перевозчик, измеряется сутками: суточное окно потоков компании,
 *   суточная зарплата, суточный спрос города, тридцать суток отсрочки до
 *   банкротства. Решать реже — значит опаздывать: контора успевает разориться
 *   между двумя мыслями.
 *
 *   ВОПРОС МОДЕЛИ — РАЗ В ИГРОВОЙ МЕСЯЦ (docs/АРХИТЕКТУРА.md §7). Стратегия — это
 *   то, что не меняют ежедневно: какое кольцо строить, куда лезть, чем возить.
 *   Месяц на скорости ×1 — это десять реальных минут, то есть примерно шесть
 *   запросов в час на конкурента; трое конкурентов дают восемнадцать. Спрашивай
 *   модель каждые игровые сутки — вышло бы полтысячи запросов в час, деньги на
 *   ветер и лента рассуждений, в которой не виден ни один мотив.
 *
 * В прочие сутки решение берётся у скрипта и честно помечается fromModel: false.
 * Это не подмена, а разделение труда: модель ставит замысел, скрипт доводит его
 * до ума — сажает водителей, выводит машины на кольцо, отправляет на ТО. Игрок
 * видит в ленте, чей это был ход, и не гадает.
 *
 * ЗАПАСНОЙ ПУТЬ ТОТ ЖЕ САМЫЙ. Нет ключа, нет сети, лимит, мусор вместо JSON —
 * askGemini возвращает null, и раннер берёт scriptedCommands/scriptedThought с
 * той же честной отметкой. Без ключа раннер вообще не забирает конкурентов: они
 * остаются за скриптом, и тик ведёт их сам. Игра без ключа обязана быть полной,
 * а не «игрой без конкурентов».
 */

import { useEffect } from 'react'
import { scriptedCommands, scriptedThought } from '../../sim/ai/scripted'
import { DAYS_PER_GROWTH_MONTH } from '../../sim/economy/consumption'
import { TICKS_PER_DAY } from '../../sim/types'
import type { CompanyId, CompetitorPersonality, GameState } from '../../sim/types'
import { useGameStore } from '../store'
import type { GameStore } from '../store'
import { askGemini, hasGeminiKey } from './gemini'
import { snapshotFor } from './prompt'
import type { ModelPlan, Snapshot } from './prompt'

/**
 * Через сколько тиков конкурента снова спрашивают модель.
 *
 * Месяц берётся у симуляции (DAYS_PER_GROWTH_MONTH в economy/consumption.ts), а
 * не пишется тридцаткой: расчётный игровой месяц в проекте уже определён, и
 * второй месяц, заведённый здесь, разошёлся бы с первым молча.
 */
export const ASK_INTERVAL_TICKS = TICKS_PER_DAY * DAYS_PER_GROWTH_MONTH

/** Чем раннер спрашивает модель. Подменяется в тестах — сети там нет. */
export type AskModel = (
  snapshot: Snapshot,
  personality: CompetitorPersonality | null,
) => Promise<ModelPlan | null>

/**
 * Что раннеру нужно от стора. Ровно три вещи и ни одной больше.
 *
 * Узкий интерфейс вместо всего GameStore — не педантизм: он показывает, что
 * раннер НЕ МЕНЯЕТ состояние сам. Всё, что он умеет, — попросить стор принять
 * план и пометить, кто ведёт компанию. Дай ему полный стор, и однажды кто-нибудь
 * подвинет отсюда машину напрямую, мимо очереди команд и мимо проверок.
 */
export type RivalStore = {
  getState: () => Pick<GameStore, 'state' | 'deliverPlan' | 'setController'>
  subscribe: (listener: () => void) => () => void
}

export type RivalRunnerOptions = {
  /** Чем спрашивать. По умолчанию — Gemini. */
  ask?: AskModel
  /** Где состояние. По умолчанию — общий стор игры. */
  store?: RivalStore
  /**
   * Работает ли раннер вообще. По умолчанию — есть ли ключ.
   *
   * Выключенный раннер не просто молчит: он ВОЗВРАЩАЕТ конкурентов скрипту (см.
   * release). Компания, помеченная моделью, которую никто не ведёт, замерла бы
   * навсегда — тик её намеренно не трогает.
   */
  enabled?: boolean
}

export type RivalRunner = {
  /**
   * Один проход. Синхронный и дешёвый: зовётся на каждое обновление стора,
   * то есть по нескольку раз в секунду.
   */
  poll: () => void
  /** Идёт ли сейчас запрос. Для интерфейса и для тестов. */
  isBusy: () => boolean
  /** Дождаться, пока канал освободится. Нужно тестам, игре — нет. */
  whenIdle: () => Promise<void>
  /** Больше не работать. Компании остаются за моделью до следующего раннера. */
  stop: () => void
}

/**
 * Игровой день, в который попадает тик.
 *
 * Считается ДНЁМ, а не сравнением с «последним тиком суток», как это делает
 * isDecisionTick в тике. Причина — асинхронность: раннер видит состояние не
 * каждый тик, а когда стор обновился, и за один кадр может пройти до десяти
 * тиков (MAX_TICKS_PER_FRAME в loop.ts). Условие «ровно последний тик суток»
 * такой пропуск не переживает: конкурент молчал бы сутками на ускоренном
 * времени, причём тем чаще, чем слабее машина игрока.
 */
function dayOf(tick: number): number {
  return Math.floor(tick / TICKS_PER_DAY)
}

/**
 * Раннер как объект, а не как модульная функция.
 *
 * Всё его состояние — кого он забрал, кто когда решал и занят ли канал —
 * приватное и живёт внутри. Модульные переменные означали бы, что второй раннер
 * (перемонтирование в StrictMode, тест рядом с игрой) молча наследует чужую
 * память.
 */
export function createRivalRunner(
  options: RivalRunnerOptions = {},
): RivalRunner {
  const ask = options.ask ?? askGemini
  const store: RivalStore = options.store ?? useGameStore
  const enabled = options.enabled ?? hasGeminiKey()

  /** Компании, за которые раннер отвечает. */
  const taken = new Set<CompanyId>()
  /** Последний игровой день, в который компания принимала решение. */
  const lastDay = new Map<CompanyId, number>()
  /** Тик последнего ВОПРОСА МОДЕЛИ. Отсутствие означает «ещё ни разу». */
  const lastAsk = new Map<CompanyId, number>()

  /**
   * Запрос в полёте. Ровно один на весь раннер.
   *
   * ВТОРОЙ ЗАПРОС НЕ ВЫПУСКАЕТСЯ, ПОКА НЕ ВЕРНУЛСЯ ПЕРВЫЙ, и это требование не
   * про экономию. Три конкурента впервые доходят до своего месяца в один и тот же
   * день; выпусти их разом — и три запроса уйдут одной пачкой, чтобы получить
   * 429 все три сразу. Канал по одному растаскивает пачку сам собой: сегодня
   * спрашивает первый, завтра второй, послезавтра третий, и дальше их месяцы
   * разъезжаются навсегда.
   */
  let inFlight: Promise<void> | null = null
  let stopped = false
  /** Защита от рекурсии: правка стора будит подписчиков, а те зовут poll. */
  let polling = false

  /** Положить готовое решение в состояние. Единственная дверь наружу. */
  const deliver = (
    api: Pick<GameStore, 'deliverPlan'>,
    companyId: CompanyId,
    plan: ModelPlan,
    fromModel: boolean,
  ): void => {
    api.deliverPlan(companyId, {
      commands: plan.commands,
      thought: plan.thought,
      fromModel,
    })
  }

  /** Решение скрипта по ЖИВОМУ состоянию. Оно же — запасной путь. */
  const scripted = (state: GameState, companyId: CompanyId): ModelPlan => ({
    commands: scriptedCommands(state, companyId),
    thought: scriptedThought(state, companyId),
  })

  /**
   * Спросить модель и уложить ответ.
   *
   * Снимок собирается СЕЙЧАС, а применится ответ через несколько тиков — столько,
   * сколько шёл запрос. Это неустранимо и потому честно: конкурент решает по
   * миру, который видел, ровно как человек, отвернувшийся к бумагам. Скриптовый
   * запасной вариант при этом считается по СВЕЖЕМУ состоянию — раз уж модель
   * промолчала, отвечать по устаревшему снимку незачем.
   */
  const askAndDeliver = async (
    companyId: CompanyId,
    snapshot: Snapshot,
    personality: CompetitorPersonality | null,
  ): Promise<void> => {
    let plan: ModelPlan | null = null
    try {
      plan = await ask(snapshot, personality)
    } catch {
      // askGemini обещает не бросать, но обещание чужой функции — не гарантия.
      // Упавший раннер остановил бы конкурентов навсегда, и починить это можно
      // было бы только перезапуском игры.
      plan = null
    }

    if (stopped) return

    const api = store.getState()
    // Компания могла разориться, пока шёл запрос. deliverPlan это переживёт
    // (банкроту план не кладётся), но и звать его незачем.
    const company = api.state.companies[companyId]
    if (company === undefined || company.bankrupt) return

    if (plan === null) {
      deliver(api, companyId, scripted(api.state, companyId), false)
      return
    }
    deliver(api, companyId, plan, true)
  }

  /** Вернуть компании скрипту: раннер выключен, а без хозяина они замрут. */
  const release = (
    api: Pick<GameStore, 'state' | 'setController'>,
  ): void => {
    for (const id of Object.keys(api.state.companies) as CompanyId[]) {
      if (id === api.state.playerId) continue
      if (api.state.companies[id].controller !== 'модель') continue
      api.setController(id, 'скрипт')
    }
    taken.clear()
  }

  /**
   * Забрать конкурентов себе.
   *
   * Берутся ВСЕ, кроме игрока и банкротов: разные характеры под одной моделью —
   * это и есть проверка того, что характер меняет стратегию, а не силу. Компания,
   * уже помеченная моделью (сейв, перемонтирование в StrictMode), тоже
   * подбирается — иначе после перезапуска раннера она осталась бы без хозяина.
   *
   * День решения ставится ТЕКУЩИЙ, а не нулевой. Иначе только что забранный
   * конкурент сходил бы немедленно — то есть на сутки раньше своих соседей под
   * скриптом, которые решают в конце игровых суток. Фора в один ход маленькая, но
   * она ровно та, которой в этом срезе быть не должно.
   */
  const adopt = (
    api: Pick<GameStore, 'state' | 'setController'>,
    day: number,
  ): void => {
    for (const id of Object.keys(api.state.companies) as CompanyId[]) {
      if (id === api.state.playerId) continue

      const company = api.state.companies[id]
      if (company.bankrupt) {
        taken.delete(id)
        continue
      }
      if (taken.has(id)) continue

      if (company.controller === 'скрипт') api.setController(id, 'модель')
      else if (company.controller !== 'модель') continue

      taken.add(id)
      lastDay.set(id, day)
    }
  }

  const poll = (): void => {
    if (stopped || polling) return
    polling = true

    try {
      const api = store.getState()

      if (!enabled) {
        release(api)
        return
      }

      const day = dayOf(api.state.tick)
      adopt(api, day)

      /*
       * Состояние перечитывается: adopt только что подменил контроллеров, и
       * работать дальше по снимку, снятому до этого, значило бы принимать решения
       * за компании в их прошлом виде.
       *
       * ДАЛЬШЕ ОНО НЕ ПЕРЕЧИТЫВАЕТСЯ НИ РАЗУ, и это то же правило, по которому
       * устроена фаза решений в тике (runAi в sim/tick.ts): все конкуренты
       * смотрят на ОДИН снимок мира. Иначе решение второго зависело бы от
       * решения первого, то есть от порядка ключей объекта, и «кто кого
       * опередил» держалось бы ни на чём.
       */
      const fresh = store.getState()

      for (const id of taken) {
        const company = fresh.state.companies[id]
        if (company === undefined || company.bankrupt) {
          taken.delete(id)
          continue
        }
        // Компанию вернули скрипту снаружи (панель, тест) — раннер не спорит.
        if (company.controller !== 'модель') {
          taken.delete(id)
          continue
        }
        /*
         * ПРОШЛОЕ РЕШЕНИЕ ЕЩЁ НЕ РАЗОБРАНО — новое не принимается. То же правило,
         * по которому молчит скриптовый конкурент (decide в sim/ai/scripted.ts):
         * очередь применяется раз в тик, а раннер зовут по нескольку раз в
         * секунду, и без этой проверки одно «купить машину» легло бы в очередь
         * пачкой.
         */
        if ((company.pendingCommands ?? []).length > 0) continue

        const previous = lastDay.get(id)
        if (previous !== undefined && day <= previous) continue

        lastDay.set(id, day)

        const askedAt = lastAsk.get(id)
        const askDue =
          askedAt === undefined || fresh.state.tick - askedAt >= ASK_INTERVAL_TICKS

        /*
         * КАНАЛ ЗАНЯТ — ХОДИМ СКРИПТОМ, А ВОПРОС ОТКЛАДЫВАЕМ. Соблазн подождать
         * свободного канала («это же всего секунда») оборачивается тем, что при
         * висящем на таймауте запросе двое конкурентов не делают ничего
         * пятнадцать реальных секунд — то есть почти игровые сутки. Отложенный
         * вопрос не теряется: lastAsk не сдвигается, и завтра компания снова
         * окажется первой в очереди.
         */
        if (!askDue || inFlight !== null) {
          deliver(fresh, id, scripted(fresh.state, id), false)
          continue
        }

        lastAsk.set(id, fresh.state.tick)

        const snapshot = snapshotFor(fresh.state, id)
        const personality = company.personality

        // ЗАПРОС ВЫПУСКАЕТСЯ И ЗАБЫВАЕТСЯ: игровой цикл не ждёт сеть ни кадра.
        const request = askAndDeliver(id, snapshot, personality).finally(() => {
          if (inFlight === request) inFlight = null
        })
        inFlight = request
      }
    } finally {
      polling = false
    }
  }

  return {
    poll,
    isBusy: () => inFlight !== null,
    whenIdle: async () => {
      while (inFlight !== null) await inFlight
    },
    stop: () => {
      stopped = true
    },
  }
}

/**
 * Завести раннер на всё время жизни приложения.
 *
 * Подписка на стор, а не таймер: решения привязаны к ИГРОВОМУ времени, а оно
 * идёт только когда идут тики. На паузе стор молчит, раннер не просыпается, и
 * конкуренты честно стоят вместе с миром — таймер по реальным часам продолжал бы
 * думать за них, пока игрок разглядывает карту.
 *
 * Первый poll — сразу, не дожидаясь первого тика: именно он забирает конкурентов
 * себе, а до этого их ведёт скрипт (и правильно делает).
 */
export function useRivalRunner(): void {
  useEffect(() => {
    const runner = createRivalRunner()
    runner.poll()

    const unsubscribe = useGameStore.subscribe(() => runner.poll())

    return () => {
      unsubscribe()
      runner.stop()
    }
  }, [])
}
