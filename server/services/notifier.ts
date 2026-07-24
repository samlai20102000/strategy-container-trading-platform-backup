/**
 * 告警通知服務 - V3.5
 * 包裝內建 Owner Notification API（Manus 通知服務）
 * 觸發場景：極限止損、移動止盈、馬丁加倉、每日虧損限額、策略自動停用
 *
 * 失敗容錯：通知失敗不影響交易主流程，僅記錄日誌。
 */

import { notifyOwner as coreNotifyOwner } from "../_core/notification";

export async function notifyOwner(title: string, content: string): Promise<boolean> {
  try {
    const ok = await coreNotifyOwner({
      title: title.slice(0, 1000),
      content: content.slice(0, 18000),
    });
    if (!ok) {
      console.warn(`[Notifier] 通知發送未被接受: ${title}`);
    }
    return ok;
  } catch (e: unknown) {
    console.error(`[Notifier] 通知發送失敗: ${title}`, e instanceof Error ? e.message : e);
    return false;
  }
}
