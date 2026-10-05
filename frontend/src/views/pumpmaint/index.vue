<template>
  <section class="page" data-module="pumpmaint">
    <header class="page-head">
      <div>
        <h2>泵组检修管理</h2>
        <p class="page-desc">维护泵组检修记录，围绕检修编号、泵组编号、检修类别、检修班组做登记、筛选与状态流转。状态只能从待开工顺着走到完工。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" :disabled="selectedIds.length === 0" @click="openSchedule">
          成批排期<span v-if="selectedIds.length">（已圈 {{ selectedIds.length }} 条）</span>
        </button>
        <button class="btn" type="button" @click="exportRows">导出泵组检修清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
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

    <table class="data-table">
      <thead>
        <tr>
          <th class="col-check">
            <input
              type="checkbox"
              :checked="allVisiblePendingSelected"
              :disabled="visiblePendingIds.length === 0"
              title="只可圈选待开工记录；已完工、检修中不参与成批排期"
              @change="toggleSelectAll"
            />
          </th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td class="col-check">
            <input
              v-if="String(row.status) === '待开工'"
              type="checkbox"
              :checked="isSelected(row)"
              @change="toggleSelect(row)"
            />
            <span v-else class="check-disabled" title="只有待开工记录可以圈选排期">—</span>
          </td>
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>
            {{ row.status }}
            <span v-if="String(row.status) === '已完工'" class="tag tag-done">不可再改</span>
          </td>
          <td class="row-actions">
            <button
              v-if="String(row.status) === '待开工'"
              class="link"
              type="button"
              @click="runAction('提交开工', row)"
            >
              提交开工
            </button>
            <button
              v-if="String(row.status) === '检修中'"
              class="link"
              type="button"
              @click="runAction('确认完工', row)"
            >
              确认完工
            </button>
            <span v-if="String(row.status) === '已完工'" class="muted-text">流程已结束</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无泵组检修数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条泵组检修记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="scheduleOpen" class="modal-mask" @click.self="closeSchedule">
      <div class="modal" role="dialog" aria-modal="true" aria-label="成批排期">
        <h3 class="modal-title">成批排期</h3>
        <p class="modal-desc">
          将对已圈选的 {{ selectedIds.length }} 条待开工记录统一设定检修类别与计划工期。
          提交后逐条回执：成功的立即生效，工期冲突或版本过期的记录会被挡下并留在列表；已完工记录不参与。
        </p>
        <div class="modal-body">
          <label class="modal-field">
            <span>检修类别</span>
            <select v-model="form.category">
              <option value="">请选择检修类别</option>
              <option v-for="item in categoryOptions" :key="item" :value="item">{{ item }}</option>
            </select>
          </label>
          <label class="modal-field">
            <span>计划开工日</span>
            <input v-model="form.start" type="date" />
          </label>
          <label class="modal-field">
            <span>计划完工日</span>
            <input v-model="form.end" type="date" />
          </label>
          <p v-if="formError" class="error-text">{{ formError }}</p>
        </div>

        <div v-if="batchResult" class="result-panel">
          <p class="result-summary">
            本批共 {{ batchResult.items.length + batchResult.duplicated }} 条圈选，
            成功 <strong class="ok-text">{{ batchResult.succeeded.length }}</strong> 条，
            挡下 <strong class="error-text">{{ batchResult.rejected.length }}</strong> 条
            <template v-if="batchResult.duplicated">，重复圈选 {{ batchResult.duplicated }} 条已按一次计算</template>。
            被挡下的记录仍留在列表里，可核对后重新提交；成功的记录不会回滚。
          </p>
          <ul class="result-list">
            <li
              v-for="item in batchResult.items"
              :key="item.id"
              :class="item.ok ? 'result-ok' : 'result-fail'"
            >
              <span class="result-flag">{{ item.ok ? '成功' : '挡下' }}</span>
              {{ item.message }}
            </li>
          </ul>
        </div>

        <div class="modal-actions">
          <button class="btn primary" type="button" :disabled="submitting" @click="submitSchedule">
            {{ submitting ? '提交中…' : '提交排期' }}
          </button>
          <button class="btn ghost" type="button" @click="closeSchedule">
            {{ batchResult && batchResult.succeeded.length ? '关闭并刷新' : '取消' }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import {
  advanceMaintenance,
  batchSchedule,
  countCompletedThisMonth,
  countPendingMaintenance,
  countPumpsInMaintenance,
} from '@/api/pumpmaint-service'
import type { BatchScheduleResult, EntryRow } from '@/data/types'

const meta = moduleMeta('pumpmaint')
const columns = ["检修编号", "泵组编号", "检修类别", "检修班组", "计划工期", "完成日期", "更换部件"]
const statuses = ["待开工", "检修中", "已完工"]
const categoryOptions = ["例行保养", "故障抢修", "大修", "专项检修"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["检修编号", "泵组编号", "检修类别"]

// 圈选快照：id -> 圈选那一刻的版本号，用于后提交批次的乐观锁校验。重复圈选同一 id 天然只算一条。
const selection = reactive(new Map<number, number>())

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 统计卡与泵组运行看板走同一份口径（countPumpsInMaintenance），两页读数必然一致。
const stats = computed(() => [
  { label: '待开工检修', value: countPendingMaintenance() },
  { label: '检修中泵组', value: countPumpsInMaintenance() },
  { label: '本月完工数', value: countCompletedThisMonth() },
])

const selectedIds = computed(() => [...selection.keys()])
const visiblePendingIds = computed(() =>
  rows.value.filter((row) => String(row.status) === '待开工').map((row) => Number(row.id)),
)
const allVisiblePendingSelected = computed(
  () =>
    visiblePendingIds.value.length > 0 &&
    visiblePendingIds.value.every((id) => selection.has(id)),
)

function isSelected(row: EntryRow): boolean {
  return selection.has(Number(row.id))
}

function toggleSelect(row: EntryRow) {
  const id = Number(row.id)
  if (selection.has(id)) {
    selection.delete(id)
  } else {
    selection.set(id, Number(row.version ?? 1))
  }
}

function toggleSelectAll(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  for (const id of visiblePendingIds.value) {
    if (checked) {
      const row = rows.value.find((item) => Number(item.id) === id)
      selection.set(id, Number(row?.version ?? 1))
    } else {
      selection.delete(id)
    }
  }
}

const scheduleOpen = ref(false)
const submitting = ref(false)
const formError = ref('')
const batchResult = ref<BatchScheduleResult | null>(null)
const form = reactive({ category: '', start: '', end: '' })

function openSchedule() {
  batchResult.value = null
  formError.value = ''
  form.category = ''
  form.start = ''
  form.end = ''
  scheduleOpen.value = true
}

function closeSchedule() {
  scheduleOpen.value = false
  if (batchResult.value && batchResult.value.succeeded.length > 0) {
    reload()
  }
}

function periodText(): string {
  if (!form.start) {
    return ''
  }
  return form.end && form.end !== form.start ? `${form.start}~${form.end}` : form.start
}

function submitSchedule() {
  formError.value = ''
  if (selectedIds.value.length === 0) {
    formError.value = '请先在列表里圈选待开工记录'
    return
  }
  if (!form.category) {
    formError.value = '请选择检修类别'
    return
  }
  if (!form.start) {
    formError.value = '请填写计划开工日'
    return
  }
  if (form.end && form.end < form.start) {
    formError.value = '计划完工日不能早于计划开工日'
    return
  }

  submitting.value = true
  try {
    const result = batchSchedule({
      category: form.category,
      period: periodText(),
      // 服务层也会按 id 去重，这里直接给出当前快照；同一编号重复圈选只按一条提交。
      items: selectedIds.value.map((id) => ({ id, version: selection.get(id) ?? 1 })),
    })
    batchResult.value = result

    for (const item of result.succeeded) {
      selection.delete(item.id)
    }
    // 被挡下的：版本过期的本地快照已失效，清出圈选，要求看最新一版；
    // 工期冲突等记录保留圈选，方便用户改完工期直接再提，且它们仍留在列表里。
    for (const item of result.rejected) {
      if (item.reason === 'stale-version' || item.reason === 'not-found') {
        selection.delete(item.id)
      }
    }
    reload()
  } finally {
    submitting.value = false
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = advanceMaintenance(Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  // 状态一变动，之前圈选的快照即失效：开工成功就从待排期圈选里移除。
  selection.delete(Number(row.id))
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    // 列表刷新后清掉已经不在待开工状态的圈选（例如别的页签改动、筛选隐藏），并校正快照基准。
    for (const id of [...selection.keys()]) {
      const row = rows.value.find((item) => Number(item.id) === id)
      if (!row || String(row.status) !== '待开工') {
        selection.delete(id)
      }
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '泵组检修列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.col-check {
  width: 40px;
  text-align: center;
}
.check-disabled {
  color: var(--muted);
}
.muted-text {
  color: var(--muted);
  font-size: 12px;
}
.tag {
  display: inline-block;
  margin-left: 6px;
  font-size: 11px;
  border-radius: 999px;
  padding: 0 8px;
}
.tag-done {
  background: #e2e8f0;
  color: #475569;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal {
  width: 640px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  overflow: auto;
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
}
.modal-title {
  margin: 0 0 6px;
  font-size: 16px;
}
.modal-desc {
  margin: 0 0 14px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.6;
}
.modal-body {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.modal-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
.modal-field select,
.modal-field input {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 13px;
  color: #1f2937;
}
.result-panel {
  margin-top: 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  background: #f8fafc;
}
.result-summary {
  margin: 0 0 8px;
  font-size: 13px;
}
.result-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 220px;
  overflow: auto;
}
.result-list li {
  font-size: 12px;
  line-height: 1.5;
  padding: 4px 8px;
  border-radius: 6px;
}
.result-ok {
  background: #ecfdf3;
  color: #027a48;
}
.result-fail {
  background: #fef3f2;
  color: #b42318;
}
.result-flag {
  display: inline-block;
  min-width: 32px;
  font-weight: 600;
  margin-right: 6px;
}
.ok-text {
  color: #027a48;
}
.modal-actions {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
