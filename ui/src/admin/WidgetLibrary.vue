<script lang="ts">
/**
 * The card's own dragend does not always fire — a drag released outside the window, or onto
 * another application, can skip it — and a stale dragWidgetId would make the canvas show a
 * ghost for the next unrelated drag. Clear it from the document too.
 *
 * Module scope, reference counted, so however many libraries are mounted the document carries
 * exactly one pair of listeners — and keeps them until the last library goes away.
 */
import { useAdminStore as useStore } from './store'

let mounted = 0
function clearDrag(): void { useStore().setDragWidget(null) }

function bindDragFallback(): void {
  if (mounted++ > 0) return
  document.addEventListener('dragend', clearDrag)
  document.addEventListener('drop', clearDrag)
}
function unbindDragFallback(): void {
  if (--mounted > 0) return
  document.removeEventListener('dragend', clearDrag)
  document.removeEventListener('drop', clearDrag)
}
</script>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseCard from '../shared/ui/BaseCard.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import BaseSection from '../shared/ui/BaseSection.vue'
import WidgetPermissions from './WidgetPermissions.vue'
import { pick, useI18n } from '../shared/i18n'
import { DND_TYPE, useAdminStore } from './store'
import { groupByCategory } from './library'

const s = useAdminStore()
const { t } = useI18n()

/** One group per category that has widgets, each sorted by name in the language in force. */
const groups = computed(() => groupByCategory(
  Object.values(s.state.manifests),
  (a, b) => pick(a.name).localeCompare(pick(b.name)),
).map((g) => ({ ...g, title: t(`admin.library.category.${g.id}`) })))

function onDragStart(e: DragEvent, id: string): void {
  s.setDragWidget(id)
  e.dataTransfer?.setData(DND_TYPE, id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
}

onMounted(bindDragFallback)
onBeforeUnmount(unbindDragFallback)
</script>

<template>
  <section>
    <h2>{{ t('admin.library.title') }} <BaseButton variant="icon" :title="t('admin.library.rescan')" @click="s.rescan()"><BaseIcon name="redo-2" :size="16" /></BaseButton></h2>
    <BaseSection v-for="g in groups" :key="g.id" :id="`library.${g.id}`" :title="g.title"
      :badge="String(g.widgets.length)" default-open>
      <div class="list">
        <BaseCard v-for="m in g.widgets" :key="m.id" grab :draggable="true" @dragstart="onDragStart($event, m.id)" @dragend="s.setDragWidget(null)"
          @click="s.addWidget(m.id)">
          <BaseIcon :name="m.icon" :size="20" />
          <div class="txt">
            <strong>{{ pick(m.name) }}</strong>
            <small>{{ m.defaultSize[0] }}×{{ m.defaultSize[1] }} · {{ pick(m.description) }}</small>
            <WidgetPermissions :manifest="m" compact />
          </div>
        </BaseCard>
      </div>
    </BaseSection>
    <div v-if="s.state.catalogErrors.length" class="list errors">
      <BaseCard v-for="e in s.state.catalogErrors" :key="'err-' + e.id" class="err">
        <BaseIcon name="alert-triangle" :size="20" />
        <div class="txt"><strong>{{ e.id }}</strong><small>{{ e.error }}</small></div>
      </BaseCard>
    </div>
  </section>
</template>

<style scoped>
section { margin-top: var(--space-4); }
h2 { display: flex; align-items: center; justify-content: space-between; font-size: var(--fs-xs);
  text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted); margin: 0 0 var(--space-2); }
.errors { margin-top: var(--space-3); }
.list { display: flex; flex-direction: column; gap: var(--space-2); }
.txt { display: flex; flex-direction: column; min-width: 0; }
.txt strong { font-size: var(--fs-sm); font-weight: 600; }
.txt small { font-size: var(--fs-xs); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.err { border-color: var(--danger); color: var(--danger); }
</style>
