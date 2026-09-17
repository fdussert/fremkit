<script setup lang="ts">
/**
 * Native colour picker, framed like BaseInput, with the hex shown next to it and an
 * optional reset. `modelValue` may be empty: the swatch then previews `fallback`
 * (the value actually in use) without pretending the instance carries a colour.
 */
const props = withDefaults(defineProps<{ modelValue: string; fallback?: string; resetLabel?: string; ariaLabel?: string }>(), {
  fallback: '#d9b36a',
})
const emit = defineEmits<{ 'update:modelValue': [value: string]; reset: [] }>()
function onChange(e: Event): void {
  emit('update:modelValue', (e.target as HTMLInputElement).value)
}
</script>

<template>
  <!--
    A plain div, not a <label>: these sit inside BaseField's own <label>, and a nested one
    would make every click in the row reopen the colour picker. The reset button stops its
    click for the same reason.
  -->
  <div class="row">
    <div class="field">
      <input type="color" :value="modelValue || fallback" :aria-label="ariaLabel" @change="onChange" />
      <span class="hex">{{ modelValue || fallback }}</span>
    </div>
    <button v-if="resetLabel && props.modelValue" type="button" class="reset" @click.prevent.stop="emit('reset')">
      {{ resetLabel }}
    </button>
  </div>
</template>

<style scoped>
.row { display: flex; align-items: center; gap: var(--space-2); }
.field { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--space-2);
  box-sizing: border-box; background: var(--surface); border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm); padding: 5px 8px; }
/* Strip the platform chrome so the swatch reads as one flat rectangle in the frame. */
input[type='color'] { flex: 0 0 auto; width: 28px; height: 20px; padding: 0; border: 0; background: none; cursor: pointer; }
input[type='color']::-webkit-color-swatch-wrapper { padding: 0; }
input[type='color']::-webkit-color-swatch { border: 1px solid var(--border-strong); border-radius: 4px; }
.hex { font-size: var(--fs-sm); color: var(--text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.reset { flex: 0 0 auto; font: inherit; font-size: var(--fs-xs); color: var(--text-muted);
  background: none; border: 0; padding: 4px 2px; cursor: pointer; text-decoration: underline; }
.reset:hover { color: var(--text); }
</style>
