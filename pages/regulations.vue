<script setup lang="ts">
import { regulationCatalog } from '~/data/seed';
import { useCertificationStore } from '~/stores/certification';

const store = useCertificationStore();
const selectedCategory = ref('全部');
const selectedProjectId = ref('TA-2026-118');

const categories = computed(() => ['全部', ...Array.from(new Set(regulationCatalog.map((item) => item.category)))]);

const selectedProject = computed(() => store.projectById(selectedProjectId.value));
// 法规树直接使用项目内随版本重算的法规项，保证与页面、审计同一版本依据
const projectRegulations = computed(() => selectedProject.value?.regulations ?? []);
const visible = computed(() =>
  selectedCategory.value === '全部'
    ? projectRegulations.value
    : projectRegulations.value.filter((item) => item.category === selectedCategory.value)
);
const projectOptions = computed(() => store.projects.map((project) => ({ label: `${project.id} · ${project.name}`, value: project.id })));

onMounted(() => store.hydrate());
</script>

<template>
  <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold">法规项目树</h1>
      <p class="mt-1 text-sm text-slate-600">
        按安全、环保、能耗、软件和部件分类查看证据覆盖；覆盖状态随项目版本变更链重算。
      </p>
    </div>
    <div class="min-w-[320px]">
      <UFormGroup label="查看认证项目">
        <USelect v-model="selectedProjectId" :options="projectOptions" />
      </UFormGroup>
    </div>
  </div>

  <div v-if="selectedProject" class="mb-4 flex flex-wrap items-center gap-3 text-sm text-slate-600">
    <UBadge color="gray" variant="soft">统一版本依据</UBadge>
    <span>
      {{ selectedProject.versions[0]?.label }} · R{{ selectedProject.revision }}
      （{{ selectedProject.maintenanceVersion }} / SW {{ selectedProject.softwareVersion }}）
    </span>
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
    v-if="selectedProject"
    :regulations="visible"
    :evidence="selectedProject.evidence"
    :basis-label="selectedProject.versions[0]?.label"
    :revision="selectedProject.revision"
  />
  <div v-else class="border border-red-200 bg-red-50 p-6 text-red-900">未找到所选认证项目。</div>
</template>
