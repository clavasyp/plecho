/**
 * Детерминированный генератор псевдослучайных чисел.
 *
 * Состояние — одно 32-битное число, поэтому оно живёт прямо в GameState и
 * сериализуется вместе с ним. Одинаковый сид всегда даёт одинаковую
 * последовательность: без этого не воспроизводятся баги по сохранению и не
 * работают прогоны баланса.
 *
 * Алгоритм — mulberry32. Быстрый, проходит статистические тесты, достаточен
 * для игровой логики (криптостойкость здесь не нужна).
 */

export class Rng {
  private state: number

  private constructor(state: number) {
    this.state = state | 0
  }

  /** Создать из сохранённого состояния (или из сида — это одно и то же). */
  static from(state: number): Rng {
    return new Rng(state)
  }

  /** Текущее состояние — записать обратно в GameState после использования. */
  get seed(): number {
    return this.state | 0
  }

  /** Случайное число в [0, 1). */
  float(): number {
    this.state = (this.state + 0x6d2b79f5) | 0
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Случайное целое в [min, max] включительно. */
  int(min: number, max: number): number {
    return min + Math.floor(this.float() * (max - min + 1))
  }

  /** Случайное число в [min, max). */
  range(min: number, max: number): number {
    return min + this.float() * (max - min)
  }

  /** true с вероятностью p (0..1). */
  chance(p: number): boolean {
    return this.float() < p
  }

  /** Случайный элемент массива. Бросает на пустом массиве — это всегда баг. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error('Rng.pick: пустой массив')
    }
    return items[Math.floor(this.float() * items.length)]
  }

  /**
   * Отдельный поток случайности, выведенный из строкового ключа.
   *
   * Нужен для процедурной генерации, привязанной к сущности: силуэт города
   * должен быть одинаковым между сессиями и не зависеть от того, сколько раз
   * до этого дёрнули основной поток.
   */
  static forKey(key: string, salt = 0): Rng {
    let h = 2166136261 ^ salt
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return new Rng(h)
  }
}
