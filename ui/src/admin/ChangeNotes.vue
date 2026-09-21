<script setup lang="ts">
/**
 * What a version changed, as the package's own changelog put it.
 *
 * The one question somebody has in front of an Update button, and until now the dialog answered
 * only with permissions — which say what a widget *may* do, never what is different about it.
 *
 * Rendered with `{{ }}` and `white-space: pre-wrap`: the text came over the network, out of a
 * file written in a pull request. The registry strips the markdown at its end; this end never
 * treats the result as markup, whatever the registry did or failed to do.
 *
 * Long entries are clamped to two lines with a button to open them, so a card stays a card.
 */
import { computed, ref } from 'vue'
import { useI18n } from '../shared/i18n'

const props = withDefaults(defineProps<{
  /** The latest version's entry, when there is one. */
  changes?: string
  /** Every version that said something, newest first. Only shown once expanded. */
  history?: { version: string; changes: string }[]
  /** Whether to say "no notes" rather than draw nothing. The dialogs do; a card does not. */
  sayWhenEmpty?: boolean
}>(), { history: () => [], sayWhenEmpty: false })

const { t } = useI18n()
const open = ref(false)

/** More than the latest entry to show: earlier versions, or a long one. */
const expandable = computed(() =>
  props.history.length > 1 || (props.changes ?? '').length > 120 || (props.changes ?? '').includes('\n'))

/** The versions before the latest, which somebody several updates behind is also accepting. */
const earlier = computed(() => props.history.slice(1))
</script>

<template>
  <div v-if="changes" class="notes">
    <span class="lbl">{{ t('admin.market.whatChanges') }}</span>
    <p class="text" :class="{ clamped: !open }">{{ changes }}</p>
    <button v-if="expandable" type="button" class="more" @click="open = !open">
      {{ open ? t('admin.market.changesLess') : t('admin.market.changesMore') }}
    </button>
    <template v-if="open">
      <div v-for="entry in earlier" :key="entry.version" class="earlier">
        <span class="v">{{ entry.version }}</span>
        <p class="text">{{ entry.changes }}</p>
      </div>
    </template>
  </div>
  <p v-else-if="sayWhenEmpty" class="no-notes">{{ t('admin.market.noChanges') }}</p>
</template>

<style scoped>
.notes { margin: var(--space-1) 0 0; }
.lbl { display: block; font-size: var(--fs-xs); color: var(--text-muted);
  text-transform: uppercase; letter-spacing: .06em; }
/* The author's own words, newlines kept, never parsed as anything. */
.text { margin: 2px 0 0; font-size: var(--fs-xs); color: var(--text); white-space: pre-wrap;
  word-break: break-word; }
.text.clamped { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2;
  -webkit-box-orient: vertical; overflow: hidden; }
.more { font: inherit; font-size: var(--fs-xs); color: var(--accent); background: none; border: 0;
  padding: 2px 0 0; cursor: pointer; text-decoration: underline; }
.earlier { margin-top: var(--space-2); }
.earlier .v { font-size: var(--fs-xs); color: var(--text-dim); font-variant-numeric: tabular-nums; }
.no-notes { margin: var(--space-1) 0 0; font-size: var(--fs-xs); color: var(--text-dim); }
</style>
