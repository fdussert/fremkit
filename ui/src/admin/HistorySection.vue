<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import { api, type HistoryEntry, type HistoryRestoreResult } from '../shared/api'
import { pick, useI18n } from '../shared/i18n'
import { useConfirm } from '../shared/useConfirm'
import { useThemes } from '../shared/theme'
import type { Config } from '../shared/types'
import { groupByDay, revealHistory, stampOf, summaryPhrases, timeOf } from './history'
import { useAdminStore } from './store'

/**
 * Screen → History: every saved version of the dashboard, by day, with what changed, a look at
 * its pages and a way back. The server keeps them (`server/src/config/history.ts`); restoring one
 * is a save of its own, so the version it replaces is the next line down and undoes it.
 */
const s = useAdminStore()
const { t, locale } = useI18n()
const { themes } = useThemes()
const confirm = useConfirm()

const root = ref<HTMLElement>()
const entries = ref<HistoryEntry[]>([])
const loaded = ref(false)
const error = ref('')
const openId = ref<string | null>(null)
const preview = ref<Config | null>(null)
const previewError = ref('')
const restoring = ref(false)
const restored = ref<{ result: HistoryRestoreResult; savedAt: number } | null>(null)

const names = {
  widget: (id: string) => pick(s.state.manifests[id]?.name) || id,
  theme: (id: string) => pick(themes.value[id]?.name) || id,
}
const groups = computed(() => groupByDay(entries.value, t, locale.value))
const newestId = computed(() => entries.value[0]?.id ?? null)

async function refresh(): Promise<void> {
  try {
    const answer = await api.getHistory()
    // A server without the history (an older one behind `pnpm dev`) answers something else.
    entries.value = Array.isArray(answer?.entries) ? answer.entries : []
    error.value = ''
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    loaded.value = true
  }
}

/** A save landed: the top line changed, or a new one appeared. Read again shortly after. */
let timer: ReturnType<typeof setTimeout> | undefined
watch(() => s.state.status, (status) => {
  if (status !== 'saved') return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { void refresh() }, 400)
})
onUnmounted(() => { if (timer) clearTimeout(timer) })

onMounted(async () => {
  await refresh()
  if (revealHistory.value) {
    revealHistory.value = false
    await nextTick()
    root.value?.closest('[data-section]')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }
})

async function toggle(entry: HistoryEntry): Promise<void> {
  confirm.reset()
  if (openId.value === entry.id) { openId.value = null; return }
  openId.value = entry.id
  preview.value = null
  previewError.value = ''
  try {
    const version = await api.getHistoryVersion(entry.id)
    if (openId.value === entry.id) preview.value = version.config
  } catch (err) {
    if (openId.value === entry.id) previewError.value = (err as Error).message
  }
}

function kindLabel(entry: HistoryEntry): string {
  if (entry.kind === 'save') return ''
  if (entry.kind === 'revert') {
    return entry.revertedTo ? t('admin.history.kind.revertOf', { when: stampOf(entry.revertedTo, locale.value) }) : t('admin.history.kind.revert')
  }
  return t(`admin.history.kind.${entry.kind}`)
}

function restore(entry: HistoryEntry): void {
  confirm.ask(`history:${entry.id}`, async () => {
    restoring.value = true
    restored.value = null
    error.value = ''
    try {
      // An edit still waiting for its debounce would otherwise land on top of the restore.
      await s.flush()
      const result = await api.restoreHistory(entry.id)
      restored.value = { result, savedAt: entry.savedAt }
      openId.value = null
      // The whole dashboard changed underneath the admin: reload it rather than reconcile it.
      await s.load()
      await refresh()
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      restoring.value = false
    }
  })
}

/** A tile on the miniature, in percent of its page. */
function boxStyle(item: { x: number; y: number; w: number; h: number }, cols: number, rows: number): Record<string, string> {
  return {
    left: `${(item.x / cols) * 100}%`, top: `${(item.y / rows) * 100}%`,
    width: `${(item.w / cols) * 100}%`, height: `${(item.h / rows) * 100}%`,
  }
}
function tileName(config: Config, instanceId: string): string {
  const w = config.widgets[instanceId]
  if (!w) return instanceId
  return w.title?.trim() || names.widget(w.widgetId)
}
</script>

<template>
  <div ref="root" class="history" data-test="history">
    <div class="head">
      <p class="ro">{{ t('admin.history.hint') }}</p>
      <BaseButton variant="icon" :title="t('admin.history.refresh')" @click="refresh()">
        <BaseIcon name="refresh-cw" :size="16" />
      </BaseButton>
    </div>
    <p v-if="error" class="bad">{{ error }}</p>
    <template v-if="restored">
      <p class="ok">{{ t('admin.history.restored', { when: stampOf(restored.savedAt, locale) }) }}</p>
      <p v-if="restored.result.reenterSecrets.length" class="ro">
        {{ t('admin.inspector.screen.restore.reenter') }}
        <strong>{{ restored.result.reenterSecrets.map((c) => c.name).join(', ') }}</strong>
      </p>
    </template>
    <p v-if="loaded && !entries.length && !error" class="ro">{{ t('admin.history.empty') }}</p>

    <section v-for="g in groups" :key="g.day" class="day">
      <h4>{{ g.label }}</h4>
      <ul>
        <li v-for="e in g.entries" :key="e.id" :class="{ open: openId === e.id }">
          <button type="button" class="row" :aria-expanded="openId === e.id" @click="toggle(e)">
            <span class="time">{{ timeOf(e.savedAt, locale) }}</span>
            <span class="what">
              <span v-if="kindLabel(e)" class="kind">{{ kindLabel(e) }}</span>
              <span class="phrases">{{ summaryPhrases(e.summary, t, locale, names).join(' · ') }}</span>
            </span>
            <span v-if="e.id === newestId" class="now">{{ t('admin.history.current') }}</span>
            <BaseIcon class="chevron" name="chevron-down" :size="14" />
          </button>

          <div v-if="openId === e.id" class="preview">
            <p v-if="previewError" class="bad">{{ previewError }}</p>
            <p v-else-if="!preview" class="ro">{{ t('common.loading') }}</p>
            <template v-else>
              <div v-for="screen in preview.screens" :key="screen.id" class="screen">
                <p v-if="preview.screens.length > 1" class="screen-name">{{ screen.name }}</p>
                <figure v-for="page in screen.pages" :key="page.id" class="page">
                  <div class="mini" :style="{ aspectRatio: `${screen.display.cols} / ${screen.display.rows}` }">
                    <span v-for="item in page.items" :key="item.instanceId" class="tile"
                      :style="boxStyle(item, screen.display.cols, screen.display.rows)"
                      :title="tileName(preview, item.instanceId)">{{ tileName(preview, item.instanceId) }}</span>
                  </div>
                  <figcaption>{{ page.name }}
                    <span class="count">{{ t('admin.history.widgetCount', { count: page.items.length }) }}</span>
                  </figcaption>
                </figure>
              </div>
              <p v-if="e.id === newestId" class="ro">{{ t('admin.history.isCurrent') }}</p>
              <template v-else>
                <!-- Above the button, where the eye already is when it turns red. -->
                <p v-if="confirm.armed(`history:${e.id}`)" class="ro warn">{{ t('admin.history.restore.confirm') }}</p>
                <div class="actions">
                  <BaseButton :variant="confirm.armed(`history:${e.id}`) ? 'danger' : 'secondary'" :disabled="restoring || s.state.degraded"
                    data-test="history-restore" @click="restore(e)">
                    <BaseIcon v-if="!confirm.armed(`history:${e.id}`)" name="history" :size="16" />
                    {{ confirm.armed(`history:${e.id}`) ? t('admin.history.restore.confirmButton') : t('admin.history.restore') }}
                  </BaseButton>
                </div>
              </template>
            </template>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.head { display: flex; gap: var(--space-2); align-items: flex-start; }
.head .ro { flex: 1; }
.ro { margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--text-muted); }
.ro.warn { color: var(--danger); }
.bad { margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--danger); white-space: pre-wrap; }
.ok { margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--ok); }
.day h4 { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted);
  margin: var(--space-3) 0 var(--space-1); font-weight: 600; }
.day h4::first-letter { text-transform: uppercase; }
ul { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
li + li { border-top: 1px solid var(--border); }
.row { display: flex; align-items: center; gap: var(--space-3); width: 100%; min-height: 44px; box-sizing: border-box;
  padding: var(--space-2) var(--space-3); font: inherit; font-size: var(--fs-sm); color: var(--text); text-align: left;
  background: transparent; border: 0; cursor: pointer; }
.row:hover { background: var(--surface-2); }
li.open > .row { background: var(--surface-2); }
.time { font-variant-numeric: tabular-nums; color: var(--text-muted); flex: 0 0 auto; }
.what { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.phrases { overflow-wrap: anywhere; }
.kind { font-size: var(--fs-xs); color: var(--accent); font-weight: 600; }
.now { flex: 0 0 auto; font-size: var(--fs-xs); color: var(--text-muted); border: 1px solid var(--border-strong);
  border-radius: 999px; padding: 1px 8px; }
.chevron { color: var(--text-muted); transition: transform .12s ease; transform: rotate(-90deg); }
li.open .chevron { transform: none; }
.preview { padding: var(--space-3); background: var(--surface); border-top: 1px solid var(--border); }
.screen-name { margin: 0 0 var(--space-2); font-size: var(--fs-sm); font-weight: 600; }
.page { margin: 0 0 var(--space-3); }
.mini { position: relative; width: 100%; background: var(--surface-2); border: 1px solid var(--border);
  border-radius: var(--radius-sm); overflow: hidden; }
.tile { position: absolute; box-sizing: border-box; padding: 2px 4px; overflow: hidden; white-space: nowrap;
  text-overflow: ellipsis; font-size: 10px; line-height: 1.3; color: var(--text);
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 60%, transparent); border-radius: 3px; }
figcaption { margin-top: var(--space-1); font-size: var(--fs-sm); }
.count { color: var(--text-muted); margin-left: var(--space-2); font-size: var(--fs-xs); }
.actions { display: flex; gap: var(--space-2); margin-bottom: var(--space-2); }
</style>
