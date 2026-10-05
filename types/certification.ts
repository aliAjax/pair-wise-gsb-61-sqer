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
  /** 证据最近一次提交/更新所依据的项目修订号；旧数据可能缺失，需要回填 */
  basisRevision?: number;
  expiryDate?: string;
  note: string;
  updatedAt: string;
}

export interface ProjectVersion {
  id: string;
  /** 生成该版本时的项目修订号，串联变更链 */
  revision?: number;
  label: string;
  author: string;
  createdAt: string;
  summary: string;
  changes: string[];
  impactedConfigurations: string[];
}

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  detail: string;
  /** 记录写入时的项目修订号，审计保留原依据不随后续版本改写 */
  revision?: number;
  /** 幂等键：重复提交同一操作时不再新增审计记录 */
  idempotencyKey?: string;
  createdAt: string;
}

export const supplementBatchStatuses = ['draft', 'submitted', 'voided'] as const;
export type SupplementBatchStatus = (typeof supplementBatchStatuses)[number];

export interface SupplementBatch {
  id: string;
  projectId: string;
  evidenceIds: string[];
  note: string;
  status: SupplementBatchStatus;
  /** 创建批次时依据的项目修订号 */
  basisRevision: number;
  /** 提交批次时的项目修订号 */
  submittedRevision?: number;
  /** 幂等键：重复提交不新增证据或审计 */
  idempotencyKey: string;
  createdAt: string;
  submittedAt?: string;
  voidedAt?: string;
  voidReason?: string;
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
  /** 当前修订号，每次变更递增；旧数据可能缺失，需要回填后才能批准 */
  revision?: number;
  submittedAt?: string;
  updatedAt: string;
  certificateExpiry: string;
  regulations: RegulationItem[];
  evidence: EvidenceItem[];
  versions: ProjectVersion[];
  supplements: SupplementBatch[];
  audit: AuditEntry[];
}

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

/** 两个窗口同时修改同一项目时，后到者收到的冲突信息 */
export interface RevisionConflict {
  projectId: string;
  expectedRevision: number;
  currentRevision: number;
  /** 先到者在 expectedRevision 之后生成的版本 */
  versions: ProjectVersion[];
  /** 先到者在 expectedRevision 之后写入的审计记录 */
  audit: AuditEntry[];
}

export interface MutationResult {
  ok: boolean;
  /** 幂等命中：同一操作已应用过，未新增证据或审计 */
  duplicated?: boolean;
  error?: string;
  conflict?: RevisionConflict;
}

export interface SupplementBatchResult extends MutationResult {
  batchId?: string;
  count?: number;
}
