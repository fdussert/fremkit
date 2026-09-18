<script setup lang="ts">
/**
 * One theme of the registry.
 *
 * A theme has no permissions to declare and nothing to consent to, so the card says less than a
 * widget's and shows more: the four tokens as a strip of swatches, which is what somebody is
 * actually choosing between. That is why the index carries them — a theme needs no preview image
 * and this card needs no second request.
 *
 * The strip is the one place a value an outside author wrote reaches a `style` attribute. It is
 * checked here again all the same: the server validates every token against the shape its CSS
 * property accepts, and this is the copy that does not depend on that having happened.
 */
import { computed } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseCard from '../shared/ui/BaseCard.vue'
import { pick, useI18n } from '../shared/i18n'
import { useMarketplaceStore } from './marketplace'
import { useAdminStore } from './store'
import type { MarketplaceTheme } from '../shared/types'

const props = defineProps<{ theme: MarketplaceTheme }>()
const store = useMarketplaceStore()
const { t } = useI18n()

/** The shape a colour has. Anything else is dropped rather than written into the attribute. */
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/

const ORDER = ['bg', 'surface', 'accent', 'text'] as const
const swatches = computed(() => ORDER
  .map((key) => ({ key, value: props.theme.tokens[key] }))
  .filter((s) => COLOR_RE.test(s.value ?? '')))

const meta = computed(() => {
  const kb = Math.max(1, Math.round(props.theme.size / 1024))
  return [props.theme.author, props.theme.license, `v${props.theme.version}`, `${kb} kB`].filter(Boolean).join(' · ')
})

/**
 * Whether the screen is painted with it — read from the config the admin holds live, not from
 * the index snapshot.
 *
 * `inUse` arrives with the entry, and the entry is fetched when the panel opens. Choosing this
 * theme in Screen → Theme afterwards does not touch that copy, so the card went on offering a
 * Remove the server answers 409 to. The config is the authority on which theme is in use and the
 * admin already has it; the server's answer is the fallback for a page that has not loaded one.
 */
const inUse = computed(() => {
  const chosen = useAdminStore().state.config?.display.theme
  return chosen === undefined ? props.theme.inUse : chosen === props.theme.id
})

const busy = computed(() => store.state.busy === props.theme.id)
const locked = computed(() => store.state.busy !== null || store.state.updatingAll)
</script>

<template>
  <BaseCard class="row" :data-theme="theme.id">
    <span class="strip">
      <i v-for="s in swatches" :key="s.key" class="sw" :style="{ background: s.value }" :title="s.key"></i>
    </span>
    <div class="txt">
      <strong>
        {{ pick(theme.name) }}
        <span v-if="theme.installed" class="state"><i class="dot ok"></i>{{ t('admin.market.installedAt', { version: theme.installedVersion ?? '' }) }}</span>
        <span v-if="theme.updateAvailable" class="chip up">{{ t('admin.market.updateTo', { version: theme.version }) }}</span>
        <span v-if="inUse" class="chip">{{ t('admin.market.themeInUse') }}</span>
      </strong>
      <small>{{ pick(theme.description) }}</small>
      <small class="meta">{{ meta }}</small>
    </div>
    <div class="act">
      <span v-if="theme.shadowsBuiltin" class="why">{{ t('admin.market.builtinTheme') }}</span>
      <template v-else-if="busy">
        <span class="why working">{{ t('admin.market.working') }}</span>
      </template>
      <template v-else>
        <BaseButton v-if="theme.updateAvailable" :disabled="locked" @click="store.installTheme(theme, true)">
          {{ t('admin.market.update') }}
        </BaseButton>
        <BaseButton v-else-if="!theme.installed" :disabled="locked" @click="store.installTheme(theme)">
          {{ t('admin.market.install') }}
        </BaseButton>
        <!-- Removing the theme the screen is painted with is refused by the server; saying so
             here saves the trip, and the chip above already explains why. -->
        <BaseButton v-if="theme.installed" variant="danger" :disabled="locked || inUse"
          :title="inUse ? t('admin.market.themeInUse') : undefined"
          @click="store.uninstallTheme(theme.id)">
          {{ t('admin.market.uninstall') }}
        </BaseButton>
      </template>
    </div>
  </BaseCard>
</template>

<style scoped>
.row { align-items: flex-start; }
.strip { display: flex; flex-direction: column; gap: 2px; flex: 0 0 auto; }
.sw { width: 20px; height: 9px; border-radius: 2px; border: 1px solid var(--border); }
.txt { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.txt strong { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; font-size: var(--fs-sm); font-weight: 600; }
.txt small { font-size: var(--fs-xs); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; }
.meta { color: var(--text-dim); }
.state { display: inline-flex; align-items: center; gap: var(--space-1); font-size: var(--fs-xs); font-weight: 400; color: var(--text-muted); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); flex: 0 0 auto; }
.chip { font-size: var(--fs-xs); font-weight: 400; color: var(--text-muted); border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm); padding: 0 5px; }
.chip.up { color: var(--on-accent); background: var(--accent); border-color: var(--accent); }
.act { display: flex; flex-direction: column; align-items: flex-end; gap: var(--space-1); flex: 0 0 auto; }
.why { font-size: var(--fs-xs); color: var(--text-dim); text-align: right; max-width: 10rem; }
.why.working { color: var(--accent); }
</style>
