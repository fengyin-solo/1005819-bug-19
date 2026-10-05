import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  BatchScheduleLine,
  BatchScheduleRequest,
  BatchScheduleResult,
  EntryRow,
  MaintenanceMetrics,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const PUMPMAINT_KEY = 'pumpmaint'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function rowVersion(row: EntryRow): number {
  return typeof row.version === 'number' ? row.version : 0
}

function bumpVersion(row: EntryRow): EntryRow {
  return { ...row, version: rowVersion(row) + 1 }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  // 源状态白名单：登记了的动作只能从指定状态发起，跳级、回退一律挡下。
  const allowedFrom = meta.actionFrom?.[action]
  if (allowedFrom && !allowedFrom.includes(current)) {
    return {
      ok: false,
      message: `「${action}」只能在${allowedFrom
        .map((status) => `「${status}」`)
        .join('或')}状态办理，当前为「${current}」；检修记录只能按 待开工 → 检修中 → 已完工 顺序流转，不能跳级或回退`,
    }
  }
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = bumpVersion({
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  })
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// ---- 成批排期 ----------------------------------------------------------------

type DateRange = { start: Date; end: Date }

function parseDate(value: string): Date | null {
  const text = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return null
  }
  const date = new Date(`${text}T00:00:00`)
  return Number.isNaN(date.getTime()) ? null : date
}

function formatDay(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

// 计划工期支持单日（2026-10-01）或区间（2026-10-01~2026-10-05）。
function parseRange(value: unknown): DateRange | null {
  const text = String(value ?? '').trim()
  if (!text) {
    return null
  }
  const parts = text.split(/\s*[~～至]\s*/)
  if (parts.length === 1) {
    const day = parseDate(parts[0])
    return day ? { start: day, end: day } : null
  }
  if (parts.length === 2) {
    const start = parseDate(parts[0])
    const end = parseDate(parts[1])
    if (start && end && start.getTime() <= end.getTime()) {
      return { start, end }
    }
  }
  return null
}

function formatRange(range: DateRange): string {
  const start = formatDay(range.start)
  const end = formatDay(range.end)
  return start === end ? start : `${start}~${end}`
}

function rangesOverlap(a: DateRange, b: DateRange): boolean {
  return a.start.getTime() <= b.end.getTime() && b.start.getTime() <= a.end.getTime()
}

type Occupancy = { code: string; pumpCode: string; range: DateRange }

const FINISHED_STATUS = '已完工'
const WAITING_STATUS = '待开工'
const REPAIRING_STATUS = '检修中'
// 已完工之外的状态都还占着泵组工期：待开工/检修中/已延期。
function occupiesPump(status: string): boolean {
  return status !== FINISHED_STATUS
}

/**
 * 成批排期：圈选多条一次提交。
 * 逐条校验、逐条落库、逐条给回执——成功几条就写几条，被挡的留在列表里不动，
 * 已成功的条目不随失败回滚。
 */
export function batchSchedulePumpMaint(request: BatchScheduleRequest): BatchScheduleResult {
  const planRange: DateRange | null = (() => {
    const start = parseDate(request.planStart)
    const end = parseDate(request.planEnd)
    if (!start || !end || start.getTime() > end.getTime()) {
      return null
    }
    return { start, end }
  })()

  // 重复圈选同一条按一次算：按 id 去重，保留第一次圈到的快照版本。
  const picked: { id: number; version?: number }[] = []
  const seenIds = new Set<number>()
  for (const item of request.items) {
    const id = Number(item.id)
    if (seenIds.has(id)) {
      continue
    }
    seenIds.add(id)
    picked.push({ id, version: item.version })
  }

  const rows = listRows(PUMPMAINT_KEY)
  const next = [...rows]
  const indexById = new Map<number, number>()
  rows.forEach((row, index) => indexById.set(Number(row.id), index))

  // 已有占用：未完工记录的计划工期（本批圈到的除外，它们马上要被重新排期；
  // 若被挡下保留旧工期，会在逐条处理时补回占用）。
  const occupancy: Occupancy[] = []
  for (const row of rows) {
    if (seenIds.has(Number(row.id)) || !occupiesPump(String(row.status))) {
      continue
    }
    const range = parseRange(row['计划工期'])
    if (range) {
      occupancy.push({
        code: String(row['检修编号'] ?? ''),
        pumpCode: String(row['泵组编号'] ?? ''),
        range,
      })
    }
  }

  const lines: BatchScheduleLine[] = []
  let accepted = 0
  let blocked = 0
  let skipped = 0

  function block(line: Omit<BatchScheduleLine, 'ok'>): BatchScheduleLine {
    return { ...line, ok: false }
  }

  for (const { id, version } of picked) {
    const index = indexById.get(id)
    if (index === undefined) {
      blocked += 1
      lines.push(
        block({
          id,
          code: `#${id}`,
          pumpCode: '—',
          reason: 'not-found',
          message: `编号 ${id} 的检修记录已不存在，未做改动`,
          version: version ?? 0,
        }),
      )
      continue
    }

    const row = next[index]
    const code = String(row['检修编号'] ?? `#${id}`)
    const pumpCode = String(row['泵组编号'] ?? '—')
    const currentStatus = String(row.status)
    const stay = (reason: BatchScheduleLine['reason'], message: string): void => {
      blocked += reason === 'already-finished' ? 0 : 1
      if (reason === 'already-finished') {
        skipped += 1
      }
      lines.push(
        block({ id, code, pumpCode, reason, message, version: rowVersion(row) }),
      )
      // 没改成的记录保留旧工期，继续占用泵组。
      const oldRange = parseRange(row['计划工期'])
      if (oldRange && occupiesPump(currentStatus)) {
        occupancy.push({ code, pumpCode, range: oldRange })
      }
    }

    // 完工的检修编号必须跳过：成批排期不许改动已完工记录。
    if (currentStatus === FINISHED_STATUS) {
      stay('already-finished', `检修编号 ${code} 已完工，按规定跳过，不参与本次排期`)
      continue
    }

    // 乐观锁：圈选时的版本和库内版本对不上，说明另一批已经先提交过——后提交的挡住。
    // 放在状态判断之前：哪怕状态已被前一批推进，也明确提示去看最新一版。
    if (version !== undefined && rowVersion(row) !== version) {
      stay(
        'stale',
        `检修编号 ${code} 自圈选后已被其他批次改动（版本 v${version} → v${rowVersion(
          row,
        )}，当前「${currentStatus}」），请先查看最新一版再重新排期`,
      )
      continue
    }

    // 只有待开工能排期；检修中/已延期不走这条路。
    if (currentStatus !== WAITING_STATUS) {
      stay('wrong-status', `检修编号 ${code} 当前为「${currentStatus}」，只有待开工记录能排期，未改动`)
      continue
    }

    if (!planRange) {
      stay('conflict', '计划工期无效，请填写合法的开工/完工日期后再提交，未改动')
      continue
    }

    // 同一台泵：新工期与已有安排（含本批已排成的）撞在一起就挡下。
    const clash = occupancy.find(
      (item) => item.pumpCode === pumpCode && rangesOverlap(item.range, planRange),
    )
    if (clash) {
      stay(
        'conflict',
        `检修编号 ${code} 的计划工期 ${formatRange(planRange)} 与泵组 ${pumpCode} 已安排的检修 ${
          clash.code
        }（工期 ${formatRange(clash.range)}）冲突，已挡下，未改动`,
      )
      continue
    }

    // 落库这一条：写入检修类别、计划工期，状态推进到检修中。
    const updated = bumpVersion({
      ...row,
      '检修类别': request.category.trim(),
      '计划工期': formatRange(planRange),
      status: REPAIRING_STATUS,
      pending: true,
      abnormal: false,
    })
    next[index] = updated
    occupancy.push({ code, pumpCode, range: planRange })
    accepted += 1
    lines.push({
      id,
      code,
      pumpCode,
      ok: true,
      reason: 'success',
      message: `检修编号 ${code}（泵组 ${pumpCode}）已排期：${request.category
        .trim()}，工期 ${formatRange(planRange)}，状态推进为「检修中」`,
      version: rowVersion(updated),
    })
  }

  // 部分成功也整批写盘：被挡的保持原样，成功的不回滚。
  if (accepted > 0) {
    saveRows(PUMPMAINT_KEY, next)
  }

  return {
    ok: blocked === 0 && skipped === 0,
    accepted,
    blocked,
    skipped,
    lines,
  }
}

/**
 * 检修统计唯一出口：检修台账列表页和泵组运行看板都从这里读「检修中泵组」台数，
 * 保证两个页面读到的数一致。
 */
export function maintenanceMetrics(now: Date = new Date()): MaintenanceMetrics {
  const rows = listRows(PUMPMAINT_KEY)
  const monthPrefix = `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, '0')}`
  return {
    waiting: rows.filter((row) => String(row.status) === WAITING_STATUS).length,
    repairing: rows.filter((row) => String(row.status) === REPAIRING_STATUS).length,
    finished: rows.filter((row) => String(row.status) === FINISHED_STATUS).length,
    delayed: rows.filter((row) => String(row.status) === '已延期').length,
    finishedThisMonth: rows.filter(
      (row) =>
        String(row.status) === FINISHED_STATUS &&
        String(row['完成日期'] ?? '').startsWith(monthPrefix),
    ).length,
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
