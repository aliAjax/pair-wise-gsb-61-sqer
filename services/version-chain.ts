import type {
  ApprovalProject,
  AuditEntry,
  BaselineChange,
  ConflictItem,
  EvidenceItem,
  LegacyApprovalProject,
  RegulationItem,
  SupplementBatch
} from '~/types/certification';

/**
 * 变更链核心规则（纯函数，便于测试与回放）：
 * 1. 基线更新生成新版本（修订号 +1），并重算受影响配置的证据状态与法规覆盖；
 * 2. 未提交的补件批次随新版本失效，已批准（accepted）证据与审计保留原依据；
 * 3. 两个窗口并发：先到者生成版本，后到者保留补件内容并列出冲突；
 * 4. 提交按幂等键去重，重复提交不新增证据或审计；
 * 5. 旧数据缺修订号先回填（revision 1），补全前不能批准。
 */

export const REVISION_UNBACKFILLED = 0;

export function makeId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.abs(Math.floor(Math.random() * 1e9)).toString(36) + Date.now().toString(36)}`;
}

/** 深拷贝（Pinia 状态是响应式代理，structuredClone 在部分环境无法克隆） */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function currentVersion(project: ApprovalProject) {
  return project.versions[0];
}

export function currentBasis(project: ApprovalProject) {
  const version = currentVersion(project);
  return { basisVersionId: version?.id, basisLabel: version?.label };
}

export function makeAudit(
  actor: string,
  action: string,
  detail: string,
  basis?: { basisVersionId?: string; basisLabel?: string }
): AuditEntry {
  return {
    id: makeId('AUD'),
    actor,
    action,
    detail,
    createdAt: new Date().toISOString(),
    basisVersionId: basis?.basisVersionId,
    basisLabel: basis?.basisLabel
  };
}

/* ------------------------------------------------------------------ */
/* 旧数据回填                                                          */
/* ------------------------------------------------------------------ */

export function backfillRevision(project: LegacyApprovalProject): ApprovalProject {
  const migrated = deepClone(project) as ApprovalProject;
  migrated.supplements ??= [];

  if (typeof migrated.revision !== 'number' || Number.isNaN(migrated.revision)) {
    // 旧数据没有修订号：先回填为 1，标记待复核，补全前不能批准
    migrated.revision = 1;
    migrated.revisionReady = false;
  } else {
    migrated.revisionReady = migrated.revisionReady ?? migrated.revision > REVISION_UNBACKFILLED;
  }

  // 旧版本没有 revision 字段：按时间倒序补齐修订号
  const ordered = [...migrated.versions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  ordered.forEach((version, index) => {
    if (typeof version.revision !== 'number') version.revision = index + 1;
  });
  migrated.revision = Math.max(migrated.revision, ...migrated.versions.map((v) => v.revision ?? 0));

  // 旧版本缺少基线快照：最早版本回填为项目创建口径，其余版本从 label（维护 / SW）解析
  ordered.forEach((version, index) => {
    if (version.baseline) return;
    if (index === ordered.length - 1) {
      version.baseline = {
        maintenanceVersion: migrated.maintenanceVersion,
        softwareVersion: migrated.softwareVersion,
        configuration: migrated.configuration
      };
    } else {
      const labelParts = version.label.split('/').map((part) => part.trim());
      version.baseline = {
        maintenanceVersion: labelParts[0] ?? migrated.maintenanceVersion,
        softwareVersion: labelParts[1] ?? migrated.softwareVersion,
        configuration: version.impactedConfigurations[0] ?? migrated.configuration
      };
    }
  });

  // 已批准项目的证据属于正式批准内容：锁定到批准版本，后续基线变更保留原依据；
  // 仍在审阅流程中的 accepted 证据不锁定，随下一次基线更新重新判定。
  const firstVersion = ordered[0];
  const approvedVersion = migrated.status === 'approved' ? ordered[ordered.length - 1] : undefined;
  migrated.evidence.forEach((evidence) => {
    if (approvedVersion && evidence.status === 'accepted' && !evidence.basisVersionId) {
      evidence.basisVersionId = approvedVersion.id;
    }
  });
  migrated.audit.forEach((entry) => {
    if (!entry.basisVersionId && firstVersion) {
      entry.basisVersionId = firstVersion.id;
      entry.basisLabel ??= firstVersion.label;
    }
  });

  return migrated;
}

/** 复核确认旧数据修订号已补全；确认后才允许进入批准 */
export function confirmRevision(project: ApprovalProject, actor: string): ApprovalProject {
  if (project.revisionReady) return project;
  project.revisionReady = true;
  project.audit.unshift(
    makeAudit(actor, '修订号回填确认', `旧数据修订号已回填至 R${project.revision}，变更链依据完整。`, currentBasis(project))
  );
  return project;
}

/* ------------------------------------------------------------------ */
/* 证据状态与法规覆盖重算                                              */
/* ------------------------------------------------------------------ */

/**
 * 基线变更后重算单条证据：
 * - accepted 且依据版本明确：批准内容保留原依据，不动状态，仅在其配置受影响时给出提示；
 * - 非 accepted（submitted/rejected/resubmit/missing）且软件版本落后于新基线：
 *   标记为 resubmit 并记录被哪个版本取代。
 */
export function rebaseEvidence(
  evidence: EvidenceItem,
  baseline: BaselineChange,
  versionId: string,
  impactedConfigurations: string[]
): EvidenceItem {
  const next = deepClone(evidence);
  const configHit = impactedConfigurations.some((config) => next.configurations.includes(config));

  if (next.status === 'accepted' && next.basisVersionId) {
    // 已批准内容保留原依据：不重置状态、不改软件版本
    return next;
  }

  const staleSoftware = next.softwareVersion !== baseline.softwareVersion;
  const needsResubmit = staleSoftware || configHit;

  if (needsResubmit && next.status !== 'missing') {
    next.status = 'resubmit';
    next.supersededByVersionId = versionId;
    next.note = `基线更新为 ${baseline.maintenanceVersion} / SW ${baseline.softwareVersion}，原 ${evidence.softwareVersion} 依据失效，需按新版本重交。`;
    next.updatedAt = new Date().toISOString();
  }
  return next;
}

/**
 * 依据当前项目证据重算法规项覆盖。法规树始终以当前版本口径展示。
 */
export function recomputeRegulations(project: ApprovalProject): RegulationItem[] {
  const baseline = {
    maintenanceVersion: project.maintenanceVersion,
    softwareVersion: project.softwareVersion,
    configuration: project.configuration
  };

  return project.regulations.map((regulation) => {
    const linked = project.evidence.filter((item) => item.regulationId === regulation.id);
    const issues: string[] = [];

    if (!linked.length) {
      return { ...regulation, status: 'missing', coverage: 0, issues: ['尚未关联测试报告'] };
    }

    const accepted = linked.filter((item) => item.status === 'accepted');
    const valid = linked.filter(
      (item) => item.status === 'accepted' || item.status === 'submitted'
    );
    const stale = linked.filter(
      (item) => item.softwareVersion !== baseline.softwareVersion && item.status !== 'accepted'
    );
    const coversCurrent = linked.some((item) => item.configurations.includes(baseline.configuration));

    // 覆盖度：以当前配置是否被有效证据覆盖 + 版本一致性估算
    let coverage = 0;
    if (coversCurrent) coverage += 60;
    if (valid.length) coverage += 20;
    if (!stale.length) coverage += 20;
    coverage = Math.min(100, coverage);

    if (!coversCurrent) issues.push(`当前配置「${baseline.configuration}」缺少证据覆盖`);
    if (stale.length) issues.push(`${stale.length} 份证据软件版本落后于基线 SW ${baseline.softwareVersion}`);
    if (linked.some((item) => ['rejected', 'resubmit', 'missing'].includes(item.status))) {
      issues.push('存在被拒、待重交或缺失证据');
    }

    const hasConflict = stale.length > 0;
    const complete = accepted.length > 0 && !issues.length;
    const status: RegulationItem['status'] = complete
      ? 'complete'
      : hasConflict
        ? 'conflict'
        : 'missing';

    return { ...regulation, coverage, issues, status };
  });
}

export function recomputeProgress(project: ApprovalProject): number {
  if (project.status === 'approved') return 100;
  const required = project.regulations.length || 1;
  const complete = project.regulations.filter((item) => item.status === 'complete').length;
  const accepted = project.evidence.filter((item) => item.status === 'accepted').length;
  const total = project.evidence.length || 1;
  const value = Math.round((complete / required) * 70 + (accepted / total) * 30);
  return Math.max(10, Math.min(96, value));
}

/* ------------------------------------------------------------------ */
/* 冲突检测                                                            */
/* ------------------------------------------------------------------ */

export function detectConflicts(
  project: ApprovalProject,
  baseRevision: number,
  incoming: BaselineChange
): ConflictItem[] {
  if (baseRevision >= project.revision) return [];
  const conflicts: ConflictItem[] = [];
  const push = (field: string, label: string, oldValue: string, newValue: string) => {
    if (oldValue !== newValue) {
      conflicts.push({ field, label, incoming: oldValue, current: newValue });
    }
  };
  push('maintenanceVersion', '维护版本', incoming.maintenanceVersion, project.maintenanceVersion);
  push('softwareVersion', '软件版本', incoming.softwareVersion, project.softwareVersion);
  push('configuration', '配置', incoming.configuration, project.configuration);
  return conflicts;
}

/* ------------------------------------------------------------------ */
/* 补件批次                                                            */
/* ------------------------------------------------------------------ */

export function idempotencyKey(projectId: string, basisVersionId: string, evidenceIds: string[], note: string) {
  return [projectId, basisVersionId, [...evidenceIds].sort().join('|'), note.trim()].join('::');
}

/** 未提交批次随新版本失效；返回失效的批次 */
export function invalidateDraftBatches(project: ApprovalProject, versionId: string, newSoftware: string): SupplementBatch[] {
  const invalidated: SupplementBatch[] = [];
  project.supplements.forEach((batch) => {
    if (batch.status === 'draft') {
      batch.status = 'invalidated';
      batch.reason = `项目基线已更新（新版本 ${versionId}，SW ${newSoftware}），未提交批次按旧口径失效。`;
      invalidated.push(batch);
    }
  });
  return invalidated;
}

/**
 * 并发窗口的后到者：保留补件内容（标记 retained 并列冲突），不覆盖新版本。
 */
export function retainConflictingBatch(
  project: ApprovalProject,
  batch: SupplementBatch,
  conflicts: ConflictItem[]
): SupplementBatch {
  const retained: SupplementBatch = {
    ...batch,
    id: batch.id || makeId('SUP'),
    status: 'retained',
    conflicts,
    reason: `另一窗口已生成 R${project.revision} 版本，本批次内容保留待按新基线确认。`
  };
  project.supplements.unshift(retained);
  return retained;
}

/**
 * 提交批次：幂等。重复（同项目/同版本/同证据/同说明）直接返回既有批次，
 * 不新增证据状态写入、也不新增审计记录。
 */
export function submitBatch(
  project: ApprovalProject,
  draft: SupplementBatch
): { batch: SupplementBatch; duplicated: boolean; changedEvidence: EvidenceItem[] } {
  const version = currentVersion(project);
  const key = idempotencyKey(project.id, version?.id ?? '', draft.evidenceIds, draft.note);

  const existing = project.supplements.find(
    (batch) => batch.status === 'submitted' && batch.idempotencyKey === key
  );
  if (existing) {
    return { batch: existing, duplicated: true, changedEvidence: [] };
  }

  const basis = currentBasis(project);
  const submittedAt = new Date().toISOString();
  const changedEvidence: EvidenceItem[] = [];

  project.evidence.forEach((evidence) => {
    if (!draft.evidenceIds.includes(evidence.id)) return;
    if (evidence.status === 'accepted' && evidence.basisVersionId) return; // 已批准保留原依据
    evidence.status = 'submitted';
    evidence.softwareVersion = project.softwareVersion;
    evidence.basisVersionId = basis.basisVersionId;
    evidence.supersededByVersionId = undefined;
    evidence.note = draft.note || evidence.note;
    evidence.updatedAt = submittedAt;
    changedEvidence.push(evidence);
  });

  const batch: SupplementBatch = {
    ...draft,
    status: 'submitted',
    submittedAt,
    basisVersionId: basis.basisVersionId,
    basisLabel: basis.basisLabel,
    idempotencyKey: key,
    conflicts: undefined,
    // 事务尚未落库：persisted 由调用方在持久化成功后置为 true
    persisted: false,
    baseline: {
      maintenanceVersion: project.maintenanceVersion,
      softwareVersion: project.softwareVersion,
      configuration: project.configuration
    }
  };
  const existingIndex = project.supplements.findIndex((item) => item.id === draft.id);
  if (existingIndex >= 0) project.supplements.splice(existingIndex, 1, batch);
  else project.supplements.unshift(batch);

  return { batch, duplicated: false, changedEvidence };
}

/* ------------------------------------------------------------------ */
/* 恢复：写入失败后从最近完整批次恢复                                  */
/* ------------------------------------------------------------------ */

/**
 * 从最近一个已落库（persisted）的 submitted 完整批次恢复证据状态与依据；
 * 写入失败时产生的在途批次先降级为 invalidated，不作为恢复源；
 * 找不到完整批次时返回 false（交由调用方做版本级回退）。
 */
export function recoverFromLatestCompleteBatch(project: ApprovalProject, actor: string, writeError: string): boolean {
  const recoveredAt = new Date().toISOString();

  // 本次事务产生、但未成功落库的在途批次不完整，先标记失效
  project.supplements.forEach((batch) => {
    if (batch.status === 'submitted' && batch.persisted === false) {
      batch.status = 'invalidated';
      batch.reason = `写入失败（${writeError}），该在途批次未落库，不作为恢复源。`;
    }
  });

  const latest = project.supplements.find((batch) => batch.status === 'submitted' && batch.persisted !== false);

  if (latest) {
    // 版本历史已持久化，项目基线保持当前版本；从最近完整批次恢复证据内容与覆盖状态，
    // 证据按当前版本口径重新挂接（恢复后仍需审阅，但数据回到可用的完整状态）。
    const recoveredBasis = currentBasis(project);

    latest.evidenceIds.forEach((evidenceId) => {
      const evidence = project.evidence.find((item) => item.id === evidenceId);
      if (!evidence) return;
      evidence.status = 'submitted';
      evidence.softwareVersion = project.softwareVersion;
      evidence.basisVersionId = recoveredBasis.basisVersionId;
      evidence.supersededByVersionId = undefined;
      evidence.updatedAt = recoveredAt;
    });

    project.regulations = recomputeRegulations(project);
    project.progress = recomputeProgress(project);
    project.lastRecovery = {
      at: recoveredAt,
      fromBatchId: latest.id,
      detail: `写入失败（${writeError}），已从最近完整批次 ${latest.id}（${latest.basisLabel ?? ''}）恢复证据与覆盖状态，项目基线保持当前版本。`
    };
    project.audit.unshift(
      makeAudit(actor, '故障恢复', project.lastRecovery.detail, recoveredBasis)
    );
    return true;
  }

  project.lastRecovery = {
    at: recoveredAt,
    detail: `写入失败（${writeError}），无完整补件批次，回退到最近版本基线。`
  };
  project.audit.unshift(makeAudit(actor, '故障恢复', project.lastRecovery.detail, currentBasis(project)));
  return false;
}
