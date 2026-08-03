from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from matplotlib import font_manager


ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / "artifacts" / "backtest-100dd"
OUTPUT = ARTIFACTS / "report-assets"
OUTPUT.mkdir(parents=True, exist_ok=True)

FONT_PATH = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
font_manager.fontManager.addfont(FONT_PATH)
FONT_NAME = font_manager.FontProperties(fname=FONT_PATH).get_name()
plt.rcParams.update({
    "font.family": FONT_NAME,
    "axes.unicode_minus": False,
    "figure.facecolor": "#F7F9FC",
    "axes.facecolor": "#FFFFFF",
    "axes.edgecolor": "#CBD5E1",
    "axes.labelcolor": "#334155",
    "xtick.color": "#475569",
    "ytick.color": "#475569",
    "text.color": "#0F172A",
    "grid.color": "#E2E8F0",
})


def load_json(name: str):
    return json.loads((ARTIFACTS / name).read_text(encoding="utf-8"))


def as_datetime(timestamp_ms: int) -> datetime:
    return datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc)


def save(fig: plt.Figure, filename: str) -> None:
    fig.savefig(OUTPUT / filename, dpi=220, bbox_inches="tight", facecolor=fig.get_facecolor())
    plt.close(fig)


def build_equity_chart() -> dict:
    curve = load_json("job_1785770356467_b7fe7008_equity_curve.json")
    dates = [as_datetime(int(point["timestamp"])) for point in curve]
    equities = [float(point["equity"]) for point in curve]

    peak_equity = equities[0]
    peak_index = 0
    max_drawdown_pct = -1.0
    max_drawdown_usdt = 0.0
    drawdown_peak_index = 0
    trough_index = 0
    for index, equity in enumerate(equities):
        if equity > peak_equity:
            peak_equity = equity
            peak_index = index
        drawdown_usdt = peak_equity - max(0.0, equity)
        drawdown_pct = drawdown_usdt / peak_equity if peak_equity > 0 else 0.0
        if drawdown_pct > max_drawdown_pct:
            max_drawdown_pct = drawdown_pct
            max_drawdown_usdt = drawdown_usdt
            drawdown_peak_index = peak_index
            trough_index = index

    first_non_positive_index = next(
        (index for index, equity in enumerate(equities) if equity <= 0),
        None,
    )
    minimum_index = min(range(len(equities)), key=lambda index: equities[index])

    fig, ax = plt.subplots(figsize=(12.8, 6.4))
    ax.plot(dates, equities, color="#0F766E", linewidth=1.8, label="持久化顯示曲線（2,001 點降採樣）")
    ax.fill_between(
        dates,
        equities,
        0,
        where=[equity < 0 for equity in equities],
        color="#DC2626",
        alpha=0.24,
        label="非正權益（破產區）",
    )
    ax.axhline(0, color="#991B1B", linewidth=1.2, linestyle="--")
    ax.scatter(
        [dates[drawdown_peak_index], dates[trough_index], dates[minimum_index]],
        [equities[drawdown_peak_index], equities[trough_index], equities[minimum_index]],
        color=["#2563EB", "#DC2626", "#7F1D1D"],
        s=54,
        zorder=5,
    )
    if first_non_positive_index is not None:
        ax.axvline(dates[first_non_positive_index], color="#DC2626", alpha=0.55, linestyle=":")
        ax.annotate(
            f"首次非正權益\n{dates[first_non_positive_index]:%Y-%m-%d %H:%M} UTC\n{equities[first_non_positive_index]:,.2f} USDT",
            xy=(dates[first_non_positive_index], equities[first_non_positive_index]),
            xytext=(38, 78),
            textcoords="offset points",
            arrowprops={"arrowstyle": "->", "color": "#DC2626"},
            fontsize=9,
            bbox={"boxstyle": "round,pad=0.35", "fc": "white", "ec": "#FCA5A5"},
        )
    ax.annotate(
        f"最大回撤峰值\n{equities[drawdown_peak_index]:,.2f} USDT",
        xy=(dates[drawdown_peak_index], equities[drawdown_peak_index]),
        xytext=(-95, 28),
        textcoords="offset points",
        arrowprops={"arrowstyle": "->", "color": "#2563EB"},
        fontsize=9,
        bbox={"boxstyle": "round,pad=0.35", "fc": "white", "ec": "#93C5FD"},
    )
    ax.annotate(
        f"最低權益\n{equities[minimum_index]:,.2f} USDT",
        xy=(dates[minimum_index], equities[minimum_index]),
        xytext=(112, -6),
        textcoords="offset points",
        arrowprops={"arrowstyle": "->", "color": "#7F1D1D"},
        fontsize=9,
        bbox={"boxstyle": "round,pad=0.35", "fc": "white", "ec": "#FCA5A5"},
    )
    fig.suptitle(
        "KRM 本次回測：權益確實穿越 0，之後又恢復正值",
        fontsize=15,
        weight="bold",
        x=0.08,
        ha="left",
        y=0.965,
    )
    fig.text(
        0.08,
        0.915,
        "100% 最大回撤是破產路徑的正確數學結果；異常在於模擬器未清算、未終止。",
        color="#475569",
        fontsize=10,
    )
    ax.set_ylim(min(-8_500, min(equities) - 1_000), max(equities) + 2_500)
    ax.set_ylabel("權益（USDT）")
    ax.set_xlabel("UTC 日期")
    ax.xaxis.set_major_locator(mdates.AutoDateLocator(minticks=6, maxticks=10))
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y-%m", tz=timezone.utc))
    ax.grid(True, alpha=0.8)
    ax.legend(loc="upper left", frameon=False)
    fig.subplots_adjust(top=0.86, bottom=0.14, left=0.08, right=0.98)
    save(fig, "equity_insolvency_path.png")

    return {
        "pointCount": len(curve),
        "drawdownPeak": equities[drawdown_peak_index],
        "drawdownTroughRaw": equities[trough_index],
        "maxDrawdownPct": max_drawdown_pct * 100,
        "maxDrawdownUSDTWithFiniteLiabilityFloor": max_drawdown_usdt,
        "minimumEquity": equities[minimum_index],
        "firstNonPositiveTimestamp": curve[first_non_positive_index]["timestamp"] if first_non_positive_index is not None else None,
    }


def build_layer_risk_chart() -> dict:
    summary = load_json("krm_true_data_replay_summary.json")
    audit = summary["riskPolicyAudit"]["layerRiskAudit"]
    layers = [int(item["layer"]) for item in audit]
    gross = [float(item["cumulativeGrossAtMark"]) for item in audit]
    gross_limit = [float(item["grossLimit"]) for item in audit]
    margin = [float(item["cumulativeMargin"]) for item in audit]
    margin_limit = [float(item["marginLimit"]) for item in audit]
    approvals = [bool(item["policyApproved"]) for item in audit]

    fig, ax = plt.subplots(figsize=(12.8, 6.4))
    ax.plot(layers, gross, marker="o", linewidth=2.1, color="#7C3AED", label="累計名義曝險")
    ax.plot(layers, gross_limit, linewidth=1.6, linestyle="--", color="#2563EB", label="Gross 上限（100% 權益）")
    ax.plot(layers, margin, marker="s", linewidth=1.6, color="#EA580C", label="所需保證金（1x）")
    ax.plot(layers, margin_limit, linewidth=1.6, linestyle="--", color="#059669", label="保證金上限（40% 權益）")
    rejected_layers = [layer for layer, approved in zip(layers, approvals) if not approved]
    for layer in rejected_layers:
        index = layers.index(layer)
        ax.scatter(layer, gross[index], color="#DC2626", s=48, zorder=6)
    first_margin = summary["riskPolicyAudit"]["firstMarginBreach"]
    first_gross = summary["riskPolicyAudit"]["firstGrossBreach"]
    ax.axvspan(first_margin["layer"] - 0.35, max(layers) + 0.35, color="#FEE2E2", alpha=0.45)
    ax.annotate(
        f"第 {first_margin['layer']} 層首次違反保證金上限\n{first_margin['cumulativeMargin']:,.0f} > {first_margin['marginLimit']:,.0f} USDT",
        xy=(first_margin["layer"], first_margin["cumulativeMargin"]),
        xytext=(35, 40),
        textcoords="offset points",
        arrowprops={"arrowstyle": "->", "color": "#DC2626"},
        fontsize=9,
        bbox={"boxstyle": "round,pad=0.35", "fc": "white", "ec": "#FCA5A5"},
    )
    ax.annotate(
        f"第 {first_gross['layer']} 層首次違反 Gross 上限",
        xy=(first_gross["layer"], first_gross["cumulativeGrossAtMark"]),
        xytext=(45, -40),
        textcoords="offset points",
        arrowprops={"arrowstyle": "->", "color": "#DC2626"},
        fontsize=9,
        bbox={"boxstyle": "round,pad=0.35", "fc": "white", "ec": "#FCA5A5"},
    )
    ax.set_yscale("log")
    ax.set_xticks(layers)
    ax.set_xlabel("馬丁層級（1 = 首倉）")
    ax.set_ylabel("USDT（對數尺度）")
    fig.suptitle(
        "KRM 逐層風險稽核：第 6 層起即不應成交",
        fontsize=15,
        weight="bold",
        x=0.08,
        ha="left",
        y=0.965,
    )
    fig.text(
        0.08,
        0.915,
        "策略仍一路成交至第 12 層；這是 executionPolicy 未接入 runner，而不是最大回撤公式錯誤。",
        color="#475569",
        fontsize=10,
    )
    ax.grid(True, which="both", alpha=0.7)
    ax.legend(loc="upper left", frameon=False, ncol=2)
    fig.subplots_adjust(top=0.86, bottom=0.13, left=0.08, right=0.98)
    save(fig, "martin_layer_risk_breach.png")

    return {
        "layerCount": len(audit),
        "firstMarginBreachLayer": int(first_margin["layer"]),
        "firstGrossBreachLayer": int(first_gross["layer"]),
        "finalGrossNotional": float(gross[-1]),
        "finalMarginRequired": float(margin[-1]),
    }


def build_guard_behavior_chart() -> None:
    fig, axes = plt.subplots(1, 2, figsize=(12.8, 4.7))
    before = ["允許超限加倉", "負權益仍持倉", "破產後恢復", "發布 completed"]
    after = ["逐筆 kernel（目標）", "全域負權益守門", "禁止破產後恢復", "專用錯誤碼 fail closed"]
    colors_before = ["#FCA5A5", "#F87171", "#EF4444", "#991B1B"]
    colors_after = ["#BFDBFE", "#93C5FD", "#60A5FA", "#2563EB"]
    for index, (label, color) in enumerate(zip(before, colors_before)):
        axes[0].barh(index, 1, color=color)
        axes[0].text(0.03, index, label, va="center", color="#111827", weight="bold" if index == 3 else "normal")
    for index, (label, color) in enumerate(zip(after, colors_after)):
        axes[1].barh(index, 1, color=color)
        axes[1].text(0.03, index, label, va="center", color="#111827", weight="bold" if index == 3 else "normal")
    for axis, title in zip(axes, ["修正前：錯誤結果可被發布", "本次共用守門：異常結果不可發布"]):
        axis.set_xlim(0, 1)
        axis.set_ylim(-0.6, 3.6)
        axis.invert_yaxis()
        axis.set_xticks([])
        axis.set_yticks([])
        axis.set_title(title, fontsize=12, weight="bold", loc="left")
        for spine in axis.spines.values():
            spine.set_visible(False)
    fig.suptitle("修正邊界：先阻止錯誤 KPI，再逐 runner 遷移到同一 runtime risk kernel", fontsize=15, weight="bold")
    save(fig, "before_after_guard_behavior.png")


if __name__ == "__main__":
    evidence = {
        "equity": build_equity_chart(),
        "layerRisk": build_layer_risk_chart(),
    }
    build_guard_behavior_chart()
    (OUTPUT / "chart_evidence.json").write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(evidence, ensure_ascii=False, indent=2))
