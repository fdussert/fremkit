<script lang="ts">
import { ref } from 'vue'

/** Whether the palette shows. ⌘K toggles it (`App.vue`); anything may open it. */
export const paletteOpen = ref(false)

/** Where the palette keeps what was run last: this browser only, a convenience. */
const RECENT_KEY = 'fremkit.palette.recent'

function readRecent(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}
function writeRecent(list: string[]): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)) } catch { /* private window: nothing remembered */ }
}
</script>

<script setup lang="ts">
/**
 * ⌘K: one field over the editor and every command it has, found by typing (`palette.ts`) and run
 * from the keyboard — ↑ ↓ to choose, Enter to run, → to open a submenu, ← or Backspace to come
 * back out, Escape to close. It is a list and a field, drawn like the context menu (`menu.css`),
 * not a second menu system: the commands are mostly the menus' own items (`paletteCommands.ts`).
 */
import { computed, nextTick, ref as vref, watch } from 'vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import '../shared/ui/menu.css'
import { step } from '../shared/ui/contextMenu'
import { pick, useI18n } from '../shared/i18n'
import { BUILTIN_THEME, useThemes } from '../shared/theme'
import { useAdminStore } from './store'
import { useMarketplaceStore } from './marketplace'
import { useConnectionsStore } from './connections'
import { useHealth } from './useHealth'
import { editorFocus, renameRequest } from './editorFocus'
import { openHistory } from './history'
import { pushRecent, searchCommands, type Command, type Hit, type PaletteGroup } from './palette'
import { buildCommands, type PaletteUi } from './paletteCommands'
import { shortcutHint } from './shortcuts'

const s = useAdminStore()
const market = useMarketplaceStore()
const connections = useConnectionsStore()
const health = useHealth()
const { themes } = useThemes()
const { t } = useI18n()

const query = vref('')
/** The submenus opened, outermost first. */
const stack = vref<Command[]>([])
const active = vref(-1)
const recent = vref<string[]>([])
const input = vref<HTMLInputElement | null>(null)
const list = vref<HTMLElement | null>(null)
let previousFocus: HTMLElement | null = null

const ui: PaletteUi = {
  ...editorFocus,
  renamePage: (i) => { const p = s.screen.value?.pages[i]; if (p) renameRequest.value = { kind: 'page', id: p.id } },
  renameScreen: (id) => { renameRequest.value = { kind: 'screen', id } },
  openHistory: () => openHistory(s),
  openShortcuts: () => s.openModal('shortcuts'),
}

const commands = computed<Command[]>(() => (paletteOpen.value
  ? buildCommands({
    store: s, market, ui,
    health: { entries: health.entries.value, fix: health.fix, update: health.update, run: health.run },
    connections: connections.state.connections,
    connectionTypes: connections.state.types,
    themes: Object.values(themes.value).map((x) => ({ id: x.id, label: pick(x.name) || x.id }))
      .sort((a, b) => Number(b.id === BUILTIN_THEME) - Number(a.id === BUILTIN_THEME) || a.label.localeCompare(b.label)),
    theme: s.state.config?.theme ?? BUILTIN_THEME,
  })
  : []))

const sections = computed(() => {
  const parent = stack.value[stack.value.length - 1]
  return parent
    ? searchCommands(parent.children ?? [], query.value, [], { whole: true })
    : searchCommands(commands.value, query.value, recent.value)
})
/** Every row, in the order drawn: what ↑ and ↓ walk. */
const rows = computed<Hit[]>(() => sections.value.flatMap((x) => x.hits))
const rowIndex = (section: number, i: number): number =>
  sections.value.slice(0, section).reduce((n, x) => n + x.hits.length, 0) + i

function title(group: PaletteGroup): string {
  if (stack.value.length) return ''
  if (group === 'widget') {
    const sel = s.selected.value
    if (s.state.selection.length > 1) return t('admin.inspector.selection.title', { n: s.state.selection.length })
    return sel ? (sel.title?.trim() || pick(s.state.manifests[sel.widgetId]?.name) || sel.widgetId) : ''
  }
  return t(`admin.palette.group.${group}`)
}
/** The muted text after a label: its context, and the submenus a search found it in. */
const contextOf = (hit: Hit): string => [hit.command.context, ...hit.trail].filter(Boolean).join(' › ')

const firstRow = (): number => step(rows.value.map((h) => ({ label: h.command.label, disabled: h.command.disabled })), -1, 1)
watch([sections], () => { active.value = firstRow() })
watch(active, async () => {
  await nextTick()
  list.value?.querySelector('.fk-menu-item.active')?.scrollIntoView({ block: 'nearest' })
})

watch(paletteOpen, async (open) => {
  if (open) {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    query.value = ''
    stack.value = []
    recent.value = readRecent()
    await nextTick()
    active.value = firstRow()
    input.value?.focus()
  }
})

function close(restoreFocus: boolean): void {
  paletteOpen.value = false
  const back = previousFocus
  previousFocus = null
  if (restoreFocus && back && document.contains(back)) back.focus({ preventScroll: true })
}

function openSub(command: Command): void {
  if (!command.children?.length || command.disabled) return
  stack.value = [...stack.value, command]
  query.value = ''
}

function activate(index: number): void {
  const hit = rows.value[index]
  if (!hit || hit.command.disabled) return
  const command = hit.command
  if (!command.run) { openSub(command); return }
  recent.value = pushRecent(recent.value, command.id)
  writeRecent(recent.value)
  close(false)
  command.run()
}

function move(delta: 1 | -1): void {
  active.value = step(rows.value.map((h) => ({ label: h.command.label, disabled: h.command.disabled })), active.value, delta)
}

function onKey(e: KeyboardEvent): void {
  // The palette owns the keyboard while it is open: the editor's shortcuts behind it see nothing.
  e.stopPropagation()
  const field = input.value
  const atEnd = !field || field.selectionStart === field.value.length
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); move(1); return
    case 'ArrowUp': e.preventDefault(); move(-1); return
    case 'Enter': e.preventDefault(); activate(active.value); return
    case 'Tab': e.preventDefault(); return
    case 'Escape':
      e.preventDefault()
      if (stack.value.length) { stack.value = stack.value.slice(0, -1); query.value = '' } else close(true)
      return
    case 'ArrowRight': {
      const command = rows.value[active.value]?.command
      if (atEnd && command?.children?.length) { e.preventDefault(); openSub(command) }
      return
    }
    case 'ArrowLeft':
    case 'Backspace':
      if (!query.value && stack.value.length) { e.preventDefault(); stack.value = stack.value.slice(0, -1) }
      return
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); close(true) }
}

const placeholder = computed(() => (stack.value.length ? t('admin.palette.filter') : t('admin.palette.placeholder')))
const emptyQuery = computed(() => !rows.value.length)
</script>

<template>
  <Teleport to="body">
    <div v-if="paletteOpen" class="backdrop" data-overlay @pointerdown.self="close(true)">
      <div class="palette fk-menu" role="dialog" :aria-label="t('admin.palette.title')" @keydown="onKey">
        <div class="field">
          <BaseIcon name="search" :size="16" />
          <span v-for="(c, i) in stack" :key="i" class="crumb">{{ c.label }}<BaseIcon name="chevron-right" :size="12" /></span>
          <input ref="input" v-model="query" type="text" :placeholder="placeholder" spellcheck="false" autocomplete="off"
            role="combobox" aria-expanded="true" aria-controls="palette-list" :aria-label="t('admin.palette.title')"
            :aria-activedescendant="active >= 0 ? `palette-row-${active}` : undefined" />
          <kbd>{{ shortcutHint('palette') }}</kbd>
        </div>
        <div id="palette-list" ref="list" class="list" role="listbox">
          <template v-for="(section, si) in sections" :key="section.group">
            <div v-if="title(section.group)" class="head" role="presentation">{{ title(section.group) }}</div>
            <div
              v-for="(hit, i) in section.hits" :id="`palette-row-${rowIndex(si, i)}`" :key="hit.command.id + i"
              class="fk-menu-item row" role="option" :aria-selected="active === rowIndex(si, i)"
              :aria-disabled="hit.command.disabled ? 'true' : undefined"
              :class="{ active: active === rowIndex(si, i), disabled: hit.command.disabled, danger: hit.command.danger }"
              @pointermove="!hit.command.disabled && (active = rowIndex(si, i))"
              @click="activate(rowIndex(si, i))"
            >
              <span class="mark"><BaseIcon v-if="hit.command.checked" name="check" :size="13" /></span>
              <span class="label">{{ hit.command.label }}</span>
              <span v-if="contextOf(hit)" class="context">{{ contextOf(hit) }}</span>
              <span v-if="hit.command.children?.length" class="fk-menu-tail"><BaseIcon name="chevron-right" :size="13" /></span>
              <span v-else-if="hit.command.shortcut" class="fk-menu-tail fk-menu-key">{{ hit.command.shortcut }}</span>
            </div>
            <div v-if="section.more" class="more" role="presentation">{{ t('admin.palette.more', { n: section.more }) }}</div>
          </template>
          <p v-if="emptyQuery" class="empty">{{ query ? t('admin.palette.empty', { query }) : t('admin.palette.nothing') }}</p>
        </div>
        <footer>{{ t('admin.palette.hints') }}</footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop { position: fixed; inset: 0; z-index: 900; display: flex; justify-content: center; align-items: flex-start;
  padding: 14vh 16px 16px; }
.palette { width: min(640px, 100%); max-height: min(560px, 76vh); display: flex; flex-direction: column; overflow: hidden; }
.field { display: flex; align-items: center; gap: 8px; padding: 10px 14px; color: var(--text-muted);
  border-bottom: 1px solid color-mix(in srgb, var(--border-strong) 70%, transparent); }
.field input { flex: 1 1 auto; min-width: 0; font: inherit; font-size: var(--fs-md, 15px); color: var(--text);
  background: transparent; border: 0; outline: none; padding: 4px 0; }
.field input:focus-visible { box-shadow: none; }
.field input::placeholder { color: var(--text-dim); }
.crumb { display: inline-flex; align-items: center; gap: 2px; flex: 0 0 auto; padding: 2px 6px; border-radius: 5px;
  color: var(--text); background: color-mix(in srgb, var(--surface-3, var(--surface-2)) 80%, transparent); }
kbd { flex: 0 0 auto; font-family: inherit; font-size: var(--fs-xs); color: var(--text-dim); }
.list { flex: 1 1 auto; overflow-y: auto; padding: 5px; }
.head { padding: 8px 8px 3px; font-size: var(--fs-xs); font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
  color: var(--text-muted); }
.row { min-height: 30px; cursor: default; }
.mark { width: 14px; flex: 0 0 14px; display: inline-flex; align-items: center; justify-content: center; }
.label { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.context { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--text-muted); margin-left: 6px; }
.row.active .context { color: inherit; opacity: .8; }
.row:not(:has(.context)) .label { flex: 1 1 auto; }
.more { padding: 3px 8px 3px 28px; font-size: var(--fs-xs); color: var(--text-dim); }
.empty { margin: 0; padding: 16px; text-align: center; color: var(--text-muted); }
footer { flex: 0 0 auto; padding: 6px 14px; font-size: var(--fs-xs); color: var(--text-dim);
  border-top: 1px solid color-mix(in srgb, var(--border-strong) 70%, transparent); }
</style>
