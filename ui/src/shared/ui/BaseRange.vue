<script setup lang="ts">
import { ref, watch } from 'vue'
/**
 * A slider that commits on `change`, never on `input`: dragging the thumb would otherwise push
 * one config save — and one undo step — per pixel it travels. The readout next to it follows
 * the thumb live, so the user sees the value they are about to commit. Values are whole units
 * of whatever the caller works in (every use so far is a percent).
 */
const props = withDefaults(defineProps<{
  modelValue: number
  min?: number
  max?: number
  step?: number
  unit?: string
  ariaLabel?: string
}>(), { min: 0, max: 100, step: 1, unit: '%', ariaLabel: undefined })

const emit = defineEmits<{ change: [value: number] }>()
const live = ref(props.modelValue)
watch(() => props.modelValue, (v) => { live.value = v })

function onInput(e: Event): void {
  const value = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(value)) live.value = value
}
function onChange(e: Event): void {
  const value = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(value)) emit('change', value)
}
</script>

<template>
  <div class="row">
    <input
      class="range"
      type="range"
      :min="props.min"
      :max="props.max"
      :step="props.step"
      :value="props.modelValue"
      :aria-label="props.ariaLabel"
      @input="onInput"
      @change="onChange"
    />
    <span class="value">{{ live }}{{ props.unit ? ' ' + props.unit : '' }}</span>
  </div>
</template>

<style scoped>
.row { display: flex; align-items: center; gap: var(--space-3); }
.range { flex: 1; min-width: 0; accent-color: var(--accent); }
.value { flex: 0 0 auto; min-width: 4ch; text-align: right; font-size: var(--fs-sm); color: var(--text-muted); font-variant-numeric: tabular-nums; }
</style>
