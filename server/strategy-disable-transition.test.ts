import { describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { transitionStrategyToDisabled } from "./db";

function createFakeDb(result: unknown) {
  let updateValues: Record<string, unknown> | undefined;
  let whereCondition: any;
  const db = {
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateValues = values;
        return {
          where: vi.fn(async (condition: unknown) => {
            whereCondition = condition;
            return result;
          }),
        };
      }),
    })),
  };
  return {
    db,
    getUpdateValues: () => updateValues,
    getWhereCondition: () => whereCondition,
  };
}

describe("V4 策略原子停用狀態轉移", () => {
  it.each([
    [[{ affectedRows: 1 }], true],
    [[{ affectedRows: 0 }], false],
    [{ rowsAffected: 1 }, true],
    [{ rowsAffected: 0 }, false],
  ] as const)("正確解析資料庫回傳 %j", async (driverResult, expected) => {
    const fake = createFakeDb(driverResult);
    await expect(
      transitionStrategyToDisabled(fake.db as any, 77, "hard stop"),
    ).resolves.toBe(expected);
  });

  it("必須只更新指定且仍為 enabled=true 的策略", async () => {
    const fake = createFakeDb([{ affectedRows: 1 }]);
    await transitionStrategyToDisabled(fake.db as any, 77, "hard stop");

    expect(fake.getUpdateValues()).toEqual({
      enabled: false,
      disabledReason: "hard stop",
    });

    const query = new MySqlDialect().sqlToQuery(fake.getWhereCondition());
    expect(query.params).toEqual(expect.arrayContaining([77, true]));
  });
});
