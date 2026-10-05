<script setup lang="ts">
import type { ConcurrentSupplement, EvidenceStatus, ProjectInput, ProjectStatus } from '~/types/certification';
import { validateEvidenceUpgrade, validateProjectInput, validateSubmission } from '~/services/validators';
import { useCertificationStore } from '~/stores/certification';

const route = useRoute();
const store = useCertificationStore();
const id = String(route.params.id);
const project = computed(() => store.projectById(id));
const activeTab = ref(0);
const message = ref('');
const error = ref('');

/** 本窗口打开项目时持有的修订号，用于并发冲突判定 */
const baseRevision = ref<number | undefined>(undefined);

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

watch(
  project,
  (value) => {
    if (!value) return;
    if (baseRevision.value === undefined) baseRevision.value = value.revision;
    Object.assign(editor, {
      name: value.name,
      modelCode: value.modelCode,
      vehicleType: value.vehicleType,
      configuration: value.configuration,
      maintenanceVersion: value.maintenanceVersion,
      softwareVersion: value.softwareVersion,
      applicant: value.applicant,
      agency: value.agency,
      certificateExpiry: value.certificateExpiry
    });
  },
  { immediate: true }
);

const transitionStatus = ref<ProjectStatus>('under_review');
const transitionReason = ref('');
const editReason = ref('');
const supplementNote = ref('');
const selectedEvidence = ref<string[]>([]);
const conflictNotice = ref<string[]>([]);

const tabs = [
  { label: '证据文件', icon: 'i-heroicons-document-text' },
  { label: '法规项目', icon: 'i-heroicons-list-bullet' },
  { label: '版本与影响', icon: 'i-heroicons-arrows-right-left' },
  { label: '补件批次', icon: 'i-heroicons-inbox-stack' },
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

const pendingSupplementEvidence = computed(() =>
  project.value?.evidence.filter((evidence) => ['rejected', 'resubmit', 'missing'].includes(evidence.status)) ?? []
);

function formatTime(value?: string) {
  return value ? value.slice(0, 16).replace('T', ' ') : '';
}

function saveEditor() {
  message.value = '';
  error.value = '';
  conflictNotice.value = [];
  const errors = validateProjectInput(editor);
  if (Object.keys(errors).length) {
    error.value = Object.values(errors)[0] ?? '项目资料校验失败';
    return;
  }
  if (!editReason.value.trim()) {
    error.value = '请填写本次变更原因';
    return;
  }
  const pending: ConcurrentSupplement | undefined = selectedEvidence.value.length
    ? { evidenceIds: [...selectedEvidence.value], note: supplementNote.value, author: project.value!.applicant }
    : undefined;
  const result = store.updateProject(id, { ...editor }, editReason.value, baseRevision.value, pending);
  if (!result.ok && result.conflict) {
    conflictNotice.value = result.conflict.conflicts.map(
      (item) => `${item.label}：本窗口旧口径 ${item.incoming}，先到窗口新口径 ${item.current}`
    );
    if (result.conflict.retainedBatchId) {
      conflictNotice.value.push(`本窗口未提交补件内容已保留为批次 ${result.conflict.retainedBatchId}`);
    }
    error.value = `检测到并发修改：另一窗口已生成 R${result.conflict.currentRevision} 版本，本窗口未覆盖其内容。`;
    return;
  }
  baseRevision.value = project.value?.revision;
  editReason.value = '';
  message.value = `项目资料已保存，已生成 R${project.value?.revision} 版本并重算受影响配置的证据状态与法规覆盖。`;
}

function refreshFromLatest() {
  baseRevision.value = project.value?.revision;
  conflictNotice.value = [];
  error.value = '';
  message.value = `已按最新 R${project.value?.revision} 版本同步本窗口口径。`;
}

function confirmBackfill() {
  if (!project.value) return;
  store.confirmRevision(id, project.value.applicant);
  message.value = `修订号已回填至 R${project.value.revision} 并确认，项目可以进入批准流程。`;
}

function transition() {
  if (!project.value) return;
  message.value = '';
  error.value = '';
  if (!transitionReason.value.trim()) {
    error.value = '请填写审批流转依据';
    return;
  }
  if (transitionStatus.value === 'approved') {
    if (!project.value.revisionReady) {
      error.value = '旧数据修订号未回填确认，补全前不能批准。';
      return;
    }
    if (blockingIssues.value.length) {
      error.value = `存在阻断项，不能批准：${blockingIssues.value.join('；')}`;
      return;
    }
  }
  const ok = store.transition(
    id,
    transitionStatus.value,
    project.value.reviewer === '待分派' ? '认证机构审阅人' : project.value.reviewer,
    transitionReason.value
  );
  if (!ok) {
    error.value = '审批流转被拒绝：修订号依据不完整。';
    return;
  }
  transitionReason.value = '';
  message.value = '审批状态已更新，记录保留当前版本依据。';
}

function updateEvidence(evidenceId: string, status: EvidenceStatus) {
  if (!project.value) return;
  const ok = store.updateEvidence(id, evidenceId, status, `审阅人将证据标记为${status}`);
  message.value = ok ? '证据审阅状态已更新。' : '该证据已按旧版本批准锁定，不能直接修改；请在新基线下补件。';
}

function bulkSupplement() {
  if (!project.value) return;
  message.value = '';
  error.value = '';
  const errors = validateEvidenceUpgrade(project.value, selectedEvidence.value, supplementNote.value);
  if (errors.length) {
    error.value = errors.join('；');
    return;
  }
  const result = store.bulkSupplement(
    id,
    selectedEvidence.value,
    supplementNote.value,
    baseRevision.value,
    project.value.applicant
  );
  if (!result.ok) {
    error.value = `基线已被另一窗口更新（R${project.value.revision}），补件内容已保留为批次 ${result.batchId}，请按新基线确认冲突后重交。`;
    return;
  }
  selectedEvidence.value = [];
  supplementNote.value = '';
  message.value = result.duplicated
    ? `重复提交已忽略：沿用既有批次 ${result.batchId}，未新增证据或审计记录。`
    : `已提交批次 ${result.batchId}，${result.count} 项证据更新至当前版本基线。`;
  if (result.recovered) message.value += '（检测到写入失败，已自动从最近完整批次恢复）';
}

function resubmitBatch(batchId: string) {
  if (!project.value) return;
  const result = store.resubmitRetainedBatch(id, batchId, project.value.applicant);
  message.value = result.ok
    ? `批次 ${result.batchId} 已按 R${project.value.revision} 重新提交。`
    : '批次重交失败。';
  error.value = '';
}

function simulateWriteFailure() {
  store.armWriteFailure();
  message.value = '已安排下一次写入失败，随后提交补件将演示从最近完整批次恢复。';
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
          <UBadge color="gray" variant="soft">修订号 R{{ project.revision }}</UBadge>
          <UBadge :color="project.revisionReady ? 'green' : 'amber'" variant="soft">
            {{ project.revisionReady ? '修订依据完整' : '修订号待回填确认' }}
          </UBadge>
        </div>
        <p class="mt-2 text-lg font-medium">{{ project.name }}</p>
        <p class="mt-1 text-sm text-slate-500">
          {{ project.modelCode }} · {{ project.vehicleType }} · {{ project.configuration }} ·
          {{ project.maintenanceVersion }} / SW {{ project.softwareVersion }}
          <template v-if="project.versions[0]"> · 版本依据 {{ project.versions[0].label }}（{{ project.versions[0].id }}）</template>
        </p>
        <p v-if="baseRevision !== undefined && baseRevision < project.revision" class="mt-1 text-xs font-medium text-red-700">
          本窗口基于 R{{ baseRevision }}，项目已被其他窗口更新到 R{{ project.revision }}。
          <UButton size="xs" variant="link" @click="refreshFromLatest">同步最新口径</UButton>
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

    <div v-if="message" class="mb-4 border border-green-200 bg-green-50 p-3 text-sm text-green-900">{{ message }}</div>
    <div v-if="error" class="mb-4 border border-red-200 bg-red-50 p-3 text-sm text-red-900">
      {{ error }}
      <ul v-if="conflictNotice.length" class="mt-2 list-inside list-disc space-y-1">
        <li v-for="item in conflictNotice" :key="item">{{ item }}</li>
      </ul>
    </div>
    <div v-if="project.lastRecovery" class="mb-4 border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
      <p class="font-semibold">写入恢复记录</p>
      <p class="mt-1">{{ project.lastRecovery.detail }}</p>
      <p class="mt-1 text-xs">恢复时间：{{ formatTime(project.lastRecovery.at) }}</p>
    </div>
    <div v-if="blockingIssues.length" class="mb-5 border border-amber-200 bg-amber-50 p-4">
      <p class="text-sm font-semibold text-amber-950">批准前阻断项</p>
      <ul class="mt-2 list-inside list-disc space-y-1 text-sm text-amber-900">
        <li v-for="issue in blockingIssues" :key="issue">{{ issue }}</li>
      </ul>
      <UButton v-if="!project.revisionReady" size="xs" color="amber" class="mt-3" @click="confirmBackfill">
        回填并确认修订号
      </UButton>
    </div>

    <section class="mb-6 grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
      <div class="border border-slate-200 bg-white p-5">
        <div class="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 class="font-semibold">项目与版本基线</h2>
            <p class="mt-1 text-xs text-slate-500">变更会生成新版本（修订号 +1），重算受影响配置的证据状态与法规覆盖；未提交补件批次随之失效。</p>
          </div>
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
            <span class="ml-3 text-xs text-slate-500">提交时携带本窗口修订号 R{{ baseRevision }}</span>
          </div>
        </form>
      </div>

      <div class="border border-slate-200 bg-white p-5">
        <h2 class="font-semibold">审批流转</h2>
        <p class="mt-1 text-xs text-slate-500">批准前检查缺失证据、版本错配、配置覆盖与修订号回填；批准内容锁定当前版本依据。</p>
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
        <p class="mt-1 text-xs text-slate-500">
          逐项接受、拒绝或要求重新抽样；已批准证据显示其锁定的版本依据，基线更新不改变已批准内容。
        </p>
      </div>
      <EvidenceTable :evidence="project.evidence" :current-software="project.softwareVersion" :versions="project.versions" editable @update="updateEvidence" />
    </section>

    <section v-else-if="activeTab === 1">
      <div class="mb-4">
        <h2 class="font-semibold">法规项目覆盖</h2>
        <p class="mt-1 text-sm text-slate-500">
          按当前版本依据 {{ project.versions[0]?.label }}（R{{ project.revision }}）重算证据、配置覆盖和阻断问题。
        </p>
      </div>
      <RegulationTree :regulations="project.regulations" :evidence="project.evidence" :basis-label="project.versions[0]?.label" :revision="project.revision" />
    </section>

    <section v-else-if="activeTab === 2" class="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
      <div class="border border-slate-200 bg-white">
        <div class="border-b border-slate-200 px-4 py-3">
          <h2 class="font-semibold">版本差异</h2>
          <p class="mt-1 text-xs text-slate-500">页面、法规项目树和审计记录统一引用同一版本依据。</p>
        </div>
        <div class="divide-y divide-slate-200">
          <article v-for="version in project.versions" :key="version.id" class="p-4">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p class="font-medium">{{ version.label }} · {{ version.author }}</p>
                <p class="mt-1 text-xs text-slate-500">
                  {{ formatTime(version.createdAt) }} · R{{ version.revision }} · {{ version.id }}
                </p>
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
        <p class="mt-1 text-xs text-slate-500">
          将缺失、被拒或待重交证据更新到当前软件基线；重复提交不新增证据或审计。基线更新后未提交批次自动失效。
        </p>
        <form class="mt-4 space-y-4" @submit.prevent="bulkSupplement">
          <label
            v-for="item in pendingSupplementEvidence"
            :key="item.id"
            class="flex gap-3 border border-slate-200 p-3"
          >
            <input v-model="selectedEvidence" type="checkbox" :value="item.id" class="mt-1" />
            <span>
              <span class="block text-sm font-medium">{{ item.name }}</span>
              <span class="mt-1 block text-xs text-slate-500">
                {{ item.id }} · 当前 SW {{ item.softwareVersion }}
                <template v-if="item.supersededByVersionId"> · 已被新版本判定失效</template>
              </span>
            </span>
          </label>
          <p v-if="!pendingSupplementEvidence.length" class="text-sm text-slate-500">
            当前没有待补件证据。
          </p>
          <UFormGroup label="补件说明">
            <UTextarea v-model="supplementNote" :rows="3" placeholder="说明已完成的测试、配置覆盖和版本更新" />
          </UFormGroup>
          <div class="flex flex-wrap gap-2">
            <UButton type="submit" color="primary" class="justify-center">批量更新并重新提交</UButton>
            <UButton type="button" color="gray" variant="soft" size="sm" @click="simulateWriteFailure">
              模拟下次写入失败
            </UButton>
          </div>
          <p class="text-xs text-slate-500">提交基于本窗口修订号 R{{ baseRevision }}。</p>
        </form>
      </div>
    </section>

    <section v-else-if="activeTab === 3" class="border border-slate-200 bg-white">
      <div class="border-b border-slate-200 px-4 py-3">
        <h2 class="font-semibold">补件批次</h2>
        <p class="mt-1 text-xs text-slate-500">
          草稿批次在基线更新后失效；并发窗口的后到补件保留内容并列出冲突，可按当前版本重新提交。
        </p>
      </div>
      <div class="divide-y divide-slate-200">
        <article v-for="batch in project.supplements" :key="batch.id" class="p-4">
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
                {{ batch.author }} · {{ formatTime(batch.submittedAt || batch.createdAt) }}
                <template v-if="batch.basisLabel"> · 版本依据 {{ batch.basisLabel }}</template>
                <template v-if="batch.baseRevision !== undefined"> · 基于 R{{ batch.baseRevision }}</template>
              </p>
            </div>
            <UButton
              v-if="batch.status === 'retained' || batch.status === 'invalidated'"
              size="xs"
              color="primary"
              variant="soft"
              @click="resubmitBatch(batch.id)"
            >
              按 R{{ project.revision }} 重新提交
            </UButton>
          </div>
          <p class="mt-2 text-sm text-slate-600">{{ batch.note }}</p>
          <p class="mt-1 text-xs text-slate-500">{{ batch.evidenceIds.length }} 项证据：{{ batch.evidenceIds.join('、') }}</p>
          <p v-if="batch.reason" class="mt-2 border-l-2 border-amber-500 pl-3 text-sm text-amber-900">{{ batch.reason }}</p>
          <ul v-if="batch.conflicts?.length" class="mt-2 list-inside list-disc space-y-1 text-sm text-red-800">
            <li v-for="conflict in batch.conflicts" :key="conflict.field">
              {{ conflict.label }}：旧口径 {{ conflict.incoming }} → 先到版本口径 {{ conflict.current }}
            </li>
          </ul>
        </article>
        <p v-if="!project.supplements.length" class="p-8 text-center text-sm text-slate-500">暂无补件批次。</p>
      </div>
    </section>

    <section v-else class="border border-slate-200 bg-white p-5">
      <h2 class="font-semibold">项目审计记录</h2>
      <p class="mt-1 text-xs text-slate-500">每条记录标注生效时的版本依据；历史批准记录保留原依据，不随后续基线改写。</p>
      <div class="mt-5 space-y-5">
        <article v-for="entry in project.audit" :key="entry.id" class="audit-item">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-sm font-medium">{{ entry.action }} · {{ entry.actor }}</p>
            <span class="text-xs text-slate-500">{{ formatTime(entry.createdAt) }}</span>
          </div>
          <p class="mt-1 text-sm text-slate-600">{{ entry.detail }}</p>
          <p class="mt-1 text-xs text-slate-500">
            版本依据：
            <span v-if="entry.basisLabel">{{ entry.basisLabel }}（{{ entry.basisVersionId }}）</span>
            <span v-else>项目创建基线</span>
          </p>
        </article>
      </div>
    </section>
  </template>
</template>
