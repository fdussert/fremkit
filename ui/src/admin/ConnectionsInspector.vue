<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseCard from '../shared/ui/BaseCard.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import ConnectionForm from './ConnectionForm.vue'
import { useI18n } from '../shared/i18n'
import { useConfirm } from '../shared/useConfirm'
import { useConnectionsStore } from './connections'
import { useAdminStore } from './store'

const s = useConnectionsStore()
const admin = useAdminStore()
const { t } = useI18n()
/** Which connection the form is editing: an id for an existing one, '' for none. */
const editingId = ref('')
/** Type of the connection being created, empty when editing an existing one. */
const creatingType = ref('')

/**
 * Opens straight onto a new connection when the admin asked for one of a given type.
 *
 * `load()` first, because the form needs the type's fields — and the type may be a declared one
 * the list has never rendered.
 */
onMounted(async () => {
  if (!s.state.loaded) await s.load().catch(() => { /* the banner shows the error */ })
  const wanted = admin.state.newConnectionType
  if (wanted && s.state.types.some((t) => t.id === wanted)) startCreate(wanted)
})

const editing = computed(() => s.state.connections.find((c) => c.id === editingId.value) ?? null)
const type = computed(() => s.state.types.find((t) => t.id === (creatingType.value || editing.value?.type)) ?? null)
const typeName = (id: string): string => s.state.types.find((t) => t.id === id)?.name ?? id
const typeIcon = (id: string): string => s.state.types.find((t) => t.id === id)?.icon ?? 'layout-grid'

/**
 * A connection whose type nothing offers any more.
 *
 * Uninstalling a widget takes its declared type out of the registry and leaves the connections
 * alone, on purpose: reinstalling is then the same connection rather than a form to fill again,
 * and deleting somebody's API key because they removed a widget is not a decision this code
 * makes. So the row stays, greyed, saying why — and Remove still works.
 */
const orphan = (typeId: string): boolean =>
  s.state.loaded && !s.state.types.some((t) => t.id === typeId)

function startCreate(typeId: string): void {
  creatingType.value = typeId
  editingId.value = s.suggestId(typeId)
  s.clearError()
}
function startEdit(id: string): void {
  creatingType.value = ''
  editingId.value = id
  s.clearError()
}
function close(): void {
  creatingType.value = ''
  editingId.value = ''
  s.clearError()
}
const confirm = useConfirm()
function remove(id: string): void {
  // Two taps, no dialog: the kiosk's web view shows none. The banner shows a 409.
  confirm.ask(id, () => s.remove(id).catch(() => { /* the banner shows the 409 */ }))
}
</script>

<template>
  <div v-if="type && editingId">
    <h2>{{ editing ? editing.name : t('admin.connections.new') }} <span class="kind">{{ type.name }}</span></h2>
    <ConnectionForm :key="editingId" :type="type" :connection="editing" :id="editingId" @done="close" @cancel="close" />
  </div>

  <div v-else>
    <p v-if="s.state.error" class="err">{{ s.state.error }}</p>
    <p v-if="!s.state.connections.length" class="empty">{{ t('admin.connections.empty') }}</p>
    <div class="list">
      <BaseCard v-for="c in s.state.connections" :key="c.id" :class="{ orphan: orphan(c.type) }"
        :data-connection="c.id" @click="startEdit(c.id)">
        <BaseIcon :name="typeIcon(c.type)" :size="20" />
        <div class="txt">
          <strong>{{ c.name }}</strong>
          <small v-if="orphan(c.type)">{{ t('declared.orphan') }}</small>
          <small v-else>{{ typeName(c.type) }}</small>
        </div>
        <BaseButton v-if="confirm.armed(c.id)" variant="danger" :title="t('common.confirm')" @click.stop="remove(c.id)">
          {{ t('common.confirm') }}
        </BaseButton>
        <BaseButton v-else variant="icon" :title="t('common.remove')" @click.stop="remove(c.id)">
          <BaseIcon name="trash-2" :size="14" />
        </BaseButton>
      </BaseCard>
    </div>

    <h3>{{ t('admin.connections.add') }}</h3>
    <p v-if="!s.state.types.length" class="empty">{{ t('admin.connections.noTypes') }}</p>
    <div class="list">
      <BaseCard v-for="t in s.state.types" :key="t.id" @click="startCreate(t.id)">
        <BaseIcon :name="t.icon" :size="20" />
        <div class="txt">
          <strong>{{ t.name }}</strong>
          <small>{{ t.description }}</small>
        </div>
      </BaseCard>
    </div>
  </div>
</template>

<style scoped>
h2 { display: flex; align-items: baseline; gap: var(--space-2); font-size: var(--fs-md); margin: 0 0 var(--space-3); }
h2 .kind { font-size: var(--fs-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: .06em; }
h3 { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted);
  margin: var(--space-4) 0 var(--space-2); }
.list { display: flex; flex-direction: column; gap: var(--space-2); }
.list :deep(.card) { cursor: pointer; }
/* The type is gone, the credential is not: readable, clearly inert, still removable. */
.list :deep(.card.orphan) { opacity: .6; }
.txt { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.txt strong { font-size: var(--fs-sm); font-weight: 600; }
.txt small { font-size: var(--fs-xs); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty, .err { font-size: var(--fs-sm); color: var(--text-muted); margin: 0 0 var(--space-3); }
.err { color: var(--danger); white-space: pre-wrap; }
</style>
