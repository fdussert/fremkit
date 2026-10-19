<script setup lang="ts">
/**
 * "Import a layout…": what a shared file would add, what it needs, and where it goes.
 *
 * The server reads the file first (`server/src/share/import.ts`) — the file is somebody else's,
 * so nothing in it is taken at its word — and answers what may be applied. This dialog asks the
 * rest: widgets this Mac does not have are installed from the Sietch through the marketplace's
 * own consent dialog, one by one and never silently; the settings that point at a connection ask
 * which of the user's to use; and the layout goes beside what is there unless the user picks
 * "replace". Applying is one `apply()` — one undo step — after the images are in the library.
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseCheckbox from '../shared/ui/BaseCheckbox.vue'
import BaseChip from '../shared/ui/BaseChip.vue'
import BaseSegmented from '../shared/ui/BaseSegmented.vue'
import { api } from '../shared/api'
import { pick, useI18n } from '../shared/i18n'
import { useThemes } from '../shared/theme'
import type { ImportPreview } from '../shared/types'
import ConsentDialog from './ConsentDialog.vue'
import { useAdminStore } from './store'
import { useMarketplaceStore } from './marketplace'
import { useConnectionsStore } from './connections'
import { mergeLayout, skippedDeviceScreens, type ImportMode, type ImportOutcome } from './shareApply'
import { share } from './share'

const s = useAdminStore()
const market = useMarketplaceStore()
const connections = useConnectionsStore()
const { themes } = useThemes()
const { t } = useI18n()

const preview = ref<ImportPreview | null>(null)
const error = ref('')
const busy = ref(false)
const mode = ref<ImportMode>('add')
const useTheme = ref(false)
/** `<widget key>:<setting>` → the chosen connection id, '' for "later". */
const chosen = reactive<Record<string, string>>({})

async function read(): Promise<void> {
  if (!share.importing) return
  error.value = ''
  try {
    preview.value = await api.readLayout(share.importing.raw)
    // Every connection question starts on "choose later", which is what an untouched select means.
    for (const c of preview.value.report.connections) chosen[`${c.widget}:${c.setting}`] ??= ''
  }
  catch (e) { error.value = (e as Error).message; preview.value = null }
}

onMounted(async () => {
  await read()
  void market.load()
  if (!connections.state.loaded) await connections.load().catch(() => { /* the select is then empty */ })
})
// A widget installed from here lands in the catalogue: read the file again, it now has a place.
watch(() => Object.keys(s.state.manifests).length, () => { void read() })

const report = computed(() => preview.value?.report ?? null)
const scope = computed(() => report.value?.scope ?? 'page')

const title = computed(() => {
  const r = report.value
  if (!r) return share.importing?.fileName ?? ''
  if (r.scope === 'setup') return t('admin.share.import.titleSetup')
  return t(r.scope === 'page' ? 'admin.share.import.titlePage' : 'admin.share.import.titleScreen', { name: r.name ?? '' })
})

/** Each widget of the file, with what can be done about it here. */
const widgets = computed(() => (report.value?.widgets ?? []).map((w) => {
  const listed = market.state.widgets.find((m) => m.id === w.widgetId && !m.sdkTooNew && !m.shadowsBuiltin)
  const name = s.state.manifests[w.widgetId]?.name ?? listed?.name ?? w.widgetId
  return { ...w, name: pick(name), listed: w.status === 'missing' ? listed ?? null : null }
}))
const missing = computed(() => widgets.value.filter((w) => w.status === 'missing'))

const themeState = computed(() => {
  const id = report.value?.theme?.day
  // Nothing to ask when the file uses the theme already in force.
  if (!id || id === s.state.config?.theme) return null
  if (themes.value[id]) return { id, state: 'here' as const }
  const listed = market.state.themes.find((th) => th.id === id && !th.shadowsBuiltin)
  return listed ? { id, state: 'sietch' as const, listed } : { id, state: 'unknown' as const }
})

const target = computed(() => {
  const scr = s.screen.value
  if (scope.value === 'page') return s.page.value?.name ?? ''
  return scr?.name ?? ''
})
const modes = computed(() => [
  { value: 'add', label: t(`admin.share.import.add.${scope.value}`) },
  { value: 'replace', label: t(`admin.share.import.replace.${scope.value}`, { name: target.value }) },
])

const dropped = computed(() => {
  const d = report.value?.dropped
  return d && (d.settings || d.placements || d.images) ? d : null
})

async function install(widgetId: string): Promise<void> {
  const row = market.state.widgets.find((m) => m.id === widgetId)
  if (row) await market.start(row)
}

async function installTheme(): Promise<void> {
  const th = themeState.value
  if (th?.state === 'sietch') await market.installTheme(th.listed)
}

/** Uploads the file's images into the library, and answers where each one landed. */
async function storeImages(): Promise<Record<string, string>> {
  const p = preview.value!
  const out: Record<string, string> = {}
  for (const img of p.report.images) {
    if (img.shipped) { out[img.key] = p.shippedBackground; continue }
    const entry = p.layout.images[img.key]
    if (entry && 'data' in entry) out[img.key] = (await api.uploadBackground(img.key, entry.data)).name
  }
  return out
}

/** The file's iPad screens this import will skip while they are an experimental feature that is off. */
const skipping = computed(() => (preview.value && s.state.config ? skippedDeviceScreens(s.state.config, preview.value.layout) : 0))

async function apply(): Promise<void> {
  const p = preview.value
  if (!p || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const images = await storeImages()
    const picks: Record<string, string | string[]> = {}
    for (const c of p.report.connections) {
      const id = chosen[`${c.widget}:${c.setting}`]
      if (id) picks[`${c.widget}:${c.setting}`] = c.multiple ? [id] : id
    }
    let outcome: ImportOutcome = { screenId: '', pageIndex: 0, leftOut: 0, skippedDevices: 0 }
    const at = { screenId: s.screen.value?.id ?? '', pageIndex: s.state.pageIndex }
    s.apply((cfg) => {
      outcome = mergeLayout(cfg, p.layout, at, {
        mode: mode.value, images, connections: picks, theme: useTheme.value && themeState.value?.state === 'here',
      }, s.state.manifests)
    })
    s.selectScreen(outcome.screenId)
    s.selectPage(outcome.pageIndex)
    const done = outcome.leftOut
      ? t('admin.share.import.doneLeftOut', { n: outcome.leftOut })
      : t('admin.share.import.done')
    // Every screen of the file was an iPad one and skipped: nothing landed, and "imported" would
    // say otherwise.
    const nothing = outcome.skippedDevices > 0 && outcome.skippedDevices === p.layout.screens.length
    s.state.toast = nothing
      ? t('admin.share.import.nothingDevices')
      : outcome.skippedDevices
        ? `${done} ${t('admin.share.import.devicesSkipped', { n: outcome.skippedDevices })}`
        : done
    share.importing = null
    s.closeModal()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="import">
    <p class="lead">{{ title }}</p>
    <p v-if="error" class="bad" role="alert">{{ error }}</p>

    <template v-if="report">
      <p class="ro">
        {{ t('admin.share.import.counts', { screens: report.screens, pages: report.pages, tiles: report.tiles }) }}
        <template v-if="report.fremkit"> · {{ t('admin.share.import.madeWith', { version: report.fremkit }) }}</template>
      </p>

      <section>
        <h3>{{ t('admin.share.import.widgets') }}</h3>
        <ul class="widgets">
          <li v-for="w in widgets" :key="w.widgetId">
            <span class="name">{{ w.name }}<template v-if="w.count > 1"> ×{{ w.count }}</template></span>
            <BaseChip v-if="w.status !== 'missing'">{{ t('admin.share.import.here') }}</BaseChip>
            <BaseButton v-else-if="w.listed" :disabled="!!market.state.busy" @click="install(w.widgetId)">
              {{ market.state.busy === w.widgetId ? t('admin.share.import.installing') : t('admin.share.import.install') }}
            </BaseButton>
            <BaseChip v-else tone="danger">{{ t(w.source === 'local' ? 'admin.share.import.authorOnly' : 'admin.share.import.unknown') }}</BaseChip>
          </li>
        </ul>
        <p v-if="missing.length" class="ro">{{ t('admin.share.import.missingHint') }}</p>
        <p v-if="market.state.error" class="bad">{{ market.state.error }}</p>
      </section>

      <section v-if="report.connections.length">
        <h3>{{ t('admin.share.import.connections') }}</h3>
        <p class="ro">{{ t('admin.share.import.connectionsHint') }}</p>
        <label v-for="c in report.connections" :key="c.widget + c.setting" class="conn">
          <span>{{ pick(s.state.manifests[c.widgetId]?.name) || c.widgetId }} — {{ pick(c.label) }}</span>
          <select v-model="chosen[`${c.widget}:${c.setting}`]">
            <option value="">{{ t('admin.share.import.later') }}</option>
            <option v-for="o in connections.ofType(c.connectionType)" :key="o.id" :value="o.id">{{ o.name }}</option>
          </select>
        </label>
      </section>

      <section v-if="themeState">
        <h3>{{ t('admin.share.import.theme') }}</h3>
        <BaseCheckbox v-if="themeState.state === 'here'" v-model="useTheme"
          :label="t('admin.share.import.useTheme', { name: pick(themes[themeState.id]?.name) || themeState.id })" />
        <div v-else-if="themeState.state === 'sietch'" class="row">
          <span class="ro">{{ t('admin.share.import.themeSietch', { name: pick(themeState.listed.name) }) }}</span>
          <BaseButton :disabled="!!market.state.busy" @click="installTheme()">{{ t('admin.share.import.install') }}</BaseButton>
        </div>
        <p v-else class="ro">{{ t('admin.share.import.themeUnknown', { id: themeState.id }) }}</p>
      </section>

      <p v-if="report.images.length" class="ro">{{ t('admin.share.import.images', { n: report.images.length }) }}</p>
      <p v-if="dropped" class="ro warn">{{ t('admin.share.import.dropped', dropped) }}</p>
      <p v-if="skipping" class="ro warn" data-test="devices-skipped">{{ t('admin.share.import.devicesSkipped', { n: skipping }) }}</p>

      <section>
        <h3>{{ t('admin.share.import.where') }}</h3>
        <BaseSegmented :model-value="mode" :options="modes" @update:model-value="mode = $event as ImportMode" />
        <p v-if="mode === 'replace'" class="ro warn">{{ t('admin.share.import.replaceHint') }}</p>
      </section>
    </template>

    <div class="actions">
      <BaseButton @click="s.closeModal()">{{ t('common.cancel') }}</BaseButton>
      <BaseButton variant="primary" :disabled="!report || busy" @click="apply()">
        {{ t('admin.share.import.apply') }}
      </BaseButton>
    </div>

    <ConsentDialog v-if="market.state.consent" :prompt="market.state.consent"
      @accept="market.accept()" @cancel="market.cancel()" />
  </div>
</template>

<style scoped>
.import { display: flex; flex-direction: column; gap: var(--space-3); }
.lead { margin: 0; font-weight: 600; }
section { border-top: 1px solid var(--border); padding-top: var(--space-2); }
h3 { margin: 0 0 var(--space-1); font-size: var(--fs-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: .06em; }
.ro { margin: 0 0 var(--space-1); font-size: var(--fs-sm); color: var(--text-muted); }
.warn { color: var(--danger); }
.bad { margin: 0; color: var(--danger); font-size: var(--fs-sm); }
ul { list-style: none; margin: 0; padding: 0; }
.widgets li { display: flex; align-items: center; gap: var(--space-2); padding: 3px 0; font-size: var(--fs-sm); min-height: 32px; }
.widgets .name { flex: 1; }
.conn { display: flex; align-items: center; gap: var(--space-2); font-size: var(--fs-sm); margin-bottom: var(--space-2); }
.conn span { flex: 1; }
select { font: inherit; font-size: var(--fs-sm); color: var(--text); background: var(--surface-2);
  border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 4px 8px; max-width: 50%; }
.row { display: flex; align-items: center; gap: var(--space-2); }
.row .ro { flex: 1; margin: 0; }
.actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
</style>
