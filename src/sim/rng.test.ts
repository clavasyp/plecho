import { describe, expect, it } from 'vitest'
import { Rng } from './rng'

describe('Rng', () => {
  it('одинаковый сид даёт одинаковую последовательность', () => {
    const a = Rng.from(12345)
    const b = Rng.from(12345)
    const seqA = Array.from({ length: 100 }, () => a.float())
    const seqB = Array.from({ length: 100 }, () => b.float())
    expect(seqA).toEqual(seqB)
  })

  it('разные сиды дают разные последовательности', () => {
    const a = Rng.from(1)
    const b = Rng.from(2)
    expect(a.float()).not.toBe(b.float())
  })

  it('float остаётся в [0, 1)', () => {
    const rng = Rng.from(999)
    for (let i = 0; i < 10_000; i++) {
      const v = rng.float()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('состояние восстанавливается — продолжение с сохранённого seed совпадает', () => {
    const original = Rng.from(777)
    original.float()
    original.float()

    const saved = original.seed
    const expected = [original.float(), original.float(), original.float()]

    const restored = Rng.from(saved)
    const actual = [restored.float(), restored.float(), restored.float()]

    expect(actual).toEqual(expected)
  })

  it('int попадает в границы включительно и покрывает их', () => {
    const rng = Rng.from(42)
    const seen = new Set<number>()
    for (let i = 0; i < 5_000; i++) {
      const v = rng.int(1, 6)
      expect(v).toBeGreaterThanOrEqual(1)
      expect(v).toBeLessThanOrEqual(6)
      expect(Number.isInteger(v)).toBe(true)
      seen.add(v)
    }
    expect(seen.size).toBe(6)
  })

  it('chance(0) никогда, chance(1) всегда', () => {
    const rng = Rng.from(5)
    for (let i = 0; i < 200; i++) {
      expect(rng.chance(0)).toBe(false)
      expect(rng.chance(1)).toBe(true)
    }
  })

  it('распределение float примерно равномерное', () => {
    const rng = Rng.from(2024)
    const buckets = new Array(10).fill(0)
    const n = 100_000
    for (let i = 0; i < n; i++) {
      buckets[Math.floor(rng.float() * 10)]++
    }
    // каждая корзина должна быть в пределах ±5% от n/10
    for (const count of buckets) {
      expect(count).toBeGreaterThan(n / 10 - n / 200)
      expect(count).toBeLessThan(n / 10 + n / 200)
    }
  })

  it('pick бросает на пустом массиве', () => {
    const rng = Rng.from(1)
    expect(() => rng.pick([])).toThrow()
  })

  it('forKey стабилен для одного ключа и различается для разных', () => {
    const a = Rng.forKey('moscow').float()
    const b = Rng.forKey('moscow').float()
    const c = Rng.forKey('tula').float()
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('forKey не зависит от состояния основного потока', () => {
    const main = Rng.from(1)
    const before = Rng.forKey('city-7').float()
    for (let i = 0; i < 50; i++) main.float()
    const after = Rng.forKey('city-7').float()
    expect(after).toBe(before)
  })
})
