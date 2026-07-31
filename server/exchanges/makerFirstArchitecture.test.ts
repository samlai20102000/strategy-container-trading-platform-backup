import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return productionTypeScriptFiles(path);
    if (!path.endsWith(".ts") || path.endsWith(".test.ts")) return [];
    return [path];
  });
}

function extractBalanced(source: string, openIndex: number, open: string, close: string): string {
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, index + 1);
    }
  }
  throw new Error(`Unbalanced source at ${openIndex}`);
}

function mutationCalls(source: string, method: "placeOrder" | "closePosition" | "closePositionSmart") {
  const calls: string[] = [];
  const pattern = new RegExp(`\\.${method}\\s*\\(`, "g");
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const openIndex = source.indexOf("(", match.index);
    calls.push(extractBalanced(source, openIndex, "(", ")"));
  }
  return calls;
}

describe("Maker-First architecture guard", () => {
  const files = productionTypeScriptFiles(SERVER_ROOT);

  it("原生 OKX／Bybit adapter 只能由唯一 factory 建立", () => {
    const violations = files
      .filter(path => !path.endsWith("/exchanges/factory.ts"))
      .filter(path => /new\s+(?:OKX|Bybit)Adapter\s*\(/.test(readFileSync(path, "utf8")))
      .map(path => relative(SERVER_ROOT, path));
    expect(violations).toEqual([]);
  });

  it("一般 factory 必須自動套用中央 facade，recovery 原生入口只可由恢復引擎使用", () => {
    const factory = readFileSync(join(SERVER_ROOT, "exchanges/factory.ts"), "utf8");
    expect(factory).toContain("createMakerFirstAdapter(rawAdapter");
    expect(factory).toContain("getOrderPolicyRuntimeConfig");

    const recoveryImportUsers = files
      .filter(path => readFileSync(path, "utf8").includes("createNativeAdapterForOrderPolicyRecovery"))
      .map(path => relative(SERVER_ROOT, path))
      .sort();
    expect(recoveryImportUsers).toEqual([
      "exchanges/factory.ts",
      "services/orderPolicyRecovery.ts",
    ]);
  });

  it("所有 service／router 下單 mutation 必須攜帶結構化 policy context", () => {
    const auditedRoots = [join(SERVER_ROOT, "services"), join(SERVER_ROOT, "routers.ts"), join(SERVER_ROOT, "routers")];
    const auditedFiles = auditedRoots.flatMap(path => statSync(path).isDirectory() ? productionTypeScriptFiles(path) : [path]);
    const violations: string[] = [];

    for (const path of auditedFiles) {
      const source = readFileSync(path, "utf8");
      mutationCalls(source, "placeOrder").forEach((call, index) => {
        if (!/orderPolicyFields\s*\(|policyContext\s*:/.test(call)) {
          violations.push(`${relative(SERVER_ROOT, path)}#placeOrder:${index + 1}`);
        }
      });
      for (const method of ["closePosition", "closePositionSmart"] as const) {
        mutationCalls(source, method).forEach((call, index) => {
          if (!/closePolicyOptions\s*\(|policyContext\s*:/.test(call)) {
            violations.push(`${relative(SERVER_ROOT, path)}#${method}:${index + 1}`);
          }
        });
      }
    }

    expect(violations).toEqual([]);
  });

  it("只有共用 intent helper 可建立具名 emergency 授權", () => {
    const allowed = new Set([
      "exchanges/orderPolicyIntent.ts",
      "exchanges/makerFirstFacade.ts",
      "exchanges/runtimeGuardedAdapter.ts",
    ]);
    const violations = files
      .filter(path => !allowed.has(relative(SERVER_ROOT, path)))
      .filter(path => /emergencyReason\s*:\s*["'](?:STOP_LOSS|DAILY_LOSS_LIMIT|KILL_SWITCH)["']/.test(readFileSync(path, "utf8")))
      .map(path => relative(SERVER_ROOT, path));
    expect(violations).toEqual([]);
  });
});
