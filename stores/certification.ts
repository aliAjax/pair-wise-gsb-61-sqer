import { defineStore } from 'pinia';
import { seedProjects } from '~/data/seed';
import {
  allConfigurations,
  backfillProject,
  buildConflict,
  needsRevisionBackfill,
  nextRevision,
  recalculateRegulations,
  recomputeEvidenceForBaseline,
  voidDraftBatches
} from '~/services/change-chain';
import type {
  ApprovalProject,
  AuditEntry,
  EvidenceItem,
  MutationResult,
  ProjectInput,
  ProjectStatus,
  ProjectVersion,
  SupplementBatch,
  SupplementBatchResult
} from '~/types/certification';

const STORAGE_KEY = 'vehicle-type-approval-projects-v1';
const BACKUP_KEY = `${STORAGE_KEY}:backup`;
const WRITE_FAIL_MESSAGE = '写入本地存储失败，已从最近完整批次恢复。';

/** 深拷贝：响应式 Proxy 不能直接 structuredClone，统一走 JSON 往返 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneSeed() {
  return clone(seedProjects);
}

function makeId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}

function audit(actor: string, action: string, detail: string, revision?: number, idempotencyKey?: string): AuditEntry {
  return {
    id: makeId('AUD'),
    actor,
    action,
    detail,
    revision,
    idempotencyKey,
    createdAt: new Date().toISOString()
  };
}

/** 读取持久化数据：主键损坏时从最近完整批次（备份键）恢复，最终回退到种子数据 */
function readProjects(): ApprovalProject[] {
  if (typeof localStorage === 'undefined') return cloneSeed();
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as ApprovalProject[];
    } catch {
      // 主键损坏，尝试备份
    }
  }
  const backup = localStorage.getItem(BACKUP_KEY);
  if (backup) {
    try {
      return JSON.parse(backup) as ApprovalProject[];
    } catch {
      // 备份也损坏，回退种子数据
    }
  }
  return cloneSeed();
}

export const useCertificationStore = defineStore('certification', {
  state: () => ({
    projects: cloneSeed(),
    hydrated: false,
    /** 最近一次完整写入成功的状态，写入失败后从这里恢复 */
    lastPersistedSnapshot: null as ApprovalProject[] | null,
    lastWriteError: ''
  }),

  getters: {
    projectById: (state) => (id: string) => state.projects.find((project) => project.id === id),
    agencies: (state) => Array.from(new Set(state.projects.map((project) => project.agency))).sort(),
    expiringEvidence: (state) =>
      state.projects.flatMap((project) =>
        project.evidence
          .filter((item) => item.expiryDate)
          .map((item) => ({ project, evidence: item }))
          .filter(({ evidence }) => new Date(evidence.expiryDate!) <= new Date('2027-01-31'))
      )
  },

  actions: {
    hydrate() {
      if (this.hydrated || typeof localStorage === 'undefined') return;
      this.projects = readProjects();
      // 旧数据缺修订号时先回填，回填幂等且只记录一次审计
      let backfilled = false;
      this.projects.forEach((project) => {
        if (backfillProject(project, (detail, revision) => audit('系统', '修订号回填', detail, revision))) {
          backfilled = true;
        }
      });
      this.hydrated = true;
      if (backfilled) {
        this.persist();
      } else {
        this.lastPersistedSnapshot = clone(this.projects);
      }
      if (typeof window !== 'undefined') {
        window.addEventListener('storage', (event) => {
          if (event.key === STORAGE_KEY) this.syncFromStorage();
        });
      }
    },

    /** 写入失败时回滚到最近完整批次，返回是否成功 */
    persist() {
      if (typeof localStorage === 'undefined') return true;
      try {
        const payload = JSON.stringify(this.projects);
        // 先写备份再写主键，保证备份始终是最近一个完整批次
        localStorage.setItem(BACKUP_KEY, payload);
        localStorage.setItem(STORAGE_KEY, payload);
        this.lastPersistedSnapshot = clone(this.projects);
        this.lastWriteError = '';
        return true;
      } catch {
        this.projects = this.lastPersistedSnapshot ? clone(this.lastPersistedSnapshot) : cloneSeed();
        this.lastWriteError = WRITE_FAIL_MESSAGE;
        return false;
      }
    },

    /** 变更前对齐其他窗口已持久化的最新状态 */
    syncFromStorage() {
      if (typeof localStorage === 'undefined') return;
      this.projects = readProjects();
      this.lastPersistedSnapshot = clone(this.projects);
    },

    createProject(input: ProjectInput) {
      this.syncFromStorage();
      const createdAt = new Date().toISOString();
      const project: ApprovalProject = {
        id: `TA-${new Date().getFullYear()}-${String(this.projects.length + 121).padStart(3, '0')}`,
        ...input,
        status: 'draft',
        progress: 18,
        reviewer: '待分派',
        revision: 1,
        updatedAt: createdAt,
        regulations: [
          {
            id: 'REG-BRAKE',
            code: 'GB 21670',
            title: '乘用车制动系统技术要求',
            category: '安全',
            required: true,
            status: 'missing',
            coverage: 0,
            issues: ['尚未关联测试报告']
          },
          {
            id: 'REG-EMC',
            code: 'GB 34660',
            title: '道路车辆电磁兼容性要求',
            category: '环保',
            required: true,
            status: 'missing',
            coverage: 0,
            issues: ['尚未关联测试报告']
          }
        ],
        evidence: [],
        versions: [
          {
            id: makeId('VER'),
            revision: 1,
            label: `${input.maintenanceVersion} / ${input.softwareVersion}`,
            author: input.applicant,
            createdAt,
            summary: '创建认证证据包草稿。',
            changes: ['录入车型、配置和维护版本', '建立基础法规项'],
            impactedConfigurations: [input.configuration]
          }
        ],
        supplements: [],
        audit: [audit(input.applicant, '建立项目', '创建型式认证证据包草稿。', 1)]
      };
      this.projects.unshift(project);
      this.persist();
      return project.id;
    },

    updateProject(
      id: string,
      input: ProjectInput,
      reason: string,
      expectedRevision?: number,
      idempotencyKey?: string
    ): MutationResult {
      this.syncFromStorage();
      const project = this.projects.find((item) => item.id === id);
      if (!project) return { ok: false, error: '项目不存在' };
      backfillProject(project, (detail, revision) => audit('系统', '修订号回填', detail, revision));

      // 重复提交不新增版本或审计
      if (idempotencyKey && project.audit.some((entry) => entry.idempotencyKey === idempotencyKey)) {
        return { ok: true, duplicated: true };
      }
      // 两个窗口同时修改：先到者已生成版本，后到者收到冲突清单
      if (expectedRevision != null && (project.revision ?? 0) !== expectedRevision) {
        return { ok: false, conflict: buildConflict(project, expectedRevision) };
      }

      const now = new Date().toISOString();
      const previous = {
        maintenanceVersion: project.maintenanceVersion,
        softwareVersion: project.softwareVersion,
        configuration: project.configuration
      };
      Object.assign(project, input, { updatedAt: now });

      const changed: string[] = [];
      if (previous.maintenanceVersion !== input.maintenanceVersion) changed.push('维护版本');
      if (previous.softwareVersion !== input.softwareVersion) changed.push('软件版本');
      if (previous.configuration !== input.configuration) changed.push('配置范围');

      const revision = nextRevision(project);
      if (changed.length) {
        const baselineChanged =
          previous.softwareVersion !== input.softwareVersion ||
          previous.maintenanceVersion !== input.maintenanceVersion;
        const impacted = baselineChanged
          ? allConfigurations(project)
          : Array.from(new Set([previous.configuration, input.configuration]));
        const version: ProjectVersion = {
          id: makeId('VER'),
          revision,
          label: `${input.maintenanceVersion} / ${input.softwareVersion}`,
          author: project.applicant,
          createdAt: now,
          summary: `更新${changed.join('、')}：${reason}`,
          changes: changed,
          impactedConfigurations: impacted
        };
        project.versions.unshift(version);

        // 版本更新后重算受影响配置的证据状态和法规覆盖，未提交的补件批次失效
        const downgraded = recomputeEvidenceForBaseline(project, impacted, now);
        const voided = voidDraftBatches(project, now);
        recalculateRegulations(project);
        const lockedNote = project.status === 'approved' ? '；已批准内容保留原依据' : '';
        project.audit.unshift(
          audit(
            project.applicant,
            '更新项目版本',
            `R${revision}：${changed.join('、')}；影响配置：${impacted.join('、')}；` +
              `${downgraded.length} 项证据需重交；${voided} 个未提交补件批次失效${lockedNote}。`,
            revision,
            idempotencyKey
          )
        );
      } else {
        project.audit.unshift(audit(project.applicant, '更新项目资料', `R${revision}：${reason}`, revision, idempotencyKey));
      }
      if (!this.persist()) return { ok: false, error: WRITE_FAIL_MESSAGE };
      return { ok: true };
    },

    transition(id: string, status: ProjectStatus, actor: string, reason: string, idempotencyKey?: string): MutationResult {
      this.syncFromStorage();
      const project = this.projects.find((item) => item.id === id);
      if (!project) return { ok: false, error: '项目不存在' };
      backfillProject(project, (detail, revision) => audit('系统', '修订号回填', detail, revision));
      if (idempotencyKey && project.audit.some((entry) => entry.idempotencyKey === idempotencyKey)) {
        return { ok: true, duplicated: true };
      }
      // 旧数据缺修订号时先回填，补全前不能批准
      if (status === 'approved' && needsRevisionBackfill(project)) {
        return { ok: false, error: '旧数据缺少修订号，完成回填前不能批准' };
      }
      project.status = status;
      if (status === 'submitted') project.submittedAt = new Date().toISOString().slice(0, 10);
      if (status === 'approved') project.progress = 100;
      if (status === 'supplement_required') project.progress = Math.min(project.progress, 82);
      project.updatedAt = new Date().toISOString();
      const revision = nextRevision(project);
      project.audit.unshift(audit(actor, '审批状态流转', `R${revision}：${status}；${reason}`, revision, idempotencyKey));
      if (!this.persist()) return { ok: false, error: WRITE_FAIL_MESSAGE };
      return { ok: true };
    },

    updateEvidence(projectId: string, evidenceId: string, status: EvidenceItem['status'], note: string): MutationResult {
      this.syncFromStorage();
      const project = this.projects.find((item) => item.id === projectId);
      const evidence = project?.evidence.find((item) => item.id === evidenceId);
      if (!project || !evidence) return { ok: false, error: '证据不存在' };
      backfillProject(project, (detail, revision) => audit('系统', '修订号回填', detail, revision));
      evidence.status = status;
      evidence.note = note || evidence.note;
      evidence.updatedAt = new Date().toISOString();
      project.updatedAt = evidence.updatedAt;
      const revision = nextRevision(project);
      recalculateRegulations(project);
      project.audit.unshift(audit(project.reviewer, '更新证据状态', `R${revision}：${evidence.name}：${status}`, revision));
      if (!this.persist()) return { ok: false, error: WRITE_FAIL_MESSAGE };
      return { ok: true };
    },

    /** 第一步：生成补件批次（草稿），版本更新前未提交会失效 */
    createSupplementBatch(projectId: string, evidenceIds: string[], note: string, idempotencyKey: string): SupplementBatchResult {
      this.syncFromStorage();
      const project = this.projects.find((item) => item.id === projectId);
      if (!project) return { ok: false, error: '项目不存在' };
      backfillProject(project, (detail, revision) => audit('系统', '修订号回填', detail, revision));
      // 幂等：同一批次重复创建不新增批次或审计
      const existing = project.supplements.find((batch) => batch.idempotencyKey === idempotencyKey && batch.status !== 'voided');
      if (existing) return { ok: true, duplicated: true, batchId: existing.id };

      const now = new Date().toISOString();
      const revision = nextRevision(project);
      const batch: SupplementBatch = {
        id: makeId('SUP'),
        projectId,
        evidenceIds: [...evidenceIds],
        note,
        status: 'draft',
        basisRevision: revision,
        idempotencyKey,
        createdAt: now
      };
      project.supplements.unshift(batch);
      project.updatedAt = now;
      project.audit.unshift(
        audit(project.applicant, '创建补件批次', `R${revision}：批次 ${batch.id}，${evidenceIds.length} 项证据待提交。${note}`, revision, idempotencyKey)
      );
      if (!this.persist()) return { ok: false, error: WRITE_FAIL_MESSAGE };
      return { ok: true, batchId: batch.id };
    },

    /** 第二步：提交补件批次，证据更新到当前基线；重复提交不新增证据或审计 */
    submitSupplementBatch(projectId: string, batchId: string): SupplementBatchResult {
      this.syncFromStorage();
      const project = this.projects.find((item) => item.id === projectId);
      if (!project) return { ok: false, error: '项目不存在' };
      const batch = project.supplements.find((item) => item.id === batchId);
      if (!batch) return { ok: false, error: '补件批次不存在' };
      if (batch.status === 'submitted') {
        return { ok: true, duplicated: true, count: batch.evidenceIds.length, batchId };
      }
      if (batch.status === 'voided') {
        return { ok: false, error: '批次已因版本更新失效，请重新生成补件批次' };
      }

      const now = new Date().toISOString();
      const revision = nextRevision(project);
      let count = 0;
      project.evidence.forEach((evidence) => {
        if (!batch.evidenceIds.includes(evidence.id)) return;
        evidence.status = 'submitted';
        evidence.softwareVersion = project.softwareVersion;
        evidence.basisRevision = revision;
        evidence.note = batch.note;
        evidence.updatedAt = now;
        count += 1;
      });
      batch.status = 'submitted';
      batch.submittedAt = now;
      batch.submittedRevision = revision;
      project.updatedAt = now;
      recalculateRegulations(project);
      project.audit.unshift(
        audit(
          project.applicant,
          '批量补件',
          `R${revision}：批次 ${batch.id}，${count} 项证据更新至 SW ${project.softwareVersion}。${batch.note}`,
          revision
        )
      );
      if (!this.persist()) return { ok: false, error: WRITE_FAIL_MESSAGE };
      return { ok: true, count, batchId };
    },

    discardSupplementBatch(projectId: string, batchId: string): MutationResult {
      this.syncFromStorage();
      const project = this.projects.find((item) => item.id === projectId);
      const batch = project?.supplements.find((item) => item.id === batchId);
      if (!project || !batch) return { ok: false, error: '补件批次不存在' };
      if (batch.status !== 'draft') return { ok: false, error: '仅未提交的批次可以作废' };
      const now = new Date().toISOString();
      const revision = nextRevision(project);
      batch.status = 'voided';
      batch.voidedAt = now;
      batch.voidReason = '申请方手动作废';
      project.updatedAt = now;
      project.audit.unshift(audit(project.applicant, '作废补件批次', `R${revision}：批次 ${batch.id} 已作废。`, revision));
      if (!this.persist()) return { ok: false, error: WRITE_FAIL_MESSAGE };
      return { ok: true };
    },

    reset() {
      this.projects = cloneSeed();
      this.lastWriteError = '';
      this.persist();
    }
  }
});
