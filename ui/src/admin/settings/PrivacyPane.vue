<script setup lang="ts">
/**
 * What the server may read on this Mac, and what it may show. Moved out of the former
 * ScreenInspector.vue.
 */
import { computed, onMounted, ref, watch } from 'vue'
import BaseCheckbox from '../../shared/ui/BaseCheckbox.vue'
import BaseField from '../../shared/ui/BaseField.vue'
import BaseInput from '../../shared/ui/BaseInput.vue'
import { api, type ClaudeAccount } from '../../shared/api'
import BaseSection from '../../shared/ui/BaseSection.vue'
import { useI18n } from '../../shared/i18n'
import { useAdminStore } from '../store'

const s = useAdminStore()
const { t, locale } = useI18n()
/** As long as the server takes (`ACCOUNT_NAME_MAX`): the name titles a row on a narrow tile. */
const CLAUDE_ACCOUNT_NAME_MAX = 24

const privacy = computed(() => s.state.config!.privacy)
/**
 * Turning the Claude usage on is the whole consent step: until it is ticked the server does not
 * read the keychain item and sends nothing. The hint below spells out what is read and where it
 * goes, so the box is never the only thing the user has to go on.
 */
function setClaudeAccountUsage(on: boolean): void {
  s.apply((c) => { c.privacy.claudeAccountUsage = on })
}
/**
 * The Claude accounts in use on this Mac, one name field each: what the Claude limits widget calls
 * each account's row. Listed by the server from the Claude Code folders' own files, with the plan,
 * the organisation unless it is an address, and when the account was last seen; never an e-mail.
 */
const claudeAccounts = ref<ClaudeAccount[]>([])
async function loadClaudeAccounts(): Promise<void> {
  try { claudeAccounts.value = (await api.getClaudeAccounts()).accounts } catch { claudeAccounts.value = [] }
}
onMounted(loadClaudeAccounts)
watch(() => privacy.value.claudeAccountUsage, loadClaudeAccounts)
/** What tells the accounts apart without an address: the plan, the organisation, when last seen. */
function accountLabel(a: ClaudeAccount): string {
  const parts = [
    a.plan ? t('admin.inspector.screen.claudeAccount.plan', { plan: a.plan }) : t('admin.inspector.screen.claudeAccount.noPlan'),
    a.org,
    a.lastSeen ? t('admin.inspector.screen.claudeAccount.seen', { when: new Date(a.lastSeen).toLocaleString(locale.value, { dateStyle: 'short', timeStyle: 'short' }) }) : null,
  ]
  return parts.filter(Boolean).join(' · ')
}
function accountName(uuid: string): string {
  return privacy.value.claudeAccountNames?.[uuid] ?? ''
}
/** An empty name removes the entry: the row goes back to showing the plan. */
function setAccountName(uuid: string, value: string): void {
  const name = value.trim().slice(0, CLAUDE_ACCOUNT_NAME_MAX)
  if (name === accountName(uuid)) return
  s.apply((c) => {
    const names = { ...(c.privacy.claudeAccountNames ?? {}) }
    if (name) names[uuid] = name
    else delete names[uuid]
    c.privacy.claudeAccountNames = names
  })
}
const CODEX_SOURCES = ['appServer', 'vscode', 'cli', 'exec', 'subAgent', 'unknown'] as const
const CODEX_SUBAGENT_SOURCES = ['subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther'] as const
type CodexSource = typeof CODEX_SOURCES[number] | typeof CODEX_SUBAGENT_SOURCES[number]
function setCodexAccount(on: boolean): void {
  s.apply((c) => { c.privacy.codexAccount = on })
}
function setCodexSource(source: CodexSource, on: boolean): void {
  s.apply((c) => { c.privacy.codexHistorySources = on
    ? [...new Set([...c.privacy.codexHistorySources, source])]
    : c.privacy.codexHistorySources.filter(value => value !== source) })
}
function setMacmonTemperature(on: boolean): void {
  s.apply((c) => { c.privacy.macmonTemperature = on })
}
/**
 * Off, the server leaves the account e-mail out of every snapshot it publishes; this box does
 * not hide it in a widget, it decides whether any widget is sent it at all.
 */
function setShowAccountEmail(on: boolean): void {
  s.apply((c) => { c.privacy.showAccountEmail = on })
}
</script>

<template>
  <BaseSection id="screen.privacy" :title="t('admin.inspector.screen.privacy')">
  <BaseCheckbox :model-value="privacy.claudeAccountUsage"
    :label="t('admin.inspector.screen.claudeUsage')"
    @update:model-value="setClaudeAccountUsage($event)" />
  <p class="ro">{{ t('admin.inspector.screen.claudeUsage.hint') }}</p>
  <p class="ro sub">{{ t('admin.inspector.screen.claudeAccounts') }}</p>
  <p class="ro">{{ t('admin.inspector.screen.claudeAccounts.hint') }}</p>
  <p v-if="claudeAccounts.length === 0" class="ro">{{ t('admin.inspector.screen.claudeAccounts.none') }}</p>
  <BaseField v-for="a in claudeAccounts" :key="a.uuid" :label="accountLabel(a)">
    <BaseInput lazy :model-value="accountName(a.uuid)" :placeholder="a.plan ?? 'Claude'"
      @update:model-value="setAccountName(a.uuid, String($event))" />
  </BaseField>
  <BaseCheckbox :model-value="privacy.showAccountEmail"
    :label="t('admin.inspector.screen.accountEmail')"
    @update:model-value="setShowAccountEmail($event)" />
  <p class="ro">{{ t('admin.inspector.screen.accountEmail.hint') }}</p>
  <BaseCheckbox :model-value="privacy.codexAccount"
    :label="t('admin.inspector.screen.codexAccount')"
    @update:model-value="setCodexAccount($event)" />
  <p class="ro">{{ t('admin.inspector.screen.codexAccount.hint') }}</p>
  <p class="ro">{{ t('admin.inspector.screen.codexSources') }}</p>
  <p class="ro">{{ t('admin.inspector.screen.codexSources.hint') }}</p>
  <div class="codex-sources">
    <BaseCheckbox v-for="source in CODEX_SOURCES" :key="source"
      :model-value="privacy.codexHistorySources.includes(source)"
      :label="t('admin.inspector.screen.codexSource.' + source)"
      @update:model-value="setCodexSource(source, $event)" />
  </div>
  <details class="codex-subagent-sources">
    <summary>{{ t('admin.inspector.screen.codexSources.subagents') }}</summary>
    <div class="codex-sources">
      <BaseCheckbox v-for="source in CODEX_SUBAGENT_SOURCES" :key="source"
        :model-value="privacy.codexHistorySources.includes(source)"
        :label="t('admin.inspector.screen.codexSource.' + source)"
        @update:model-value="setCodexSource(source, $event)" />
    </div>
  </details>
  <BaseCheckbox :model-value="privacy.macmonTemperature"
    :label="t('admin.inspector.screen.macmonTemperature')"
    @update:model-value="setMacmonTemperature($event)" />
  <p class="ro">{{ t('admin.inspector.screen.macmonTemperature.hint') }}</p>
  </BaseSection>
</template>

<style scoped>
.ro { margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--text-muted); }
.codex-sources { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: var(--space-1); margin-bottom: var(--space-3); }
.codex-subagent-sources { margin-bottom: var(--space-3); }
.sub { color: var(--text); font-weight: 600; }
.codex-subagent-sources summary { cursor: pointer; margin-bottom: var(--space-2); }
</style>
