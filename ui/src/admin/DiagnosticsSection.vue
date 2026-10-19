<script setup lang="ts">
/**
 * "Copy diagnostics", in Screen → About.
 *
 * The report is shown before it is copied: it is going into a public issue, and the user should
 * see exactly what that is. The server has already removed secrets, addresses, names and
 * e-mails (see `server/src/diagnostics/redact.ts`); the preview is what lets a person check.
 */
import { ref } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import { api } from '../shared/api'
import { useI18n } from '../shared/i18n'
import { BUG_REPORT_URL } from '../shared/credits'

const { t } = useI18n()
const report = ref<string | null>(null)
const loading = ref(false)
const error = ref('')
const copied = ref<'yes' | 'failed' | null>(null)
const area = ref<HTMLTextAreaElement | null>(null)

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  copied.value = null
  try {
    report.value = await api.getDiagnostics()
  } catch (e) {
    error.value = t('admin.inspector.screen.about.diagnostics.loadFailed', { error: (e as Error).message })
  } finally {
    loading.value = false
  }
}

/**
 * The async clipboard first; the admin can run in the helper's web view, where it may be
 * refused, and then the selected text area and `execCommand` still work.
 */
async function copy(): Promise<void> {
  if (report.value === null) return
  try {
    await navigator.clipboard.writeText(report.value)
    copied.value = 'yes'
    return
  } catch { /* fall back below */ }
  const el = area.value
  if (el) {
    const top = el.scrollTop
    el.focus()
    el.select()
    copied.value = document.execCommand('copy') ? 'yes' : 'failed'
    // Selecting the whole text scrolls to its end; the reader was looking at the top.
    el.scrollTop = top
  } else {
    copied.value = 'failed'
  }
}
</script>

<template>
  <h3>{{ t('admin.inspector.screen.about.diagnostics') }}</h3>
  <p class="ro">{{ t('admin.inspector.screen.about.diagnostics.hint') }}</p>
  <div class="row">
    <BaseButton :disabled="loading" @click="load">
      {{ report === null ? t('admin.inspector.screen.about.diagnostics.show') : t('admin.inspector.screen.about.diagnostics.refresh') }}
    </BaseButton>
    <BaseButton v-if="report !== null" variant="primary" @click="copy">{{ t('admin.inspector.screen.about.diagnostics.copy') }}</BaseButton>
  </div>
  <p v-if="error" class="bad">{{ error }}</p>
  <p v-if="copied === 'yes'" class="ok">{{ t('admin.inspector.screen.about.diagnostics.copied') }}</p>
  <p v-else-if="copied === 'failed'" class="bad">{{ t('admin.inspector.screen.about.diagnostics.copyFailed') }}</p>
  <textarea v-if="report !== null" ref="area" class="preview" readonly :value="report"
    :aria-label="t('admin.inspector.screen.about.diagnostics')" spellcheck="false" />
  <p class="ro">
    <a class="link" :href="BUG_REPORT_URL" target="_blank" rel="noopener noreferrer">{{ t('admin.inspector.screen.about.diagnostics.report') }}</a>
  </p>
</template>

<style scoped>
h3 { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted);
  margin: var(--space-4) 0 var(--space-2); }
.ro { margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--text-muted); }
.row { display: flex; gap: var(--space-2); margin-bottom: var(--space-2); flex-wrap: wrap; }
.bad { margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--danger); white-space: pre-wrap; }
.ok { margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--ok); }
.preview { display: block; width: 100%; box-sizing: border-box; height: 240px; resize: vertical; margin: 0 0 var(--space-2);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--fs-xs); line-height: 1.4;
  color: var(--text); background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
  padding: var(--space-2); white-space: pre; overflow: auto; }
.link { color: var(--accent); text-decoration: none; }
.link:hover { text-decoration: underline; }
</style>
