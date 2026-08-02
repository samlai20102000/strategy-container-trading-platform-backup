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

function topLevelArguments(parenthesized: string): string[] {
  const source = parenthesized.slice(1, -1);
  const args: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
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
    if (char === "(" || char === "{" || char === "[") depth += 1;
    else if (char === ")" || char === "}" || char === "]") depth -= 1;
    else if (char === "," && depth === 0) {
      args.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  args.push(source.slice(start).trim());
  return args;
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

  it("Runtime Gate 必須把穩定事件鍵下沉至 Maker-First，禁止未來策略以時間戳破壞跨重試冪等", () => {
    const runtimeAdapter = readFileSync(join(SERVER_ROOT, "exchanges/runtimeGuardedAdapter.ts"), "utf8");
    const makerFirst = readFileSync(join(SERVER_ROOT, "exchanges/makerFirstFacade.ts"), "utf8");
    expect(runtimeAdapter).toContain("const intentKey = stableOperationKey");
    expect(runtimeAdapter).toContain("const legIntentKey = stableOperationKey");
    expect(runtimeAdapter).toContain("intentKey,");
    expect(makerFirst).toContain("intent.policyContext?.intentKey");
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

  it("所有直接 reduce-only placeOrder 必須明確指定 posSide，禁止未來策略誤平反向腿", () => {
    const auditedRoots = [join(SERVER_ROOT, "services"), join(SERVER_ROOT, "routers.ts"), join(SERVER_ROOT, "routers")];
    const auditedFiles = auditedRoots.flatMap(path => statSync(path).isDirectory() ? productionTypeScriptFiles(path) : [path]);
    const violations: string[] = [];

    for (const path of auditedFiles) {
      const source = readFileSync(path, "utf8");
      mutationCalls(source, "placeOrder").forEach((call, index) => {
        if (/reduceOnly\s*:\s*true/.test(call) && !/\bposSide\s*(?::|,)/.test(call)) {
          violations.push(`${relative(SERVER_ROOT, path)}#placeOrder:${index + 1}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it("所有策略級 close 必須傳入 owned requestedSize，且不得再把數量誤塞入 closePositionSmart timeout", () => {
    const auditedRoots = [join(SERVER_ROOT, "services"), join(SERVER_ROOT, "routers.ts"), join(SERVER_ROOT, "routers")];
    const auditedFiles = auditedRoots.flatMap(path => statSync(path).isDirectory() ? productionTypeScriptFiles(path) : [path]);
    const violations: string[] = [];

    for (const path of auditedFiles) {
      const source = readFileSync(path, "utf8");
      for (const method of ["closePosition", "closePositionSmart"] as const) {
        mutationCalls(source, method).forEach((call, index) => {
          const helperIndex = call.indexOf("closePolicyOptions");
          if (helperIndex < 0) return;
          const helperOpen = call.indexOf("(", helperIndex);
          const helperArgs = topLevelArguments(extractBalanced(call, helperOpen, "(", ")"));
          if (helperArgs.length < 3 || !helperArgs[2] || helperArgs[2] === "undefined") {
            violations.push(`${relative(SERVER_ROOT, path)}#${method}:missing-requested-size:${index + 1}`);
          }

          if (method === "closePositionSmart") {
            const closeArgs = topLevelArguments(call);
            if (/requestedSize|totalSize|positionSize|local\.size/i.test(closeArgs[2] ?? "")) {
              violations.push(`${relative(SERVER_ROOT, path)}#closePositionSmart:size-in-timeout:${index + 1}`);
            }
          }
        });
      }
    }

    expect(violations).toEqual([]);
  });

  it("策略監控器不得把帳戶同向聚合腿自動認領為單一策略 ownership", () => {
    const monitorFiles = [
      "services/v35Monitor.ts",
      "services/v50Monitor.ts",
      "services/v61Monitor.ts",
    ];
    const forbiddenOwnershipWrites = [
      /state\.totalSize\s*=\s*exchangeSize/,
      /state\.avgPrice\s*=\s*exchange(?:AvgPrice|EntryPrice)/,
      /const\s+totalSize\s*=\s*exchangeSize\s*>\s*0/,
      /\{\s*\.\.\.state\s*,\s*totalSize\s*,\s*avgPrice\s*\}/,
    ];
    const violations: string[] = [];

    for (const relativePath of monitorFiles) {
      const source = readFileSync(join(SERVER_ROOT, relativePath), "utf8");
      forbiddenOwnershipWrites.forEach((pattern, index) => {
        if (pattern.test(source)) violations.push(`${relativePath}:forbidden-aggregate-write:${index + 1}`);
      });
      if (!source.includes("不回寫 ownership")) {
        violations.push(`${relativePath}:missing-readonly-drift-contract`);
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
