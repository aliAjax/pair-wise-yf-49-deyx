import type { Evidence } from "../types";
import type { State } from "./courtSlice";
import type { MergeResolution } from "./merge";

export interface PublicView {
  merging: boolean;
  /** 合并完成前，这些证据的敏感备注不得出现在公开屏 */
  gatedIds: Set<string>;
  orderChanged: boolean;
  version: number;
}

/** 合并期间的公开屏策略：重算中 + 敏感备注门控 */
export function selectPublicView(state: State): PublicView {
  const merging = state.merge.status === "merging";
  if (!merging) return { merging: false, gatedIds: new Set(), orderChanged: false, version: state.publicVersion };
  const gatedIds = new Set<string>();
  const orderChanged = state.merge.resolutions.some((item) => item.kind === "order");
  const collect = (item: MergeResolution) => {
    if (!item.evidenceId) return;
    if (item.kind === "sensitive" || item.kind === "content") {
      const evidence = state.evidence.find((entry) => entry.id === item.evidenceId);
      if (evidence?.sensitive) gatedIds.add(item.evidenceId);
    }
  };
  state.merge.resolutions.forEach(collect);
  state.merge.conflicts.forEach((conflict) => {
    if (conflict.field === "note") {
      const evidence = state.evidence.find((entry) => entry.id === conflict.evidenceId);
      if (evidence?.sensitive) gatedIds.add(conflict.evidenceId);
    }
  });
  return { merging: true, gatedIds, orderChanged, version: state.publicVersion };
}

/** 公开屏已确认画面：只呈现已确认证据，顺序跟随目录，版本号驱动重算 */
export function selectConfirmedSequence(state: State): Evidence[] {
  void state.publicVersion; // 作为重算信号
  return state.evidence.filter((item) => item.status === "已展示" || item.status === "已跳过");
}
