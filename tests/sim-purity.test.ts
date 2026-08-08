import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Страж главного архитектурного правила проекта.
 *
 * src/sim/ — чистый TypeScript: ноль зависимостей от React, Three.js, DOM и
 * вообще от браузера. Симуляция должна запускаться в Node без окружения.
 *
 * От этого зависят: тесты экономики без браузера, прогоны баланса на тысячу
 * игровых лет, детерминизм, сохранения как обычный JSON, воспроизведение багов.
 * Один useState внутри sim/ — и всё это отваливается.
 *
 * Правило проверяется тестом, а не линтером, намеренно: тест нельзя отключить
 * комментарием и он падает в общем прогоне.
 */

const SIM_DIR = join(process.cwd(), 'src', 'sim')

/** Пакеты, привязывающие код к браузеру или к слою представления. */
const FORBIDDEN_PACKAGES = [
  'react',
  'react-dom',
  'three',
  'zustand',
  '@react-three/fiber',
  '@react-three/drei',
  '@react-three/postprocessing',
  'postprocessing',
]

/** Глобалы, которых нет в Node или которые тянут за собой среду. */
const FORBIDDEN_GLOBALS = [
  'window',
  'document',
  'localStorage',
  'sessionStorage',
  'navigator',
  'requestAnimationFrame',
  'fetch',
]

function collectSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full))
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

/** Источники всех статических и динамических импортов файла. */
function extractImportSources(code: string): string[] {
  const sources: string[] = []
  const patterns = [
    /(?:^|\n)\s*import\s+[^'"]*from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      sources.push(match[1])
    }
  }
  return sources
}

/** Убирает строковые литералы и комментарии — чтобы не ловить слова в тексте. */
function stripStringsAndComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
}

const files = collectSourceFiles(SIM_DIR)

describe('чистота src/sim', () => {
  it('в sim есть исходники — тест не проходит вхолостую', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files.map((f) => [relative(process.cwd(), f), f] as const))(
    '%s не импортирует запрещённые пакеты',
    (_label, file) => {
      const sources = extractImportSources(readFileSync(file, 'utf8'))
      const violations = sources.filter((source) =>
        FORBIDDEN_PACKAGES.some(
          (pkg) => source === pkg || source.startsWith(`${pkg}/`),
        ),
      )
      expect(violations).toEqual([])
    },
  )

  it.each(files.map((f) => [relative(process.cwd(), f), f] as const))(
    '%s не обращается к браузерным глобалам',
    (_label, file) => {
      const code = stripStringsAndComments(readFileSync(file, 'utf8'))
      const violations = FORBIDDEN_GLOBALS.filter((name) =>
        new RegExp(`(?<![.\\w$])${name}\\s*[.([]`).test(code),
      )
      expect(violations).toEqual([])
    },
  )

  it('sim импортируется в Node без браузерного окружения', async () => {
    for (const file of files) {
      const url = `file://${file.replace(/\\/g, '/')}`
      await expect(import(/* @vite-ignore */ url)).resolves.toBeDefined()
    }
  })
})
