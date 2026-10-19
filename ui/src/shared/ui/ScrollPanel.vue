<script setup lang="ts">
/**
 * A panel whose header stays put while its list scrolls under it: a title, its tools, whatever
 * the header slot adds (a search box, tabs), and — when the list holds several sections — an
 * "expand all" and a "collapse all".
 *
 * The widget library was the first to want it, then the settings window, the Sietch and the
 * widget inspector: one piece, so the four fold their sections with the same two buttons in the
 * same place. The parent gives it a height (a flex column, a modal body); it fills it.
 *
 * `--scroll-panel-pad` sets the side padding of both parts, so the scrollbar sits at the edge.
 */
import BaseButton from './BaseButton.vue'
import BaseIcon from './BaseIcon.vue'
import { setSectionsOpen } from './BaseSection.vue'
import { useI18n } from '../i18n'

const props = withDefaults(defineProps<{
  /** Every section the list can show, found or not, so "collapse all" also folds a hidden one. */
  sectionIds?: readonly string[]
  /** While a search forces the sections open, folding them would do nothing visible. */
  foldDisabled?: boolean
}>(), { sectionIds: () => [], foldDisabled: false })

const { t } = useI18n()
</script>

<template>
  <div class="scroll-panel">
    <div class="head">
      <div v-if="$slots.title || $slots.tools || props.sectionIds.length > 1" class="title-row">
        <div class="title"><slot name="title" /></div>
        <span class="tools">
          <template v-if="props.sectionIds.length > 1">
            <BaseButton variant="icon" :title="t('common.expandAll')" :disabled="foldDisabled"
              @click="setSectionsOpen(props.sectionIds, true)">
              <BaseIcon name="chevrons-up-down" :size="16" />
            </BaseButton>
            <BaseButton variant="icon" :title="t('common.collapseAll')" :disabled="foldDisabled"
              @click="setSectionsOpen(props.sectionIds, false)">
              <BaseIcon name="chevrons-down-up" :size="16" />
            </BaseButton>
          </template>
          <slot name="tools" />
        </span>
      </div>
      <slot name="header" />
    </div>
    <div class="scroll" data-scroll><slot /></div>
  </div>
</template>

<style scoped>
.scroll-panel { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.head { flex: 0 0 auto; padding: 0 var(--scroll-panel-pad, 0); }
.title-row { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-2); }
.title { flex: 1; min-width: 0; }
.tools { display: inline-flex; gap: 2px; flex: 0 0 auto; }
.scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 var(--scroll-panel-pad, 0) var(--space-3); }
</style>
