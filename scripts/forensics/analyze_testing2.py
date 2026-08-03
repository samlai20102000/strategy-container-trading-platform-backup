from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

import pandas as pd


INPUT_PATH = Path("/home/ubuntu/upload/testing2.xlsx")
OUTPUT_DIR = Path("/home/ubuntu/策略容器化自動交易平台-的副本/artifacts/backtest-100dd")
INITIAL_CAPITAL = 10_000.0
DISPLAYED_TOTAL_RETURN_PCT = 208.59
DISPLAYED_TOTAL_RETURN_USDT = 20_859.08
DISPLAYED_MAX_DRAWDOWN_PCT = 100.0
DISPLAYED_MAX_DRAWDOWN_USDT = 11_450.29


def finite(value: object) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"非有限數值: {value!r}")
    return number


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    sha256 = hashlib.sha256(INPUT_PATH.read_bytes()).hexdigest()
    excel = pd.ExcelFile(INPUT_PATH)
    frame = pd.read_excel(INPUT_PATH, sheet_name=excel.sheet_names[0])

    required = {
        "時間",
        "Cycle ID",
        "方向",
        "入場價",
        "出場價",
        "數量",
        "盈虧",
        "盈虧%",
        "馬丁層數",
    }
    missing = sorted(required.difference(frame.columns))
    if missing:
        raise ValueError(f"缺少必要欄位: {missing}")

    frame["時間"] = pd.to_datetime(frame["時間"], errors="raise")
    for column in ["入場價", "出場價", "數量", "盈虧", "盈虧%", "馬丁層數"]:
        frame[column] = pd.to_numeric(frame[column], errors="raise")
    frame = frame.sort_values(["時間", "Cycle ID"], kind="stable").reset_index(drop=True)

    frame["入場名義價值"] = frame["入場價"] * frame["數量"]
    frame["出場名義價值"] = frame["出場價"] * frame["數量"]
    frame["毛損益推算"] = frame.apply(
        lambda row: (
            (row["出場價"] - row["入場價"]) * row["數量"]
            if row["方向"] == "買升"
            else (row["入場價"] - row["出場價"]) * row["數量"]
        ),
        axis=1,
    )
    frame["推算總費用"] = frame["毛損益推算"] - frame["盈虧"]
    frame["已實現累計損益"] = frame["盈虧"].cumsum()
    frame["已實現權益"] = INITIAL_CAPITAL + frame["已實現累計損益"]
    realized_peak = frame["已實現權益"].cummax().clip(lower=INITIAL_CAPITAL)
    frame["已實現回撤_USDT"] = realized_peak - frame["已實現權益"]
    frame["已實現回撤_%"] = frame["已實現回撤_USDT"] / realized_peak * 100
    frame["入場名義價值_相對初始資金倍數"] = frame["入場名義價值"] / INITIAL_CAPITAL
    frame["入場名義價值_相對當時已實現權益倍數"] = frame["入場名義價值"] / (
        frame["已實現權益"] - frame["盈虧"]
    )

    pnl_sum = finite(frame["盈虧"].sum())
    winning = frame[frame["盈虧"] > 0]
    losing = frame[frame["盈虧"] < 0]
    breakeven = frame[frame["盈虧"] == 0]
    realized_dd_index = int(frame["已實現回撤_%"].idxmax())
    max_notional_index = int(frame["入場名義價值"].idxmax())
    max_layer_index = int(frame["馬丁層數"].idxmax())
    inferred_initial = DISPLAYED_TOTAL_RETURN_USDT / (DISPLAYED_TOTAL_RETURN_PCT / 100)
    displayed_implied_trough = max(0.0, DISPLAYED_MAX_DRAWDOWN_USDT * (1 - DISPLAYED_MAX_DRAWDOWN_PCT / 100))

    summary = {
        "source": {
            "path": str(INPUT_PATH),
            "sha256": sha256,
            "sheet_names": excel.sheet_names,
            "sheet": excel.sheet_names[0],
            "rows": int(len(frame)),
            "columns": int(len(frame.columns)),
            "time_start": frame["時間"].min().isoformat(),
            "time_end": frame["時間"].max().isoformat(),
        },
        "ui_observation": {
            "displayed_total_return_pct": DISPLAYED_TOTAL_RETURN_PCT,
            "displayed_total_return_usdt": DISPLAYED_TOTAL_RETURN_USDT,
            "displayed_max_drawdown_pct": DISPLAYED_MAX_DRAWDOWN_PCT,
            "displayed_max_drawdown_usdt": DISPLAYED_MAX_DRAWDOWN_USDT,
            "initial_capital_inferred_from_return": round(inferred_initial, 8),
            "displayed_drawdown_implied_trough_if_peak_equals_usdt_drawdown": displayed_implied_trough,
        },
        "independent_trade_recalculation": {
            "initial_capital": INITIAL_CAPITAL,
            "trade_count": int(len(frame)),
            "winning_trades": int(len(winning)),
            "losing_trades": int(len(losing)),
            "breakeven_trades": int(len(breakeven)),
            "win_rate_pct": round(len(winning) / len(frame) * 100, 8),
            "pnl_sum_usdt": round(pnl_sum, 8),
            "final_realized_equity": round(INITIAL_CAPITAL + pnl_sum, 8),
            "total_return_pct": round(pnl_sum / INITIAL_CAPITAL * 100, 8),
            "gross_profit": round(finite(winning["盈虧"].sum()), 8),
            "gross_loss_abs": round(abs(finite(losing["盈虧"].sum())), 8),
            "profit_factor": round(
                finite(winning["盈虧"].sum()) / abs(finite(losing["盈虧"].sum())), 8
            ),
            "max_drawdown_closed_trade_equity_pct": round(finite(frame["已實現回撤_%"].max()), 8),
            "max_drawdown_closed_trade_equity_usdt": round(finite(frame["已實現回撤_USDT"].max()), 8),
            "closed_trade_drawdown_row": frame.loc[
                realized_dd_index,
                ["時間", "Cycle ID", "盈虧", "已實現權益", "已實現回撤_USDT", "已實現回撤_%"],
            ].to_dict(),
        },
        "exposure_forensics": {
            "maximum_martin_layer": int(frame["馬丁層數"].max()),
            "maximum_quantity": round(finite(frame["數量"].max()), 12),
            "maximum_entry_notional_usdt": round(finite(frame["入場名義價值"].max()), 8),
            "maximum_entry_notional_to_initial_capital": round(
                finite(frame["入場名義價值_相對初始資金倍數"].max()), 8
            ),
            "maximum_entry_notional_row": frame.loc[
                max_notional_index,
                [
                    "時間",
                    "Cycle ID",
                    "方向",
                    "入場價",
                    "出場價",
                    "數量",
                    "盈虧",
                    "馬丁層數",
                    "入場名義價值",
                    "入場名義價值_相對初始資金倍數",
                    "入場名義價值_相對當時已實現權益倍數",
                ],
            ].to_dict(),
            "maximum_layer_row": frame.loc[
                max_layer_index,
                [
                    "時間",
                    "Cycle ID",
                    "方向",
                    "入場價",
                    "出場價",
                    "數量",
                    "盈虧",
                    "馬丁層數",
                    "入場名義價值",
                ],
            ].to_dict(),
            "top_10_notional": frame.nlargest(10, "入場名義價值")[
                [
                    "時間",
                    "Cycle ID",
                    "方向",
                    "數量",
                    "馬丁層數",
                    "入場名義價值",
                    "盈虧",
                ]
            ].to_dict(orient="records"),
        },
        "consistency_checks": {
            "pnl_sum_matches_ui_total_return_usdt": abs(pnl_sum - DISPLAYED_TOTAL_RETURN_USDT) <= 0.02,
            "trade_count_matches_ui_91": len(frame) == 91,
            "wins_matches_ui_90": len(winning) == 90,
            "losses_matches_ui_1": len(losing) == 1,
            "closed_trade_equity_can_explain_100pct_drawdown": finite(frame["已實現回撤_%"].max()) >= 99.999,
            "xlsx_contains_intrabar_equity_curve": False,
            "diagnostic": (
                "交易檔僅包含平倉交易。若已實現權益回撤遠低於 100%，則畫面 100% 必定來自另一份逐 K 線的 mark-to-market equityCurve；"
                "需取得持久化 equityCurve 才能定位首次歸零時間、當時方向、數量、價格與未實現虧損。"
            ),
        },
    }

    def json_default(value: object) -> object:
        if isinstance(value, pd.Timestamp):
            return value.isoformat()
        if hasattr(value, "item"):
            return value.item()
        raise TypeError(type(value).__name__)

    (OUTPUT_DIR / "testing2_forensic_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, default=json_default),
        encoding="utf-8",
    )
    frame.to_csv(OUTPUT_DIR / "testing2_enriched_trades.csv", index=False, encoding="utf-8-sig")

    print(json.dumps(summary, ensure_ascii=False, indent=2, default=json_default))


if __name__ == "__main__":
    main()
