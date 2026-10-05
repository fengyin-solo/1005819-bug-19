import { listRows, saveRows } from '@/data/local-store'
import type {
  BatchScheduleRequest,
  BatchScheduleResult,
  EntryRow,
  ScheduleItemResult,
  ScheduleRejectReason,
  ScheduleRequestItem,
} from '@/data/types'

const KEY = 'pumpmaint'
const STATUS_PENDING = '待开工'
const STATUS_RUNNING = '检修中'
const STATUS_DONE = '已完工'
const PUMP_FIELD = '泵组编号'
const CODE_FIELD = '检修编号'
const PERIOD_FIELD = '计划工期'
const CATEGORY_FIELD = '检修类别'
const FINISH_FIELD = '完成日期'

type DateRange = { start: string; end: string }

/** 老数据里可能没有版本号，统一按第 1 版对待。 */
function versionOf(row: EntryRow): number {
  const value = Number(row.version ?? 1)
  return Number.isInteger(value) && value > 0 ? value : 1
}

function fieldOf(row: EntryRow, field: string): string {
  return String(row[field] ?? '').trim()
}

/** 支持「2026-10-05」单日，或「2026-10-05~2026-10-08」「2026-10-05 至 2026-10-08」这类区间写法。 */
export function parsePeriod(text: string): DateRange | null {
  const value = text.trim()
  if (!value) {
    return null
  }
  const match = value.split(/\s*(?:~|～|--|—|–|至)\s*/)
  const dates = (match.length === 1 ? [value, value] : match)
    .map((part) => part.trim())
    .filter(Boolean)
  if (dates.length !== 2 || dates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
    return null
  }
  const [start, end] = dates
  return start <= end ? { start, end } : { start: end, end: start }
}

function overlaps(a: DateRange, b: DateRange): boolean {
  return a.start <= b.end && b.start <= a.end
}

function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function describe(row: EntryRow): string {
  return fieldOf(row, CODE_FIELD) || String(row.id)
}

/** 检修中台数：台账页与泵组运行看板都从这里读，两个页面读到的数天然一致。 */
export function countPumpsInMaintenance(): number {
  const pumps = new Set<string>()
  for (const row of listRows(KEY)) {
    if (String(row.status) === STATUS_RUNNING) {
      const pump = fieldOf(row, PUMP_FIELD)
      if (pump) {
        pumps.add(pump)
      }
    }
  }
  return pumps.size
}

export function countPendingMaintenance(): number {
  return listRows(KEY).filter((row) => String(row.status) === STATUS_PENDING).length
}

export function countCompletedThisMonth(): number {
  const prefix = today().slice(0, 7)
  return listRows(KEY).filter(
    (row) => String(row.status) === STATUS_DONE && fieldOf(row, FINISH_FIELD).startsWith(prefix),
  ).length
}

function reject(
  item: ScheduleRequestItem,
  code: string,
  pumpCode: string,
  reason: ScheduleRejectReason,
  message: string,
): ScheduleItemResult {
  return { id: item.id, code, pumpCode, ok: false, reason, message }
}

/**
 * 成批排期：逐条独立处理、逐条给回执。
 * - 成功的当场落库，不因后面任何一条失败而回滚；
 * - 被挡下的原样留在列表里，回执里写清原因，绝不静默丢掉；
 * - 同一编号重复圈选只按一条计算；
 * - 已完工记录只跳过并说明，不允许改动。
 */
export function batchSchedule(request: BatchScheduleRequest): BatchScheduleResult {
  const period = request.period.trim()
  const category = request.category.trim()
  const rows = listRows(KEY)
  const next = rows.map((row) => ({ ...row }))
  const items: ScheduleItemResult[] = []
  const seen = new Set<number>()
  let duplicated = 0

  for (const item of request.items) {
    if (seen.has(item.id)) {
      duplicated += 1
      continue
    }
    seen.add(item.id)

    const index = next.findIndex((row) => Number(row.id) === Number(item.id))
    if (index < 0) {
      items.push(
        reject(item, String(item.id), '', 'not-found', `编号 ${item.id} 的检修记录不存在，未处理`),
      )
      continue
    }
    const row = next[index]
    const code = describe(row)
    const pumpCode = fieldOf(row, PUMP_FIELD)
    const status = String(row.status)

    // 乐观锁优先于状态判断：两批同时圈到同一条/同一台泵，后提交的批一律先被挡住，
    // 提示查看最新一版——哪怕第一批已把它推进到检修中，也不能用“不在待排期”掩盖过期事实。
    if (versionOf(row) !== item.version) {
      items.push(
        reject(
          item,
          code,
          pumpCode,
          'stale-version',
          `检修编号 ${code} 已被先提交的批次改动（泵组 ${pumpCode}），请刷新查看最新一版后再提交`,
        ),
      )
      continue
    }
    // 完工的检修编号必须跳过，成批排期不能动它。
    if (status === STATUS_DONE) {
      items.push(
        reject(item, code, pumpCode, 'completed', `检修编号 ${code} 已完工，按规定跳过，不允许改动`),
      )
      continue
    }
    // 只有待开工的记录能进排期；检修中的也不能重复排期。
    if (status !== STATUS_PENDING) {
      items.push(
        reject(
          item,
          code,
          pumpCode,
          'not-pending',
          `检修编号 ${code} 当前状态为「${status}」，不在待排期范围，已跳过`,
        ),
      )
      continue
    }
    if (!category) {
      items.push(
        reject(item, code, pumpCode, 'invalid-period', `检修编号 ${code} 未设置检修类别，无法排期`),
      )
      continue
    }
    const target = parsePeriod(period)
    if (!target) {
      items.push(
        reject(
          item,
          code,
          pumpCode,
          'invalid-period',
          `检修编号 ${code} 的计划工期「${period}」不是有效日期或日期区间，无法排期`,
        ),
      )
      continue
    }

    // 计划工期与已有安排冲突：同一台泵，待开工/检修中的记录工期重叠即挡下。
    // 本批里已经排上的也占用工期，防止一批内部给同一台泵排两段重叠工期。
    const occupied = next.find(
      (other) =>
        Number(other.id) !== Number(row.id) &&
        fieldOf(other, PUMP_FIELD) === pumpCode &&
        [STATUS_PENDING, STATUS_RUNNING].includes(String(other.status)) &&
        (() => {
          const otherRange = parsePeriod(fieldOf(other, PERIOD_FIELD))
          return otherRange ? overlaps(target, otherRange) : false
        })(),
    )
    if (occupied) {
      items.push(
        reject(
          item,
          code,
          pumpCode,
          'schedule-conflict',
          `检修编号 ${code} 的计划工期 ${period} 与泵组 ${pumpCode} 已有安排（${describe(
            occupied,
          )}，工期 ${fieldOf(occupied, PERIOD_FIELD) || '未填写'}）冲突，已挡下`,
        ),
      )
      continue
    }

    next[index] = {
      ...row,
      [CATEGORY_FIELD]: category,
      [PERIOD_FIELD]: period,
      status: STATUS_RUNNING,
      pending: true,
      version: versionOf(row) + 1,
    }
    items.push({
      id: Number(row.id),
      code,
      pumpCode,
      ok: true,
      reason: null,
      message: `检修编号 ${code}（泵组 ${pumpCode}）排期成功：${category}，计划工期 ${period}，当前状态「${STATUS_RUNNING}」`,
    })
  }

  const succeeded = items.filter((item) => item.ok)
  if (succeeded.length > 0) {
    // 一次性持久化成功条目；被挡下的在 next 里保持原样，等于留在列表里，不会被回滚也不会丢失。
    saveRows(KEY, next)
  }

  return {
    duplicated,
    items,
    succeeded,
    rejected: items.filter((item) => !item.ok),
  }
}

/**
 * 单条状态流转，同样强制顺序：待开工 → 检修中 → 已完工。
 * 跳级、回退一律挡下；完工时回写完成日期。
 */
export function advanceMaintenance(id: number, action: string): { ok: boolean; message: string } {
  const rows = listRows(KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的检修记录` }
  }
  const row = rows[index]
  const code = describe(row)
  const status = String(row.status)

  if (action === '提交开工') {
    if (status === STATUS_DONE) {
      return { ok: false, message: `检修编号 ${code} 已完工，不能回退到检修中` }
    }
    if (status === STATUS_RUNNING) {
      return { ok: false, message: `检修编号 ${code} 已在检修中，不用重复开工` }
    }
    if (status !== STATUS_PENDING) {
      return { ok: false, message: `检修编号 ${code} 当前为「${status}」，不能跳过待开工直接开工` }
    }
  } else if (action === '确认完工') {
    if (status === STATUS_DONE) {
      return { ok: false, message: `检修编号 ${code} 已完工，不能重复确认完工` }
    }
    if (status === STATUS_PENDING) {
      return { ok: false, message: `检修编号 ${code} 还在待开工，不能跳过检修中直接完工` }
    }
    if (status !== STATUS_RUNNING) {
      return { ok: false, message: `检修编号 ${code} 当前为「${status}」，不允许回退或跳级` }
    }
  } else {
    return { ok: false, message: `泵组检修记录没有登记「${action}」这个动作` }
  }

  const updated: EntryRow = {
    ...row,
    status: action === '确认完工' ? STATUS_DONE : STATUS_RUNNING,
    pending: action !== '确认完工',
    version: versionOf(row) + 1,
    ...(action === '确认完工' ? { [FINISH_FIELD]: today() } : {}),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(KEY, next)
  return {
    ok: true,
    message: `检修编号 ${code} 已${action}，当前状态「${updated.status}」`,
  }
}
