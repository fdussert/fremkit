<script setup lang="ts">
withDefaults(defineProps<{ variant?: 'primary' | 'secondary' | 'danger' | 'icon'; disabled?: boolean; title?: string; active?: boolean }>(), { variant: 'secondary' })
</script>

<template>
  <button type="button" :class="[variant, { active }]" :disabled="disabled" :title="title">
    <slot />
  </button>
</template>

<style scoped>
button { display: inline-flex; align-items: center; gap: var(--space-2); font: inherit; font-size: var(--fs-sm); cursor: pointer;
  border-radius: var(--radius-sm); padding: 6px 12px; border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--text); }
button:hover:not(:disabled) { background: var(--surface-3); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
button.primary:hover:not(:disabled) { background: var(--accent-hover); }
button.danger { background: transparent; border-color: var(--danger); color: var(--danger); }
button.danger:hover:not(:disabled) { background: rgba(217, 70, 63, .12); }
button.icon { padding: 6px; border-color: transparent; background: transparent; color: var(--text-muted); }
button.icon:hover:not(:disabled) { background: var(--surface-3); color: var(--text); }
button.active { border-color: var(--accent); color: var(--text); }
button:disabled { opacity: .45; cursor: default; }
</style>
