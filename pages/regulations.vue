<script setup lang="ts">
import { useCertificationStore } from '~/stores/certification';

const store = useCertificationStore();
const selectedCategory = ref('全部');
const selectedProjectId = ref('TA-2026-118');

const selectedProject = computed(() => store.projectById(selectedProjectId.value));
const projectOptions = computed(() => store.projects.map((project) => ({ label: `${project.id} · ${project.name}`, value: project.id })));
const categories = computed(() => [
  '全部',
  ...Array.from(new Set((selectedProject.value?.regulations ?? []).map((item) => item.category)))
]);
const visible = computed(() => {
  const regulations = selectedProject.value?.regulations ?? [];
  return selectedCategory.value === '全部'
    ? regulations
    : regulations.filter((item) => item.category === selectedCategory.value);
});

onMounted(() => {
  store.hydrate();
});
</script>

<template>
  <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold">法规项目树</h1>
      <p class="mt-1 text-sm text-slate-600">按安全、环保、能耗、软件和部件分类查看证据覆盖与配置完整性。</p>
    </div>
    <div class="min-w-[320px]">
      <UFormGroup label="查看认证项目">
        <USelect v-model="selectedProjectId" :options="projectOptions" />
      </UFormGroup>
    </div>
  </div>

  <template v-if="selectedProject">
    <div class="mb-5 flex flex-wrap items-center gap-3 border border-slate-200 bg-white px-4 py-3">
      <RevisionBadge :revision="selectedProject.revision" prefix="版本依据" />
      <span class="text-sm text-slate-600">
        {{ selectedProject.maintenanceVersion }} / SW {{ selectedProject.softwareVersion }} · {{ selectedProject.configuration }}
      </span>
      <span class="text-xs text-slate-400">与项目页、审计记录显示同一版本依据</span>
    </div>

    <div class="mb-5 flex flex-wrap gap-2">
      <UButton
        v-for="category in categories"
        :key="category"
        size="xs"
        :variant="selectedCategory === category ? 'solid' : 'soft'"
        :color="selectedCategory === category ? 'primary' : 'gray'"
        @click="selectedCategory = category"
      >
        {{ category }}
      </UButton>
    </div>

    <RegulationTree
      :regulations="visible"
      :evidence="selectedProject.evidence"
    />
  </template>
  <div v-else class="border border-red-200 bg-red-50 p-6 text-red-900">未找到所选认证项目。</div>
</template>
