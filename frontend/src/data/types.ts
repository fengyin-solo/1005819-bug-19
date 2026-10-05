/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  // 乐观锁版本：每次写入 +1。成批排期带着圈选时的版本提交，版本对不上就挡住。
  version?: number
  [field: string]: string | number | boolean | undefined
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
  // 只允许「源状态 → 目标状态」的动作：登记了就强制校验顺序，防止跳级/回退。
  actionFrom?: Record<string, string[]>
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

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 成批排期里圈选的一条：id + 圈选那一刻读到的版本。 */
export type BatchScheduleItem = {
  id: number
  version?: number
}

/** 成批排期请求：一次设定检修类别与计划工期。 */
export type BatchScheduleRequest = {
  items: BatchScheduleItem[]
  category: string
  // 计划工期区间 [起, 止]，都为 YYYY-MM-DD；只给单日时起止相同。
  planStart: string
  planEnd: string
}

/** 单条排期结果。blocked 只挡这一条，已成功的条目不回滚。 */
export type BatchScheduleLine = {
  id: number
  code: string
  pumpCode: string
  ok: boolean
  reason: 'success' | 'not-found' | 'already-finished' | 'wrong-status' | 'stale' | 'conflict'
  message: string
  version: number
}

/** 成批排期回执：逐条交代，哪些成功、哪些被挡、哪些跳过。 */
export type BatchScheduleResult = {
  ok: boolean
  accepted: number
  blocked: number
  skipped: number
  lines: BatchScheduleLine[]
}

/** 检修台账与泵组运行看板共用的检修统计，两个页面必须读到同一份数。 */
export type MaintenanceMetrics = {
  waiting: number
  repairing: number
  finished: number
  delayed: number
  finishedThisMonth: number
}
