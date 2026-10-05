import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'drainage-pump:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalize(rows: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const result: Record<string, EntryRow[]> = {}
  for (const [key, entries] of Object.entries(rows)) {
    result[key] = entries.map((row) => ({
      ...row,
      version: typeof row.version === 'number' ? row.version : 0,
    }))
  }
  return result
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = normalize(clone(SEED_ROWS))
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 老数据可能没有 version 字段，统一补 0，成批排期的乐观锁才能对所有记录生效。
    return normalize({ ...fallback, ...parsed })
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

// 另一个标签页（另一个批次）写过库就丢掉本地缓存，强制重读 localStorage 最新版，
// 成批排期的乐观锁才能挡住并发提交。
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) {
      cache = null
    }
  })
}

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const normalized = rows.map((row) => ({
    ...row,
    version: typeof row.version === 'number' ? row.version : 0,
  }))
  const next = { ...allRows(), [key]: normalized }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
