/**
 * Звук: негромкий гул мира и короткие отклики на события игрока.
 *
 * ЗВУК СИНТЕЗИРУЕТСЯ КОДОМ, а не берётся файлами, и это тот же принцип, что и
 * «вся геометрия генерируется кодом» из §15 концепта. Ни одного wav в сборке:
 * дорожный гул — отфильтрованный коричневый шум с низким дроном, отклики —
 * несколько синтезированных тонов с огибающей. Сборка от этого не тяжелеет ни
 * на килобайт, а сам гул не зацикливается на слух, потому что фильтр над ним
 * едет вместе с игровым временем.
 *
 * ПО УМОЛЧАНИЮ ВЫКЛЮЧЕНО, И ЭТО НЕ ОСТОРОЖНОСТЬ, А ГЛАВНОЕ РЕШЕНИЕ ФАЙЛА.
 * Игра открывается во вкладке браузера рядом с другими вкладками; звук,
 * начавшийся без спроса, — худшее первое впечатление, какое можно устроить, и
 * первое, что игрок сделает, — закроет вкладку, а не станет искать регулятор.
 * Поэтому включает его кнопка в панели времени и только она.
 *
 * ОТСЮДА ЖЕ И ТЕХНИЧЕСКОЕ ТРЕБОВАНИЕ: AudioContext заводится ВНУТРИ обработчика
 * нажатия. Браузер не даёт звуку начаться без жеста пользователя, и контекст,
 * созданный при загрузке страницы, родился бы в состоянии suspended — то есть
 * позже пришлось бы его будить и ловить, почему первый гудок пропал. Контекст,
 * рождённый в клике, сразу running.
 *
 * НИ ОДНОГО ЗВУКА В ЦИКЛЕ КАДРА. Модуль вообще не знает про useFrame: он
 * подписан на стор и просыпается только тогда, когда состояние сменилось (тик
 * длиннее кадра — см. app/loop.ts). Даже проснувшись, он не создаёт ни одного
 * объекта на разбор состояния: события возвращаются битовой маской, а не
 * массивом, — эта функция зовётся до шестидесяти раз в секунду на скорости ×5.
 * Сверху стоит остывание на каждый вид отклика: двадцать машин, вставших под
 * погрузку в один тик, дают один «тук», а не двадцать.
 *
 * МОДУЛЬ ОБЯЗАН РАБОТАТЬ ТАМ, ГДЕ ЗВУКА НЕТ. Сквозные тесты идут в headless-
 * браузере, юнит-тесты — в Node, где AudioContext не существует вовсе. Ни одна
 * функция здесь не имеет права упасть от его отсутствия: расчёт остаётся
 * расчётом, а синтез просто не происходит.
 *
 * ВЫБОР НЕ ЗАПОМИНАЕТСЯ между запусками намеренно. Сохранённое «включено»
 * означало бы попытку зазвучать при следующей загрузке страницы — то есть ровно
 * то, что запрещено абзацем выше, только теперь ещё и неожиданно для игрока.
 */

import { useEffect, useSyncExternalStore } from 'react'

import { dayProgress } from '../sim/time'
import type { Building, GameState, Vehicle } from '../sim/types'
import { useGameStore } from './store'

// ─── Чистая часть: что звучит и когда ──────────────────────────────────────
//
// Всё до первого упоминания AudioContext — обычный расчёт без единой ссылки на
// браузер. Он и покрыт юнит-тестами: проверять синтез нечем, а вот громкость
// от времени суток, выбор отклика и разбор события из состояния проверяются.

/**
 * События, на которые у игры есть голос.
 *
 * Список короткий сознательно. Озвучить можно каждую строчку экономики, но
 * звук в тайкуне работает как подсветка редкого: если пищит всё, не слышно
 * ничего. Здесь по одному звуку на каждый разряд происходящего — начало работы
 * («погрузка»), трата денег («покупка», «постройка») и беда («поломка»).
 */
export type SoundEvent = 'поломка' | 'постройка' | 'покупка' | 'погрузка'

/**
 * Разряд события в маске.
 *
 * Маска, а не массив событий: разбор состояния зовётся на каждое изменение
 * стора, то есть до шестидесяти раз в секунду, и возвращать оттуда свежий
 * массив значило бы плодить мусор ровно того сорта, который шапки рендера
 * запрещают. Заодно маска сама схлопывает повторы: три машины, вставшие под
 * погрузку в один тик, зажигают один и тот же бит.
 */
export const EVENT_BIT = {
  поломка: 1,
  постройка: 2,
  покупка: 4,
  погрузка: 8,
} as const satisfies Record<SoundEvent, number>

/**
 * Порядок проигрывания — он же порядок важности.
 *
 * Когда в одном тике сошлись поломка и погрузка, первой обязана прозвучать
 * поломка: отклики короткие и накладываются друг на друга, а внимание игрок
 * отдаёт тому, что началось раньше.
 */
export const EVENT_ORDER = [
  'поломка',
  'постройка',
  'покупка',
  'погрузка',
] as const satisfies readonly SoundEvent[]

/**
 * Что изменилось между двумя состояниями — маской событий.
 *
 * Чистая функция: два снимка на входе, число на выходе. Она же единственный
 * способ узнать о событии, потому что симуляция ни о каком звуке не знает и
 * знать не должна — граница src/sim проходит там, где сказано в шапке проекта.
 * Событие тут выводится из РАЗНИЦЫ СНИМКОВ, а не из уведомления, и это даёт
 * приятный побочный эффект: озвучиваются одинаково и ход игрока, и то же самое,
 * сделанное симуляцией или дев-хуком.
 *
 * СОБЫТИЯ ТОЛЬКО СВОИ. Поломка у конкурента — не новость для ушей игрока: его
 * машины он не видит на своих экранах и не может на них повлиять, а звук без
 * причины на экране читается как баг.
 *
 * Ни одного нового объекта внутри: записи парка и построек обходятся по ключам,
 * без Object.values, — та самая аллокация в цикле, за которую в этом проекте
 * уже был разбор.
 */
export function detectEvents(prev: GameState, next: GameState): number {
  // Стор будит подписчиков и на смене скорости, где состояние то же самое.
  if (prev === next) return 0

  const playerId = next.playerId
  let found = 0

  /*
   * Записи приводятся к строковому ключу ровно здесь и по одной причине:
   * идентификаторы в проекте — «фирменные» строки (VehicleId = string & brand),
   * и обойти Record<VehicleId, …> через for..in иначе нельзя без Object.keys,
   * то есть без лишнего массива на каждый вызов. Приведение действует только
   * внутри функции: наружу типы не протекают.
   */
  if (prev.vehicles !== next.vehicles) {
    const after = next.vehicles as Readonly<Record<string, Vehicle>>
    const before = prev.vehicles as Readonly<Record<string, Vehicle>>

    for (const id in after) {
      const now = after[id]
      if (now.ownerId !== playerId) continue

      const was: Vehicle | undefined = before[id]
      // Ссылка та же — машина не менялась вовсе. Самый частый случай.
      if (was === now) continue

      if (was === undefined) {
        // Новая машина в парке игрока бывает ровно одна: купленная.
        found |= EVENT_BIT.покупка
        continue
      }

      if (now.brokenDown && !was.brokenDown) found |= EVENT_BIT.поломка
      // Ноль постов занято → машина встала под погрузку или выгрузку. Момент
      // начала работы, а не конца: игрок ждёт отклика на то, что происходит.
      if (now.serviceTicksLeft > 0 && was.serviceTicksLeft === 0) {
        found |= EVENT_BIT.погрузка
      }
      // Прицеп — вторая половина покупки машины и отдельная трата денег.
      if (now.trailer !== null && was.trailer === null) {
        found |= EVENT_BIT.покупка
      }
    }
  }

  const wasCompany = prev.companies[playerId]
  const nowCompany = next.companies[playerId]
  if (
    wasCompany !== undefined &&
    nowCompany !== undefined &&
    wasCompany.buildings !== nowCompany.buildings
  ) {
    const after = nowCompany.buildings as Readonly<Record<string, Building>>
    const before = wasCompany.buildings as Readonly<Record<string, Building>>
    for (const id in after) {
      const was: Building | undefined = before[id]
      if (was === undefined) {
        found |= EVENT_BIT.постройка
        break
      }
    }
  }

  return found
}

/** Форма волны. Свой союз, а не OscillatorType, чтобы расчёт не знал про DOM. */
export type Wave = 'sine' | 'triangle' | 'square' | 'sawtooth'

/** Описание отклика: не звук, а рецепт звука. Синтез отдельно, ниже. */
export type Cue = {
  readonly wave: Wave
  /** Тоны по порядку, Гц. Один — удар, несколько — короткий мотив. */
  readonly tones: readonly number[]
  /** Задержка между тонами, секунды. */
  readonly step: number
  /** Атака и спад одного тона, секунды. */
  readonly attack: number
  readonly decay: number
  /** Пиковая громкость тона, 0..1. */
  readonly gain: number
  /** Сколько миллисекунд отклик не повторяется. */
  readonly cooldownMs: number
}

/**
 * Голоса событий.
 *
 * Логика подбора простая и вся на слуху отрасли, а не на теории музыки:
 *
 * — ПОЛОМКА единственная звучит вниз и единственная взята пилой: нисходящий
 *   ряд с резким тембром читается как «что-то сломалось» без объяснений, и он
 *   же самый громкий — это единственное событие, требующее вмешательства.
 * — ПОСТРОЙКА — два низких удара треугольником: тяжёлое и окончательное, под
 *   стать первому расходу, который не кончается.
 * — ПОКУПКА идёт вверх чистой квартой на синусе: короткое «получилось».
 * — ПОГРУЗКА самая тихая и самая короткая, потому что случается чаще всех
 *   вместе взятых. Её остывание — самое долгое по той же причине.
 *
 * Все тоны лежат в 90..750 Гц: середина, которая слышна и на ноутбучном
 * динамике, и не режет в наушниках.
 */
const CUES: Readonly<Record<SoundEvent, Cue>> = {
  поломка: {
    wave: 'sawtooth',
    tones: [330, 220, 155],
    step: 0.075,
    attack: 0.005,
    decay: 0.16,
    gain: 0.42,
    cooldownMs: 700,
  },
  постройка: {
    wave: 'triangle',
    tones: [98, 147],
    step: 0.12,
    attack: 0.004,
    decay: 0.28,
    gain: 0.34,
    cooldownMs: 300,
  },
  покупка: {
    wave: 'sine',
    tones: [523, 698],
    step: 0.08,
    attack: 0.004,
    decay: 0.18,
    gain: 0.3,
    cooldownMs: 300,
  },
  погрузка: {
    wave: 'triangle',
    tones: [196],
    step: 0,
    attack: 0.003,
    decay: 0.09,
    gain: 0.14,
    cooldownMs: 1200,
  },
}

/** Рецепт отклика на событие. */
export function cueFor(event: SoundEvent): Cue {
  return CUES[event]
}

/** Сколько длится отклик целиком, секунды. */
export function cueDuration(cue: Cue): number {
  return (cue.tones.length - 1) * cue.step + cue.attack + cue.decay
}

/**
 * Пора ли повторять отклик.
 *
 * Остывание держит слух в порядке при быстром времени: на скорости ×5 сутки
 * проходят за четыре секунды, и без него погрузки слились бы в треск. Отсчёт
 * идёт по РЕАЛЬНОМУ времени, а не по тикам, — ушам всё равно, какой в игре год.
 *
 * Время, ушедшее назад, отклик не блокирует: performance.now() у вкладки,
 * пережившей сон системы, способен прыгнуть, и залипшая на этом кнопка звука
 * молчала бы до конца партии.
 */
export function shouldPlay(
  event: SoundEvent,
  now: number,
  lastAt: number | null,
): boolean {
  if (lastAt === null) return true
  if (now < lastAt) return true
  return now - lastAt >= cueFor(event).cooldownMs
}

/** Состояние гула: громкость и срез фильтра над шумом. */
export type Ambient = {
  readonly gain: number
  readonly cutoff: number
}

/**
 * Гул глубокой ночи и гул разгара дня — два конца шкалы.
 *
 * Меняются оба параметра сразу, и это важнее, чем громкость сама по себе:
 * тише — это просто дальше, а тише И глуше — это ночь. Срез в 180 Гц оставляет
 * от дорожного шума один нижний край, ровно как слышно трассу издалека.
 */
export const AMBIENT_NIGHT: Ambient = { gain: 0.016, cutoff: 180 }
export const AMBIENT_DAY: Ambient = { gain: 0.07, cutoff: 900 }

/** Доля суток, на которой мир тише всего, — четыре утра. */
export const QUIETEST_HOUR = 4 / 24

/**
 * Гул по доле суток (0 — полночь, 0.5 — полдень).
 *
 * Косинус, а не таблица по часам: свет и звук обязаны ехать непрерывно, иначе
 * рассвет пойдёт ступеньками — та же причина, по которой dayProgress в
 * sim/time.ts принимает дробный тик. Минимум приходится на четыре утра,
 * максимум ровно через полсуток, на четыре дня, — там же, где реальный пик
 * дорожного трафика.
 *
 * Мусор на входе (NaN из недосчитанного тика) отдаёт ночь, а не NaN: попавший в
 * AudioParam NaN глушит весь граф до перезагрузки страницы.
 */
export function ambientAt(progress: number): Ambient {
  if (!Number.isFinite(progress)) return AMBIENT_NIGHT

  const shape = 0.5 - 0.5 * Math.cos(2 * Math.PI * (progress - QUIETEST_HOUR))

  return {
    gain: AMBIENT_NIGHT.gain + (AMBIENT_DAY.gain - AMBIENT_NIGHT.gain) * shape,
    cutoff:
      AMBIENT_NIGHT.cutoff + (AMBIENT_DAY.cutoff - AMBIENT_NIGHT.cutoff) * shape,
  }
}

// ─── Синтез: единственная часть, знающая про браузер ────────────────────────

/** Общая громкость. Запас до единицы оставлен наложению откликов на гул. */
const MASTER_GAIN = 0.8

/** Низкие тоны дрона, Гц. Расстроены между собой — отсюда медленное биение. */
const DRONE_HZ = [46, 46.6] as const

/** За сколько секунд гул доезжает до новой громкости. Медленно и незаметно. */
const AMBIENT_GLIDE = 1.5

/** Секунд шума в петле. Больше — незаметнее повтор, дороже память. */
const NOISE_SECONDS = 2

type AudioContextCtor = new () => AudioContext

/**
 * Конструктор контекста или null там, где звука нет.
 *
 * Через globalThis, а не через window: в Node окна нет вовсе, и одно упоминание
 * window уронило бы юнит-тесты этого же файла на импорте.
 */
function audioConstructor(): AudioContextCtor | null {
  const host = globalThis as unknown as {
    AudioContext?: AudioContextCtor
    webkitAudioContext?: AudioContextCtor
  }
  return host.AudioContext ?? host.webkitAudioContext ?? null
}

/** Есть ли в этой среде Web Audio вообще. */
export function soundAvailable(): boolean {
  return audioConstructor() !== null
}

/** Реальное время в миллисекундах — для остывания откликов. */
function nowMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

type Engine = {
  readonly ctx: AudioContext
  readonly master: GainNode
  readonly ambient: GainNode
  readonly filter: BiquadFilterNode
  readonly cues: GainNode
  /** Незатухающие источники гула — их надо остановить при закрытии. */
  readonly running: AudioScheduledSourceNode[]
}

let engine: Engine | null = null
let enabled = false

/** Когда каждый отклик звучал последний раз. Для остывания. */
const lastPlayed: Record<SoundEvent, number | null> = {
  поломка: null,
  постройка: null,
  покупка: null,
  погрузка: null,
}

/** Что уже отправлено в граф — чтобы не дёргать AudioParam впустую. */
let appliedAmbient: Ambient = AMBIENT_NIGHT

/** Отложенная остановка контекста после затухания гула. */
let suspendTimer: ReturnType<typeof setTimeout> | null = null

/** Счётчики для дев-хука: единственный способ проверить звук тестом. */
const probe = { cues: 0, lastEvent: null as SoundEvent | null }

/**
 * Дорожный шум: коричневый, то есть с завалом верхов, — так шумит трасса,
 * а не телевизор.
 *
 * Петля сшивается вручную: у коричневого шума концы отрезка гуляют далеко друг
 * от друга, и стык давал бы щелчок раз в две секунды. Вычитание линейного
 * наклона сводит последний отсчёт к первому и убирает щелчок целиком.
 */
function roadNoise(ctx: AudioContext): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * NOISE_SECONDS)
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = buffer.getChannelData(0)

  let value = 0
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1
    value = (value + 0.02 * white) / 1.02
    data[i] = value * 3.5
  }

  const drift = data[length - 1] - data[0]
  for (let i = 0; i < length; i++) {
    data[i] -= (drift * i) / (length - 1)
  }

  return buffer
}

/**
 * Собрать граф. Зовётся только из обработчика нажатия — см. шапку файла.
 *
 * Граф на весь звук один:
 *
 *     шум ──┐
 *           ├→ фильтр (сутки) → гул ─┐
 *     дрон ─┘                        ├→ мастер → выход
 *     отклики ───────────────────────┘
 *
 * Отклики идут МИМО суточного фильтра: они не часть мира, а ответ игре на
 * нажатие, и глохнуть по ночам им незачем.
 */
function createEngine(): Engine | null {
  const Ctor = audioConstructor()
  if (Ctor === null) return null

  try {
    const ctx = new Ctor()

    const master = ctx.createGain()
    master.gain.value = MASTER_GAIN
    master.connect(ctx.destination)

    const cues = ctx.createGain()
    cues.gain.value = 1
    cues.connect(master)

    const ambient = ctx.createGain()
    // Ноль на старте: гул выводится плавно, включённый звук не бьёт по ушам.
    ambient.gain.value = 0
    ambient.connect(master)

    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = AMBIENT_NIGHT.cutoff
    filter.Q.value = 0.7
    filter.connect(ambient)

    const running: AudioScheduledSourceNode[] = []

    const noise = ctx.createBufferSource()
    noise.buffer = roadNoise(ctx)
    noise.loop = true
    const noiseGain = ctx.createGain()
    noiseGain.gain.value = 0.85
    noise.connect(noiseGain).connect(filter)
    noise.start()
    running.push(noise)

    for (const hz of DRONE_HZ) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = hz
      const gain = ctx.createGain()
      gain.gain.value = 0.5
      osc.connect(gain).connect(filter)
      osc.start()
      running.push(osc)
    }

    appliedAmbient = AMBIENT_NIGHT
    return { ctx, master, ambient, filter, cues, running }
  } catch {
    // Контекстов у вкладки конечное число, и создание падает, когда лимит
    // выбран. Игра без звука — игра; игра, упавшая из-за звука, — нет.
    return null
  }
}

/**
 * Подвинуть гул к состоянию суток.
 *
 * setTargetAtTime, а не мгновенная запись: скачок громкости слышен щелчком, а
 * полторы секунды постоянной времени размазывают смену часа так, что её нельзя
 * поймать вниманием. Мелкие шаги отбрасываются — на скорости ×5 сюда прилетает
 * до полусотни вызовов в секунду, и каждый заводил бы в графе новую автоматику.
 */
function applyAmbient(progress: number): void {
  if (engine === null || !enabled) return

  const target = ambientAt(progress)
  if (
    Math.abs(target.gain - appliedAmbient.gain) < 0.0015 &&
    Math.abs(target.cutoff - appliedAmbient.cutoff) < 8
  ) {
    return
  }

  const at = engine.ctx.currentTime
  engine.ambient.gain.setTargetAtTime(target.gain, at, AMBIENT_GLIDE)
  engine.filter.frequency.setTargetAtTime(target.cutoff, at, AMBIENT_GLIDE)
  appliedAmbient = target
}

/**
 * Сыграть отклик.
 *
 * Узлы создаются на каждый тон и умирают вместе с ним — так устроен Web Audio,
 * осциллятор одноразовый. Это не «объекты в цикле кадра»: откликов единицы в
 * секунду, и потолок им ставит остывание, а не частота кадров.
 */
function playCue(event: SoundEvent, now: number): void {
  if (engine === null) return
  if (!shouldPlay(event, now, lastPlayed[event])) return
  lastPlayed[event] = now

  const cue = cueFor(event)
  const ctx = engine.ctx
  // Небольшой отступ вперёд: планировать точно в currentTime значит опоздать на
  // размер буфера и получить щелчок в начале атаки.
  const start = ctx.currentTime + 0.01

  for (let i = 0; i < cue.tones.length; i++) {
    const at = start + i * cue.step
    const osc = ctx.createOscillator()
    osc.type = cue.wave
    osc.frequency.setValueAtTime(cue.tones[i], at)

    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.linearRampToValueAtTime(cue.gain, at + cue.attack)
    // Экспонента, а не линия: так спадает всё, что звучит в природе, и хвост
    // не обрывается ступенькой.
    gain.gain.exponentialRampToValueAtTime(0.0001, at + cue.attack + cue.decay)

    osc.connect(gain).connect(engine.cues)
    osc.start(at)
    osc.stop(at + cue.attack + cue.decay + 0.02)
    osc.onended = () => {
      osc.disconnect()
      gain.disconnect()
    }
  }

  probe.cues += 1
  probe.lastEvent = event
}

/** Разложить маску на отклики в порядке важности. */
function playMask(mask: number, now: number): void {
  if (mask === 0) return
  for (const event of EVENT_ORDER) {
    if ((mask & EVENT_BIT[event]) !== 0) playCue(event, now)
  }
}

/** Поднять звук. Только из обработчика нажатия. */
function startSound(): void {
  if (suspendTimer !== null) {
    clearTimeout(suspendTimer)
    suspendTimer = null
  }

  engine ??= createEngine()
  if (engine === null) return

  // resume возвращает промис и в норме отрабатывает мгновенно: контекст,
  // созданный в клике, уже running. Ошибку глотаем — упасть здесь значит
  // сломать нажатие кнопки, а не звук.
  void engine.ctx.resume().catch(() => {})

  // Гул сразу берёт время суток, а не выезжает из ночи посреди дня.
  appliedAmbient = AMBIENT_NIGHT
  applyAmbient(dayProgress(useGameStore.getState().state.tick))
}

/** Погасить звук, оставив граф на месте: включат обратно — не пересобирать. */
function stopSound(): void {
  if (engine === null) return

  const ctx = engine.ctx
  engine.ambient.gain.setTargetAtTime(0, ctx.currentTime, 0.12)
  appliedAmbient = AMBIENT_NIGHT

  // Контекст усыпляется ПОСЛЕ затухания: suspend мгновенно обрывает звук, и
  // выключение щёлкало бы. Полсекунды хватает на затухание с запасом.
  suspendTimer = setTimeout(() => {
    suspendTimer = null
    if (engine !== null && !enabled) void engine.ctx.suspend().catch(() => {})
  }, 500)
}

/** Разобрать граф насовсем. Зовётся при размонтировании приложения. */
function closeSound(): void {
  enabled = false

  if (suspendTimer !== null) {
    clearTimeout(suspendTimer)
    suspendTimer = null
  }

  const current = engine
  engine = null
  if (current === null) return

  try {
    for (const source of current.running) source.stop()
    void current.ctx.close().catch(() => {})
  } catch {
    // Контекст мог закрыться сам вместе со вкладкой — это не ошибка.
  }
}

// ─── Кнопка и монтирование ─────────────────────────────────────────────────

const listeners = new Set<() => void>()

/** Включён ли звук. */
export function isSoundOn(): boolean {
  return enabled
}

/** Подписка для интерфейса: кнопка обязана показывать настоящее состояние. */
export function subscribeSound(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Переключить звук. ЗВАТЬ ТОЛЬКО ИЗ ОБРАБОТЧИКА НАЖАТИЯ.
 *
 * Возвращает новое состояние — кнопке удобно, тесту наглядно.
 */
export function toggleSound(): boolean {
  enabled = !enabled

  if (enabled) startSound()
  else stopSound()

  for (const listener of listeners) listener()
  return enabled
}

/**
 * Состояние звука для интерфейса.
 *
 * useSyncExternalStore, а не useState в кнопке: источник правды один — этот
 * модуль, и кнопка обязана быть его отражением, а не второй копией флага.
 */
export function useSoundOn(): boolean {
  return useSyncExternalStore(subscribeSound, isSoundOn, isSoundOn)
}

/**
 * Единственная точка монтирования звука. Стоит в App.tsx рядом с игровым циклом.
 *
 * Подписка на стор, а не на кадры. Стор будит подписчиков только тогда, когда
 * состояние сменилось (advance возвращает тот же объект, если тик не набежал, —
 * см. app/store.ts), поэтому на паузе здесь не выполняется вообще ничего.
 * Предыдущее состояние приносит сам zustand — своей копии снимка модуль не
 * держит и разъехаться с игрой не может.
 *
 * ВЫКЛЮЧЕННЫЙ ЗВУК НЕ СТОИТ НИЧЕГО: подписка выходит на первой же строке, до
 * разбора состояния. Это важно, потому что выключено — состояние по умолчанию,
 * и цена звука в игре без звука обязана быть нулевой.
 */
export function useSound(): void {
  useEffect(() => {
    const unsubscribe = useGameStore.subscribe((store, before) => {
      if (!enabled) return

      const state = store.state
      const prev = before.state
      if (prev === state) return

      playMask(detectEvents(prev, state), nowMs())

      // Гул трогаем только на смене тика: внутри тика сутки не двигаются.
      if (state.tick !== prev.tick) applyAmbient(dayProgress(state.tick))
    })

    return () => {
      unsubscribe()
      closeSound()
      for (const listener of listeners) listener()
    }
  }, [])
}

/**
 * Дев-хук: единственный честный способ проверить звук тестом.
 *
 * Услышать headless-браузер нельзя, поэтому сквозной тест смотрит на счётчики:
 * включился ли контекст, сколько откликов ушло в граф, какой был последним.
 * В продакшен-сборке ветка вырезается целиком — import.meta.env.DEV константа
 * на этапе сборки.
 */
if (import.meta.env.DEV) {
  ;(globalThis as unknown as { __plechoSound?: unknown }).__plechoSound =
    () => ({
      enabled,
      available: soundAvailable(),
      state: engine === null ? 'нет' : engine.ctx.state,
      cues: probe.cues,
      lastEvent: probe.lastEvent,
      ambientGain: appliedAmbient.gain,
      ambientCutoff: appliedAmbient.cutoff,
    })
}
