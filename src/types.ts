export type Party = "原告" | "被告" | "审判庭";
export type EvidenceStatus = "待展示" | "展示中" | "已展示" | "已跳过";
export type SessionPhase = "开庭" | "举证" | "质证" | "休庭" | "结束";

export interface Evidence {
  id: string;
  exhibitNo: string;
  title: string;
  type: "书证" | "物证" | "电子数据" | "证人";
  duration: number;
  presenter: Party;
  sensitive: boolean;
  status: EvidenceStatus;
  note: string;
}

export interface Objection {
  id: string;
  evidenceId: string;
  ground: string;
  explanation: string;
  status: "待裁定" | "支持" | "驳回";
  createdAt: string;
  updatedAt: string;
}

export interface TimelineEntry {
  id: string;
  time: string;
  actor: Party | "书记员";
  action: string;
  detail: string;
}

export interface SessionState {
  phase: SessionPhase;
  currentEvidenceId: string | null;
  timerSeconds: number;
  operatorMode: "庭审控制" | "公开屏预览";
}

// ===== 离线暂存与按字段合并 =====

/** 可离线编辑、参与合并的证据字段 */
export type MergeField = "exhibitNo" | "title" | "type" | "duration" | "presenter" | "sensitive" | "status" | "note";

export const FIELD_LABELS: Record<MergeField, string> = {
  exhibitNo: "证据编号",
  title: "证据名称",
  type: "证据类型",
  duration: "时长(分钟)",
  presenter: "举证方",
  sensitive: "敏感遮罩",
  status: "质证状态",
  note: "备注",
};

/** 暂存区中单项证据的离线改动：按字段记录最后改动时间与值 */
export interface StagedItem {
  evidenceId: string;
  changes: Partial<Record<MergeField, { at: string; value: unknown }>>;
}

/** 合并比对中的一个字段级冲突 */
export interface FieldConflict {
  evidenceId: string;
  field: MergeField;
  stagedValue: unknown;
  serverValue: unknown;
  choice: "staged" | "server" | null;
  locked: boolean;
  lockReason?: string;
}

/** 持久化到本地的暂存快照（断网期间书记员的离线改动） */
export interface PersistedStaging {
  syncBase: Evidence[];
  serverCatalog: Evidence[] | null;
  serverOrder: string[] | null;
  serverOrderAt: string | null;
  serverUpdatedAt: string | null;
  syncObjections: Objection[];
  serverObjections: Objection[] | null;
  stagedItems: Record<string, StagedItem>;
  stagedOrder: string[] | null;
  stagedOrderAt: string | null;
  stagedObjections: Objection[];
}
