/**
 * Панель времени: дата, часы и управление скоростью.
 *
 * Единственный элемент интерфейса, который обязан быть на экране всегда — по
 * нему игрок понимает, что мир жив и с какой скоростью он идёт. Отсюда все
 * решения ниже: панель маленькая, прижата в угол, ничего не перекрывает и не
 * требует наведения мыши, чтобы прочитать состояние.
 *
 * Стили заданы прямо в разметке, а не в CSS-файле: панель — единственный
 * владелец этих правил, и держать источник цветов ровно один (palette.ts)
 * важнее, чем разделять разметку и оформление. Как только элементов
 * интерфейса станет больше одного, это переедет в общий слой.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, JSX } from 'react'

import { useGameStore } from '../app/store'
import { palette } from '../render/palette'
import { dateFromTick, formatDate, formatTime } from '../sim/time'
import type { GameSpeed } from '../sim/types'

/** Скорости, доступные кнопками. Пауза — отдельная кнопка, у неё своя роль. */
const SPEEDS: readonly GameSpeed[] = [1, 2, 5]

/** Скорость по умолчанию при снятии паузы, если игра началась с паузы. */
const DEFAULT_SPEED: GameSpeed = 1

/**
 * Моноширинный стек для всего, что в панели меняется.
 *
 * Табличные цифры (font-variant-numeric в index.css) держат ширину знака, но не
 * ширину строки: «11:45» и «01:00» в пропорциональном шрифте всё равно разной
 * ширины из-за двоеточия. Моноширинный шрифт закрывает вопрос целиком, а заодно
 * даёт часам приборный вид, уместный для диспетчерской.
 */
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/**
 * Тот же цвет палитры, но полупрозрачный.
 *
 * Прозрачность считается из палитры, а не пишется готовой строкой «rgba(255,
 * 122, 26, ...)»: копия числами разъедется с palette.ts при первой же правке
 * акцента, и разъедется молча — глазом расхождение в один-два тона не поймать.
 */
function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16)
  const r = (value >> 16) & 0xff
  const g = (value >> 8) & 0xff
  const b = value & 0xff
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** Заливка активной кнопки: акцент, приглушённый до подложки. */
const ACCENT_WASH = withAlpha(palette.accent, 0.14)

const panelStyle: CSSProperties = {
  position: 'fixed',
  top: 16,
  left: 16,
  zIndex: 10,

  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '10px 12px',
  /**
   * Ширина фиксированная, а не по содержимому. Дата пишется словом («1 мая
   * 1994» против «28 сентября 1994»), и панель по содержимому меняла бы размер
   * посреди игры — самое заметное дёрганье, какое может быть у неподвижного
   * элемента. Запаса хватает: шестнадцать знаков моноширинного шрифта в 13px
   * занимают около 115 пикселей при 146 доступных.
   */
  width: 172,
  boxSizing: 'border-box',

  background: palette.panel,
  border: `1px solid ${palette.panelBorder}`,
  borderRadius: 6,
  color: palette.text,
  fontFamily: MONO,

  // Панель — приборная доска, а не текст: выделение мышью здесь только мешает
  // и мешает особенно при перетаскивании камеры мимо панели.
  userSelect: 'none',
}

const dateStyle: CSSProperties = {
  fontSize: 13,
  color: palette.textDim,
  letterSpacing: '0.02em',
  lineHeight: 1,
  whiteSpace: 'nowrap',
}

const secondLineStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 12,
  lineHeight: 1,
}

const timeStyle: CSSProperties = {
  fontSize: 20,
  color: palette.text,
}

const seasonStyle: CSSProperties = {
  fontSize: 11,
  color: palette.textDim,
  letterSpacing: '0.08em',
}

const buttonsRowStyle: CSSProperties = {
  display: 'flex',
  gap: 4,
}

/**
 * Кнопка скорости.
 *
 * Активная берёт акцент — тот же оранжевый, что и машины на карте, потому что
 * «идёт время» и «едут машины» для игрока одно и то же состояние. Неактивные
 * приглушены до textDim: панель не должна тянуть взгляд с карты, пока на неё
 * не смотрят намеренно.
 */
function buttonStyle(active: boolean, hovered: boolean): CSSProperties {
  return {
    minWidth: 28,
    height: 24,
    padding: '0 6px',

    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',

    background: active ? ACCENT_WASH : 'transparent',
    border: `1px solid ${active ? palette.accent : palette.panelBorder}`,
    borderRadius: 4,
    color: active ? palette.accent : hovered ? palette.text : palette.textDim,

    font: `12px/1 ${MONO}`,
    cursor: 'pointer',
    // Цвет и рамка меняются мгновенно — короткий переход убирает мигание,
    // но не превращает переключение скорости в анимацию.
    transition: 'color 120ms, border-color 120ms, background-color 120ms',
  }
}

export function TimeControls(): JSX.Element {
  // Подписки узкие и по одному полю: панель должна перерисовываться на смене
  // тика (это её работа — показывать время) и не должна на любом другом
  // изменении состояния, которых за тик происходит много.
  const tick = useGameStore((store) => store.state.tick)
  const startYear = useGameStore((store) => store.state.startYear)
  const speed = useGameStore((store) => store.speed)
  const setSpeed = useGameStore((store) => store.setSpeed)

  const [hovered, setHovered] = useState<GameSpeed | null>(null)

  /**
   * Скорость, на которую возвращаемся из паузы.
   *
   * Пауза не должна терять контекст: игрок, поставивший игру на паузу на ×5,
   * ждёт, что пробел вернёт именно ×5. Ref, а не state, потому что значение не
   * участвует в отрисовке — на кнопках отображается текущая скорость.
   */
  const lastRunning = useRef<GameSpeed>(DEFAULT_SPEED)
  useEffect(() => {
    if (speed !== 0) lastRunning.current = speed
  }, [speed])

  const togglePause = useCallback(() => {
    // Состояние читается из стора, а не из замыкания: обработчик клавиатуры
    // вешается один раз, и захваченная скорость к моменту нажатия устареет.
    const store = useGameStore.getState()
    store.setSpeed(store.speed === 0 ? lastRunning.current : 0)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== 'Space') return
      // Зажатый пробел не должен молотить паузой десять раз в секунду.
      if (event.repeat) return
      if (event.ctrlKey || event.altKey || event.metaKey) return

      // Пробел в поле ввода принадлежит полю. Проверка на будущее: полей в
      // интерфейсе пока нет, но появится первое же переименование линии.
      const target = event.target as HTMLElement | null
      if (target !== null) {
        if (target.isContentEditable) return
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      }

      // Без preventDefault пробел сработает дважды: как наша пауза и как
      // нажатие на кнопку скорости, которая осталась в фокусе после клика.
      event.preventDefault()
      togglePause()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [togglePause])

  const date = dateFromTick(tick, startYear)
  const paused = speed === 0

  return (
    <div style={panelStyle}>
      {/*
        Дата и время форматируются в src/sim/time.ts, а не здесь. Панель — не
        то место, где решают, как в игре выглядит календарь: формат один на всю
        игру и покрыт тестами вместе с самим календарём.
      */}
      <div style={dateStyle}>{formatDate(date)}</div>

      <div style={secondLineStyle}>
        <span style={timeStyle}>{formatTime(date)}</span>
        <span style={seasonStyle}>{date.season}</span>
      </div>

      <div style={buttonsRowStyle}>
        <button
          type="button"
          onClick={togglePause}
          onMouseEnter={() => setHovered(0)}
          onMouseLeave={() => setHovered(null)}
          style={buttonStyle(paused, hovered === 0)}
          aria-pressed={paused}
          aria-label="Пауза"
          title="Пауза (пробел)"
        >
          {/*
            Значок паузы собран из двух полосок, а не набран символом: юникодные
            «⏸» и «❚» тянут за собой шрифтовой фолбэк и на части систем
            приезжают другого размера, чем цифры соседних кнопок. Две полоски
            выглядят одинаково везде.
          */}
          <span style={{ display: 'flex', gap: 3 }}>
            <span
              style={{ width: 2, height: 10, background: 'currentColor' }}
            />
            <span
              style={{ width: 2, height: 10, background: 'currentColor' }}
            />
          </span>
        </button>

        {SPEEDS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setSpeed(option)}
            onMouseEnter={() => setHovered(option)}
            onMouseLeave={() => setHovered(null)}
            style={buttonStyle(speed === option, hovered === option)}
            aria-pressed={speed === option}
            title={`Скорость ×${option}`}
          >
            ×{option}
          </button>
        ))}
      </div>
    </div>
  )
}
