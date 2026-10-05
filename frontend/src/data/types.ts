/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

/** 成批排期里单条记录的处置结果。 */
export type ScheduleRejectReason =
  | 'not-found'
  | 'completed'
  | 'not-pending'
  | 'stale-version'
  | 'schedule-conflict'
  | 'invalid-period'

export type ScheduleItemResult = {
  id: number
  code: string
  pumpCode: string
  ok: boolean
  reason: ScheduleRejectReason | null
  message: string
}

export type ScheduleRequestItem = {
  id: number
  /** 圈选时记录的版本号；落库版本不一致说明被别的批次先改过。 */
  version: number
}

export type BatchScheduleRequest = {
  category: string
  period: string
  items: ScheduleRequestItem[]
}

export type BatchScheduleResult = {
  /** 重复圈选的记录数：同一编号只按一条处理。 */
  duplicated: number
  items: ScheduleItemResult[]
  succeeded: ScheduleItemResult[]
  rejected: ScheduleItemResult[]
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
