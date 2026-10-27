<script setup lang="ts">
/**
 * The GIF board panel's Giphy search: a query, the group results go to, and a grid of results.
 * A click on a result adds it to that group, a second click takes it out again. The server makes
 * the search with the Giphy connection's key; without one, this says so and points at the
 * connections, and the panel's paste field still works.
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseInput from '../shared/ui/BaseInput.vue'
import { api, type GifSearchError, type GifSearchResult } from '../shared/api'
import { useI18n } from '../shared/i18n'
import type { GifGroup } from '../shared/types'
import { MAX_ITEMS, addItem, findGiphy, removeItem } from './gifBoard'
import { useAdminStore } from './store'

const props = defineProps<{ groups: GifGroup[]; target: string }>()
const emit = defineEmits<{ 'update:target': [groupId: string] }>()
const s = useAdminStore()
const { t } = useI18n()

const DEBOUNCE_MS = 400
const MIN_QUERY = 2

const query = ref('')
const results = ref<GifSearchResult[]>([])
const total = ref(0)
const error = ref<GifSearchError | null>(null)
const loading = ref(false)
const full = ref(false)
// A later search wins: an answer to an earlier one is dropped.
let seq = 0
let timer: ReturnType<typeof setTimeout> | undefined

const giphyConnection = computed(() => s.state.config?.connections.find((c) => c.type === 'giphy'))
const unconfigured = computed(() => !giphyConnection.value || error.value === 'unconfigured')
const targetGroup = computed(() => props.groups.find((g) => g.id === props.target))

async function search(offset: number): Promise<void> {
  const q = query.value.trim()
  const mine = ++seq
  loading.value = true
  try {
    const res = await api.searchGifs(q, offset)
    if (mine !== seq) return
    if (!res.ok) { error.value = res.error; return }
    error.value = null
    const known = new Set(offset ? results.value.map((r) => r.giphyId) : [])
    // Giphy's pages can overlap: a GIF already listed is not listed twice.
    const fresh = res.results.filter((r) => !known.has(r.giphyId) && known.add(r.giphyId))
    results.value = offset ? [...results.value, ...fresh] : fresh
    total.value = res.total
  } catch {
    if (mine === seq) error.value = 'unreachable'
  } finally {
    if (mine === seq) loading.value = false
  }
}

watch(query, (q) => {
  clearTimeout(timer)
  if (q.trim().length < MIN_QUERY) {
    seq++
    results.value = []
    total.value = 0
    loading.value = false
    if (error.value !== 'unconfigured') error.value = null
    return
  }
  timer = setTimeout(() => void search(0), DEBOUNCE_MS)
})
onUnmounted(() => clearTimeout(timer))

const inTarget = (giphyId: string): boolean => {
  const b = s.state.config?.gifs
  return !!b && !!props.target && !!findGiphy(b, props.target, giphyId)
}

function toggle(r: GifSearchResult): void {
  const group = targetGroup.value
  if (!group) return
  const adding = !inTarget(r.giphyId)
  full.value = adding && group.items.length >= MAX_ITEMS
  if (full.value) return
  s.apply((c) => {
    if (!c.gifs) return
    const hit = findGiphy(c.gifs, group.id, r.giphyId)
    if (hit) removeItem(c.gifs, hit.id)
    else addItem(c.gifs, group.id, { kind: 'giphy', giphyId: r.giphyId })
  })
}

function openGiphy(): void {
  const c = giphyConnection.value
  if (c) s.openConnection(c.id)
  else s.openNewConnection('giphy')
}
</script>

<template>
  <div class="search">
    <div v-if="unconfigured" class="unconfigured">
      <p>{{ t('admin.gifs.unconfigured') }}</p>
      <BaseButton variant="primary" @click="openGiphy()">{{ t('admin.gifs.openConnections') }}</BaseButton>
    </div>
    <template v-else>
      <div class="bar">
        <BaseInput v-model="query" :placeholder="t('admin.gifs.search')" :aria-label="t('admin.gifs.search')"
          data-escape-clears @keydown.esc="query = ''" />
        <label class="target">
          <span>{{ t('admin.gifs.target') }}</span>
          <select :value="target" :disabled="!groups.length" @change="emit('update:target', ($event.target as HTMLSelectElement).value)">
            <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
          </select>
        </label>
      </div>
      <p v-if="error === 'rateLimited' || error === 'unauthorized' || error === 'unreachable'" class="msg bad">{{ t(`admin.gifs.${error}`) }}</p>
      <p v-else-if="full" class="msg bad">{{ t('admin.gifs.full') }}</p>
      <div class="results">
        <ul v-if="results.length" class="grid">
          <li v-for="r in results" :key="r.giphyId">
            <button type="button" :class="{ in: inTarget(r.giphyId) }" :disabled="!targetGroup" :title="r.title"
              :aria-pressed="inTarget(r.giphyId)" @click="toggle(r)">
              <img :src="r.thumb" :alt="r.title" loading="lazy" />
              <span v-if="inTarget(r.giphyId)" class="badge">{{ t('admin.gifs.inGroup', { name: targetGroup!.name }) }}</span>
            </button>
          </li>
        </ul>
        <p v-else-if="!loading && !error && query.trim().length >= MIN_QUERY" class="msg">{{ t('admin.gifs.noResults') }}</p>
        <BaseButton v-if="results.length && results.length < total" class="more" :disabled="loading"
          @click="search(results.length)">{{ t('admin.gifs.loadMore') }}</BaseButton>
      </div>
      <p class="powered">{{ t('admin.gifs.poweredBy') }}</p>
    </template>
  </div>
</template>

<style scoped>
.search { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.unconfigured { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-2); color: var(--text-muted); font-size: var(--fs-sm); }
.unconfigured p { margin: 0; }
.bar { display: flex; gap: var(--space-2); align-items: center; }
.target { display: flex; align-items: center; gap: var(--space-1); font-size: var(--fs-sm); color: var(--text-muted); white-space: nowrap; }
.target select { max-width: 180px; box-sizing: border-box; font: inherit; font-size: var(--fs-sm); color: var(--text);
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 6px 8px; }
.msg { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
.msg.bad { color: var(--danger); }
.results { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: var(--space-2); }
.grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: var(--space-2); }
.grid button { position: relative; display: block; width: 100%; aspect-ratio: 1; padding: 0; border: 2px solid transparent;
  border-radius: var(--radius-sm); overflow: hidden; background: var(--surface-2); cursor: pointer; }
.grid button.in { border-color: var(--accent); }
.grid button:disabled { cursor: default; }
.grid img { width: 100%; height: 100%; object-fit: cover; display: block; }
.badge { position: absolute; left: 4px; bottom: 4px; max-width: calc(100% - 8px); padding: 1px 6px; border-radius: 999px;
  font-size: var(--fs-xs); background: var(--accent); color: var(--on-accent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.more { align-self: center; }
.powered { margin: 0; font-size: var(--fs-xs); color: var(--text-dim); text-align: right; letter-spacing: .04em; }
</style>
