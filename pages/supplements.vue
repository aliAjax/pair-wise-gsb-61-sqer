<script setup lang="ts">
import { validateEvidenceUpgrade } from '~/services/validators';
import { useCertificationStore } from '~/stores/certification';

const store = useCertificationStore();
const selectedProjectId = ref('');
const selectedEvidence = ref<string[]>([]);
const note = ref('');
const message = ref('');
const error = ref('');

function makeKey() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const batchKey = ref(makeKey());

const projectOptions = computed(() =>
  store.projects.map((project) => ({
    label: `${project.id} · ${project.name}`,
    value: project.id
  }))
);

const current = computed(() => store.projects.find((project) => project.id === selectedProjectId.value));
const pendingEvidence = computed(
  () => current.value?.evidence.filter((item) => ['rejected', 'resubmit', 'missing'].includes(item.status)) ?? []
);
const batches = computed(() => current.value?.supplements ?? []);

const batchStatusMeta: Record<string, { label: string; color: 'gray' | 'blue' | 'green' }> = {
  draft: { label: '未提交', color: 'blue' },
  submitted: { label: '已提交', color: 'green' },
  voided: { label: '已失效', color: 'gray' }
};

function evidenceName(evidenceId: string) {
  return current.value?.evidence.find((item) => item.id === evidenceId)?.name ?? evidenceId;
}

function createBatch() {
  message.value = '';
  error.value = '';
  if (!current.value) {
    error.value = '请选择需要补件的认证项目';
    return;
  }
  const errors = validateEvidenceUpgrade(current.value, selectedEvidence.value, note.value);
  if (errors.length) {
    error.value = errors.join('；');
    return;
  }
  const result = store.createSupplementBatch(current.value.id, selectedEvidence.value, note.value, batchKey.value);
  if (!result.ok) {
    error.value = result.error ?? '生成补件批次失败';
    return;
  }
  selectedEvidence.value = [];
  note.value = '';
  batchKey.value = makeKey();
  message.value = result.duplicated
    ? '相同补件批次已存在，未重复生成。'
    : `已生成补件批次 ${result.batchId}（依据 R${current.value.revision}），提交后证据才会更新到项目基线。`;
}

function submitBatch(batchId: string) {
  message.value = '';
  error.value = '';
  if (!current.value) return;
  const result = store.submitSupplementBatch(current.value.id, batchId);
  if (!result.ok) {
    error.value = result.error ?? '提交补件批次失败';
    return;
  }
  message.value = result.duplicated
    ? `批次 ${batchId} 已提交过，未重复新增证据或审计。`
    : `已完成 ${result.count} 项证据补件，并同步到项目版本基线 R${current.value.revision}。`;
}

function discardBatch(batchId: string) {
  message.value = '';
  error.value = '';
  if (!current.value) return;
  const result = store.discardSupplementBatch(current.value.id, batchId);
  if (!result.ok) {
    error.value = result.error ?? '作废批次失败';
    return;
  }
  message.value = `批次 ${batchId} 已作废。`;
}

onMounted(() => {
  store.hydrate();
  if (!selectedProjectId.value && projectOptions.value[0]) selectedProjectId.value = projectOptions.value[0].value;
});
</script>

<template>
  <div class="mb-6">
    <h1 class="text-2xl font-semibold">批量补件工作区</h1>
    <p class="mt-1 text-sm text-slate-600">先生成补件批次再提交生效；项目版本更新后，未提交的批次自动失效。</p>
  </div>

  <div v-if="store.lastWriteError" class="mb-4 border border-red-200 bg-red-50 p-3 text-sm text-red-900">
    {{ store.lastWriteError }}
  </div>
  <div v-if="message" class="mb-4 border border-green-200 bg-green-50 p-3 text-sm text-green-900">{{ message }}</div>
  <div v-if="error" class="mb-4 border border-red-200 bg-red-50 p-3 text-sm text-red-900">{{ error }}</div>

  <div class="grid gap-6 xl:grid-cols-[minmax(280px,1fr)_minmax(0,2fr)]">
    <section class="border border-slate-200 bg-white p-5">
      <UFormGroup label="认证项目">
        <USelect v-model="selectedProjectId" :options="projectOptions" />
      </UFormGroup>
      <div v-if="current" class="mt-5 space-y-3 text-sm">
        <div>
          <p class="text-slate-500">车型配置</p>
          <p class="mt-1 font-medium">{{ current.modelCode }} · {{ current.configuration }}</p>
        </div>
        <div>
          <p class="text-slate-500">当前版本基线</p>
          <p class="mt-1 flex flex-wrap items-center gap-2 font-medium">
            <RevisionBadge :revision="current.revision" prefix="当前" />
            {{ current.maintenanceVersion }} / SW {{ current.softwareVersion }}
          </p>
        </div>
        <div>
          <p class="text-slate-500">待补件数量</p>
          <p class="metric-value mt-1 text-2xl font-semibold">{{ pendingEvidence.length }}</p>
        </div>
      </div>
    </section>

    <section class="border border-slate-200 bg-white">
      <div class="border-b border-slate-200 px-4 py-3">
        <h2 class="font-semibold">选择待补件证据</h2>
        <p class="mt-1 text-xs text-slate-500">生成批次后需再提交，证据状态才会变为已提交并更新到项目基线。</p>
      </div>
      <form class="p-4" @submit.prevent="createBatch">
        <div class="space-y-3">
          <label v-for="item in pendingEvidence" :key="item.id" class="flex gap-3 border border-slate-200 p-4">
            <input v-model="selectedEvidence" type="checkbox" :value="item.id" class="mt-1" />
            <span class="min-w-0 flex-1">
              <span class="flex flex-wrap items-center justify-between gap-2">
                <strong class="text-sm">{{ item.name }}</strong>
                <StatusBadge :status="item.status" />
              </span>
              <span class="mt-2 block text-sm text-slate-600">{{ item.note }}</span>
              <span class="mt-2 block text-xs text-slate-500">
                {{ item.regulationId }} · 文件 {{ item.version }} · 软件 {{ item.softwareVersion }} · {{ item.configurations.join('、') }}
              </span>
            </span>
          </label>
          <p v-if="!pendingEvidence.length" class="py-10 text-center text-sm text-slate-500">没有待补件证据。</p>
        </div>

        <div class="mt-5">
          <UFormGroup label="批量补件说明">
            <UTextarea v-model="note" :rows="4" placeholder="填写新增测试、说明文件、版本核对和配置覆盖结论" />
          </UFormGroup>
        </div>
        <UButton type="submit" color="primary" class="mt-4">生成补件批次</UButton>
      </form>

      <div class="border-t border-slate-200 p-4">
        <h3 class="text-sm font-semibold">补件批次</h3>
        <ul class="mt-3 space-y-3">
          <li v-for="batch in batches" :key="batch.id" class="border border-slate-200 p-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="font-mono text-xs">{{ batch.id }}</span>
              <UBadge :color="batchStatusMeta[batch.status].color" variant="soft">
                {{ batchStatusMeta[batch.status].label }}
              </UBadge>
            </div>
            <p class="mt-2 text-xs text-slate-500">
              依据 R{{ batch.basisRevision }}<span v-if="batch.submittedRevision"> · 提交于 R{{ batch.submittedRevision }}</span>
              · {{ batch.createdAt.slice(0, 16).replace('T', ' ') }}
            </p>
            <p class="mt-1 text-sm">{{ batch.note }}</p>
            <p class="mt-1 text-xs text-slate-500">{{ batch.evidenceIds.map(evidenceName).join('、') }}</p>
            <p v-if="batch.voidReason" class="mt-1 text-xs text-amber-700">{{ batch.voidReason }}</p>
            <div v-if="batch.status === 'draft'" class="mt-3 flex gap-2">
              <UButton size="xs" color="primary" @click="submitBatch(batch.id)">提交批次</UButton>
              <UButton size="xs" color="gray" variant="soft" @click="discardBatch(batch.id)">作废</UButton>
            </div>
          </li>
          <li v-if="!batches.length" class="text-sm text-slate-500">尚无补件批次。</li>
        </ul>
      </div>
    </section>
  </div>
</template>
