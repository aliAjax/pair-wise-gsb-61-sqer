<script setup lang="ts">
defineProps<{
  revision?: number;
  prefix?: string;
}>();
</script>

<template>
  <UBadge :color="revision == null ? 'amber' : 'gray'" variant="soft" class="font-mono">
    {{ prefix ?? '依据' }} {{ revision == null ? '待回填' : `R${revision}` }}
  </UBadge>
</template>
