<script setup lang="ts">
import { validateEvidenceUpgrade } from '~/services/validators';
import { useCertificationStore } from '~/stores/certification';

const store = useCertificationStore();
const selectedProjectId = ref('');
const selectedEvidence = ref<string[]>([]);
const note = ref('');
const message = ref('');
const error = ref('');
const conflictLines = ref<string[]>([]);

/** 本窗口持有的项目修订号；并发时可能落后于项目当前修订号 */
const windowRevision = ref<number | undefined>(undefined);

const projectOptions = computed(() =>
  store.projects
    .filter((project) => project.evidence.some((evidence) => ['rejected', 'resubmit', 'missing'].includes(evidence.status)))
    .map((project) => ({
      label: `${project.id} · ${project.name}（R${project.revision}）`,
      value: project.id
    }))
);

const current = computed(() => store.projects.find((project) => project.id === selectedProjectId.value));
const pendingEvidence = computed(
  () => current.value?.evidence.filter((item) => ['rejected', 'resubmit', 'missing'].includes(item.status)) ?? []
);
const batchHistory = computed(() => current.value?.supplements ?? []);

watch(
  current,
  (project) => {
    if (project && windowRevision.value === undefined) windowRevision.value = project.revision;
  },
  { immediate: true }
);

function selectProject() {
  windowRevision.value = current.value?.revision;
  conflictLines.value = [];
  message.value = '';
  error.value = '';
}

function submit(asStaleWindow = false) {
  message.value = '';
  error.value = '';
  conflictLines.value = [];
  if (!current.value) {
    error.value = '请选择需要补件的认证项目';
    return;
  }
  const errors = validateEvidenceUpgrade(current.value, selectedEvidence.value, note.value);
  if (errors.length) {
    error.value = errors.join('；');
    return;
  }
  // 第二窗口模拟：始终用本窗口打开时的旧修订号（若恰好是当前修订号则回退一个版本）
  const baseRevision = asStaleWindow
    ? Math.min(windowRevision.value ?? current.value.revision, Math.max(1, current.value.revision - 1))
    : windowRevision.value;
  const result = store.bulkSupplement(current.value.id, selectedEvidence.value, note.value, baseRevision);
  if (!result.ok) {
    const batch = current.value.supplements.find((item) => item.id === result.batchId);
    conflictLines.value =
      batch?.conflicts?.map((item) => `${item.label}：第二窗口旧口径 ${item.incoming}，先到版本口径 ${item.current}`) ?? [];
    error.value = `第二窗口基于 R${baseRevision} 的补件未覆盖新版本，内容已保留为批次 ${result.batchId}，请先解决冲突。`;
    return;
  }
  selectedEvidence.value = [];
  note.value = '';
  message.value = result.duplicated
    ? `重复提交被幂等拦截：沿用批次 ${result.batchId}，未新增证据或审计记录。`
    : `已提交批次 ${result.batchId}，${result.count} 项证据已按当前版本基线更新。`;
  if (result.recovered) message.value += ' 写入失败后已自动从最近完整批次恢复。';
  windowRevision.value = current.value.revision;
}

function resubmit(batchId: string) {
  if (!current.value) return;
  const result = store.resubmitRetainedBatch(current.value.id, batchId, current.value.applicant);
  message.value = result.ok ? `批次 ${result.batchId} 已按 R${current.value.revision} 重新提交。` : '重交失败。';
  error.value = '';
}

onMounted(() => {
  store.hydrate();
  if (!selectedProjectId.value && projectOptions.value[0]) {
    selectedProjectId.value = projectOptions.value[0].value;
    windowRevision.value = current.value?.revision;
  }
});
</script>

<template>
  <div class="mb-6">
    <h1 class="text-2xl font-semibold">批量补件工作区</h1>
    <p class="mt-1 text-sm text-slate-600">
      将退回项统一更新到当前软件基线；未提交批次随基线变更失效，重复提交幂等，两个窗口并发时后到者保留补件内容并列出冲突。
    </p>
  </div>

  <div v-if="message" class="mb-4 border border-green-200 bg-green-50 p-3 text-sm text-green-900">{{ message }}</div>
  <div v-if="error" class="mb-4 border border-red-200 bg-red-50 p-3 text-sm text-red-900">
    {{ error }}
    <ul v-if="conflictLines.length" class="mt-2 list-inside list-disc space-y-1">
      <li v-for="line in conflictLines" :key="line">{{ line }}</li>
    </ul>
  </div>

  <div class="grid gap-6 xl:grid-cols-[minmax(280px,1fr)_minmax(0,2fr)]">
    <section class="border border-slate-200 bg-white p-5">
      <UFormGroup label="认证项目">
        <USelect v-model="selectedProjectId" :options="projectOptions" @change="selectProject" />
      </UFormGroup>
      <div v-if="current" class="mt-5 space-y-3 text-sm">
        <div>
          <p class="text-slate-500">车型配置</p>
          <p class="mt-1 font-medium">{{ current.modelCode }} · {{ current.configuration }}</p>
        </div>
        <div>
          <p class="text-slate-500">当前版本基线</p>
          <p class="mt-1 font-medium">
            {{ current.maintenanceVersion }} / SW {{ current.softwareVersion }} · R{{ current.revision }}
          </p>
        </div>
        <div>
          <p class="text-slate-500">本窗口修订号</p>
          <p class="mt-1 font-medium" :class="windowRevision !== current.revision ? 'text-red-700' : ''">
            R{{ windowRevision }}
            <span v-if="windowRevision !== current.revision">（落后于项目当前版本）</span>
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
        <p class="mt-1 text-xs text-slate-500">
          提交后证据状态变为已提交，软件版本与版本依据自动更新为项目基线；同一版本、同一证据集、同一说明重复提交不会重复落库。
        </p>
      </div>
      <form class="p-4" @submit.prevent="submit(false)">
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
        <div class="mt-4 flex flex-wrap gap-2">
          <UButton type="submit" color="primary">提交批量补件</UButton>
          <UButton type="button" color="red" variant="soft" @click="submit(true)">
            模拟第二窗口（旧修订号）提交
          </UButton>
        </div>
        <p class="mt-2 text-xs text-slate-500">
          “第二窗口”按落后修订号提交，用于演示先到者已生成版本时，后到补件保留内容并列出冲突。
        </p>
      </form>
    </section>
  </div>

  <section v-if="current && batchHistory.length" class="mt-6 border border-slate-200 bg-white">
    <div class="border-b border-slate-200 px-4 py-3">
      <h2 class="font-semibold">补件批次链</h2>
      <p class="mt-1 text-xs text-slate-500">草稿随新版本失效；冲突保留批次确认口径后可重新提交。</p>
    </div>
    <div class="divide-y divide-slate-200">
      <article v-for="batch in batchHistory" :key="batch.id" class="p-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p class="text-sm font-medium">
              {{ batch.id }}
              <UBadge
                class="ml-2"
                :color="batch.status === 'submitted' ? 'green' : batch.status === 'retained' ? 'red' : 'amber'"
                variant="soft"
              >
                {{ { draft: '未提交', submitted: '已提交', invalidated: '已失效', retained: '冲突保留' }[batch.status] }}
              </UBadge>
            </p>
            <p class="mt-1 text-xs text-slate-500">
              {{ batch.author }} · {{ (batch.submittedAt || batch.createdAt).slice(0, 16).replace('T', ' ') }}
              <template v-if="batch.basisLabel"> · 依据 {{ batch.basisLabel }}</template>
              <template v-if="batch.baseRevision !== undefined"> · 基于 R{{ batch.baseRevision }}</template>
            </p>
          </div>
          <UButton
            v-if="batch.status === 'retained' || batch.status === 'invalidated'"
            size="xs"
            color="primary"
            variant="soft"
            @click="resubmit(batch.id)"
          >
            按 R{{ current.revision }} 重新提交
          </UButton>
        </div>
        <p class="mt-2 text-sm text-slate-600">{{ batch.note }}</p>
        <p v-if="batch.reason" class="mt-2 border-l-2 border-amber-500 pl-3 text-sm text-amber-900">{{ batch.reason }}</p>
        <ul v-if="batch.conflicts?.length" class="mt-2 list-inside list-disc space-y-1 text-sm text-red-800">
          <li v-for="conflict in batch.conflicts" :key="conflict.field">
            {{ conflict.label }}：旧口径 {{ conflict.incoming }} → 先到版本口径 {{ conflict.current }}
          </li>
        </ul>
      </article>
    </div>
  </section>
</template>
