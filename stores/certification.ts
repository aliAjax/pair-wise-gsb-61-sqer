import { defineStore } from 'pinia';
import { seedProjects } from '~/data/seed';
import type {
  ApprovalProject,
  AuditEntry,
  BaselineChange,
  ConcurrentSupplement,
  EvidenceItem,
  LegacyApprovalProject,
  ProjectInput,
  ProjectStatus,
  ProjectVersion,
  SupplementBatch,
  SupplementSubmitResult,
  VersionUpdateResult
} from '~/types/certification';
import {
  backfillRevision,
  confirmRevision as confirmRevisionEngine,
  currentBasis,
  deepClone,
  detectConflicts,
  idempotencyKey,
  invalidateDraftBatches,
  makeAudit,
  makeId,
  rebaseEvidence,
  recomputeProgress,
  recomputeRegulations,
  retainConflictingBatch,
  submitBatch,
  recoverFromLatestCompleteBatch
} from '~/services/version-chain';

const STORAGE_KEY = 'vehicle-type-approval-projects-v1';
/** 升级后的数据版本，旧缓存会触发修订号回填流程 */
const STORAGE_REVISION_KEY = 'vehicle-type-approval-projects-data-version';
const DATA_VERSION = 2;

function cloneSeed(): ApprovalProject[] {
  // 种子数据按旧结构给出，统一经过回填迁移
  return (deepClone(seedProjects) as LegacyApprovalProject[]).map((project) => backfillRevision(project));
}

export const useCertificationStore = defineStore('certification', {
  state: () => ({
    projects: cloneSeed() as ApprovalProject[],
    hydrated: false,
    /** 演示开关：置位后下一次持久化写入抛错，触发“从最近完整批次恢复” */
    failNextWrite: false
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
      ),
    /** 仍存在修订号未回填项目，批准前必须先确认 */
    revisionPending: (state) => state.projects.filter((project) => !project.revisionReady)
  },

  actions: {
    hydrate() {
      if (this.hydrated) return;
      if (typeof localStorage === 'undefined') {
        this.hydrated = true;
        return;
      }
      try {
        const dataVersion = Number(localStorage.getItem(STORAGE_REVISION_KEY) || '1');
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as LegacyApprovalProject[];
          this.projects = parsed.map((project) => {
            // v1 缓存缺少修订号字段，统一回填后要求人工确认才能批准
            const migrated = backfillRevision(project);
            if (dataVersion < DATA_VERSION) migrated.revisionReady = false;
            return migrated;
          });
          if (dataVersion < DATA_VERSION) this.persist();
          localStorage.setItem(STORAGE_REVISION_KEY, String(DATA_VERSION));
        }
      } catch {
        this.projects = cloneSeed();
      }
      this.hydrated = true;
    },

    persist(projectId?: string) {
      if (this.failNextWrite) {
        this.failNextWrite = false;
        throw new Error('模拟持久化写入失败（存储不可用）');
      }
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.projects));
        localStorage.setItem(STORAGE_REVISION_KEY, String(DATA_VERSION));
      }
      void projectId;
    },

    /** 带恢复的写入：失败后从最近完整批次恢复，再重试一次 */
    safePersist(project: ApprovalProject, actor: string): 'ok' | 'recovered' | 'failed' {
      const snapshot = deepClone(project);
      try {
        this.persist(project.id);
        return 'ok';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const recovered = recoverFromLatestCompleteBatch(project, actor, message);
        try {
          this.persist(project.id);
          return recovered ? 'recovered' : 'ok';
        } catch {
          // 恢复后仍无法落库：内存回到快照，避免半写入状态
          const index = this.projects.findIndex((item) => item.id === project.id);
          if (index >= 0) this.projects.splice(index, 1, snapshot);
          return 'failed';
        }
      }
    },

    armWriteFailure() {
      this.failNextWrite = true;
    },

    createProject(input: ProjectInput) {
      const createdAt = new Date().toISOString();
      const firstVersion: ProjectVersion = {
        id: makeId('VER'),
        label: `${input.maintenanceVersion} / ${input.softwareVersion}`,
        author: input.applicant,
        createdAt,
        summary: '创建认证证据包草稿。',
        changes: ['录入车型、配置和维护版本', '建立基础法规项'],
        impactedConfigurations: [input.configuration],
        revision: 1,
        baseline: {
          maintenanceVersion: input.maintenanceVersion,
          softwareVersion: input.softwareVersion,
          configuration: input.configuration
        }
      };
      const project: ApprovalProject = {
        id: `TA-${new Date().getFullYear()}-${String(this.projects.length + 121).padStart(3, '0')}`,
        ...input,
        status: 'draft',
        progress: 18,
        reviewer: '待分派',
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
        versions: [firstVersion],
        audit: [
          makeAudit(input.applicant, '建立项目', '创建型式认证证据包草稿。', {
            basisVersionId: firstVersion.id,
            basisLabel: firstVersion.label
          })
        ],
        revision: 1,
        revisionReady: true,
        supplements: []
      };
      project.regulations = recomputeRegulations(project);
      this.projects.unshift(project);
      this.safePersist(project, input.applicant);
      return project.id;
    },

    /**
     * 项目基线更新。
     * @param baseRevision 调用窗口读取项目时的修订号；用于并发冲突判定
     * @param pendingSupplement 后到窗口里未提交的补件内容，冲突时保留
     */
    updateProject(
      id: string,
      input: ProjectInput,
      reason: string,
      baseRevision?: number,
      pendingSupplement?: ConcurrentSupplement
    ): VersionUpdateResult {
      const project = this.projects.find((item) => item.id === id);
      if (!project) return { ok: false };

      const incoming: BaselineChange = {
        maintenanceVersion: input.maintenanceVersion,
        softwareVersion: input.softwareVersion,
        configuration: input.configuration
      };
      const previous: BaselineChange = {
        maintenanceVersion: project.maintenanceVersion,
        softwareVersion: project.softwareVersion,
        configuration: project.configuration
      };

      // 并发：另一窗口已先到生成了新版本
      if (typeof baseRevision === 'number' && baseRevision < project.revision) {
        const conflicts = detectConflicts(project, baseRevision, incoming);
        let retainedBatchId: string | undefined;
        if (pendingSupplement && pendingSupplement.evidenceIds.length) {
          const draft: SupplementBatch = {
            id: makeId('SUP'),
            status: 'draft',
            evidenceIds: pendingSupplement.evidenceIds,
            note: pendingSupplement.note,
            author: pendingSupplement.author,
            createdAt: new Date().toISOString(),
            baseRevision
          };
          const retained = retainConflictingBatch(project, draft, conflicts);
          retainedBatchId = retained.id;
          project.audit.unshift(
            makeAudit(
              pendingSupplement.author,
              '并发冲突·补件保留',
              `后到窗口基于 R${baseRevision} 的补件内容已保留（批次 ${retained.id}），冲突字段：${conflicts
                .map((item) => `${item.label} 旧口径 ${item.incoming} → 新口径 ${item.current}`)
                .join('；')}`,
              currentBasis(project)
            )
          );
        }
        this.safePersist(project, project.applicant);
        return { ok: false, conflict: { conflicts, retainedBatchId, currentRevision: project.revision } };
      }

      const changed: string[] = [];
      if (previous.maintenanceVersion !== incoming.maintenanceVersion) changed.push('维护版本');
      if (previous.softwareVersion !== incoming.softwareVersion) changed.push('软件版本');
      if (previous.configuration !== incoming.configuration) changed.push('配置范围');

      const now = new Date().toISOString();
      Object.assign(project, input, { updatedAt: now });

      if (changed.length) {
        const nextRevision = project.revision + 1;
        const version: ProjectVersion = {
          id: makeId('VER'),
          label: `${incoming.maintenanceVersion} / ${incoming.softwareVersion}`,
          author: project.applicant,
          createdAt: now,
          summary: `更新${changed.join('、')}：${reason}`,
          changes: changed,
          impactedConfigurations: Array.from(
            new Set([previous.configuration, incoming.configuration].filter(Boolean))
          ),
          revision: nextRevision,
          baseline: { ...incoming }
        };
        project.revision = nextRevision;
        project.versions.unshift(version);

        // 重算受影响配置的证据：未批准且落在受影响配置 / 版本落后的证据失效待重交
        const basis = { basisVersionId: version.id, basisLabel: version.label };
        project.evidence = project.evidence.map((evidence) =>
          rebaseEvidence(evidence, incoming, version.id, version.impactedConfigurations)
        );

        // 未提交补件批次按旧口径失效
        const invalidated = invalidateDraftBatches(project, version.id, incoming.softwareVersion);

        // 重算法规覆盖（法规树按当前版本口径展示）
        project.regulations = recomputeRegulations(project);
        project.progress = recomputeProgress(project);

        const detailParts = [
          `${changed.join('、')}；影响配置：${version.impactedConfigurations.join('、')}`,
          `修订号 R${nextRevision}`
        ];
        if (invalidated.length) detailParts.push(`${invalidated.length} 个未提交补件批次失效`);
        project.audit.unshift(makeAudit(project.applicant, '更新项目版本', detailParts.join('；'), basis));
      } else {
        project.audit.unshift(
          makeAudit(project.applicant, '更新项目资料', reason, currentBasis(project))
        );
      }

      this.safePersist(project, project.applicant);
      return { ok: true, versionId: project.versions[0]?.id };
    },

    confirmRevision(id: string, actor: string) {
      const project = this.projects.find((item) => item.id === id);
      if (!project) return false;
      confirmRevisionEngine(project, actor);
      this.safePersist(project, actor);
      return true;
    },

    transition(id: string, status: ProjectStatus, actor: string, reason: string) {
      const project = this.projects.find((item) => item.id === id);
      if (!project) return false;

      // 修订号未回填补全前不能批准
      if (status === 'approved' && !project.revisionReady) {
        return false;
      }

      const basis = currentBasis(project);
      const previousStatus = project.status;
      project.status = status;
      if (status === 'submitted') project.submittedAt = new Date().toISOString().slice(0, 10);
      if (status === 'approved') {
        project.progress = 100;
        // 批准：把当前所有有效证据锁定到当前版本依据；之后基线变更不再改动它们
        project.evidence.forEach((evidence) => {
          if (['accepted', 'submitted'].includes(evidence.status)) {
            evidence.status = 'accepted';
            evidence.basisVersionId = basis.basisVersionId;
          }
        });
      }
      if (status === 'supplement_required') project.progress = Math.min(project.progress, 82);
      project.updatedAt = new Date().toISOString();
      project.audit.unshift(
        makeAudit(actor, '审批状态流转', `${previousStatus} → ${status}；${reason}`, basis)
      );
      this.safePersist(project, actor);
      return true;
    },

    updateEvidence(projectId: string, evidenceId: string, status: EvidenceItem['status'], note: string) {
      const project = this.projects.find((item) => item.id === projectId);
      const evidence = project?.evidence.find((item) => item.id === evidenceId);
      if (!project || !evidence) return false;
      // 已按旧版本批准锁定的证据不能直接改状态，须走新版本补件
      if (evidence.status === 'accepted' && evidence.basisVersionId && evidence.basisVersionId !== project.versions[0]?.id) {
        return false;
      }
      evidence.status = status;
      evidence.note = note || evidence.note;
      evidence.updatedAt = new Date().toISOString();
      if (status === 'accepted') evidence.basisVersionId = project.versions[0]?.id;
      project.updatedAt = evidence.updatedAt;
      project.regulations = recomputeRegulations(project);
      project.audit.unshift(
        makeAudit(project.reviewer, '更新证据状态', `${evidence.name}：${status}`, currentBasis(project))
      );
      this.safePersist(project, project.reviewer);
      return true;
    },

    /**
     * 幂等批量补件：同一版本、同一证据集、同一说明重复提交不新增证据或审计。
     * 返回结构里 duplicated 表示命中去重，recovered 表示本次曾发生写入失败并已恢复。
     */
    bulkSupplement(
      projectId: string,
      evidenceIds: string[],
      note: string,
      baseRevision?: number,
      author?: string
    ): SupplementSubmitResult & { conflicts?: ReturnType<typeof detectConflicts> } {
      const project = this.projects.find((item) => item.id === projectId);
      if (!project) return { ok: false };

      const actor = author || project.applicant;

      // 并发：补件窗口读取后基线已被其他窗口更新，保留补件内容并列出冲突
      if (typeof baseRevision === 'number' && baseRevision < project.revision) {
        // 后到窗口的旧口径取该修订号对应版本的基线快照
        const staleVersion = project.versions.find((version) => version.revision === baseRevision);
        const incoming: BaselineChange = staleVersion?.baseline ?? {
          maintenanceVersion: project.maintenanceVersion,
          softwareVersion:
            project.evidence.find((item) => item.id === evidenceIds[0])?.softwareVersion ?? project.softwareVersion,
          configuration: project.configuration
        };
        const conflicts = detectConflicts(project, baseRevision, incoming);
        const draft: SupplementBatch = {
          id: makeId('SUP'),
          status: 'draft',
          evidenceIds,
          note,
          author: actor,
          createdAt: new Date().toISOString(),
          baseRevision
        };
        const retained = retainConflictingBatch(project, draft, conflicts);
        project.audit.unshift(
          makeAudit(
            actor,
            '并发冲突·补件保留',
            `补件基于 R${baseRevision}，项目已更新到 R${project.revision}；批次 ${retained.id} 内容保留，请按新基线确认。`,
            currentBasis(project)
          )
        );
        this.safePersist(project, actor);
        return { ok: false, batchId: retained.id, conflicts };
      }

      const basis = currentBasis(project);
      const key = idempotencyKey(project.id, basis.basisVersionId ?? '', evidenceIds, note);
      const duplicate = project.supplements.find(
        (batch) => batch.status === 'submitted' && batch.idempotencyKey === key
      );
      if (duplicate) {
        // 重复提交：直接返回既有批次，不新增证据或审计
        return { ok: true, duplicated: true, batchId: duplicate.id, count: duplicate.evidenceIds.length };
      }

      const draft: SupplementBatch = {
        id: makeId('SUP'),
        status: 'draft',
        evidenceIds,
        note,
        author: actor,
        createdAt: new Date().toISOString(),
        basisVersionId: basis.basisVersionId,
        basisLabel: basis.basisLabel
      };
      const { batch, changedEvidence } = submitBatch(project, draft);

      project.regulations = recomputeRegulations(project);
      project.progress = recomputeProgress(project);
      project.updatedAt = batch.submittedAt ?? new Date().toISOString();

      const auditEntry: AuditEntry = makeAudit(
        actor,
        '批量补件',
        `${changedEvidence.length} 项证据更新至 ${project.maintenanceVersion} / SW ${project.softwareVersion}（批次 ${batch.id}，R${project.revision}）。${note}`,
        { basisVersionId: batch.basisVersionId, basisLabel: batch.basisLabel }
      );
      project.audit.unshift(auditEntry);

      const writeResult = this.safePersist(project, actor);
      // 仅在事务完整落库后批次才是“完整批次”；恢复路径中在途批次已被降级
      if (writeResult === 'ok') batch.persisted = true;
      return {
        ok: true,
        duplicated: false,
        batchId: batch.id,
        count: changedEvidence.length,
        recovered: writeResult === 'recovered'
      };
    },

    /** 对冲突中保留（retained）/失效（invalidated）批次按当前基线确认后重新提交 */
    resubmitRetainedBatch(projectId: string, batchId: string, author: string, note?: string): SupplementSubmitResult {
      const project = this.projects.find((item) => item.id === projectId);
      const batch = project?.supplements.find((item) => item.id === batchId);
      if (!project || !batch) return { ok: false };
      return this.bulkSupplement(
        projectId,
        batch.evidenceIds,
        note ?? batch.note,
        project.revision,
        author
      );
    },

    reset() {
      this.projects = cloneSeed();
      this.failNextWrite = false;
      this.persist();
    }
  }
});
