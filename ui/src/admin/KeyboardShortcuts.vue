<script setup lang="ts">
/**
 * The keyboard shortcuts sheet (`?`, or the palette's "Keyboard shortcuts"). Drawn from the one
 * table the key handler matches against (`shortcuts.ts`), so it lists what the keys do, not what
 * somebody remembered to write down.
 */
import { useI18n } from '../shared/i18n'
import { shortcutsByGroup } from './shortcuts'

const { t } = useI18n()
const groups = shortcutsByGroup()
</script>

<template>
  <div class="sheet">
    <section v-for="g in groups" :key="g.group">
      <h3>{{ t(`admin.shortcuts.group.${g.group}`) }}</h3>
      <dl>
        <div v-for="s in g.shortcuts" :key="s.id" class="row">
          <dt>{{ t(`admin.shortcuts.${s.id}`) }}</dt>
          <dd><kbd>{{ s.display }}</kbd></dd>
        </div>
      </dl>
    </section>
  </div>
</template>

<style scoped>
.sheet { display: grid; gap: var(--space-4); }
h3 { margin: 0 0 var(--space-2); font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted); }
dl { margin: 0; }
.row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);
  padding: 6px 0; border-bottom: 1px solid var(--border); }
.row:last-child { border-bottom: 0; }
dt { font-size: var(--fs-sm); color: var(--text); }
dd { margin: 0; flex: 0 0 auto; }
kbd { display: inline-block; min-width: 22px; padding: 2px 7px; text-align: center; font-family: inherit;
  font-size: var(--fs-sm); color: var(--text); background: var(--surface-2); border: 1px solid var(--border-strong);
  border-bottom-width: 2px; border-radius: 5px; }
</style>
