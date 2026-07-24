
export class TestUnitStrategy {
  key = "unit_test_strategy";
  name = "單元測試策略";
  defaultConfig = { initial_lot: 0.02 };
  generateActions(signal, instance, marketData, martinState) {
    if (signal.action === "BUY") return { action: "OPEN_LONG", lotSize: 0.02, reason: "test" };
    return { action: "HOLD", lotSize: 0 };
  }
}