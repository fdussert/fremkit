<script setup lang="ts">
/**
 * The version, the people, the links and the diagnostics. Moved out of the former
 * ScreenInspector.vue.
 */
import { computed, nextTick, ref } from 'vue'
import BaseCheckbox from '../../shared/ui/BaseCheckbox.vue'
import BaseSection from '../../shared/ui/BaseSection.vue'
import DiagnosticsSection from '../DiagnosticsSection.vue'
import { useI18n } from '../../shared/i18n'
import { useAdminStore } from '../store'
import { labsShown, tapVersion } from '../labs'
import type { Labs } from '../../shared/types'
import { CONTRIBUTORS, MAINTAINER, REGISTRY_REPOSITORY, REPOSITORY, VERSION } from '../../shared/credits'

const s = useAdminStore()
const { t, locale } = useI18n()

/**
 * The experimental features block: one checkbox per `config.labs` flag. It appears after seven
 * clicks on the version (see `labs.ts`) and stays while any flag is on, so it can be turned off
 * again. Each switch goes through `apply` like every setting: saved, undoable, in the history.
 *
 * A flag added to `LabsSchema` gets one entry here, its label and hint keys in both locales:
 * `{ key: 'name', label: 'admin.inspector.screen.labs.name', hint: '….hint' }`. With none, the
 * block says there is nothing to try right now rather than show an empty heading.
 */
const LAB_FLAGS: readonly { key: keyof Labs; label: string; hint: string }[] = []
const labsVisible = computed(() => labsShown(s.state.config))
/**
 * The block appears right under the version; focusing its first box (the block itself when there
 * is none) brings it into view and tells a screen reader what just appeared. The admin's toast is
 * for errors, so it is not used here.
 */
const labsBlock = ref<HTMLElement>()
function onVersionClick(): void {
  if (!tapVersion()) return
  void nextTick(() => (labsBlock.value?.querySelector<HTMLInputElement>('input') ?? labsBlock.value)?.focus())
}
/** Sets one flag and keeps the others as they are. */
function setLab(key: keyof Labs, on: boolean): void {
  s.apply((c) => { c.labs = { ...c.labs, [key]: on } })
}

/** "A, B and C" in the language in force, so a third contributor needs no new string. */
const contributors = computed(() =>
  new Intl.ListFormat(locale.value, { type: 'conjunction' }).format(CONTRIBUTORS.map((p) => p.handle)))
</script>

<template>
  <BaseSection id="screen.about" :title="t('admin.inspector.screen.about')">
  <!-- Plain text to the eye, and a tab stop: seven clicks, or seven presses of Enter (held-key repeats do not count), reveal the
       experimental features, so the gesture has a keyboard path. Deliberately not styled or
       announced as a button — it is the version, with a hidden gesture on it. -->
  <p class="ro version" data-test="version" tabindex="0" @click="onVersionClick()" @keydown.enter.prevent="!$event.repeat && onVersionClick()">{{ t('admin.inspector.screen.about.version', { version: VERSION }) }}</p>
  <p class="ro">{{ t('admin.inspector.screen.about.authors', { maintainer: MAINTAINER.handle, contributors }) }}</p>
  <!-- A new tab in a browser; the helper's admin window hands these to the default browser
       rather than replacing the admin with them. -->
  <dl class="links">
    <dt>{{ t('admin.inspector.screen.about.source') }}</dt>
    <dd><a class="mono" :href="REPOSITORY" target="_blank" rel="noopener noreferrer">{{ REPOSITORY.replace('https://', '') }}</a></dd>
    <dt>{{ t('admin.inspector.screen.about.sietch') }}</dt>
    <dd><a class="mono" :href="REGISTRY_REPOSITORY" target="_blank" rel="noopener noreferrer">{{ REGISTRY_REPOSITORY.replace('https://', '') }}</a></dd>
  </dl>
  <p class="ro">{{ t('admin.inspector.screen.about.registry') }}</p>
  <p class="ro">{{ t('admin.inspector.screen.about.icons') }}</p>
  <DiagnosticsSection />
  <div v-if="labsVisible" ref="labsBlock" class="labs" data-test="labs" tabindex="-1">
    <h3>{{ t('admin.inspector.screen.labs') }}</h3>
    <template v-for="flag in LAB_FLAGS" :key="flag.key">
      <BaseCheckbox :model-value="s.state.config?.labs?.[flag.key] === true" :label="t(flag.label)"
        :data-test="`labs-${flag.key}`" @update:model-value="setLab(flag.key, $event)" />
      <p class="ro">{{ t(flag.hint) }}</p>
    </template>
    <p v-if="!LAB_FLAGS.length" class="ro" data-test="labs-none">{{ t('admin.inspector.screen.labs.none') }}</p>
  </div>
  </BaseSection>
</template>

<style scoped>
.ro { margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--text-muted); }
.version:focus-visible { outline: 1px dotted var(--text-muted); outline-offset: 2px; }
.labs:focus { outline: none; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
.links { display: grid; grid-template-columns: auto 1fr; gap: var(--space-1) var(--space-3); margin: 0 0 var(--space-2);
  font-size: var(--fs-sm); color: var(--text-muted); }
.links dd { margin: 0; min-width: 0; }
.links a { color: var(--accent); text-decoration: none; }
.links a:hover { text-decoration: underline; }
</style>
