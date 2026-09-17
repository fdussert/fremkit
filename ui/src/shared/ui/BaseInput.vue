<script setup lang="ts">
/**
 * `lazy` commits on change/blur instead of on every keystroke, so a typed word is one edit —
 * one undo step, one save — rather than one per character.
 */
const props = withDefaults(defineProps<{ modelValue: string | number; type?: 'text' | 'number'; placeholder?: string; invalid?: boolean; min?: number; max?: number; disabled?: boolean; lazy?: boolean }>(), { type: 'text' })
const emit = defineEmits<{ 'update:modelValue': [value: string | number] }>()
function commit(e: Event) {
  const raw = (e.target as HTMLInputElement).value
  // An empty number field is NaN, never 0: the caller decides whether that is an error.
  emit('update:modelValue', props.type === 'number' ? (raw.trim() === '' ? Number.NaN : Number(raw)) : raw)
}
function onInput(e: Event) { if (!props.lazy) commit(e) }
function onChange(e: Event) { if (props.lazy) commit(e) }
// Outside a <form>, Enter alone fires no change event: blur so a lazy field commits on Enter too.
function onEnter(e: KeyboardEvent) { if (props.lazy) (e.target as HTMLInputElement).blur() }
</script>

<template>
  <input :type="type" :value="modelValue" :placeholder="placeholder" :min="min" :max="max" :disabled="disabled"
    :class="{ invalid }" @input="onInput" @change="onChange" @keydown.enter="onEnter" />
</template>

<style scoped>
input { width: 100%; box-sizing: border-box; font: inherit; font-size: var(--fs-sm); color: var(--text);
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 6px 8px; }
input.invalid { border-color: var(--danger); }
input:disabled { opacity: .55; }
</style>
