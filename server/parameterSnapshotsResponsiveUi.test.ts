import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const snapshotsSource = readFileSync(
  new URL("../client/src/pages/ParameterSnapshots.tsx", import.meta.url),
  "utf8",
);

describe("ParameterSnapshots 響應式與安全操作契約", () => {
  it("在行動版使用摘要卡，桌面版保留完整資料表格", () => {
    expect(snapshotsSource).toContain('className="space-y-3 md:hidden"');
    expect(snapshotsSource).toContain('className="hidden overflow-x-auto md:block"');
    expect(snapshotsSource).toContain("回報率");
    expect(snapshotsSource).toContain("最大回撤");
    expect(snapshotsSource).toContain("夏普／盈虧比");
  });

  it("行動卡顯示 canonical Execution Profile 與 fail-closed 信任狀態", () => {
    expect(snapshotsSource).toContain("<ExecutionModeBadge mode={snapshot.artifact?.executionMode} />");
    expect(snapshotsSource).toContain('snapshot.artifact?.artifactScope ?? "LEGACY"');
    expect(snapshotsSource).toContain('trusted ? "可信" : "Fail-closed"');
    expect(snapshotsSource).toContain("Strategy v{snapshot.artifact?.strategyVersion");
  });

  it("桌面與行動版共用查看、更新、複製及部署 handlers", () => {
    expect(snapshotsSource).toContain("const openSnapshotView =");
    expect(snapshotsSource).toContain("const openSnapshotApply =");
    expect(snapshotsSource).toContain("const openSnapshotImport =");
    expect(snapshotsSource).toContain("onClick={() => openDeploymentDraft(snapshot)}");
    expect(snapshotsSource).toContain("disabled={!trusted}");
  });

  it("行動卡保留比較、查看、更新策略、複製副本、部署草稿與刪除六個入口", () => {
    for (const label of ["比較", "查看", "更新策略", "複製副本", "部署草稿", "刪除"]) {
      expect(snapshotsSource).toContain(label);
    }
    expect(snapshotsSource).toContain("toggleSnapshotComparison(snapshot.id)");
    expect(snapshotsSource).toContain("handleDelete(snapshot.id)");
  });
});
