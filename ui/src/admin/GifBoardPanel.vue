<script setup lang="ts">
/**
 * The GIF board's own editor panel, opened from a gif-board tile's settings: the one collection
 * of this Mac (every GIF board tile shows it), which the generic settings form cannot draw.
 *
 * Left, the groups (`GifGroups.vue`); right, the Giphy search (`GifSearch.vue`) and, under it,
 * the paste field, which works with or without a Giphy key. Both add to the same target group.
 * Kept self-contained on purpose: it is the first widget-specific panel, not a framework for more.
 */
import { computed, nextTick, ref, watch } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseInput from '../shared/ui/BaseInput.vue'
import { api } from '../shared/api'
import { useI18n } from '../shared/i18n'
import { parseGifAddress } from './gifAddress'
import { MAX_ITEMS, addGroup, addItem, findGiphy, findLink } from './gifBoard'
import { useAdminStore } from './store'
import GifGroups from './GifGroups.vue'
import GifSearch from './GifSearch.vue'

const s = useAdminStore()
const { t } = useI18n()

const groups = computed(() => s.state.config?.gifs?.groups ?? [])
/** The group the search and the paste field add to; follows the groups when one goes. */
const target = ref('')
watch(groups, (list) => {
  if (!list.some((g) => g.id === target.value)) target.value = list[0]?.id ?? ''
}, { immediate: true, deep: true })
const targetGroup = computed(() => groups.value.find((g) => g.id === target.value))

const groupsColumn = ref<InstanceType<typeof GifGroups>>()
const pasteField = ref<HTMLElement>()

function newGroup(): void {
  let id = ''
  const name = t('admin.gifs.defaultName', { n: groups.value.length + 1 })
  s.apply((c) => {
    c.gifs ??= { groups: [] }
    id = addGroup(c.gifs, name)
  })
  if (!id) return
  target.value = id
  void nextTick(() => groupsColumn.value?.rename(id))
}

async function focusPaste(groupId: string): Promise<void> {
  target.value = groupId
  await nextTick()
  pasteField.value?.querySelector('input')?.focus()
}

const address = ref('')
const pasteError = ref('')
const checking = ref(false)

async function addPasted(): Promise<void> {
  pasteError.value = ''
  const group = targetGroup.value
  if (!group || checking.value) return
  const parsed = parseGifAddress(address.value)
  if ('error' in parsed) { pasteError.value = t(`admin.gifs.${parsed.error}`); return }
  const b = s.state.config?.gifs
  const already = b && (parsed.kind === 'giphy' ? findGiphy(b, group.id, parsed.giphyId) : findLink(b, group.id, parsed.url))
  if (already) { pasteError.value = t('admin.gifs.already', { name: group.name }); return }
  if (group.items.length >= MAX_ITEMS) { pasteError.value = t('admin.gifs.full'); return }
  if (parsed.kind === 'link') {
    // A link is added only once this Mac holds a copy: the board shows it from the cache.
    checking.value = true
    try {
      const res = await api.checkGif(parsed.url)
      if (!res.ok) { pasteError.value = res.error; return }
    } catch (err) {
      pasteError.value = err instanceof Error ? err.message : String(err)
      return
    } finally {
      checking.value = false
    }
  }
  const item = parsed.kind === 'giphy' ? { kind: 'giphy' as const, giphyId: parsed.giphyId } : { kind: 'link' as const, url: parsed.url }
  // The group may have gone, or filled up, while the link was being checked.
  const live = groups.value.find((g) => g.id === group.id)
  if (!live) { pasteError.value = t('admin.gifs.groupGone'); return }
  if (live.items.length >= MAX_ITEMS) { pasteError.value = t('admin.gifs.full'); return }
  let added = ''
  s.apply((c) => { if (c.gifs) added = addItem(c.gifs, group.id, item) })
  if (!added) { pasteError.value = t('admin.gifs.groupGone'); return }
  address.value = ''
}
watch(address, () => { pasteError.value = '' })
</script>

<template>
  <div class="gif-panel">
    <div class="left">
      <GifGroups ref="groupsColumn" :groups="groups" :target="target"
        @target="target = $event" @add="focusPaste" @new="newGroup" />
    </div>
    <div class="right">
      <GifSearch v-model:target="target" :groups="groups" />
      <form ref="pasteField" class="paste" @submit.prevent="addPasted">
        <label for="gif-paste">{{ targetGroup ? t('admin.gifs.addTo', { name: targetGroup.name }) : t('admin.gifs.paste') }}</label>
        <div class="row">
          <BaseInput id="gif-paste" v-model="address" :placeholder="t('admin.gifs.paste')" :invalid="!!pasteError"
            :disabled="!targetGroup" data-escape-clears @keydown.esc="address = ''" />
          <BaseButton variant="primary" :disabled="!targetGroup || !address.trim() || checking" @click="addPasted">
            {{ checking ? t('admin.gifs.checking') : t('admin.gifs.add') }}
          </BaseButton>
        </div>
        <p v-if="pasteError" class="err" role="alert">{{ pasteError }}</p>
      </form>
    </div>
  </div>
</template>

<style scoped>
.gif-panel { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); }
.left { min-height: 0; overflow-y: auto; padding: var(--space-4); border-right: 1px solid var(--border); }
.right { min-height: 0; display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); }
.paste { display: flex; flex-direction: column; gap: var(--space-1); border-top: 1px solid var(--border); padding-top: var(--space-3); }
.paste label { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted); }
.row { display: flex; gap: var(--space-2); }
.err { margin: 0; color: var(--danger); font-size: var(--fs-sm); }
</style>
