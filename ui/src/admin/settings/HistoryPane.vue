<script setup lang="ts">
/**
 * The saved versions of the whole dashboard, and the archive that carries it to another Mac.
 * Moved out of the former ScreenInspector.vue.
 */
import { ref } from 'vue'
import BaseButton from '../../shared/ui/BaseButton.vue'
import BaseIcon from '../../shared/ui/BaseIcon.vue'
import { api } from '../../shared/api'
import type { RestoreResult } from '../../shared/api'
import BaseSection from '../../shared/ui/BaseSection.vue'
import HistorySection from '../HistorySection.vue'
import { useI18n } from '../../shared/i18n'
import { useConfirm } from '../../shared/useConfirm'
import { useAdminStore } from '../store'

const s = useAdminStore()
const { t } = useI18n()
/**
 * Backup and restore.
 *
 * The archive holds the config and the background library and never a secret: those live in the
 * macOS keychain. A restore therefore replaces the dashboard and leaves every connection needing
 * its secret typed in again — which is what the confirmation says and what the result lists.
 */
const restoreInput = ref<HTMLInputElement>()
const restoring = ref(false)
const restored = ref<RestoreResult | null>(null)
const restoreError = ref('')

const confirm = useConfirm()
function confirmRestore(): void {
  confirm.ask('restore', () => restoreInput.value?.click())
}

async function onRestoreFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // Cleared either way, so picking the same file twice still fires a change event.
  input.value = ''
  if (!file) return
  restoring.value = true
  restored.value = null
  restoreError.value = ''
  try {
    restored.value = await api.restoreBackup(file)
    // The whole dashboard changed underneath the admin: reload it rather than reconcile it.
    await s.load()
  } catch (err) {
    restoreError.value = (err as Error).message
  } finally {
    restoring.value = false
  }
}
</script>

<template>
  <BaseSection id="screen.history" :title="t('admin.inspector.screen.history')">
    <HistorySection />
  </BaseSection>

  <BaseSection id="screen.backup" :title="t('admin.inspector.screen.backup')">
  <div class="row">
    <BaseButton @click="api.downloadBackup()">
      <BaseIcon name="download" :size="16" />{{ t('admin.inspector.screen.backup.download') }}
    </BaseButton>
    <!-- Two taps: the first says what a restore does, the second opens the file picker. -->
    <BaseButton v-if="confirm.armed('restore')" variant="danger" :disabled="restoring" @click="confirmRestore()">
      {{ t('admin.inspector.screen.restore.confirmButton') }}
    </BaseButton>
    <BaseButton v-else :disabled="restoring" @click="confirmRestore()">
      <BaseIcon name="upload" :size="16" />{{ t('admin.inspector.screen.backup.restore') }}
    </BaseButton>
  </div>
  <input ref="restoreInput" type="file" accept=".zip,application/zip" class="hidden" @change="onRestoreFile" />
  <p v-if="confirm.armed('restore')" class="ro warn">{{ t('admin.inspector.screen.restore.confirm') }}</p>
  <p v-else class="ro">{{ t('admin.inspector.screen.backup.hint') }}</p>
  <p v-if="restoreError" class="bad">{{ restoreError }}</p>
  <template v-if="restored">
    <p class="ok">{{ t('admin.inspector.screen.restore.done', { screens: restored.screens, pages: restored.pages, backgrounds: restored.backgrounds }) }}</p>
    <p v-if="restored.reenterSecrets.length" class="ro">
      {{ t('admin.inspector.screen.restore.reenter') }}
      <strong>{{ restored.reenterSecrets.map((c) => c.name).join(', ') }}</strong>
    </p>
    <!-- The common case, and worth saying: restoring onto the same Mac finds the keychain items,
         because they are keyed by the connection ids the archive carries. -->
    <p v-else class="ro">{{ t('admin.inspector.screen.restore.nothingToReenter') }}</p>
  </template>

  </BaseSection>
</template>

<style scoped>
.ro { margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--text-muted); }
.ro.warn { color: var(--danger); }
.row { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-2); }
.hidden { display: none; }
.bad { margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--danger); white-space: pre-wrap; }
.ok { margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--ok); }
</style>
