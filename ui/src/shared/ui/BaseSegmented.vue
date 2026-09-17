<script setup lang="ts">
import BaseIcon from './BaseIcon.vue'
defineProps<{ modelValue: string; options: { value: string; label: string; icon?: string }[] }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <div class="seg">
    <button v-for="o in options" :key="o.value" type="button" :class="{ on: o.value === modelValue }"
      @click="emit('update:modelValue', o.value)">
      <BaseIcon v-if="o.icon" :name="o.icon" :size="16" />{{ o.label }}
    </button>
  </div>
</template>

<style scoped>
.seg { display: flex; background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 2px; gap: 2px; }
button { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: var(--space-1); font: inherit;
  font-size: var(--fs-xs); cursor: pointer; border: 0; border-radius: 6px; padding: 5px 8px; background: transparent; color: var(--text-muted); }
button.on { background: var(--accent); color: var(--on-accent); }
</style>
