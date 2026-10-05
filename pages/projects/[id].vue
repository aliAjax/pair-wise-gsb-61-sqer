<script setup lang="ts">
import type { EvidenceStatus, ProjectInput, ProjectStatus, RevisionConflict } from '~/types/certification';
import { validateEvidenceUpgrade, validateProjectInput, validateSubmission } from '~/services/validators';
import { useCertificationStore } from '~/stores/certification';

const route = useRoute();
const store = useCertificationStore();
const id = String(route.params.id);
const project = computed(() => store.projectById(id));
const activeTab = ref(0);
const message = ref('');
const error = ref('');

const editor = reactive<ProjectInput>({
  name: '',
  modelCode: '',
  vehicleType: '',
  configuration: '',
  maintenanceVersion: '',
  softwareVersion: '',
  applicant: '',
  agency: '',
  certificateExpiry: ''
});

function makeKey() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const editorFields: (keyof ProjectInput)[] = [
  'name',
  'modelCode',
  'vehicleType',
  'configuration',
  'maintenanceVersion',
  'softwareVersion',
  'applicant',
  'agency',
  'certificateExpiry'
];

const editorDirty = ref(false);
const editorRevision = ref(0);
const editKey = ref(makeKey());
const conflict = ref<RevisionConflict | null>(null);

function syncEditor() {
  const value = project.value;
  if (!value) return;
  editorFields.forEach((field) => {
    editor[field] = value[field];
  });
  editorRevision.value = value.revision ?? 0;
}

watch(
  project,
  (value) => {
    if (!value) return;
    if (!editorDirty.value) syncEditor();
  },
  { immediate: true }
);

// 内容偏离当前项目状态才算未保存修改；保存成功后自动回到非脏状态
watch(
  editor,
  () => {
    const value = project.value;
    if (!value) return;
    editorDirty.value = editorFields.some((field) => editor[field] !== value[field]);
  },
  { deep: true }
);

const transitionStatus = ref<ProjectStatus>('under_review');
const transitionReason = ref('');
const transitionKey = ref(makeKey());
const editReason = ref('');
const supplementNote = ref('');
const supplementKey = ref(makeKey());
const selectedEvidence = ref<string[]>([]);

const tabs = [
  { label: '证据文件', icon: 'i-heroicons-document-text' },
  { label: '法规项目', icon: 'i-heroicons-list-bullet' },
  { label: '版本与影响', icon: 'i-heroicons-arrows-right-left' },
  { label: '审计记录', icon: 'i-heroicons-clock' }
];

const transitionOptions = computed(() => {
  const current = project.value?.status;
  if (current === 'draft') return [{ label: '提交认证机构', value: 'submitted' }];
  if (current === 'submitted') return [{ label: '开始审阅', value: 'under_review' }];
  if (current === 'under_review') {
    return [
      { label: '要求补件', value: 'supplement_required' },
      { label: '批准', value: 'approved' },
      { label: '拒绝', value: 'rejected' }
    ];
  }
  if (current === 'supplement_required') return [{ label: '重新提交补件', value: 'submitted' }];
  return [{ label: '重新打开审阅', value: 'under_review' }];
});

const blockingIssues = computed(() => (project.value ? validateSubmission(project.value) : []));
const pendingEvidence = computed(
  () => project.value?.evidence.filter((item) => ['rejected', 'resubmit', 'missing'].includes(item.status)) ?? []
);
const supplements = computed(() => project.value?.supplements ?? []);

const batchStatusMeta: Record<string, { label: string; color: 'gray' | 'blue' | 'green' }> = {
  draft: { label: '未提交', color: 'blue' },
  submitted: { label: '已提交', color: 'green' },
  voided: { label: '已失效', color: 'gray' }
};

function evidenceName(evidenceId: string) {
  return project.value?.evidence.find((item) => item.id === evidenceId)?.name ?? evidenceId;
}

function saveEditor() {
  message.value = '';
  error.value = '';
  conflict.value = null;
  const errors = validateProjectInput(editor);
  if (Object.keys(errors).length) {
    error.value = Object.values(errors)[0] ?? '项目资料校验失败';
    return;
  }
  if (!editReason.value.trim()) {
    error.value = '请填写本次变更原因';
    return;
  }
  const result = store.updateProject(id, { ...editor }, editReason.value, editorRevision.value, editKey.value);
  if (result.conflict) {
    // 后到者：保留当前编辑与补件内容，列出先到者生成的版本和审计
    conflict.value = result.conflict;
    error.value = `另一窗口已先将项目推进到 R${result.conflict.currentRevision}，本次修改未保存。请核对下方冲突后重新提交。`;
    return;
  }
  if (!result.ok) {
    error.value = result.error ?? '保存失败';
    return;
  }
  editReason.value = '';
  editKey.value = makeKey();
  message.value = result.duplicated ? '本次修改已保存过，未重复生成版本或审计。' : `项目资料与版本影响已保存（当前 R${project.value?.revision}）。`;
}

function loadLatestBaseline() {
  editorDirty.value = false;
  syncEditor();
  editKey.value = makeKey();
  conflict.value = null;
  error.value = '';
  message.value = `已载入最新基线 R${editorRevision.value}，请确认后重新提交。`;
}

function transition() {
  if (!project.value) return;
  message.value = '';
  error.value = '';
  if (!transitionReason.value.trim()) {
    error.value = '请填写审批流转依据';
    return;
  }
  if (transitionStatus.value === 'approved' && blockingIssues.value.length) {
    error.value = `存在阻断项，不能批准：${blockingIssues.value.join('；')}`;
    return;
  }
  const result = store.transition(
    id,
    transitionStatus.value,
    project.value.reviewer === '待分派' ? '认证机构审阅人' : project.value.reviewer,
    transitionReason.value,
    transitionKey.value
  );
  if (!result.ok) {
    error.value = result.error ?? '流转失败';
    return;
  }
  transitionReason.value = '';
  transitionKey.value = makeKey();
  message.value = result.duplicated ? '本次流转已记录过，未重复新增审计。' : '审批状态已更新。';
}

function updateEvidence(evidenceId: string, status: EvidenceStatus) {
  if (!project.value) return;
  message.value = '';
  error.value = '';
  const result = store.updateEvidence(id, evidenceId, status, `审阅人将证据标记为${status}`);
  if (!result.ok) {
    error.value = result.error ?? '证据状态更新失败';
    return;
  }
  message.value = '证据审阅状态已更新，法规覆盖已同步重算。';
}

function createBatch() {
  if (!project.value) return;
  message.value = '';
  error.value = '';
  const errors = validateEvidenceUpgrade(project.value, selectedEvidence.value, supplementNote.value);
  if (errors.length) {
    error.value = errors.join('；');
    return;
  }
  const result = store.createSupplementBatch(id, selectedEvidence.value, supplementNote.value, supplementKey.value);
  if (!result.ok) {
    error.value = result.error ?? '生成补件批次失败';
    return;
  }
  selectedEvidence.value = [];
  supplementNote.value = '';
  supplementKey.value = makeKey();
  message.value = result.duplicated
    ? '相同补件批次已存在，未重复生成。'
    : `已生成补件批次 ${result.batchId}，提交前如项目版本更新将自动失效。`;
}

function submitBatch(batchId: string) {
  message.value = '';
  error.value = '';
  const result = store.submitSupplementBatch(id, batchId);
  if (!result.ok) {
    error.value = result.error ?? '提交补件批次失败';
    return;
  }
  message.value = result.duplicated
    ? `批次 ${batchId} 已提交过，未重复新增证据或审计。`
    : `批次 ${batchId} 已提交，${result.count} 项证据更新至当前软件基线。`;
}

function discardBatch(batchId: string) {
  message.value = '';
  error.value = '';
  const result = store.discardSupplementBatch(id, batchId);
  if (!result.ok) {
    error.value = result.error ?? '作废批次失败';
    return;
  }
  message.value = `批次 ${batchId} 已作废。`;
}
</script>

<template>
  <div v-if="!project" class="border border-red-200 bg-red-50 p-6 text-red-900">
    未找到认证项目 {{ id }}。
  </div>

  <template v-else>
    <div class="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <NuxtLink to="/" class="text-sm text-teal-700 hover:underline">返回认证项目</NuxtLink>
        <div class="mt-3 flex flex-wrap items-center gap-3">
          <h1 class="text-2xl font-semibold">{{ project.id }}</h1>
          <StatusBadge :status="project.status" />
          <RevisionBadge :revision="project.revision" prefix="当前" />
        </div>
        <p class="mt-2 text-lg font-medium">{{ project.name }}</p>
        <p class="mt-1 text-sm text-slate-500">
          {{ project.modelCode }} · {{ project.vehicleType }} · {{ project.configuration }} · {{ project.maintenanceVersion }} / SW {{ project.softwareVersion }}
        </p>
      </div>
      <div class="min-w-[240px] border border-slate-200 bg-white p-4">
        <div class="flex items-center justify-between text-sm">
          <span class="text-slate-500">证据完整度</span>
          <span class="metric-value font-semibold">{{ project.progress }}%</span>
        </div>
        <UProgress class="mt-2" :value="project.progress" size="sm" />
        <p class="mt-2 text-xs text-slate-500">证书到期：{{ project.certificateExpiry }}</p>
      </div>
    </div>

    <div v-if="store.lastWriteError" class="mb-4 border border-red-200 bg-red-50 p-3 text-sm text-red-900">
      {{ store.lastWriteError }}
    </div>
    <div v-if="message" class="mb-4 border border-green-200 bg-green-50 p-3 text-sm text-green-900">{{ message }}</div>
    <div v-if="error" class="mb-4 border border-red-200 bg-red-50 p-3 text-sm text-red-900">{{ error }}</div>

    <div v-if="conflict" class="mb-5 border border-amber-200 bg-amber-50 p-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="text-sm font-semibold text-amber-950">
          并发修改冲突：您基于 R{{ conflict.expectedRevision }} 编辑，先到者已生成 R{{ conflict.currentRevision }}
        </p>
        <UButton size="xs" color="amber" @click="loadLatestBaseline">载入最新基线并重新编辑</UButton>
      </div>
      <p class="mt-1 text-xs text-amber-900">当前编辑内容和补件选择已保留，核对以下先到者变更后可重新提交。</p>
      <div class="mt-3 grid gap-3 md:grid-cols-2">
        <div class="border border-amber-200 bg-white p-3">
          <p class="text-xs font-semibold text-slate-700">先到者生成的版本</p>
          <ul class="mt-2 space-y-2 text-sm">
            <li v-for="version in conflict.versions" :key="version.id">
              <span class="font-medium">R{{ version.revision }} · {{ version.label }}</span>
              <span class="block text-xs text-slate-500">{{ version.summary }}（{{ version.createdAt.slice(0, 16).replace('T', ' ') }}）</span>
            </li>
            <li v-if="!conflict.versions.length" class="text-xs text-slate-500">无新版本，仅有记录级变更。</li>
          </ul>
        </div>
        <div class="border border-amber-200 bg-white p-3">
          <p class="text-xs font-semibold text-slate-700">先到者写入的审计记录</p>
          <ul class="mt-2 space-y-2 text-sm">
            <li v-for="entry in conflict.audit" :key="entry.id">
              <span class="font-medium">{{ entry.action }} · {{ entry.actor }}</span>
              <span class="block text-xs text-slate-500">{{ entry.detail }}</span>
            </li>
          </ul>
        </div>
      </div>
    </div>

    <div v-if="blockingIssues.length" class="mb-5 border border-amber-200 bg-amber-50 p-4">
      <p class="text-sm font-semibold text-amber-950">批准前阻断项</p>
      <ul class="mt-2 list-inside list-disc space-y-1 text-sm text-amber-900">
        <li v-for="issue in blockingIssues" :key="issue">{{ issue }}</li>
      </ul>
    </div>

    <section class="mb-6 grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
      <div class="border border-slate-200 bg-white p-5">
        <div class="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 class="font-semibold">项目与版本基线</h2>
            <p class="mt-1 text-xs text-slate-500">
              变更会生成新版本（当前 R{{ project.revision }}），并重算受影响配置的证据状态与法规覆盖。
            </p>
          </div>
          <UBadge v-if="editorDirty" color="amber" variant="soft">有未保存修改</UBadge>
        </div>
        <form class="grid gap-4 md:grid-cols-2 xl:grid-cols-3" @submit.prevent="saveEditor">
          <UFormGroup label="项目名称"><UInput v-model="editor.name" /></UFormGroup>
          <UFormGroup label="车型代码"><UInput v-model="editor.modelCode" /></UFormGroup>
          <UFormGroup label="配置"><UInput v-model="editor.configuration" /></UFormGroup>
          <UFormGroup label="维护版本"><UInput v-model="editor.maintenanceVersion" /></UFormGroup>
          <UFormGroup label="软件版本"><UInput v-model="editor.softwareVersion" /></UFormGroup>
          <UFormGroup label="证书有效期"><UInput v-model="editor.certificateExpiry" type="date" /></UFormGroup>
          <UFormGroup label="申请主体"><UInput v-model="editor.applicant" /></UFormGroup>
          <UFormGroup label="认证机构"><UInput v-model="editor.agency" /></UFormGroup>
          <UFormGroup label="变更原因"><UInput v-model="editReason" placeholder="说明变更和影响范围" /></UFormGroup>
          <div class="md:col-span-2 xl:col-span-3">
            <UButton type="submit" color="primary">保存并生成版本</UButton>
          </div>
        </form>
      </div>

      <div class="border border-slate-200 bg-white p-5">
        <h2 class="font-semibold">审批流转</h2>
        <p class="mt-1 text-xs text-slate-500">批准前系统检查缺失证据、版本错配、配置覆盖和修订号回填。</p>
        <form class="mt-4 space-y-4" @submit.prevent="transition">
          <UFormGroup label="目标状态">
            <USelect v-model="transitionStatus" :options="transitionOptions" />
          </UFormGroup>
          <UFormGroup label="流转依据">
            <UTextarea v-model="transitionReason" :rows="3" placeholder="记录接受、拒绝或补件依据" />
          </UFormGroup>
          <UButton type="submit" color="primary" class="w-full justify-center">提交审批流转</UButton>
        </form>
      </div>
    </section>

    <UTabs v-model="activeTab" :items="tabs" class="mb-5" />

    <section v-if="activeTab === 0" class="border border-slate-200 bg-white">
      <div class="border-b border-slate-200 px-4 py-3">
        <h2 class="font-semibold">证据文件审阅</h2>
        <p class="mt-1 text-xs text-slate-500">逐项接受、拒绝或要求重新抽样；版本依据列为证据提交时的项目修订号。</p>
      </div>
      <EvidenceTable :evidence="project.evidence" :baseline-version="project.softwareVersion" editable @update="updateEvidence" />
    </section>

    <section v-else-if="activeTab === 1">
      <div class="mb-4">
        <h2 class="font-semibold">法规项目覆盖</h2>
        <p class="mt-1 text-sm text-slate-500">按法规项展开证据、配置覆盖和阻断问题，与审批依据同为 R{{ project.revision }}。</p>
      </div>
      <RegulationTree :regulations="project.regulations" :evidence="project.evidence" />
    </section>

    <section v-else-if="activeTab === 2" class="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
      <div class="border border-slate-200 bg-white">
        <div class="border-b border-slate-200 px-4 py-3">
          <h2 class="font-semibold">版本差异</h2>
          <p class="mt-1 text-xs text-slate-500">版本链与项目修订号一一对应，审计记录保留各自依据。</p>
        </div>
        <div class="divide-y divide-slate-200">
          <article v-for="version in project.versions" :key="version.id" class="p-4">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p class="flex flex-wrap items-center gap-2 font-medium">
                  <RevisionBadge :revision="version.revision" prefix="版本" />
                  {{ version.label }} · {{ version.author }}
                </p>
                <p class="mt-1 text-xs text-slate-500">{{ version.createdAt.slice(0, 16).replace('T', ' ') }}</p>
              </div>
              <UBadge color="gray" variant="soft">{{ version.impactedConfigurations.join('、') }}</UBadge>
            </div>
            <p class="mt-3 text-sm">{{ version.summary }}</p>
            <ul class="mt-2 list-inside list-disc text-sm text-slate-600">
              <li v-for="change in version.changes" :key="change">{{ change }}</li>
            </ul>
          </article>
        </div>
      </div>

      <div class="border border-slate-200 bg-white p-5">
        <h2 class="font-semibold">批量补件</h2>
        <p class="mt-1 text-xs text-slate-500">先生成补件批次，再提交生效；版本更新会使未提交批次失效。</p>
        <form class="mt-4 space-y-4" @submit.prevent="createBatch">
          <label
            v-for="item in pendingEvidence"
            :key="item.id"
            class="flex gap-3 border border-slate-200 p-3"
          >
            <input v-model="selectedEvidence" type="checkbox" :value="item.id" class="mt-1" />
            <span>
              <span class="block text-sm font-medium">{{ item.name }}</span>
              <span class="mt-1 block text-xs text-slate-500">{{ item.id }} · 当前 SW {{ item.softwareVersion }}</span>
            </span>
          </label>
          <p v-if="!pendingEvidence.length" class="text-sm text-slate-500">当前没有待补件证据。</p>
          <UFormGroup label="补件说明">
            <UTextarea v-model="supplementNote" :rows="3" placeholder="说明已完成的测试、配置覆盖和版本更新" />
          </UFormGroup>
          <UButton type="submit" color="primary" class="w-full justify-center">生成补件批次</UButton>
        </form>

        <div class="mt-6 border-t border-slate-200 pt-4">
          <h3 class="text-sm font-semibold">补件批次</h3>
          <ul class="mt-3 space-y-3">
            <li v-for="batch in supplements" :key="batch.id" class="border border-slate-200 p-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="font-mono text-xs">{{ batch.id }}</span>
                <UBadge :color="batchStatusMeta[batch.status].color" variant="soft">
                  {{ batchStatusMeta[batch.status].label }}
                </UBadge>
              </div>
              <p class="mt-2 text-xs text-slate-500">
                依据 R{{ batch.basisRevision }}<span v-if="batch.submittedRevision"> · 提交于 R{{ batch.submittedRevision }}</span>
              </p>
              <p class="mt-1 text-sm">{{ batch.note }}</p>
              <p class="mt-1 text-xs text-slate-500">{{ batch.evidenceIds.map(evidenceName).join('、') }}</p>
              <p v-if="batch.voidReason" class="mt-1 text-xs text-amber-700">{{ batch.voidReason }}</p>
              <div v-if="batch.status === 'draft'" class="mt-3 flex gap-2">
                <UButton size="xs" color="primary" @click="submitBatch(batch.id)">提交批次</UButton>
                <UButton size="xs" color="gray" variant="soft" @click="discardBatch(batch.id)">作废</UButton>
              </div>
            </li>
            <li v-if="!supplements.length" class="text-sm text-slate-500">尚无补件批次。</li>
          </ul>
        </div>
      </div>
    </section>

    <section v-else class="border border-slate-200 bg-white p-5">
      <h2 class="font-semibold">项目审计记录</h2>
      <p class="mt-1 text-xs text-slate-500">每条记录保留写入时的版本依据，不随后续版本改写。</p>
      <div class="mt-5 space-y-5">
        <article v-for="entry in project.audit" :key="entry.id" class="audit-item">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="flex flex-wrap items-center gap-2 text-sm font-medium">
              {{ entry.action }} · {{ entry.actor }}
              <RevisionBadge :revision="entry.revision" />
            </p>
            <span class="text-xs text-slate-500">{{ entry.createdAt.slice(0, 16).replace('T', ' ') }}</span>
          </div>
          <p class="mt-1 text-sm text-slate-600">{{ entry.detail }}</p>
        </article>
      </div>
    </section>
  </template>
</template>
