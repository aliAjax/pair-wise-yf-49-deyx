import { Alert, Button, Card, Modal, Space, Tag } from "@arco-design/web-react";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { completeMerge, discardStaging, resolveMergeConflict } from "../store/courtSlice";
import { FIELD_LABELS, type FieldConflict, type MergeField } from "../types";

function formatFieldValue(field: MergeField, value: unknown): string {
  if (field === "sensitive") return value ? "是（遮罩）" : "否（公开）";
  if (field === "status") {
    const map: Record<string, string> = { 待展示: "待展示", 展示中: "展示中", 已展示: "已完成质证", 已跳过: "裁定跳过" };
    return map[String(value)] ?? String(value);
  }
  return String(value ?? "");
}

export default function MergeModal() {
  const dispatch = useAppDispatch();
  const { mergeOpen, mergeWorking, mergeConflicts, mergeOrderChoice, mergeObjections, stagedObjections, syncObjections, serverObjections } = useAppSelector((root) => root.court);

  if (!mergeOpen || !mergeWorking) return null;

  const conflictsByEvidence = new Map<string, FieldConflict[]>();
  for (const conflict of mergeConflicts) {
    if (!conflictsByEvidence.has(conflict.evidenceId)) conflictsByEvidence.set(conflict.evidenceId, []);
    conflictsByEvidence.get(conflict.evidenceId)!.push(conflict);
  }

  const pendingCount = mergeConflicts.filter((conflict) => !conflict.locked && conflict.choice === null).length;
  const orderLabel = mergeOrderChoice === "staged" ? "暂存版（书记员离线调整）" : mergeOrderChoice === "server" ? "目录版（法官端）" : null;
  const touchedObjections = (mergeObjections ?? []).filter((objection) => stagedObjections.some((staged) => staged.id === objection.id));

  const confirmDiscard = () => {
    Modal.confirm({
      title: "放弃暂存改动？",
      content: "离线期间的暂存改动将被丢弃，目录保持服务端版本。此操作不可撤销。",
      okButtonProps: { status: "danger" },
      onOk: () => { dispatch(discardStaging()); }
    });
  };

  return (
    <Modal
      title="离线改动合并比对"
      visible={mergeOpen}
      onCancel={confirmDiscard}
      footer={
        <Space>
          <Button onClick={confirmDiscard}>放弃暂存</Button>
          <Button type="primary" disabled={pendingCount > 0} onClick={() => dispatch(completeMerge())}>
            合并完成{pendingCount > 0 ? `（还需选定 ${pendingCount} 项）` : ""}
          </Button>
        </Space>
      }
      style={{ width: 920, maxWidth: "92vw" }}
    >
      <Alert
        type="info"
        content="回网后按字段合并：证据排序、敏感遮罩、异议裁定取最后改动；已完成质证或裁定跳过的证据保持确认；同一项两边都改，请并列选定版本，选定后才合并进目录。"
        style={{ marginBottom: 16 }}
      />

      {orderLabel && (
        <Card size="small" title="证据顺序" style={{ marginBottom: 12 }}>
          <Space wrap>
            <Tag color="gold">按最后改动采用：{orderLabel}</Tag>
            {mergeWorking.map((item, index) => (
              <Tag key={item.id}>{index + 1}. {item.exhibitNo}</Tag>
            ))}
          </Space>
        </Card>
      )}

      {touchedObjections.length > 0 && (
        <Card size="small" title="异议裁定" style={{ marginBottom: 12 }}>
          {touchedObjections.map((objection) => {
            const serverVersion = serverObjections?.find((entry) => entry.id === objection.id) ?? syncObjections?.find((entry) => entry.id === objection.id);
            const bothChanged = !!serverVersion && serverVersion.status !== objection.status;
            return (
              <div key={objection.id} style={{ marginBottom: 8 }}>
                <Space wrap>
                  <Tag color={objection.status === "支持" ? "green" : objection.status === "驳回" ? "red" : "gray"}>{objection.status}</Tag>
                  <b>{objection.ground}</b>
                  <span>{objection.explanation}</span>
                  {bothChanged && <Tag color="orange">目录版裁定：{serverVersion.status}</Tag>}
                  <Tag>按最后改动采用</Tag>
                </Space>
              </div>
            );
          })}
        </Card>
      )}

      {[...conflictsByEvidence.entries()].map(([evidenceId, conflicts]) => {
        const working = mergeWorking.find((item) => item.id === evidenceId);
        return (
          <Card key={evidenceId} size="small" title={`${working?.exhibitNo ?? ""} ${working?.title ?? ""}`} style={{ marginBottom: 12 }}>
            {conflicts.map((conflict) => {
              if (conflict.locked) {
                return (
                  <div key={conflict.field} style={{ marginBottom: 8 }}>
                    <Space wrap>
                      <Tag color="blue">{FIELD_LABELS[conflict.field]}</Tag>
                      <span>采用：{formatFieldValue(conflict.field, conflict.choice === "staged" ? conflict.stagedValue : conflict.serverValue)}</span>
                      <Tag color="gold">{conflict.lockReason}</Tag>
                    </Space>
                  </div>
                );
              }
              return (
                <div key={conflict.field} style={{ marginBottom: 12 }}>
                  <div style={{ marginBottom: 6 }}><Tag color="blue">{FIELD_LABELS[conflict.field]}</Tag> 两边都改，请选定：</div>
                  <Space wrap>
                    <Card
                      size="small"
                      hoverable
                      onClick={() => dispatch(resolveMergeConflict({ evidenceId, field: conflict.field, choice: "staged" }))}
                      style={{ minWidth: 220, borderColor: conflict.choice === "staged" ? "#be8a3a" : undefined, background: conflict.choice === "staged" ? "#fffaf1" : undefined }}
                    >
                      <Tag color={conflict.choice === "staged" ? "gold" : "gray"}>暂存版（书记员）</Tag>
                      <div style={{ marginTop: 6 }}>{formatFieldValue(conflict.field, conflict.stagedValue)}</div>
                    </Card>
                    <Card
                      size="small"
                      hoverable
                      onClick={() => dispatch(resolveMergeConflict({ evidenceId, field: conflict.field, choice: "server" }))}
                      style={{ minWidth: 220, borderColor: conflict.choice === "server" ? "#be8a3a" : undefined, background: conflict.choice === "server" ? "#fffaf1" : undefined }}
                    >
                      <Tag color={conflict.choice === "server" ? "gold" : "gray"}>目录版（法官）</Tag>
                      <div style={{ marginTop: 6 }}>{formatFieldValue(conflict.field, conflict.serverValue)}</div>
                    </Card>
                  </Space>
                </div>
              );
            })}
          </Card>
        );
      })}

      {mergeConflicts.length === 0 && !orderLabel && touchedObjections.length === 0 && (
        <Alert type="success" content="所有离线改动已按规则自动合并，点击「合并完成」写入目录。" />
      )}
    </Modal>
  );
}
