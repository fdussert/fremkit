<script setup lang="ts">
/**
 * What the server may read on this Mac, and what it may show. Moved out of the former
 * ScreenInspector.vue.
 */
import { computed } from 'vue'
import BaseCheckbox from '../../shared/ui/BaseCheckbox.vue'
import BaseSection from '../../shared/ui/BaseSection.vue'
import { useI18n } from '../../shared/i18n'
import { useAdminStore } from '../store'

const s = useAdminStore()
const { t } = useI18n()

const privacy = computed(() => s.state.config!.privacy)
/**
 * Turning the Claude usage on is the whole consent step: until it is ticked the server does not
 * read the keychain item and sends nothing. The hint below spells out what is read and where it
 * goes, so the box is never the only thing the user has to go on.
 */
function setClaudeAccountUsage(on: boolean): void {
  s.apply((c) => { c.privacy.claudeAccountUsage = on })
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
function setMessages2FA(on: boolean): void {
  s.apply((c) => { c.privacy.messages2FA = on })
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
  <BaseCheckbox :model-value="privacy.messages2FA ?? false"
    :label="t('admin.inspector.screen.messages2FA')"
    @update:model-value="setMessages2FA($event)" />
  <p class="ro">{{ t('admin.inspector.screen.messages2FA.hint') }}</p>
  </BaseSection>
</template>

<style scoped>
.ro { margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--text-muted); }
.codex-sources { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: var(--space-1); margin-bottom: var(--space-3); }
.codex-subagent-sources { margin-bottom: var(--space-3); }
.codex-subagent-sources summary { cursor: pointer; margin-bottom: var(--space-2); }
</style>
