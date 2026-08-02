import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = process.cwd();
const backtestDir = path.join(projectRoot, "server/services/backtest");

describe("portfolio adapter 線性效能架構守門", () => {
  it("逐棒 context 只提供 O(1) previousCandle，不暴露完整 candles", () => {
    const source = fs.readFileSync(
      path.join(backtestDir, "portfolioStrategyRuntimeAdapter.ts"),
      "utf8",
    );
    const start = source.indexOf("export interface PortfolioAdapterBarContext");
    const end = source.indexOf("export interface PortfolioAdapterBarDecision");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const barContext = source.slice(start, end);
    expect(barContext).toContain("previousCandle");
    expect(barContext).not.toMatch(/\bcandles\s*:/);
  });

  it("所有 portfolio runtime factory 禁止恢復逐棒全歷史 prefix 複製", () => {
    const factoryFiles = fs.readdirSync(backtestDir)
      .filter(file => file.endsWith("PortfolioRuntimeFactories.ts"));
    expect(factoryFiles.length).toBeGreaterThan(0);
    for (const file of factoryFiles) {
      const source = fs.readFileSync(path.join(backtestDir, file), "utf8");
      expect(source, file).not.toContain("context.candles");
      expect(source, file).not.toContain("closedCandles");
      expect(source, file).not.toMatch(/slice\s*\(\s*0\s*,\s*context\.index/);
      expect(source, file).not.toMatch(/slice\s*\(\s*0\s*,\s*index\s*\+\s*1/);
    }
  });
});
