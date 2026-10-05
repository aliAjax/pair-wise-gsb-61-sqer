import type {
  ApprovalProject,
  AuditEntry,
  ProjectVersion,
  RegulationItem,
  RevisionConflict
} from '~/types/certification';

/**
 * 变更链纯函数：项目版本、证据、法规项和补件批次共用同一套修订号规则，
 * 保证页面、法规项目树和审计记录读到同一份版本依据。
 */

export function nextRevision(project: ApprovalProject) {
  project.revision = (project.revision ?? 0) + 1;
  return project.revision;
}

/** 旧数据缺修订号时视为未回填，补全前不能批准 */
export function needsRevisionBackfill(project: ApprovalProject) {
  return (
    project.revision == null ||
    project.versions.some((version) => version.revision == null) ||
    project.evidence.some((item) => item.basisRevision == null) ||
    project.audit.some((entry) => entry.revision == null)
  );
}

function revisionAt(versions: ProjectVersion[], timestamp: string) {
  const sorted = [...versions]
    .filter((version) => version.revision != null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let revision = 1;
  for (const version of sorted) {
    if (version.createdAt <= timestamp) revision = version.revision!;
  }
  return revision;
}

/**
 * 按版本链回填缺失的修订号：版本按时间正序编号，证据和审计记录
 * 取各自时间戳所处的版本修订号。回填幂等，重复执行不产生新记录。
 * 返回是否发生了回填。
 */
export function backfillProject(project: ApprovalProject, makeAudit: (detail: string, revision: number) => AuditEntry) {
  let changed = false;
  if (!Array.isArray(project.supplements)) {
    project.supplements = [];
    changed = true;
  }
  if (project.revision == null) {
    project.revision = Math.max(1, project.versions.length);
    changed = true;
  }
  const ordered = [...project.versions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  ordered.forEach((version, index) => {
    if (version.revision == null) {
      version.revision = index + 1;
      changed = true;
    }
  });
  project.evidence.forEach((item) => {
    if (item.basisRevision == null) {
      item.basisRevision = revisionAt(project.versions, item.updatedAt);
      changed = true;
    }
  });
  project.audit.forEach((entry) => {
    if (entry.revision == null) {
      entry.revision = revisionAt(project.versions, entry.createdAt);
      changed = true;
    }
  });
  if (changed) {
    project.audit.unshift(makeAudit(`旧数据缺少修订号，已按版本链回填至 R${project.revision}，补全前项目不能批准。`, project.revision));
  }
  return changed;
}

/** 项目涉及的全部配置（申报配置 + 证据覆盖配置） */
export function allConfigurations(project: ApprovalProject) {
  return Array.from(new Set([project.configuration, ...project.evidence.flatMap((item) => item.configurations)]));
}

/**
 * 版本更新后重算受影响配置的证据状态：
 * 软件基线已移动、且覆盖受影响配置的证据需要重新提交；
 * 已批准项目的证据保留原依据，不做降级。
 */
export function recomputeEvidenceForBaseline(project: ApprovalProject, impactedConfigurations: string[], now: string) {
  const downgraded: string[] = [];
  if (project.status === 'approved') return downgraded;
  project.evidence.forEach((item) => {
    const impacted = item.configurations.some((config) => impactedConfigurations.includes(config));
    if (!impacted || item.softwareVersion === project.softwareVersion) return;
    if (item.status === 'accepted' || item.status === 'submitted') {
      item.status = 'resubmit';
      item.note = `基线更新至 SW ${project.softwareVersion}（R${project.revision}），原依据 R${item.basisRevision ?? '?'} 的审阅结论保留，需按新基线重新提交。`;
      item.updatedAt = now;
      downgraded.push(item.id);
    }
  });
  return downgraded;
}

/** 版本更新后，未提交的补件批次失效；已提交批次保留原依据 */
export function voidDraftBatches(project: ApprovalProject, now: string) {
  let voided = 0;
  project.supplements.forEach((batch) => {
    if (batch.status !== 'draft') return;
    batch.status = 'voided';
    batch.voidedAt = now;
    batch.voidReason = `项目版本更新至 R${project.revision}，未提交批次失效`;
    voided += 1;
  });
  return voided;
}

/** 由证据推导法规项覆盖，保证法规项目树与审批依据一致 */
export function recalculateRegulations(project: ApprovalProject) {
  if (project.status === 'approved') return;
  project.regulations.forEach((regulation: RegulationItem) => {
    const linked = project.evidence.filter((item) => item.regulationId === regulation.id);
    if (!linked.length) {
      regulation.status = 'missing';
      regulation.coverage = 0;
      regulation.issues = ['尚未关联测试报告'];
      return;
    }
    const mismatched = linked.filter((item) => item.softwareVersion !== project.softwareVersion);
    const rejected = linked.filter((item) => item.status === 'rejected');
    const pending = linked.filter((item) => ['missing', 'submitted', 'resubmit'].includes(item.status));
    const accepted = linked.filter((item) => item.status === 'accepted' && item.softwareVersion === project.softwareVersion);
    const issues: string[] = [];
    if (mismatched.length) issues.push(`软件基线 ${project.softwareVersion} 与 ${mismatched.length} 项证据软件版本不一致`);
    if (rejected.length) issues.push(`${rejected.length} 项证据被拒绝，需重新提交`);
    if (pending.length) issues.push(`${pending.length} 项证据待审阅或需重交`);
    regulation.coverage = Math.round((accepted.length / linked.length) * 100);
    regulation.issues = issues;
    regulation.status =
      accepted.length === linked.length ? 'complete' : mismatched.length || rejected.length ? 'conflict' : 'missing';
  });
  const complete = project.regulations.filter((item) => item.status === 'complete').length;
  project.progress = Math.round((complete / Math.max(1, project.regulations.length)) * 100);
}

/** 后到者的冲突清单：先到者在 expectedRevision 之后生成的版本与审计记录 */
export function buildConflict(project: ApprovalProject, expectedRevision: number): RevisionConflict {
  return {
    projectId: project.id,
    expectedRevision,
    currentRevision: project.revision ?? 0,
    versions: project.versions.filter((version) => (version.revision ?? 0) > expectedRevision),
    audit: project.audit.filter((entry) => (entry.revision ?? 0) > expectedRevision)
  };
}
