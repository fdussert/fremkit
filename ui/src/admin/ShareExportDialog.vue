<script setup lang="ts">
/**
 * "Export page… / screen… / the whole setup…": what the file will hold, what it leaves out, and
 * the two ways to take it — a download (the browser's, or the helper window's save panel), or
 * the clipboard when a download is not possible.
 *
 * Every number and list here is the server's report on the very file it would write
 * (`server/src/share/export.ts`), never a guess made in the page. Free-text settings are the one
 * choice offered: unticked by default, and ticking one asks the server for the file again.
 */
import { computed, onMounted, ref } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseCheckbox from '../shared/ui/BaseCheckbox.vue'
import BaseChip from '../shared/ui/BaseChip.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import { api } from '../shared/api'
import { pick, useI18n } from '../shared/i18n'
import type { ExportPreview } from '../shared/types'
import { useAdminStore } from './store'
import { formatBytes, share } from './share'
import { useThemes } from '../shared/theme'

const s = useAdminStore()
const { t } = useI18n()
const { themes } = useThemes()
/** A theme by the name it is shown under, its id when this Mac does not know it. */
const themeName = (id: string): string => pick(themes.value[id]?.name) || id

const preview = ref<ExportPreview | null>(null)
const error = ref('')
const loading = ref(false)
const include = ref<string[]>([])
const copied = ref(false)
const request = computed(() => share.exporting ? { ...share.exporting, include: include.value } : null)

async function load(): Promise<void> {
  if (!request.value) return
  loading.value = true
  error.value = ''
  try { preview.value = await api.previewLayout(request.value) }
  catch (e) { error.value = (e as Error).message }
  finally { loading.value = false }
}

function toggle(id: string, on: boolean): void {
  include.value = on ? [...include.value, id] : include.value.filter((x) => x !== id)
  copied.value = false
  void load()
}

// The file is built from the config as saved: pending edits go first.
onMounted(async () => { await s.flush(); await load() })

const report = computed(() => preview.value?.report ?? null)
const title = computed(() => {
  const r = report.value
  if (!share.exporting) return ''
  if (share.exporting.scope === 'setup') return t('admin.share.export.titleSetup')
  return t(share.exporting.scope === 'page' ? 'admin.share.export.titlePage' : 'admin.share.export.titleScreen', { name: r?.name ?? '' })
})
const imagesBytes = computed(() => report.value?.images.embedded.reduce((n, i) => n + i.bytes, 0) ?? 0)
/** The file as it will be written, minus the image bytes, for whoever wants to read it. */
const fileText = computed(() => preview.value ? JSON.stringify(preview.value.file, null, 2) : '')

function download(): void {
  if (!request.value) return
  api.downloadLayout(request.value)
}

/**
 * Through a `ClipboardItem` built on the pending fetch where there is one: WebKit only lets a
 * page write to the clipboard from inside the click, and the fetch would otherwise end it.
 */
async function copy(): Promise<void> {
  if (!request.value) return
  const text = api.layoutText(request.value)
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then((v) => new Blob([v], { type: 'text/plain' })) })])
    } else {
      await navigator.clipboard.writeText(await text)
    }
    copied.value = true
  } catch {
    error.value = t('admin.share.export.copyFailed')
  }
}

const reasonLabel = (reason: string): string => t(`admin.share.export.reason.${reason}`)
</script>

<template>
  <div class="export">
    <p class="lead">{{ title }}</p>
    <p v-if="error" class="bad" role="alert">{{ error }}</p>
    <p v-if="!report && loading" class="ro">{{ t('common.loading') }}</p>

    <template v-if="report">
      <section>
        <h3>{{ t('admin.share.export.holds') }}</h3>
        <p class="ro">{{ t('admin.share.export.counts', { screens: report.screens, pages: report.pages, tiles: report.tiles }) }}</p>
        <ul class="widgets">
          <li v-for="w in report.widgets" :key="w.widgetId">
            <span class="name">{{ pick(w.name) }}</span>
            <span class="v">v{{ w.version }}<template v-if="w.count > 1"> · ×{{ w.count }}</template></span>
            <BaseChip :tone="w.source === 'local' ? 'danger' : 'neutral'">{{ t(`admin.share.source.${w.source}`) }}</BaseChip>
          </li>
        </ul>
        <p v-if="report.widgets.some((w) => w.source === 'local')" class="ro warn">{{ t('admin.share.export.localWidget') }}</p>
        <p v-if="report.theme" class="ro">
          {{ report.theme.night
            ? t('admin.share.export.themes', { day: themeName(report.theme.day), night: themeName(report.theme.night) })
            : t('admin.share.export.theme', { day: themeName(report.theme.day) }) }}
        </p>
        <p v-if="report.images.embedded.length" class="ro">
          {{ t('admin.share.export.images', { n: report.images.embedded.length, size: formatBytes(imagesBytes) }) }}
        </p>
        <p v-for="(img, i) in report.images.leftOut" :key="i" class="ro warn">
          {{ t(`admin.share.export.image.${img.reason}`, { size: img.bytes ? formatBytes(img.bytes) : '' }) }}
        </p>
      </section>

      <section v-if="report.optional.length">
        <h3>{{ t('admin.share.export.optional') }}</h3>
        <p class="ro">{{ t('admin.share.export.optionalHint') }}</p>
        <div v-for="o in report.optional" :key="o.id" class="opt">
          <BaseCheckbox :model-value="include.includes(o.id)" :label="`${o.widget} — ${pick(o.label)}`"
            @update:model-value="toggle(o.id, $event)" />
          <code>{{ o.preview }}</code>
        </div>
      </section>

      <section>
        <h3>{{ t('admin.share.export.leftOut') }}</h3>
        <p class="ro">{{ t('admin.share.export.never') }}</p>
        <ul v-if="report.removed.length" class="removed">
          <li v-for="r in report.removed" :key="r.instanceId + r.key">
            {{ r.widget }} — {{ pick(r.label) }} <span class="why">{{ reasonLabel(r.reason) }}</span>
          </li>
        </ul>
        <p v-for="(r, i) in report.renamed" :key="'r' + i" class="ro">
          {{ r.to ? t(`admin.share.export.renamed.${r.kind}`, { to: r.to }) : t('admin.share.export.renamed.title') }}
        </p>
      </section>

      <details>
        <summary>{{ t('admin.share.export.see') }}</summary>
        <pre>{{ fileText }}</pre>
      </details>
    </template>

    <div class="actions">
      <span v-if="copied" class="ok"><BaseIcon name="check" :size="14" />{{ t('admin.share.export.copied') }}</span>
      <span class="spacer" />
      <BaseButton :disabled="!report || loading" @click="copy()">
        <BaseIcon name="copy" :size="16" />{{ t('admin.share.export.copy') }}
      </BaseButton>
      <BaseButton variant="primary" :disabled="!report || loading" @click="download()">
        <BaseIcon name="download" :size="16" />{{ t('admin.share.export.download') }}
      </BaseButton>
    </div>
    <p v-if="preview" class="ro file">{{ preview.filename }}</p>
  </div>
</template>

<style scoped>
.export { display: flex; flex-direction: column; gap: var(--space-3); }
.lead { margin: 0; font-weight: 600; }
section { border-top: 1px solid var(--border); padding-top: var(--space-2); }
h3 { margin: 0 0 var(--space-1); font-size: var(--fs-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: .06em; }
.ro { margin: 0 0 var(--space-1); font-size: var(--fs-sm); color: var(--text-muted); }
.warn { color: var(--danger); }
.bad { margin: 0; color: var(--danger); font-size: var(--fs-sm); }
.ok { display: inline-flex; align-items: center; gap: var(--space-1); color: var(--text-muted); font-size: var(--fs-sm); }
ul { list-style: none; margin: 0; padding: 0; }
.widgets li { display: flex; align-items: center; gap: var(--space-2); padding: 3px 0; font-size: var(--fs-sm); }
.widgets .name { flex: 1; }
.v { color: var(--text-dim); font-size: var(--fs-xs); }
.removed li { font-size: var(--fs-sm); padding: 2px 0; }
.why { color: var(--text-dim); font-size: var(--fs-xs); }
.opt { display: flex; flex-direction: column; gap: 2px; margin-bottom: var(--space-2); }
.opt :deep(.cb) { margin-bottom: 0; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--fs-xs); }
.opt code { margin-left: 24px; color: var(--text-dim); word-break: break-all; }
details summary { cursor: pointer; font-size: var(--fs-sm); color: var(--text-muted); }
pre { max-height: 240px; overflow: auto; background: var(--surface-2); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: var(--space-2); margin: var(--space-2) 0 0; }
.actions { display: flex; align-items: center; gap: var(--space-2); }
.spacer { flex: 1; }
.file { font-size: var(--fs-xs); text-align: right; }
</style>
