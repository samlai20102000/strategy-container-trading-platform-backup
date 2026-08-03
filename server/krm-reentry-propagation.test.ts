import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function section(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start, `找不到區段起點：${startMarker}`).toBeGreaterThanOrEqual(0);
  expect(end, `找不到區段終點：${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("KRM 自動重新入市路由傳播契約", () => {
  const strategyRouterSource = readFileSync("server/routers.ts", "utf8");
  const backtestRouterSource = readFileSync("server/routers/backtest.router.ts", "utf8");
  const strategiesRouterBody = section(
    strategyRouterSource,
    "const strategiesRouter = router({",
    "const studioRouter = router({",
  );

  it("策略列表以 canonical 私有配置投影 reentryEnabled", () => {
    const listBody = section(
      strategiesRouterBody,
      "list: protectedProcedure.query",
      "martingaleLayerSnapshots: protectedProcedure",
    );

    expect(listBody).toContain("resolveBoundKamaRainbowMartinConfig");
    expect(listBody).toContain(".reentryEnabled");
    expect(listBody.indexOf("resolveBoundKamaRainbowMartinConfig"))
      .toBeLessThan(listBody.indexOf("strategyWithLegacyConfig.v35Config.Reentry_On_Trend === true"));
  });

  it("策略新建與編輯均透過 canonical KRM binding 同步相容欄位", () => {
    const createBody = section(
      strategiesRouterBody,
      "create: protectedProcedure",
      "update: protectedProcedure",
    );
    const updateBody = section(
      strategiesRouterBody,
      "update: protectedProcedure",
      "delete: protectedProcedure",
    );

    expect(createBody).toContain("bindKamaRainbowMartinStrategyConfig");
    expect(createBody).toContain("reentryEnabled: krmColumns.reentryEnabled");
    expect(updateBody).toContain("bindKamaRainbowMartinStrategyConfig");
    expect(updateBody).toContain("Object.assign(data, binding.columns)");
  });

  it("快照複製為新策略保留 canonical reentryEnabled，不得再硬編碼 false", () => {
    const importBody = section(
      backtestRouterSource,
      "importSnapshotAsNew: protectedProcedure",
      "applySnapshotToInstance: protectedProcedure",
    );

    expect(importBody).toContain("bindKamaRainbowMartinStrategyConfig");
    expect(importBody).toContain("? krmColumns.reentryEnabled");
    expect(importBody).not.toContain("kamaRainbowMartinConfig\n            ? false");
  });

  it("快照套用與直接套用配置都由同一 canonical binding 寫入", () => {
    const applySnapshotBody = section(
      backtestRouterSource,
      "applySnapshot: protectedProcedure",
      "importSnapshotAsNew: protectedProcedure",
    );
    const directApplyBody = section(
      backtestRouterSource,
      "applySnapshotToInstance: protectedProcedure",
      "getSnapshotConfig: protectedProcedure",
    );

    for (const body of [applySnapshotBody, directApplyBody]) {
      expect(body).toContain("bindKamaRainbowMartinStrategyConfig");
      expect(body).toContain("reentryEnabled: krmColumns.reentryEnabled");
    }
  });
});
