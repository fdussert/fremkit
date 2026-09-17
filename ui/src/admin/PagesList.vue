<script setup lang="ts">
import { ref } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import { useI18n } from '../shared/i18n'
import { useAdminStore } from './store'

const s = useAdminStore()
const { t } = useI18n()
const editing = ref<string | null>(null)
// Escape unmounts the input, and that unmount fires a native blur — so the blur handler has to
// be told the edit was abandoned, or it would commit the very text Escape just rejected.
let cancelling = false

function startEdit(id: string): void {
  cancelling = false
  editing.value = id
}
function cancelEdit(): void {
  cancelling = true
  editing.value = null
}
function commitName(i: number, e: Event): void {
  if (cancelling) { cancelling = false; return }
  const value = (e.target as HTMLInputElement).value.trim()
  if (value) s.renamePage(i, value)
  editing.value = null
}
function confirmRemove(i: number, name: string): void {
  if (window.confirm(t('admin.pages.confirmRemove', { name }))) s.removePage(i)
}
</script>

<template>
  <section>
    <h2>{{ t('admin.pages.title') }} <BaseButton variant="icon" :title="t('admin.pages.add')" @click="s.addPage()"><BaseIcon name="plus" :size="16" /></BaseButton></h2>
    <ul>
      <li v-for="(p, i) in s.state.config!.pages" :key="p.id" :class="{ on: i === s.state.pageIndex }" @click="s.selectPage(i)">
        <input v-if="editing === p.id" :value="p.name" autofocus
          @click.stop @blur="commitName(i, $event)" @keydown.enter="($event.target as HTMLInputElement).blur()" @keydown.esc="cancelEdit()" />
        <span v-else class="name" @dblclick.stop="startEdit(p.id)">{{ p.name }}</span>
        <BaseButton variant="icon" :title="t('admin.pages.rename')" @click.stop="startEdit(p.id)"><BaseIcon name="pencil" :size="14" /></BaseButton>
        <BaseButton variant="icon" :title="t('common.moveUp')" :disabled="i === 0" @click.stop="s.movePage(i, -1)"><BaseIcon name="chevron-up" :size="14" /></BaseButton>
        <BaseButton variant="icon" :title="t('common.moveDown')" :disabled="i === s.state.config!.pages.length - 1" @click.stop="s.movePage(i, 1)"><BaseIcon name="chevron-down" :size="14" /></BaseButton>
        <BaseButton variant="icon" :title="t('common.duplicate')" @click.stop="s.duplicatePage(i)"><BaseIcon name="copy" :size="14" /></BaseButton>
        <BaseButton variant="icon" :title="t('common.remove')" :disabled="s.state.config!.pages.length <= 1" @click.stop="confirmRemove(i, p.name)"><BaseIcon name="trash-2" :size="14" /></BaseButton>
      </li>
    </ul>
  </section>
</template>

<style scoped>
h2 { display: flex; align-items: center; justify-content: space-between; font-size: var(--fs-xs);
  text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted); margin: 0 0 var(--space-2); }
ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 2px; }
li { display: flex; align-items: center; gap: 2px; padding: 2px 2px 2px var(--space-2);
  border-radius: var(--radius-sm); cursor: pointer; font-size: var(--fs-sm); }
li:hover { background: var(--surface-2); }
li.on { background: var(--surface-3); }
.name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
input { flex: 1; min-width: 0; font: inherit; font-size: var(--fs-sm); color: var(--text);
  background: var(--bg); border: 1px solid var(--accent); border-radius: 6px; padding: 3px 6px; }
</style>
