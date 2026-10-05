export const projectStatuses = [
  'draft',
  'submitted',
  'under_review',
  'supplement_required',
  'approved',
  'rejected'
] as const;

export const evidenceStatuses = ['missing', 'submitted', 'accepted', 'rejected', 'resubmit'] as const;

export type ProjectStatus = (typeof projectStatuses)[number];
export type EvidenceStatus = (typeof evidenceStatuses)[number];

export interface RegulationItem {
  id: string;
  code: string;
  title: string;
  category: '安全' | '环保' | '能耗' | '软件' | '部件';
  required: boolean;
  status: 'complete' | 'missing' | 'conflict';
  coverage: number;
  issues: string[];
}

export interface EvidenceItem {
  id: string;
  projectId: string;
  regulationId: string;
  name: string;
  type: 'test_report' | 'part_list' | 'software_report' | 'exemption' | 'certificate';
  version: string;
  softwareVersion: string;
  configurations: string[];
  status: EvidenceStatus;
  expiryDate?: string;
  note: string;
  updatedAt: string;
  /** 证据当前依据的版本；批准后该依据被冻结，基线变更不改变已接受证据 */
  basisVersionId?: string;
  /** 证据最后一次被哪一个版本判定为失效，需按新版本重交 */
  supersededByVersionId?: string;
}

export interface ProjectVersion {
  id: string;
  label: string;
  author: string;
  createdAt: string;
  summary: string;
  changes: string[];
  impactedConfigurations: string[];
  /** 单调递增修订号，用于乐观并发：先到者 +1，后到者按冲突处理 */
  revision?: number;
  /** 该版本相对上一版本变更的软件 / 维护 / 配置基线，供冲突清单使用 */
  baseline?: {
    maintenanceVersion: string;
    softwareVersion: string;
    configuration: string;
  };
}

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  detail: string;
  createdAt: string;
  /** 该记录生效时的项目版本，批准内容永久保留原依据 */
  basisVersionId?: string;
  basisLabel?: string;
}

/** 补件批次：草稿（未提交）随基线变更失效；提交是幂等操作，不重复产生证据/审计 */
export interface SupplementBatch {
  id: string;
  status: 'draft' | 'submitted' | 'invalidated' | 'retained';
  evidenceIds: string[];
  note: string;
  author: string;
  createdAt: string;
  submittedAt?: string;
  /** 批次依据的项目版本：提交后固定为当前版本 */
  basisVersionId?: string;
  basisLabel?: string;
  /** 失效 / 保留（冲突）原因 */
  reason?: string;
  /** 并发冲突时后到者提交所基于的修订号 */
  baseRevision?: number;
  conflicts?: ConflictItem[];
  /** 幂等键：同项目、同版本、同证据集、同说明重复提交不重复落库 */
  idempotencyKey?: string;
  /** 批次是否已成功落库；写入失败的在途批次不作为“最近完整批次” */
  persisted?: boolean;
  /** 提交时项目基线快照，供故障恢复回放 */
  baseline?: BaselineChange;
}

export interface ConflictItem {
  field: string;
  label: string;
  /** 后到者持有的旧口径 */
  incoming: string;
  /** 先到者已生成版本的新口径 */
  current: string;
}

export interface ApprovalProject {
  id: string;
  name: string;
  modelCode: string;
  vehicleType: string;
  configuration: string;
  maintenanceVersion: string;
  softwareVersion: string;
  status: ProjectStatus;
  progress: number;
  applicant: string;
  reviewer: string;
  agency: string;
  submittedAt?: string;
  updatedAt: string;
  certificateExpiry: string;
  regulations: RegulationItem[];
  evidence: EvidenceItem[];
  versions: ProjectVersion[];
  audit: AuditEntry[];
  /** 当前项目修订号，随每次基线版本递增 */
  revision: number;
  /** 旧数据修订号回填是否完成；未完成不能批准 */
  revisionReady: boolean;
  supplements: SupplementBatch[];
  /** 最近一次写入失败后是否已从最近完整批次恢复 */
  lastRecovery?: {
    at: string;
    fromBatchId?: string;
    detail: string;
  };
}

/** 落库 / 种子里可能仍是缺字段的旧结构 */
export type LegacyApprovalProject = Omit<
  ApprovalProject,
  'revision' | 'revisionReady' | 'supplements'
> & {
  revision?: number;
  revisionReady?: boolean;
  supplements?: SupplementBatch[];
};

export interface ProjectInput {
  name: string;
  modelCode: string;
  vehicleType: string;
  configuration: string;
  maintenanceVersion: string;
  softwareVersion: string;
  applicant: string;
  agency: string;
  certificateExpiry: string;
}

export interface ProjectFilters {
  query: string;
  status: ProjectStatus | 'all';
  agency: string | 'all';
  risk: 'all' | 'expiring' | 'missing' | 'version_conflict';
}

export interface BaselineChange {
  maintenanceVersion: string;
  softwareVersion: string;
  configuration: string;
}

export interface ConcurrentSupplement {
  evidenceIds: string[];
  note: string;
  author: string;
}

export interface VersionUpdateResult {
  ok: boolean;
  conflict?: {
    conflicts: ConflictItem[];
    retainedBatchId?: string;
    currentRevision: number;
  };
  versionId?: string;
}

export interface SupplementSubmitResult {
  ok: boolean;
  duplicated?: boolean;
  batchId?: string;
  count?: number;
  recovered?: boolean;
}
