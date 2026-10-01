import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { Evidence, FieldConflict, MergeField, Objection, PersistedStaging, SessionPhase, SessionState, StagedItem, TimelineEntry } from "../types";
import { applyFieldChoice, computeMerge } from "./merge";

const seedEvidence: Evidence[] = [
  { id: "e1", exhibitNo: "原告-003", title: "项目验收会议纪要", type: "书证", duration: 8, presenter: "原告", sensitive: false, status: "待展示", note: "第4页涉及合同补充约定" },
  { id: "e2", exhibitNo: "原告-004", title: "设备故障检测报告", type: "书证", duration: 10, presenter: "原告", sensitive: true, status: "待展示", note: "含第三方客户名称，公开屏需遮罩" },
  { id: "e3", exhibitNo: "被告-002", title: "系统运行日志", type: "电子数据", duration: 12, presenter: "被告", sensitive: false, status: "待展示", note: "重点展示 14:20 至 14:45" }
];
const seedSession: SessionState = { phase: "举证", currentEvidenceId: "e1", timerSeconds: 8 * 60, operatorMode: "庭审控制" };
const seedObjection: Objection = { id: "o1", evidenceId: "e2", ground: "关联性异议", explanation: "检测报告来源和保管链尚未说明。", status: "待裁定", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };

interface State {
  initialized: boolean;
  evidence: Evidence[];
  objections: Objection[];
  timeline: TimelineEntry[];
  snapshots: { id: string; label: string; time: string; evidence: Evidence[]; phase: SessionPhase; currentEvidenceId: string | null }[];
  session: SessionState;
  online: boolean;
  // 离线暂存与按字段合并
  syncBase: Evidence[] | null;
  serverCatalog: Evidence[] | null;
  serverOrder: string[] | null;
  serverOrderAt: string | null;
  serverUpdatedAt: string | null;
  syncObjections: Objection[] | null;
  serverObjections: Objection[] | null;
  stagedItems: Record<string, StagedItem>;
  stagedOrder: string[] | null;
  stagedOrderAt: string | null;
  stagedObjections: Objection[];
  mergeOpen: boolean;
  mergeWorking: Evidence[] | null;
  mergeConflicts: FieldConflict[];
  mergeOrderChoice: "staged" | "server" | null;
  mergeSensitive: Record<string, "staged" | "server">;
  mergeObjections: Objection[] | null;
}

const initialState: State = {
  initialized: false,
  evidence: seedEvidence,
  objections: [seedObjection],
  timeline: [{ id: "t1", time: new Date().toISOString(), actor: "书记员", action: "庭审开始", detail: "核对到庭人员并宣布法庭纪律" }],
  snapshots: [],
  session: seedSession,
  online: true,
  syncBase: null, serverCatalog: null, serverOrder: null, serverOrderAt: null, serverUpdatedAt: null,
  syncObjections: null, serverObjections: null,
  stagedItems: {}, stagedOrder: null, stagedOrderAt: null, stagedObjections: [],
  mergeOpen: false, mergeWorking: null, mergeConflicts: [], mergeOrderChoice: null, mergeSensitive: {}, mergeObjections: null
};

function now() { return new Date().toISOString(); }

function addEntry(state: State, actor: TimelineEntry["actor"], action: string, detail: string) {
  state.timeline.unshift({ id: crypto.randomUUID(), time: now(), actor, action, detail });
}

function hasPendingStaging(state: Pick<State, "stagedItems" | "stagedOrder" | "stagedObjections">): boolean {
  return Object.keys(state.stagedItems).length > 0 || !!state.stagedOrder || state.stagedObjections.length > 0;
}

/** 离线时把字段改动记入暂存区；在线时不做处理（直接改目录） */
function recordStagedChange(state: State, evidenceId: string, field: MergeField, value: unknown) {
  if (state.online) return;
  if (!state.stagedItems[evidenceId]) state.stagedItems[evidenceId] = { evidenceId, changes: {} };
  state.stagedItems[evidenceId].changes[field] = { at: now(), value };
}

function recordStagedOrder(state: State, order: string[]) {
  if (state.online) return;
  state.stagedOrder = order;
  state.stagedOrderAt = now();
}

/** 离线时把异议创建/裁定记入暂存区（按 id  upsert，保留最后改动时间） */
function recordStagedObjection(state: State, objection: Objection) {
  if (state.online) return;
  const idx = state.stagedObjections.findIndex((entry) => entry.id === objection.id);
  if (idx >= 0) state.stagedObjections[idx] = objection;
  else state.stagedObjections.push(objection);
}

/** 异议的最后改动(LWW)合并：暂存侧与服务端同 id 时取 updatedAt 更晚者 */
function mergeObjections(base: Objection[], server: Objection[], staged: Objection[]): Objection[] {
  const ids = new Set<string>([...base, ...server, ...staged].map((entry) => entry.id));
  const result: Objection[] = [];
  for (const id of ids) {
    const b = base.find((entry) => entry.id === id);
    const s = server.find((entry) => entry.id === id);
    const st = staged.find((entry) => entry.id === id);
    if (st && s) result.push(st.updatedAt > s.updatedAt ? st : s);
    else if (st) result.push(st);
    else if (s) result.push(s);
    else if (b) result.push(b);
  }
  return result;
}

function runMerge(state: State) {
  const base = state.syncBase ?? [];
  const server = state.serverCatalog ?? base;
  const result = computeMerge({
    base, server,
    stagedItems: state.stagedItems,
    stagedOrder: state.stagedOrder,
    stagedOrderAt: state.stagedOrderAt,
    serverOrder: state.serverOrder,
    serverOrderAt: state.serverOrderAt,
    serverUpdatedAt: state.serverUpdatedAt
  });
  state.mergeWorking = result.evidence;
  state.mergeConflicts = result.conflicts;
  state.mergeOrderChoice = result.orderChoice;
  state.mergeSensitive = result.sensitiveChoice;
  state.mergeObjections = mergeObjections(state.syncObjections ?? [], state.serverObjections ?? state.syncObjections ?? [], state.stagedObjections);
  state.mergeOpen = true;
}

function clearStaging(state: State) {
  state.syncBase = null; state.serverCatalog = null; state.serverOrder = null; state.serverOrderAt = null; state.serverUpdatedAt = null;
  state.syncObjections = null; state.serverObjections = null;
  state.stagedItems = {}; state.stagedOrder = null; state.stagedOrderAt = null; state.stagedObjections = [];
  state.mergeOpen = false; state.mergeWorking = null; state.mergeConflicts = []; state.mergeOrderChoice = null; state.mergeSensitive = {}; state.mergeObjections = null;
}

const slice = createSlice({
  name: "court",
  initialState,
  reducers: {
    initialize(state, action: PayloadAction<{ evidence: Evidence[]; staging: PersistedStaging | null }>) {
      if (state.initialized) return;
      state.evidence = action.payload.evidence.length ? action.payload.evidence : seedEvidence;
      state.objections = state.objections.map((entry) => ({ ...entry, updatedAt: entry.updatedAt ?? entry.createdAt }));
      state.initialized = true;
      const staging = action.payload.staging;
      if (staging && (Object.keys(staging.stagedItems).length > 0 || staging.stagedOrder || staging.stagedObjections.length > 0)) {
        state.syncBase = staging.syncBase;
        state.serverCatalog = staging.serverCatalog;
        state.serverOrder = staging.serverOrder;
        state.serverOrderAt = staging.serverOrderAt;
        state.serverUpdatedAt = staging.serverUpdatedAt;
        state.syncObjections = staging.syncObjections;
        state.serverObjections = staging.serverObjections;
        state.stagedItems = staging.stagedItems;
        state.stagedOrder = staging.stagedOrder;
        state.stagedOrderAt = staging.stagedOrderAt;
        state.stagedObjections = staging.stagedObjections;
        state.online = true;
        runMerge(state);
      }
    },
    setOnline(state, action: PayloadAction<boolean>) {
      if (action.payload) {
        // 回网：若有暂存改动则进入按字段合并流程
        state.online = true;
        if (hasPendingStaging(state)) {
          runMerge(state);
          addEntry(state, "书记员", "回网合并", "离线改动按字段与目录比对，待书记员选定后合并");
        } else {
          addEntry(state, "书记员", "恢复在线", "无暂存改动，目录保持同步");
        }
      } else {
        // 断网：快照目录作为合并基准，离线改动进入暂存区
        state.syncBase = structuredClone(state.evidence);
        state.syncObjections = structuredClone(state.objections);
        state.serverCatalog = null; state.serverOrder = null; state.serverOrderAt = null; state.serverUpdatedAt = null;
        state.serverObjections = null;
        state.stagedItems = {}; state.stagedOrder = null; state.stagedOrderAt = null; state.stagedObjections = [];
        state.mergeOpen = false; state.mergeWorking = null; state.mergeConflicts = [];
        state.online = false;
        addEntry(state, "书记员", "切换离线", "离线改动进入暂存区，回网后按字段合并");
      }
    },
    setMode(state, action: PayloadAction<SessionState["operatorMode"]>) { state.session.operatorMode = action.payload; },
    reorder(state, action: PayloadAction<Evidence[]>) {
      state.evidence = action.payload;
      recordStagedOrder(state, action.payload.map((item) => item.id));
      addEntry(state, "书记员", "调整证据顺序", "已更新举证顺序");
    },
    selectEvidence(state, action: PayloadAction<string>) {
      const item = state.evidence.find((entry) => entry.id === action.payload);
      if (!item) return;
      state.session.currentEvidenceId = item.id;
      state.session.timerSeconds = item.duration * 60;
      addEntry(state, item.presenter, "切换展示证据", `${item.exhibitNo} ${item.title}`);
    },
    showEvidence(state) {
      const item = state.evidence.find((entry) => entry.id === state.session.currentEvidenceId);
      if (!item) return;
      item.status = "展示中";
      recordStagedChange(state, item.id, "status", "展示中");
      state.session.phase = "质证";
      addEntry(state, item.presenter, "开始展示", item.title);
    },
    completeEvidence(state) {
      const item = state.evidence.find((entry) => entry.id === state.session.currentEvidenceId);
      if (!item) return;
      item.status = "已展示";
      recordStagedChange(state, item.id, "status", "已展示");
      const next = state.evidence.find((entry) => entry.status === "待展示");
      state.session.currentEvidenceId = next?.id ?? null;
      state.session.timerSeconds = (next?.duration ?? 0) * 60;
      state.session.phase = next ? "举证" : "休庭";
      addEntry(state, "审判庭", "完成质证", item.title);
    },
    toggleSensitive(state, action: PayloadAction<string>) {
      const item = state.evidence.find((entry) => entry.id === action.payload);
      if (!item) return;
      item.sensitive = !item.sensitive;
      recordStagedChange(state, item.id, "sensitive", item.sensitive);
      addEntry(state, "审判庭", item.sensitive ? "隐藏敏感内容" : "恢复公开内容", item.title);
    },
    editEvidence(state, action: PayloadAction<{ id: string; title?: string; note?: string }>) {
      const item = state.evidence.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      if (action.payload.title !== undefined) { item.title = action.payload.title; recordStagedChange(state, item.id, "title", item.title); }
      if (action.payload.note !== undefined) { item.note = action.payload.note; recordStagedChange(state, item.id, "note", item.note); }
      addEntry(state, "书记员", "编辑证据信息", `${item.exhibitNo} ${item.title}`);
    },
    addObjection(state, action: PayloadAction<{ evidenceId: string; ground: string; explanation: string }>) {
      const item = state.evidence.find((entry) => entry.id === action.payload.evidenceId);
      const objection: Objection = { ...action.payload, id: crypto.randomUUID(), status: "待裁定", createdAt: now(), updatedAt: now() };
      state.objections.unshift(objection);
      recordStagedObjection(state, objection);
      state.session.phase = "质证";
      addEntry(state, item?.presenter ?? "审判庭", "提出异议", `${item?.exhibitNo ?? ""} ${action.payload.ground}`);
    },
    resolveObjection(state, action: PayloadAction<{ id: string; status: "支持" | "驳回" }>) {
      const objection = state.objections.find((entry) => entry.id === action.payload.id);
      if (!objection) return;
      objection.status = action.payload.status;
      objection.updatedAt = now();
      recordStagedObjection(state, { ...objection });
      const item = state.evidence.find((entry) => entry.id === objection.evidenceId);
      if (action.payload.status === "支持" && item) {
        item.status = "已跳过";
        recordStagedChange(state, item.id, "status", "已跳过");
        addEntry(state, "审判庭", "异议成立", `${item.exhibitNo} 暂不展示`);
      } else {
        addEntry(state, "审判庭", "异议驳回", item?.title ?? "继续质证");
      }
    },
    snapshot(state, action: PayloadAction<string>) {
      state.snapshots.unshift({ id: crypto.randomUUID(), label: action.payload, time: now(), evidence: structuredClone(state.evidence), phase: state.session.phase, currentEvidenceId: state.session.currentEvidenceId });
      state.snapshots = state.snapshots.slice(0, 10);
    },
    restore(state, action: PayloadAction<string>) {
      const snapshot = state.snapshots.find((entry) => entry.id === action.payload);
      if (!snapshot) return;
      state.evidence = structuredClone(snapshot.evidence);
      state.session.phase = snapshot.phase;
      state.session.currentEvidenceId = snapshot.currentEvidenceId;
      addEntry(state, "审判庭", "恢复庭审快照", snapshot.label);
    },
    tick(state) { if (state.session.phase === "质证" && state.session.timerSeconds > 0) state.session.timerSeconds -= 1; },
    setPhase(state, action: PayloadAction<SessionPhase>) { state.session.phase = action.payload; addEntry(state, "审判庭", "切换庭审阶段", action.payload); },
    // 服务端（法官端）在书记员离线期间确认进度，制造目录侧改动
    simulateJudgeConfirm(state) {
      if (state.online) return;
      const server = structuredClone(state.serverCatalog ?? state.syncBase ?? []);
      const target = server.find((entry) => entry.status === "待展示");
      if (target) {
        target.status = "已展示";
        target.note = `${target.note}（法官已确认质证进度）`;
      }
      state.serverCatalog = server;
      state.serverOrder = server.map((entry) => entry.id);
      state.serverOrderAt = now();
      state.serverUpdatedAt = now();
      const serverObjections = structuredClone(state.syncObjections ?? []);
      const pending = serverObjections.find((entry) => entry.status === "待裁定");
      if (pending) { pending.status = "驳回"; pending.updatedAt = now(); }
      state.serverObjections = serverObjections;
      addEntry(state, "审判庭", "法官确认进度", "服务端举证进度与异议裁定已更新");
    },
    // 书记员在合并弹窗中选定某字段采用哪一版
    resolveMergeConflict(state, action: PayloadAction<{ evidenceId: string; field: MergeField; choice: "staged" | "server" }>) {
      const conflict = state.mergeConflicts.find((entry) => entry.evidenceId === action.payload.evidenceId && entry.field === action.payload.field);
      if (!conflict || conflict.locked) return;
      conflict.choice = action.payload.choice;
      if (state.mergeWorking) {
        state.mergeWorking = applyFieldChoice(state.mergeWorking, action.payload.evidenceId, action.payload.field, action.payload.choice, conflict.stagedValue, conflict.serverValue);
      }
    },
    // 合并完成：把选定结果写入目录，重算当前证据，清空暂存
    completeMerge(state) {
      if (!state.mergeWorking) return;
      state.evidence = state.mergeWorking;
      const current = state.evidence.find((entry) => entry.id === state.session.currentEvidenceId);
      if (!current || current.status === "已展示" || current.status === "已跳过") {
        const next = state.evidence.find((entry) => entry.status === "待展示");
        state.session.currentEvidenceId = next?.id ?? null;
        state.session.timerSeconds = (next?.duration ?? 0) * 60;
      }
      state.objections = state.mergeObjections ?? mergeObjections(state.syncObjections ?? [], state.serverObjections ?? state.syncObjections ?? [], state.stagedObjections);
      clearStaging(state);
      addEntry(state, "书记员", "合并完成", "离线改动已按字段合并入目录，公开屏已重算");
    },
    // 放弃暂存：回退到服务端版本
    discardStaging(state) {
      state.evidence = structuredClone(state.serverCatalog ?? state.syncBase ?? state.evidence);
      state.objections = mergeObjections(state.syncObjections ?? [], state.serverObjections ?? state.syncObjections ?? [], []);
      clearStaging(state);
      addEntry(state, "书记员", "放弃暂存", "离线改动已丢弃，目录保持服务端版本");
    }
  }
});

export const {
  initialize, setOnline, setMode, reorder, selectEvidence, showEvidence, completeEvidence,
  toggleSensitive, editEvidence, addObjection, resolveObjection, snapshot, restore, tick, setPhase,
  simulateJudgeConfirm, resolveMergeConflict, completeMerge, discardStaging
} = slice.actions;
export default slice.reducer;
