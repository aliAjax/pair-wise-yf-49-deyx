import { useEffect, useMemo, useState } from "react";
import { Button, Card, Form, Input, Message, Modal, Radio, Select, Space, Statistic, Switch, Tag, Timeline } from "@arco-design/web-react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { NavLink, Route, Routes } from "react-router-dom";
import { useSaveEvidenceMutation, useGetEvidenceQuery } from "./store/api";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import { addObjection, completeEvidence, initialize, reorder, resolveObjection, restore, selectEvidence, selectStagedSummary, setMode, setOnline, setPhase, showEvidence, snapshot, tick, toggleSensitive, stageNote, simulateJudgeEdits, reconnect, chooseConflict, applyMerge, discardStaged } from "./store/courtSlice";
import { selectConfirmedSequence, selectPublicView } from "./store/selectors";
import { FIELD_LABELS, type MergeConflict, type Side } from "./store/merge";
import type { SessionPhase } from "./types";

const objectionSchema = z.object({ ground: z.string().min(2), explanation: z.string().min(6) });
type ObjectionForm = z.infer<typeof objectionSchema>;

function formatTime(seconds: number) { return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }

/** 回网合并对话框：规则自动合并项展示 + 两版并列由书记员逐字段选定 */
function MergeModal() {
  const dispatch = useAppDispatch();
  const merge = useAppSelector((root) => root.court.merge);
  if (merge.status !== "merging") return null;
  const allChosen = merge.conflicts.every((item) => item.choice);
  const hasRemote = merge.remote.length > 0;

  const valueText = (conflict: MergeConflict, side: Side) => String(side === "staged" ? conflict.staged : conflict.directory);

  const abandon = () => {
    Modal.confirm({
      title: "放弃本次离线暂存？",
      content: "将直接以法官目录为准，暂存中的离线改动不再参与合并。",
      okText: "放弃暂存", cancelText: "取消",
      onOk: () => { dispatch(discardStaged()); Message.info("已放弃暂存，目录侧为准"); }
    });
  };

  return <Modal
    title="回网合并 · 按字段三路合并"
    visible
    maskClosable={false}
    escToExit={false}
    closable={false}
    style={{ width: 760, maxWidth: "94vw" }}
    okText={`按选定结果合并进目录（${merge.conflicts.filter((item) => item.choice).length}/${merge.conflicts.length}）`}
    cancelText="放弃暂存，目录为准"
    okButtonProps={{ disabled: !allChosen }}
    cancelButtonProps={{ disabled: !hasRemote }}
    onOk={() => { dispatch(applyMerge()); Message.success("已按字段合并进目录，公开屏按新顺序重算发布"); }}
    onCancel={abandon}
  >
    <div className="merge-rules">
      <p>基线：断网瞬间快照。<b>排序 / 敏感遮罩 / 异议裁定取最后改动</b>；<b>已完成质证或裁定跳过的证据保持确认</b>，整批回写不会冲掉法官确认的进度。</p>
      <Tag color="orange">敏感备注在本次合并完成前不会出现在公开屏</Tag>
    </div>

    <div className="merge-section">
      <h4>规则自动合并（{merge.resolutions.length}）</h4>
      {merge.resolutions.map((item) => <div key={item.id} className="merge-line">
        <Tag size="small" color={item.kind === "order" ? "purple" : item.kind === "status" ? "green" : item.kind === "sensitive" ? "red" : item.kind === "objection" ? "orange" : "arcoblue"}>
          {item.kind === "order" ? "排序" : item.kind === "status" ? "确认锁定" : item.kind === "sensitive" ? "遮罩LWW" : item.kind === "objection" ? "异议裁定" : "字段"}
        </Tag>
        <span>{item.text}</span>
      </div>)}
      {!merge.resolutions.length && <p className="muted">无自动合并项。</p>}
    </div>

    <div className="merge-section">
      <h4>需要书记员选定（{merge.conflicts.length}）— 暂存与目录都改过，选定后才合并进目录</h4>
      {merge.conflicts.map((conflict) => <div key={conflict.id} className="conflict-card">
        <div className="conflict-head"><b>{conflict.exhibitNo}</b><Tag>{FIELD_LABELS[conflict.field]}</Tag>{!conflict.choice && <Tag size="small" color="red">待选定</Tag>}</div>
        <Radio.Group
          value={conflict.choice}
          direction="vertical"
          onChange={(value) => dispatch(chooseConflict({ id: conflict.id, choice: value as Side }))}
        >
          <Radio value="staged">
            <span className="choice-label">暂存（书记员离线版）</span>
            <span className="choice-value">{valueText(conflict, "staged")}</span>
          </Radio>
          <Radio value="directory">
            <span className="choice-label">目录（法官侧版本）</span>
            <span className="choice-value">{valueText(conflict, "directory")}</span>
          </Radio>
        </Radio.Group>
      </div>)}
      {!merge.conflicts.length && <p className="muted">无并列两版冲突，可直接合并。</p>}
    </div>
  </Modal>;
}

/** 断网暂存面板：汇总离线改动，并提供法官侧改动模拟与回网入口 */
function OfflinePanel() {
  const dispatch = useAppDispatch();
  const online = useAppSelector((root) => root.court.online);
  const merging = useAppSelector((root) => root.court.merge.status === "merging");
  const judgeApplied = useAppSelector((root) => root.court.judgeEditsApplied);
  const evidence = useAppSelector((root) => root.court.evidence);
  const summary = useAppSelector((root) => selectStagedSummary(root.court));
  if (online || merging) return null;
  const name = (id: string) => evidence.find((item) => item.id === id)?.exhibitNo ?? id;
  return <Card className="offline-panel" title={<Space><Tag color="red">离线暂存中</Tag><span>改动不整批回写，回网后按字段合并</span></Space>}>
    <div className="offline-tags">
      <Tag color={summary.order ? "purple" : "gray"}>排序{summary.order ? "：已拖拽改序" : "：未改"}</Tag>
      <Tag color={summary.sensitive.length ? "red" : "gray"}>敏感遮罩{summary.sensitive.length ? `：${summary.sensitive.map(name).join("、")}` : "：未改"}</Tag>
      <Tag color={summary.notes.length ? "arcoblue" : "gray"}>备注/内容{summary.notes.length ? `：${summary.notes.map(name).join("、")}` : "：未改"}</Tag>
    </div>
    <p className="muted">演示建议：取消 e2 遮罩、拖拽改序、在“证据目录”页改 e1 备注，然后让法官侧继续质证，再回网看三路合并。</p>
    <Space wrap>
      <Button size="small" status="warning" disabled={judgeApplied} onClick={() => { dispatch(simulateJudgeEdits()); Message.info("已模拟法官在目录侧继续质证并改动（仅回网时参与合并）"); }}>
        {judgeApplied ? "法官侧改动已注入" : "模拟：法官断网期间在目录继续质证/改动"}
      </Button>
      <Button size="small" type="primary" onClick={() => { dispatch(reconnect()); Message.info("已回网，正在按字段比对"); }}>回网并按字段合并</Button>
    </Space>
  </Card>;
}

function CourtControl() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.court);
  const [mode, setLocalMode] = useState<"控制" | "预览">("控制");
  const [objectionOpen, setObjectionOpen] = useState(false);
  const current = state.evidence.find((item) => item.id === state.session.currentEvidenceId);
  const pending = state.objections.filter((item) => item.status === "待裁定");
  const publicView = useAppSelector((root) => selectPublicView(root.court));
  const confirmed = useAppSelector((root) => selectConfirmedSequence(root.court));
  const { control, handleSubmit, reset } = useForm<ObjectionForm>({ resolver: zodResolver(objectionSchema), defaultValues: { ground: "关联性异议", explanation: "" } });

  useEffect(() => { const timer = window.setInterval(() => dispatch(tick()), 1000); return () => window.clearInterval(timer); }, [dispatch]);
  const submitObjection = (values: ObjectionForm) => { if (!current) return; dispatch(addObjection({ evidenceId: current.id, ...values })); reset(); setObjectionOpen(false); Message.warning("异议已进入待裁定分支"); };
  const noteGated = current ? publicView.gatedIds.has(current.id) : false;

  return <div className="court-grid">
    <MergeModal />
    <div className="main-stack">
      <OfflinePanel />
      <Card className="operator" title="证据操作台" extra={<Space><Tag color={state.online ? "green" : "red"}>{state.online ? "本地审计在线" : "离线恢复模式"}</Tag><Button size="small" onClick={() => dispatch(snapshot("手动存档"))}>保存快照</Button></Space>}>
        <div className="evidence-list">{state.evidence.map((item, index) => <article key={item.id} draggable onDragStart={(event) => event.dataTransfer.setData("text/plain", String(index))} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const from = Number(event.dataTransfer.getData("text/plain")); const items = [...state.evidence]; const [moved] = items.splice(from, 1); items.splice(index, 0, moved); dispatch(reorder(items)); }} className={current?.id === item.id ? "active" : ""}>
          <span>{index + 1}</span><div><b>{item.exhibitNo} · {item.title}</b><small>{item.type} · {item.presenter} · {item.duration}分钟</small></div><Tag color={item.status === "已展示" ? "green" : item.status === "展示中" ? "orange" : item.status === "已跳过" ? "red" : "gray"}>{item.status}</Tag><Button size="mini" onClick={() => dispatch(selectEvidence(item.id))}>选中</Button>
        </article>)}</div>
        <div className="control-strip"><Button type="primary" onClick={() => dispatch(showEvidence())} disabled={!current}>开始展示</Button><Button onClick={() => dispatch(completeEvidence())} disabled={!current}>完成并切换下一条</Button><Button status="warning" onClick={() => setObjectionOpen(true)} disabled={!current}>提出异议</Button><Button onClick={() => dispatch(toggleSensitive(current?.id ?? ""))} disabled={!current}>{current?.sensitive ? "恢复敏感内容" : "隐藏敏感内容"}</Button></div>
      </Card>
    </div>
    <div className="side-stack">
      <Card title="公开屏预览" extra={<Select size="small" value={mode} onChange={(value) => { setLocalMode(value as "控制" | "预览"); dispatch(setMode(value === "预览" ? "公开屏预览" : "庭审控制")); }} options={[{value:"控制",label:"控制者视图"},{value:"预览",label:"公开屏"}]} />} className="preview-card">
        <div className="public-screen">
          {publicView.merging && <div className="merge-banner"><b>回网合并中 · 已确认画面重算中</b><p>顺序按最后改动合并，落盘后发布新版本（v{publicView.version + 1}）</p></div>}
          {mode === "预览" ? <>
            <small>公开展示</small><h2>{current?.exhibitNo ?? "暂无证据"}</h2><h3>{current?.title ?? "庭审进行中"}</h3>
            {current?.sensitive || noteGated
              ? <div className="redaction"><b>敏感内容已遮罩</b><p>{publicView.merging ? "合并完成前，本证据敏感备注不在公开屏出现。" : "该证据包含不适宜公开的信息，庭审结束后统一入卷。"}</p></div>
              : <p>{current?.note}</p>}
            <div className="confirmed-seq" data-version={`v${publicView.version}${publicView.merging ? "·重算" : ""}`}>
              <small>已确认画面 · {confirmed.length} 条{publicView.orderChanged && publicView.merging ? " · 顺序待重算" : ` · ${`v${publicView.version}`}`}</small>
              <ol>{confirmed.map((item) => <li key={item.id}><span>{item.exhibitNo}</span><em>{item.status === "已跳过" ? "裁定跳过" : "已质证"}</em></li>)}</ol>
            </div>
            <footer>计时 {formatTime(state.session.timerSeconds)} · {state.session.phase}</footer>
          </> : <><small>控制者私有视图</small><h2>敏感内容可预览</h2><p>{current?.sensitive ? "此证据将在公开屏遮罩客户名称，控制者可查看完整备注。" : "当前证据可完整公开。"}</p><Tag color="red">操作端专属</Tag>{publicView.merging && <p className="muted-light">合并进行中：敏感备注暂不向公开屏发布。</p>}</>}
        </div>
      </Card>
      <Card title="待审异议" extra={<Tag color="red">{pending.length}</Tag>}>{pending.map((item) => <div className="objection" key={item.id}><b>{item.ground}</b><p>{item.explanation}</p><Space><Button size="mini" status="success" onClick={() => dispatch(resolveObjection({ id: item.id, status: "支持" }))}>支持并跳过</Button><Button size="mini" onClick={() => dispatch(resolveObjection({ id: item.id, status: "驳回" }))}>驳回继续</Button></Space></div>)}{!pending.length && <p>当前没有待裁定异议。</p>}</Card>
    </div>
    <Modal title="提出证据异议" visible={objectionOpen} onCancel={() => setObjectionOpen(false)} onOk={() => handleSubmit(submitObjection)()}><Form layout="vertical"><Form.Item label="异议类型"><Controller name="ground" control={control} render={({ field }) => <Select {...field} options={[{value:"关联性异议",label:"关联性异议"},{value:"真实性异议",label:"真实性异议"},{value:"合法性异议",label:"合法性异议"}]} />} /></Form.Item><Form.Item label="异议说明"><Controller name="explanation" control={control} render={({ field }) => <Input.TextArea {...field} placeholder="说明异议依据和希望法庭裁定的事项" />} /></Form.Item></Form></Modal>
    <Card title="庭审阶段" className="phase-card"><Radio.Group value={state.session.phase} onChange={(value) => dispatch(setPhase(value as SessionPhase))}><Radio value="开庭">开庭</Radio><Radio value="举证">举证</Radio><Radio value="质证">质证</Radio><Radio value="休庭">休庭</Radio><Radio value="结束">结束</Radio></Radio.Group></Card>
  </div>;
}

function TimelinePage() {
  const state = useAppSelector((root) => root.court);
  const dispatch = useAppDispatch();
  return <div className="timeline-grid"><Card title="庭审时间线"><Timeline>{state.timeline.map((item) => <Timeline.Item key={item.id} label={new Date(item.time).toLocaleTimeString("zh-CN", { hour12: false })}><b>{item.action}</b> <Tag>{item.actor}</Tag><p>{item.detail}</p></Timeline.Item>)}</Timeline></Card><Card title="本地恢复点"><p>每次手动存档或关键操作都会保留当前证据顺序和阶段。</p>{state.snapshots.map((item) => <div className="snapshot" key={item.id}><b>{item.label}</b><small>{new Date(item.time).toLocaleString("zh-CN")}</small><Button size="mini" onClick={() => dispatch(restore(item.id))}>恢复</Button></div>)}</Card></div>;
}

function EvidencePage() {
  const state = useAppSelector((root) => root.court);
  const dispatch = useAppDispatch();
  const summary = useAppSelector((root) => selectStagedSummary(root.court));
  const dirty = new Set(summary.notes);
  return <Card title={<Space>证据目录与公开属性{!state.online && <Tag color="red">离线 · 备注改动仅暂存</Tag>}</Space>}><div className="catalog">{state.evidence.map((item) => <article key={item.id}><div><b>{item.exhibitNo} {item.title}{dirty.has(item.id) && <Tag size="small" color="arcoblue" style={{ marginLeft: 8 }}>暂存已改</Tag>}</b>
    {state.online
      ? <p>{item.note}</p>
      : <Input.TextArea value={item.note} autoSize={{ minRows: 1, maxRows: 3 }} onChange={(value) => dispatch(stageNote({ id: item.id, note: value }))} placeholder="离线修改备注，回网后按字段合并" />}
  </div><Tag>{item.type}</Tag><div className="switch-line"><span>公开屏敏感遮罩</span><Switch checked={item.sensitive} onChange={() => dispatch(toggleSensitive(item.id))} /></div></article>)}</div></Card>;
}

export default function App() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.court);
  const { data = [] } = useGetEvidenceQuery();
  const [save] = useSaveEvidenceMutation();
  const { t, i18n } = useTranslation();
  useEffect(() => { if (data.length) dispatch(initialize(data)); }, [data, dispatch]);
  // 仅在线且无未决合并时回写；离线改动留在暂存，杜绝整批覆盖法官目录
  useEffect(() => {
    if (!state.online || state.merge.status === "merging") return;
    const timer = window.setTimeout(() => void save(state.evidence), 300);
    return () => window.clearTimeout(timer);
  }, [state.evidence, state.online, state.merge.status, save]);
  const metrics = useMemo(() => ({ shown: state.evidence.filter((item) => item.status === "已展示").length, sensitive: state.evidence.filter((item) => item.sensitive).length, objections: state.objections.length }), [state]);
  return <div className="shell"><aside><div className="brand"><b>COURT</b><span>庭审控制</span></div><nav><NavLink to="/">{t("control")}</NavLink><NavLink to="/evidence">证据目录</NavLink><NavLink to="/timeline">{t("timeline")}</NavLink></nav><Button onClick={() => void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh")}>{i18n.language === "zh" ? "EN" : "中文"}</Button></aside><main><header><div><small>案件号 2026-民初-1084 · 全流程审计开启</small><h1>{t("title")}</h1></div><div className="top-tools"><label>本地恢复 <Switch checked={!state.online} disabled={state.merge.status === "merging"} onChange={(value) => dispatch(setOnline(!value))} /></label><Tag color={state.merge.status === "merging" ? "orange" : state.online ? "green" : "red"}>{state.merge.status === "merging" ? "回网合并中" : state.online ? "协作同步" : "离线操作"}</Tag></div></header><section className="metrics"><Card><Statistic title="证据总数" value={state.evidence.length} /></Card><Card><Statistic title="已完成质证" value={metrics.shown} /></Card><Card><Statistic title="敏感证据" value={metrics.sensitive} /></Card><Card><Statistic title="异议记录" value={metrics.objections} /></Card></section><Routes><Route path="/" element={<CourtControl />} /><Route path="/evidence" element={<EvidencePage />} /><Route path="/timeline" element={<TimelinePage />} /></Routes></main></div>;
}
