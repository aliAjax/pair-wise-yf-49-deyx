import type { Evidence, Objection } from "../types";

/** 普通内容字段：两侧都改且不一致时，需要书记员二选一 */
export type ContentField = "exhibitNo" | "title" | "type" | "duration" | "presenter" | "note";
export const CONTENT_FIELDS: ContentField[] = ["exhibitNo", "title", "type", "duration", "presenter", "note"];
export const FIELD_LABELS: Record<ContentField, string> = {
  exhibitNo: "证号",
  title: "证据名称",
  type: "证据类型",
  duration: "举证时长(分钟)",
  presenter: "举证人",
  note: "备注"
};

export type Side = "staged" | "directory";

export interface MergeConflict {
  /** `${evidenceId}:${field}` */
  id: string;
  evidenceId: string;
  exhibitNo: string;
  field: ContentField;
  staged: string | number;
  directory: string | number;
  choice?: Side;
}

export interface MergeResolution {
  id: string;
  kind: "order" | "sensitive" | "status" | "content" | "objection";
  evidenceId?: string;
  text: string;
  winner?: Side | "locked";
}

export interface FieldClock {
  sensitive?: number;
}

export interface MergeInput {
  base: Evidence[];
  local: Evidence[];
  remote: Evidence[];
  localClocks: Record<string, FieldClock>;
  remoteClocks: Record<string, FieldClock>;
  localOrder: string[] | null;
  localOrderAt: number;
  remoteOrder: string[] | null;
  remoteOrderAt: number;
  localObjections: Objection[];
  remoteObjections: Objection[];
}

export type MergeEvidenceInput = Omit<MergeInput, "localObjections" | "remoteObjections">;

export interface MergePlan {
  conflicts: MergeConflict[];
  resolutions: MergeResolution[];
}

const CONFIRMED: Evidence["status"][] = ["已展示", "已跳过"];
const isConfirmed = (status: Evidence["status"]) => CONFIRMED.includes(status);
const byId = (list: Evidence[]) => new Map(list.map((item) => [item.id, item]));
let rid = 0;
const nextId = (prefix: string) => `${prefix}-${++rid}`;

export function formatClock(at: number) {
  return new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
}

function sameOrder(a: string[], b: string[]) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

type OrderInput = Pick<MergeInput, "localOrder" | "localOrderAt" | "remoteOrder" | "remoteOrderAt">;

function orderWinner(input: OrderInput, baseOrder: string[]): { order: string[]; side: Side; at: number } | null {
  const localChanged = !!input.localOrder && !sameOrder(input.localOrder, baseOrder);
  const remoteChanged = !!input.remoteOrder && !sameOrder(input.remoteOrder, baseOrder);
  if (!localChanged && !remoteChanged) return null;
  if (localChanged && remoteChanged) {
    // 排序取最后改动，时间相同以法官目录为准
    return input.localOrderAt > input.remoteOrderAt
      ? { order: input.localOrder!, side: "staged", at: input.localOrderAt }
      : { order: input.remoteOrder!, side: "directory", at: input.remoteOrderAt };
  }
  if (localChanged) return { order: input.localOrder!, side: "staged", at: input.localOrderAt };
  return { order: input.remoteOrder!, side: "directory", at: input.remoteOrderAt };
}

/** 计算合并预案：自动合并项 + 必须人工选定的冲突；不修改任何数组 */
export function planMerge(input: MergeInput): MergePlan {
  const conflicts: MergeConflict[] = [];
  const resolutions: MergeResolution[] = [];
  const baseMap = byId(input.base);
  const localMap = byId(input.local);
  const remoteMap = byId(input.remote);

  // 1. 证据排序：取最后改动
  const winner = orderWinner(input, input.base.map((item) => item.id));
  if (winner) {
    resolutions.push({
      id: nextId("r"),
      kind: "order",
      text: `证据排序取最后改动（${winner.side === "directory" ? `目录 ${formatClock(winner.at)}` : `暂存 ${formatClock(winner.at)}`}），另一方顺序不覆盖`,
      winner: winner.side
    });
  }

  // 2. 逐证据、逐字段
  for (const id of new Set([...localMap.keys(), ...remoteMap.keys()])) {
    const b = baseMap.get(id);
    const l = localMap.get(id);
    const r = remoteMap.get(id);
    const no = r?.exhibitNo ?? l?.exhibitNo ?? id;

    // 2a. 已完成质证 / 裁定跳过：确认状态保持
    const remoteConfirmed = r && b && isConfirmed(r.status) && r.status !== b.status;
    const localConfirmed = l && b && isConfirmed(l.status) && l.status !== b.status;
    if (remoteConfirmed || localConfirmed) {
      const side: Side = remoteConfirmed ? "directory" : "staged";
      const status = (remoteConfirmed ? r! : l!).status;
      resolutions.push({
        id: nextId("r"),
        kind: "status",
        evidenceId: id,
        text: `${no} 已${status === "已跳过" ? "裁定跳过" : "完成质证"}，保持${side === "directory" ? "法官目录" : "暂存"}侧确认，整批回写也不回退`,
        winner: "locked"
      });
    }

    // 2b. 敏感遮罩：取最后改动（以操作时间戳为准）
    if (b && l && r) {
      const lAt = input.localClocks[id]?.sensitive;
      const rAt = input.remoteClocks[id]?.sensitive;
      const lTouched = l.sensitive !== b.sensitive || lAt !== undefined;
      const rTouched = r.sensitive !== b.sensitive || rAt !== undefined;
      if (lTouched || rTouched) {
        let side: Side;
        let at: number;
        if (lTouched && rTouched) {
          side = (lAt ?? 0) > (rAt ?? 0) ? "staged" : "directory";
          at = side === "staged" ? lAt! : rAt!;
        } else if (lTouched) {
          side = "staged";
          at = lAt ?? 0;
        } else {
          side = "directory";
          at = rAt ?? 0;
        }
        const finalValue = side === "staged" ? l.sensitive : r.sensitive;
        const contested = l.sensitive !== r.sensitive;
        resolutions.push({
          id: nextId("r"),
          kind: "sensitive",
          evidenceId: id,
          text: `${no} 敏感遮罩取最后改动（${side === "directory" ? `目录 ${formatClock(at)}` : `暂存 ${formatClock(at)}`}）→ ${finalValue ? "维持遮罩" : "取消遮罩"}${contested ? "，两侧曾不一致" : ""}`,
          winner: side
        });
      }
    }

    // 2c. 内容字段：仅一侧改 → 自动并入；两侧都改且不一致 → 并列两版待选定
    if (b && l && r) {
      for (const field of CONTENT_FIELDS) {
        const bv = b[field];
        const lv = l[field];
        const rv = r[field];
        if (lv === rv) continue;
        const lChanged = lv !== bv;
        const rChanged = rv !== bv;
        if (lChanged && rChanged) {
          conflicts.push({ id: `${id}:${field}`, evidenceId: id, exhibitNo: no, field, staged: lv, directory: rv });
        } else if (lChanged || rChanged) {
          resolutions.push({
            id: nextId("r"),
            kind: "content",
            evidenceId: id,
            text: `${no} ${FIELD_LABELS[field]}仅${lChanged ? "暂存" : "目录"}侧修改，自动并入`,
            winner: lChanged ? "staged" : "directory"
          });
        }
      }
    }
  }

  // 3. 异议裁定：取最后裁定
  for (const ro of input.remoteObjections) {
    const lo = input.localObjections.find((item) => item.id === ro.id);
    const evidence = remoteMap.get(ro.evidenceId) ?? localMap.get(ro.evidenceId);
    if (ro.status !== "待裁定" && (!lo || lo.status === "待裁定" || (ro.resolvedAt ?? 0) >= (lo.resolvedAt ?? 0))) {
      resolutions.push({
        id: nextId("r"),
        kind: "objection",
        evidenceId: ro.evidenceId,
        text: `${evidence?.exhibitNo ?? ro.evidenceId} 异议裁定取最后改动：目录侧「${ro.status}」${ro.status === "支持" ? "，证据保持跳过" : "，继续质证"}`,
        winner: "directory"
      });
    }
  }

  return { conflicts, resolutions };
}

/** 书记员完成选定后，产出合并进目录的最终证据数组 */
export function buildMergedEvidence(input: MergeEvidenceInput, choices: Record<string, Side>): Evidence[] {
  const baseMap = byId(input.base);
  const localMap = byId(input.local);
  const remoteMap = byId(input.remote);
  const merged = new Map<string, Evidence>();

  for (const id of new Set([...localMap.keys(), ...remoteMap.keys()])) {
    const b = baseMap.get(id);
    const l = localMap.get(id);
    const r = remoteMap.get(id);
    const out: Evidence = structuredClone((l ?? r)!);
    if (b && l && r) {
      const outRecord = out as unknown as Record<string, string | number | boolean>;
      for (const field of CONTENT_FIELDS) {
        const bv = b[field];
        const lv = l[field];
        const rv = r[field];
        if (lv === rv) {
          outRecord[field] = lv;
        } else if (lv !== bv && rv !== bv) {
          outRecord[field] = choices[`${id}:${field}`] === "staged" ? lv : rv;
        } else if (lv !== bv) {
          outRecord[field] = lv;
        } else if (rv !== bv) {
          outRecord[field] = rv;
        }
      }

      // 敏感遮罩 LWW
      const lAt = input.localClocks[id]?.sensitive;
      const rAt = input.remoteClocks[id]?.sensitive;
      const lTouched = l.sensitive !== b.sensitive || lAt !== undefined;
      const rTouched = r.sensitive !== b.sensitive || rAt !== undefined;
      if (lTouched && rTouched) {
        out.sensitive = (lAt ?? 0) > (rAt ?? 0) ? l.sensitive : r.sensitive;
      } else if (rTouched) {
        out.sensitive = r.sensitive;
      } else if (lTouched) {
        out.sensitive = l.sensitive;
      }

      // 确认状态锁定：法官目录侧确认优先，其次暂存侧
      const remoteConfirmed = isConfirmed(r.status) && r.status !== b.status;
      const localConfirmed = isConfirmed(l.status) && l.status !== b.status;
      if (remoteConfirmed) out.status = r.status;
      else if (localConfirmed) out.status = l.status;
      else if (r.status !== b.status) out.status = r.status;
      else out.status = l.status;
    }
    merged.set(id, out);
  }

  // 按获胜顺序重排，新增/遗漏项保持相对顺序追加
  const decided = orderWinner(input, input.base.map((item) => item.id));
  const order = decided?.order ?? input.base.map((item) => item.id);
  const result: Evidence[] = [];
  for (const id of order) {
    const item = merged.get(id);
    if (item) result.push(item);
  }
  for (const id of merged.keys()) {
    if (!result.some((item) => item.id === id)) result.push(merged.get(id)!);
  }
  return result;
}

/** 异议合并：裁定时戳晚者胜；暂存侧新增的异议保留 */
export function mergeObjections(local: Objection[], remote: Objection[]): Objection[] {
  const map = new Map(local.map((item) => [item.id, structuredClone(item)]));
  for (const ro of remote) {
    const lo = map.get(ro.id);
    if (!lo) {
      map.set(ro.id, structuredClone(ro));
      continue;
    }
    if (ro.status !== "待裁定" && (lo.status === "待裁定" || (ro.resolvedAt ?? 0) >= (lo.resolvedAt ?? 0))) {
      lo.status = ro.status;
      lo.resolvedAt = ro.resolvedAt;
    }
  }
  return [...map.values()];
}
