<template>
  <section class="page" data-module="pumpmaint">
    <header class="page-head">
      <div>
        <h2>泵组检修管理</h2>
        <p class="page-desc">维护泵组检修记录，围绕检修编号、泵组编号、检修类别、检修班组做登记、筛选与状态流转。可在列表中圈选多条待开工记录一次成批排期。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出泵组检修清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <!-- 成批排期：圈选多条待开工记录，一次设定检修类别与计划工期 -->
    <section class="batch-panel">
      <h3 class="batch-title">成批排期</h3>
      <p class="batch-tip">
        已圈选 <strong>{{ selectedIds.length }}</strong> 条待开工检修记录；提交后逐条返回结果，冲突或已完工的记录会留在列表中并说明原因，已排期成功的不会回滚。
      </p>
      <div class="batch-form">
        <label class="batch-field">
          <span>检修类别</span>
          <select v-model="batch.category">
            <option value="">请选择检修类别</option>
            <option v-for="item in categoryOptions" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
        <label class="batch-field">
          <span>计划开工</span>
          <input v-model="batch.planStart" type="date" />
        </label>
        <label class="batch-field">
          <span>计划完工</span>
          <input v-model="batch.planEnd" type="date" />
        </label>
        <button class="btn primary" type="button" :disabled="!selectedIds.length" @click="submitBatch">
          成批排期（{{ selectedIds.length }} 条）
        </button>
        <button class="btn ghost" type="button" :disabled="!selectedIds.length" @click="clearSelection">
          清空圈选
        </button>
      </div>
      <p v-if="batchError" class="error-text">{{ batchError }}</p>

      <div v-if="batchResult" class="receipt">
        <p class="receipt-head" :class="batchResult.ok ? 'ok' : 'warn'">
          本次提交 {{ batchResult.accepted + batchResult.blocked + batchResult.skipped }} 条：
          成功 {{ batchResult.accepted }} 条，挡下 {{ batchResult.blocked }} 条，跳过 {{ batchResult.skipped }} 条
        </p>
        <ul class="receipt-list">
          <li v-for="line in batchResult.lines" :key="line.id" class="receipt-line" :class="lineClass(line.reason)">
            <span class="receipt-tag">{{ reasonLabel(line.reason) }}</span>
            <span>{{ line.message }}</span>
          </li>
        </ul>
      </div>
    </section>

    <table class="data-table">
      <thead>
        <tr>
          <th class="col-check">
            <input
              type="checkbox"
              :checked="allWaitingChecked"
              :disabled="!waitingRows.length"
              @change="toggleAllWaiting"
            />
            圈选
          </th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-selected': isSelected(Number(row.id)) }">
          <td class="col-check">
            <input
              type="checkbox"
              :checked="isSelected(Number(row.id))"
              :disabled="String(row.status) !== WAITING_STATUS"
              :title="String(row.status) === WAITING_STATUS ? '圈选参与成批排期' : '只有待开工记录能参与成批排期'"
              @change="toggleRow(Number(row.id))"
            />
          </td>
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>
            {{ row.status }}
            <span v-if="isSelected(Number(row.id))" class="picked-flag">已圈选</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!actionsFor(row).length" class="muted-text">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无泵组检修数据，可先登记泵组检修记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条泵组检修记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  batchSchedulePumpMaint,
  downloadEntries,
  listEntries,
  maintenanceMetrics,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { BatchScheduleLine, EntryRow } from '@/data/types'

const meta = moduleMeta('pumpmaint')
const columns = ['检修编号', '泵组编号', '检修类别', '检修班组', '计划工期', '完成日期', '更换部件', '检修状态']
const statuses = ['待开工', '检修中', '已完工', '已延期']
const WAITING_STATUS = '待开工'
const REPAIRING_STATUS = '检修中'
const FINISHED_STATUS = '已完工'
const DELAYED_STATUS = '已延期'
const categoryOptions = ['常规检修', '专项检修', '大修', '故障抢修']

// 状态只能顺着走：待开工 → 检修中 → 已完工；待开工可申请延期。
const NEXT_ACTIONS: Record<string, string[]> = {
  [WAITING_STATUS]: ['提交开工', '申请延期'],
  [REPAIRING_STATUS]: ['确认完工'],
  [FINISHED_STATUS]: [],
  [DELAYED_STATUS]: [],
}

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

// 圈选快照：id -> 圈选那一刻的版本号，成批提交时做乐观锁比对。
const picked = ref<Map<number, number>>(new Map())
const batch = ref({ category: '', planStart: '', planEnd: '' })
const batchError = ref('')
const batchResult = ref<ReturnType<typeof batchSchedulePumpMaint> | null>(null)
const metrics = ref(maintenanceMetrics())

const statCards = computed(() => [
  { label: '待开工检修', value: metrics.value.waiting },
  { label: '检修中泵组', value: metrics.value.repairing },
  { label: '本月完工数', value: metrics.value.finishedThisMonth },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const waitingRows = computed(() => rows.value.filter((row) => String(row.status) === WAITING_STATUS))
const selectedIds = computed(() => [...picked.value.keys()])
const allWaitingChecked = computed(
  () => waitingRows.value.length > 0 && waitingRows.value.every((row) => picked.value.has(Number(row.id))),
)

function versionOf(row: EntryRow): number {
  return typeof row.version === 'number' ? row.version : 0
}

function isSelected(id: number): boolean {
  return picked.value.has(id)
}

function toggleRow(id: number): void {
  const next = new Map(picked.value)
  if (next.has(id)) {
    next.delete(id)
  } else {
    const row = rows.value.find((item) => Number(item.id) === id)
    if (row && String(row.status) === WAITING_STATUS) {
      next.set(id, versionOf(row))
    }
  }
  picked.value = next
  batchResult.value = null
}

function toggleAllWaiting(): void {
  const next = new Map(picked.value)
  if (allWaitingChecked.value) {
    for (const row of waitingRows.value) {
      next.delete(Number(row.id))
    }
  } else {
    for (const row of waitingRows.value) {
      next.set(Number(row.id), versionOf(row))
    }
  }
  picked.value = next
  batchResult.value = null
}

function clearSelection(): void {
  picked.value = new Map()
}

function actionsFor(row: EntryRow): string[] {
  return NEXT_ACTIONS[String(row.status)] ?? []
}

function reasonLabel(reason: BatchScheduleLine['reason']): string {
  switch (reason) {
    case 'success':
      return '成功'
    case 'already-finished':
      return '跳过'
    case 'stale':
      return '版本过期'
    case 'conflict':
      return '冲突挡下'
    case 'wrong-status':
      return '状态不符'
    case 'not-found':
      return '记录缺失'
  }
}

function lineClass(reason: BatchScheduleLine['reason']): string {
  if (reason === 'success') {
    return 'line-ok'
  }
  if (reason === 'already-finished') {
    return 'line-skip'
  }
  return 'line-block'
}

function submitBatch(): void {
  batchError.value = ''
  batchResult.value = null
  if (!picked.value.size) {
    batchError.value = '请先在列表中圈选至少一条待开工检修记录'
    return
  }
  const category = batch.value.category.trim()
  if (!category) {
    batchError.value = '请选择检修类别'
    return
  }
  if (!batch.value.planStart || !batch.value.planEnd) {
    batchError.value = '请填写计划开工与计划完工日期'
    return
  }
  if (batch.value.planStart > batch.value.planEnd) {
    batchError.value = '计划开工日期不能晚于计划完工日期'
    return
  }

  const result = batchSchedulePumpMaint({
    items: [...picked.value.entries()].map(([id, version]) => ({ id, version })),
    category,
    planStart: batch.value.planStart,
    planEnd: batch.value.planEnd,
  })
  batchResult.value = result
  reload()

  // 被挡/跳过的记录留在列表里，保留圈选并刷新为最新版本，方便调整后再提交；
  // 成功的已经进入检修中，自动从圈选中移除。
  const remain = new Map<number, number>()
  for (const line of result.lines) {
    if (!line.ok) {
      const row = rows.value.find((item) => Number(item.id) === line.id)
      if (row && String(row.status) === WAITING_STATUS) {
        remain.set(line.id, versionOf(row))
      }
    }
  }
  picked.value = remain
}

function resetFilters(): void {
  filters.value = {}
  reload()
}

function exportRows(): void {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow): void {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  picked.value = new Map([...picked.value].filter(([id]) => id !== Number(row.id)))
  reload()
}

function reload(): void {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    metrics.value = maintenanceMetrics()
    // 清理已经不在列表或状态已变化的圈选，并同步最新版本。
    const next = new Map<number, number>()
    for (const row of rows.value) {
      const id = Number(row.id)
      if (picked.value.has(id) && String(row.status) === WAITING_STATUS) {
        next.set(id, versionOf(row))
      }
    }
    picked.value = next
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '泵组检修列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.batch-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.batch-title {
  margin: 0 0 4px;
  font-size: 14px;
}
.batch-tip {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--muted);
}
.batch-form {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-end;
}
.batch-field span {
  display: block;
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 2px;
}
.batch-field select,
.batch-field input {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 13px;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.col-check {
  width: 56px;
  text-align: center;
  white-space: nowrap;
}
.row-selected {
  background: #eef5ff;
}
.picked-flag {
  margin-left: 6px;
  font-size: 11px;
  color: var(--brand);
  background: #dbeafe;
  border-radius: 999px;
  padding: 0 8px;
}
.muted-text {
  color: var(--muted);
}
.receipt {
  margin-top: 10px;
  border-top: 1px dashed var(--border);
  padding-top: 8px;
}
.receipt-head {
  margin: 0 0 6px;
  font-size: 13px;
}
.receipt-head.ok {
  color: #067647;
}
.receipt-head.warn {
  color: #b54708;
}
.receipt-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.receipt-line {
  font-size: 12px;
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.receipt-tag {
  flex: none;
  border-radius: 4px;
  padding: 0 6px;
  color: #fff;
  font-size: 11px;
  line-height: 18px;
}
.line-ok .receipt-tag {
  background: #12b76a;
}
.line-block .receipt-tag {
  background: #f04438;
}
.line-skip .receipt-tag {
  background: #f79009;
}
</style>
