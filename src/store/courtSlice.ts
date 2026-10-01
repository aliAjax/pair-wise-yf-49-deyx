import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { Evidence, Objection, SessionPhase, SessionState, TimelineEntry } from "../types";
import { buildMergedEvidence, CONTENT_FIELDS, mergeObjections, planMerge, type FieldClock, type MergeConflict, type MergeResolution, type Side } from "./merge";

const seedEvidence: Evidence[] = [
  { id: "e1", exhibitNo: "原告-003", title: "项目验收会议纪要", type: "书证", duration: 8, presenter: "原告", sensitive: false, status: "待展示", note: "第4页涉及合同补充约定" },
  { id: "e2", exhibitNo: "原告-004", title: "设备故障检测报告", type: "书证", duration: 10, presenter: "原告", sensitive: true, status: "待展示", note: "含第三方客户名称，公开屏需遮罩" },
  { id: "e3", exhibitNo: "被告-002", title: "系统运行日志", type: "电子数据", duration: 12, presenter: "被告", sensitive: false, status: "待展示", note: "重点展示 14:20 至 14:45" }
];
const seedSession: SessionState = { phase: "举证", currentEvidenceId: "e1", timerSeconds: 8 * 60, operatorMode: "庭审控制" };

interface MergeState {
  status: "idle" | "merging";
  /** 断网瞬间的共同基线（三路合并的 base） */
  base: Evidence[];
  /** 回网时法官侧目录（remote） */
  remote: Evidence[];
  remoteClocks: Record<string, FieldClock>;
  remoteOrderAt: number;
  remoteObjections: Objection[];
  /** 规则自动合并说明 */
  resolutions: MergeResolution[];
  /** 两版并存、待书记员选定的字段冲突 */
  conflicts: MergeConflict[];
  /** 已落盘的合并说明（留痕用） */
  appliedResolutions: MergeResolution[];
}

const idleMerge: MergeState = {
  status: "idle",
  base: [],
  remote: [],
  remoteClocks: {},
  remoteOrderAt: 0,
  remoteObjections: [],
  resolutions: [],
  conflicts: [],
  appliedResolutions: []
};

export interface State {
  initialized: boolean;
  evidence: Evidence[];
  objections: Objection[];
  timeline: TimelineEntry[];
  snapshots: { id: string; label: string; time: string; evidence: Evidence[]; phase: SessionPhase; currentEvidenceId: string | null }[];
  session: SessionState;
  online: boolean;
  /** 公开屏已确认画面版本：合并落盘 / 在线改序后重算 */
  publicVersion: number;
  merge: MergeState;
  /** 断网暂存：字段操作时钟（敏感遮罩） */
  localClocks: Record<string, FieldClock>;
  localOrder: string[] | null;
  localOrderAt: number;
  /** 模拟法官侧改动是否已注入 */
  judgeEditsApplied: boolean;
}

const initialState: State = {
  initialized: false,
  evidence: seedEvidence,
  objections: [{ id: "o1", evidenceId: "e2", ground: "关联性异议", explanation: "检测报告来源和保管链尚未说明。", status: "待裁定", createdAt: new Date().toISOString() }],
  timeline: [{ id: "t1", time: new Date().toISOString(), actor: "书记员", action: "庭审开始", detail: "核对到庭人员并宣布法庭纪律" }],
  snapshots: [], session: seedSession, online: true, publicVersion: 0,
  merge: idleMerge, localClocks: {}, localOrder: null, localOrderAt: 0, judgeEditsApplied: false
};

function addEntry(state: State, actor: TimelineEntry["actor"], action: string, detail: string) {
  state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), actor, action, detail });
}

const slice = createSlice({
  name: "court",
  initialState,
  reducers: {
    initialize(state, action: PayloadAction<Evidence[]>) { if (!state.initialized) { state.evidence = action.payload.length ? action.payload : seedEvidence; state.initialized = true; } },
    setOnline(state, action: PayloadAction<boolean>) {
      // 仅处理“断网”：回网必须走 reconnect（按字段合并，不允许直接切回在线）
      if (action.payload || !state.online || state.merge.status === "merging") return;
      // 断网：固化共同基线，之后所有改动只进暂存
      state.online = false;
      state.merge = idleMerge;
      state.merge.base = structuredClone(state.evidence);
      state.localClocks = {};
      state.localOrder = null;
      state.localOrderAt = 0;
      state.judgeEditsApplied = false;
      addEntry(state, "书记员", "操作台断网", "改动进入本地暂存，回网后按字段合并，不做整批回写");
    },
    setMode(state, action: PayloadAction<SessionState["operatorMode"]>) { state.session.operatorMode = action.payload; },
    reorder(state, action: PayloadAction<Evidence[]>) {
      state.evidence = action.payload;
      if (!state.online) {
        state.localOrder = action.payload.map((item) => item.id);
        state.localOrderAt = Date.now();
        addEntry(state, "书记员", "离线调整证据顺序", "已暂存，回网后与法官目录按最后改动合并");
      } else {
        state.publicVersion += 1;
        addEntry(state, "书记员", "调整证据顺序", "已更新举证顺序，公开屏已确认画面重算");
      }
    },
    selectEvidence(state, action: PayloadAction<string>) { const item = state.evidence.find((entry) => entry.id === action.payload); if (!item) return; state.session.currentEvidenceId = item.id; state.session.timerSeconds = item.duration * 60; addEntry(state, item.presenter, "切换展示证据", `${item.exhibitNo} ${item.title}${state.online ? "" : "（离线暂存）"}`); },
    showEvidence(state) { const item = state.evidence.find((entry) => entry.id === state.session.currentEvidenceId); if (!item) return; item.status = "展示中"; state.session.phase = "质证"; addEntry(state, item.presenter, "开始展示", item.title + (state.online ? "" : "（离线暂存）")); },
    completeEvidence(state) { const item = state.evidence.find((entry) => entry.id === state.session.currentEvidenceId); if (!item) return; item.status = "已展示"; const next = state.evidence.find((entry) => entry.status === "待展示"); state.session.currentEvidenceId = next?.id ?? null; state.session.timerSeconds = (next?.duration ?? 0) * 60; state.session.phase = next ? "举证" : "休庭"; addEntry(state, "审判庭", "完成质证", item.title + (state.online ? "" : "（离线暂存，回网后保持确认）")); },
    toggleSensitive(state, action: PayloadAction<string>) {
      const item = state.evidence.find((entry) => entry.id === action.payload);
      if (!item) return;
      item.sensitive = !item.sensitive;
      if (!state.online) {
        state.localClocks[item.id] ??= {};
        state.localClocks[item.id].sensitive = Date.now();
        addEntry(state, "审判庭", item.sensitive ? "离线隐藏敏感内容" : "离线恢复公开内容", `${item.title}（改动暂存，备注在合并完成前不公开）`);
      } else {
        addEntry(state, "审判庭", item.sensitive ? "隐藏敏感内容" : "恢复公开内容", item.title);
      }
    },
    /** 离线时编辑备注等内容字段，仅写暂存 */
    stageNote(state, action: PayloadAction<{ id: string; note: string }>) {
      const item = state.evidence.find((entry) => entry.id === action.payload.id);
      if (!item || state.online) return;
      item.note = action.payload.note;
    },
    addObjection(state, action: PayloadAction<{ evidenceId: string; ground: string; explanation: string }>) { const item = state.evidence.find((entry) => entry.id === action.payload.evidenceId); state.objections.unshift({ ...action.payload, id: crypto.randomUUID(), status: "待裁定", createdAt: new Date().toISOString() }); state.session.phase = "质证"; addEntry(state, item?.presenter ?? "审判庭", "提出异议", `${item?.exhibitNo ?? ""} ${action.payload.ground}`); },
    resolveObjection(state, action: PayloadAction<{ id: string; status: "支持" | "驳回" }>) {
      const objection = state.objections.find((entry) => entry.id === action.payload.id);
      if (!objection) return;
      objection.status = action.payload.status;
      if (!state.online) objection.resolvedAt = Date.now();
      const item = state.evidence.find((entry) => entry.id === objection.evidenceId);
      if (action.payload.status === "支持" && item) { item.status = "已跳过"; addEntry(state, "审判庭", "异议成立", `${item.exhibitNo} 暂不展示${state.online ? "" : "（离线裁定暂存）"}`); }
      else { addEntry(state, "审判庭", "异议驳回", (item?.title ?? "继续质证") + (state.online ? "" : "（离线裁定暂存）")); }
    },
    /**
     * 演示用：断网期间法官在协作目录一侧的改动。
     * remote 只在回网时参与合并，不触碰当前暂存数组。
     */
    simulateJudgeEdits(state) {
      if (state.online || state.judgeEditsApplied) return;
      const now = Date.now();
      const remote = structuredClone(state.merge.base);
      const remoteClocks: Record<string, FieldClock> = {};
      const remoteObjections = structuredClone(
        state.objections.map((item) => {
          if (item.id !== "o1") return item;
          return { ...item, status: "支持" as const, resolvedAt: now + 3_000 };
        })
      );
      const byId = new Map(remote.map((item) => [item.id, item]));
      // 法官继续质证：e3 完成确认（整批回写不得冲掉）
      const e3 = byId.get("e3");
      if (e3) e3.status = "已展示";
      // 法官也改了 e1 备注，与书记员暂存并列两版
      const e1 = byId.get("e1");
      if (e1) e1.note = "法官确认：第4页补充约定以2025年12月版为准";
      const e2 = byId.get("e2");
      if (e2) {
        // 支持异议：e2 裁定跳过，回网后保持确认
        e2.status = "已跳过";
        // 书记员离线取消过遮罩，法官在更晚时刻再次打上遮罩（取最后改动）
        if (state.localClocks.e2?.sensitive) {
          e2.sensitive = true;
          remoteClocks.e2 = { sensitive: now + 5_000 };
        }
      }
      // 法官调整顺序（时间晚于书记员拖拽）
      const remoteOrder = ["e2", "e3", "e1"];
      state.merge.remote = remote.sort((a, b) => remoteOrder.indexOf(a.id) - remoteOrder.indexOf(b.id));
      state.merge.remoteClocks = remoteClocks;
      state.merge.remoteOrderAt = now + 6_000;
      state.merge.remoteObjections = remoteObjections;
      state.judgeEditsApplied = true;
      addEntry(state, "审判庭", "法官侧目录更新（模拟）", "继续质证 e3、改 e1 备注、重排顺序、支持异议跳过 e2");
    },
    /** 回网：三路合并，remote 为法官侧目录 */
    reconnect(state) {
      if (state.online || state.merge.status === "merging" || !state.merge.base.length) return;
      // 无法官侧改动时，目录侧即为断网基线
      const remote = state.merge.remote.length ? state.merge.remote : state.merge.base;
      const remoteOrderAt = state.merge.remoteOrderAt;
      const plan = planMerge({
        base: state.merge.base,
        local: state.evidence,
        remote,
        localClocks: state.localClocks,
        remoteClocks: state.merge.remoteClocks,
        localOrder: state.localOrder,
        localOrderAt: state.localOrderAt,
        remoteOrder: remote.map((item) => item.id),
        remoteOrderAt,
        localObjections: state.objections,
        remoteObjections: state.merge.remoteObjections
      });
      if (!plan.conflicts.length && !plan.resolutions.length) {
        state.online = true;
        state.merge = idleMerge;
      } else {
        state.merge.status = "merging";
        state.merge.resolutions = plan.resolutions;
        state.merge.conflicts = plan.conflicts;
      }
      state.localClocks = {};
      state.localOrder = null;
      state.localOrderAt = 0;
      state.judgeEditsApplied = false;
    },
    /** 书记员对并列两版逐字段选定 */
    chooseConflict(state, action: PayloadAction<{ id: string; choice: Side }>) {
      if (state.merge.status !== "merging") return;
      const conflict = state.merge.conflicts.find((item) => item.id === action.payload.id);
      if (conflict) conflict.choice = action.payload.choice;
    },
    /** 全部冲突选定后，按字段合并进目录；未选定时不允许提交 */
    applyMerge(state) {
      if (state.merge.status !== "merging") return;
      if (state.merge.conflicts.some((item) => !item.choice)) return;
      const choices: Record<string, Side> = {};
      for (const conflict of state.merge.conflicts) choices[conflict.id] = conflict.choice!;
      const merged = buildMergedEvidence({
        base: state.merge.base,
        local: state.evidence,
        remote: state.merge.remote,
        localClocks: state.localClocks,
        remoteClocks: state.merge.remoteClocks,
        localOrder: state.localOrder,
        localOrderAt: state.localOrderAt,
        remoteOrder: state.merge.remote.map((item) => item.id),
        remoteOrderAt: state.merge.remoteOrderAt
      }, choices);
      const objections = mergeObjections(state.objections, state.merge.remoteObjections);
      const orderChanged = state.merge.resolutions.some((item) => item.kind === "order");
      state.evidence = merged;
      state.objections = objections;
      if (!merged.some((item) => item.id === state.session.currentEvidenceId)) state.session.currentEvidenceId = null;
      state.online = true;
      state.publicVersion += orderChanged ? 1 : 0;
      state.merge.appliedResolutions = state.merge.resolutions;
      addEntry(state, "书记员", "回网字段合并完成", `${state.merge.resolutions.length} 项规则自动合并，${state.merge.conflicts.length} 项由书记员选定，未整批覆盖任何已确认进度`);
      if (orderChanged) addEntry(state, "书记员", "公开屏已确认画面重算", "按合并后的新顺序重新发布");
      state.merge.status = "idle";
      state.merge.resolutions = [];
      state.merge.conflicts = [];
      state.merge.base = [];
      state.merge.remote = [];
      state.merge.remoteClocks = {};
      state.merge.remoteOrderAt = 0;
      state.merge.remoteObjections = [];
    },
    /** 放弃本次暂存（仅整体放弃，目录侧为准） */
    discardStaged(state) {
      if (state.merge.status !== "merging" || !state.merge.remote.length) return;
      state.evidence = structuredClone(state.merge.remote);
      state.objections = structuredClone(state.merge.remoteObjections);
      state.publicVersion += 1;
      addEntry(state, "书记员", "放弃离线暂存", "以法官目录为准，未执行整批回写");
      state.online = true;
      state.merge = idleMerge;
    },
    snapshot(state, action: PayloadAction<string>) { state.snapshots.unshift({ id: crypto.randomUUID(), label: action.payload, time: new Date().toISOString(), evidence: structuredClone(state.evidence), phase: state.session.phase, currentEvidenceId: state.session.currentEvidenceId }); state.snapshots = state.snapshots.slice(0, 10); },
    restore(state, action: PayloadAction<string>) { const snapshot = state.snapshots.find((entry) => entry.id === action.payload); if (!snapshot) return; state.evidence = structuredClone(snapshot.evidence); state.session.phase = snapshot.phase; state.session.currentEvidenceId = snapshot.currentEvidenceId; addEntry(state, "审判庭", "恢复庭审快照", snapshot.label); },
    tick(state) { if (state.session.phase === "质证" && state.session.timerSeconds > 0) state.session.timerSeconds -= 1; },
    setPhase(state, action: PayloadAction<SessionPhase>) { state.session.phase = action.payload; addEntry(state, "审判庭", "切换庭审阶段", action.payload); }
  }
});

/** 暂存改动概览（断网面板用） */
export function selectStagedSummary(state: State) {
  if (state.online || !state.merge.base.length) return { order: false, sensitive: [] as string[], notes: [] as string[] };
  const base = new Map(state.merge.base.map((item) => [item.id, item]));
  const sensitive: string[] = [];
  const notes: string[] = [];
  for (const item of state.evidence) {
    const b = base.get(item.id);
    if (!b) continue;
    if (b.sensitive !== item.sensitive) sensitive.push(item.id);
    for (const field of CONTENT_FIELDS) {
      if (b[field] !== item[field]) { if (field === "note") notes.push(item.id); }
    }
  }
  const baseOrder = state.merge.base.map((item) => item.id);
  const order = !!state.localOrder && state.localOrder.length === baseOrder.length && state.localOrder.some((id, index) => id !== baseOrder[index]);
  return { order, sensitive, notes: [...new Set(notes)] };
}

export const { initialize, setOnline, setMode, reorder, selectEvidence, showEvidence, completeEvidence, toggleSensitive, stageNote, addObjection, resolveObjection, simulateJudgeEdits, reconnect, chooseConflict, applyMerge, discardStaged, snapshot, restore, tick, setPhase } = slice.actions;
export default slice.reducer;
