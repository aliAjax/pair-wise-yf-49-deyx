import type { Evidence, FieldConflict, MergeField, StagedItem } from "../types";

/** 内容字段：两边都改时并列两版，由书记员选定 */
const CONTENT_FIELDS: MergeField[] = ["exhibitNo", "title", "type", "duration", "presenter", "note"];
/** 锁定字段：已质证/已跳过保持确认，不可被离线改动回滚 */
const LOCKED_FIELDS: MergeField[] = ["status"];
/** 最后改动胜出字段：敏感遮罩按时间戳 LWW */
const LWW_FIELDS: MergeField[] = ["sensitive"];

export interface MergeInput {
  base: Evidence[];
  server: Evidence[];
  stagedItems: Record<string, StagedItem>;
  stagedOrder: string[] | null;
  stagedOrderAt: string | null;
  serverOrder: string[] | null;
  serverOrderAt: string | null;
  serverUpdatedAt: string | null;
}

export interface MergeResult {
  evidence: Evidence[];
  conflicts: FieldConflict[];
  orderChoice: "staged" | "server" | null;
  orderChanged: boolean;
  sensitiveChoice: Record<string, "staged" | "server">;
}

/**
 * 三向字段级合并：
 * - 仅暂存侧改动 → 采用暂存侧
 * - 仅目录侧改动 → 采用目录侧（法官刚确认的进度）
 * - 两边都改：
 *   - 已质证/已跳过 → 锁定，保持目录侧确认
 *   - 敏感遮罩 → 最后改动(LWW)
 *   - 其余内容字段 → 并列两版，书记员选定
 * - 证据顺序 → 最后改动(LWW)
 */
export function computeMerge(input: MergeInput): MergeResult {
  const { base, server, stagedItems, stagedOrder, stagedOrderAt, serverOrder, serverOrderAt, serverUpdatedAt } = input;
  const conflicts: FieldConflict[] = [];
  const sensitiveChoice: Record<string, "staged" | "server"> = {};
  const serverAt = serverUpdatedAt ?? "";

  const evidence: Evidence[] = server.map((serverItem) => {
    const baseItem = base.find((entry) => entry.id === serverItem.id);
    const staged = stagedItems[serverItem.id];
    const result: Evidence = { ...serverItem };
    if (!staged || !baseItem) return result;

    for (const field of [...CONTENT_FIELDS, ...LOCKED_FIELDS, ...LWW_FIELDS] as MergeField[]) {
      const stagedChange = staged.changes[field];
      if (!stagedChange) continue;
      const serverChanged = JSON.stringify(serverItem[field]) !== JSON.stringify(baseItem[field]);
      if (!serverChanged) {
        // 仅暂存侧改动：直接采用
        Object.assign(result, { [field]: stagedChange.value });
        continue;
      }
      if (field === "status" && (serverItem.status === "已展示" || serverItem.status === "已跳过")) {
        // 已完成质证或裁定跳过：保持确认，锁定目录侧
        conflicts.push({ evidenceId: serverItem.id, field, stagedValue: stagedChange.value, serverValue: serverItem[field], choice: "server", locked: true, lockReason: "法官已确认质证/跳过，保持确认" });
        continue;
      }
      if (field === "sensitive") {
        const choice: "staged" | "server" = stagedChange.at > serverAt ? "staged" : "server";
        sensitiveChoice[serverItem.id] = choice;
        if (choice === "staged") result.sensitive = stagedChange.value as boolean;
        conflicts.push({ evidenceId: serverItem.id, field, stagedValue: stagedChange.value, serverValue: serverItem.sensitive, choice, locked: true, lockReason: "遮罩按最后改动采用" });
        continue;
      }
      // 内容字段两边都改：并列两版，书记员选定
      conflicts.push({ evidenceId: serverItem.id, field, stagedValue: stagedChange.value, serverValue: serverItem[field], choice: null, locked: false });
    }
    return result;
  });

  // 证据顺序：最后改动胜出
  let orderChoice: "staged" | "server" | null = null;
  const orderChanged = !!stagedOrder || !!serverOrder;
  if (stagedOrder && serverOrder && JSON.stringify(stagedOrder) !== JSON.stringify(serverOrder)) {
    orderChoice = (stagedOrderAt ?? "") > (serverOrderAt ?? "") ? "staged" : "server";
  } else if (stagedOrder) {
    orderChoice = "staged";
  } else if (serverOrder) {
    orderChoice = "server";
  }
  if (orderChoice === "staged" && stagedOrder) {
    evidence.sort((a, b) => stagedOrder.indexOf(a.id) - stagedOrder.indexOf(b.id));
  } else if (orderChoice === "server" && serverOrder) {
    evidence.sort((a, b) => serverOrder.indexOf(a.id) - serverOrder.indexOf(b.id));
  }

  return { evidence, conflicts, orderChoice, orderChanged, sensitiveChoice };
}

/** 应用书记员的字段选择到合并结果 */
export function applyFieldChoice(evidence: Evidence[], evidenceId: string, field: MergeField, choice: "staged" | "server", stagedValue: unknown, serverValue: unknown): Evidence[] {
  return evidence.map((item) => {
    if (item.id !== evidenceId) return item;
    const value = choice === "staged" ? stagedValue : serverValue;
    return { ...item, [field]: value };
  });
}
