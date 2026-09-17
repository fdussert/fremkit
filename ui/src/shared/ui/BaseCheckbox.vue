<script setup lang="ts">
defineProps<{ modelValue: boolean; label: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>

<template>
  <label class="cb">
    <input type="checkbox" :checked="modelValue" @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)" />
    <span>{{ label }}</span>
  </label>
</template>

<style scoped>
.cb { display: flex; align-items: center; gap: var(--space-2); font-size: var(--fs-sm); margin-bottom: var(--space-3); cursor: pointer; }
input { accent-color: var(--accent); width: 16px; height: 16px; }
</style>
