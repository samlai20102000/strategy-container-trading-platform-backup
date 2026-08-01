import { createAdapter } from "../server/exchanges/factory";
import { Balance } from "../server/exchanges/types";
import { getLogger } from "../server/_core/log";
import { encrypt } from "../server/lib/crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

const log = getLogger("MakerFirstTest");

const TEST_SYMBOL = "USDT-USDC-SWAP"; // 低波動交易對
const TEST_QUANTITY = 1; // 最小額度
const TEST_TTL_SECONDS = 60; // 訂單存活時間

async function runMakerFirstTest() {
  log.info("啟動 Maker-First 測試網送單驗收...");

  const apiKey = process.env.OKX_API_KEY;
  const apiSecret = process.env.OKX_API_SECRET;
  const apiPassphrase = process.env.OKX_API_PASSPHRASE;

  if (!apiKey || !apiSecret || !apiPassphrase) {
    log.error("缺少 OKX API 憑證，請設定環境變數 OKX_API_KEY, OKX_API_SECRET, OKX_API_PASSPHRASE");
    throw new TRPCError({ code: "BAD_REQUEST", message: "缺少 OKX API 憑證" });
  }

  const adapter = createAdapter({
    exchange: "okx",
    apiKeyEncrypted: encrypt(apiKey),
    apiSecretEncrypted: encrypt(apiSecret),
    passphraseEncrypted: encrypt(apiPassphrase),
    isTestnet: true,
  });

  try {
    // 1. 檢查餘額
    log.info("檢查帳戶餘額...");
    const balance = await adapter.getBalance();
    if (!balance || balance.free < TEST_QUANTITY) {
      log.error(`USDT 餘額不足，需要 ${TEST_QUANTITY}，目前可用 ${balance?.free || 0}`);
      throw new TRPCError({ code: "BAD_REQUEST", message: "USDT 餘額不足" });
    }
    log.info(`USDT 可用餘額: ${balance.free}`);

    // 2. 放置 Maker-First 訂單 (Post-Only)
    log.info(`放置 Maker-First 訂單: ${TEST_SYMBOL}, 數量 ${TEST_QUANTITY}, Post-Only...`);
    const clientOrderId = `maker-test-${Date.now()}`;
    const order = await adapter.placeOrder({
      symbol: TEST_SYMBOL,
      side: "buy",
      orderType: "limit",
      size: TEST_QUANTITY,
      price: 0.99, // 故意放一個低於市價的價格，確保是 Maker
      clientOrderId,
      postOnly: true,
      timeInForce: "GTC", // Good-Till-Cancelled
    });
    log.info(`訂單已放置: ${JSON.stringify(order)}`);

    // 3. 查詢訂單狀態
    log.info(`查詢訂單狀態: ${order.orderId || clientOrderId}...`);
    await new Promise(resolve => setTimeout(resolve, 5000)); // 等待 5 秒讓訂單生效
    const orderDetails = await adapter.getOrderDetail(
      TEST_SYMBOL,
      order.orderId,
      order.clientOrderId
    );
    log.info(`訂單詳情: ${JSON.stringify(orderDetails)}`);

    if (orderDetails.state === "live" && orderDetails.postOnly) {
      log.info("訂單為 Maker-First (Post-Only) 且處於活動狀態，符合預期。");
    } else {
      log.error("訂單狀態不符合 Maker-First (Post-Only) 預期。");
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "訂單狀態不符" });
    }

    // 4. 撤銷訂單
    log.info(`撤銷訂單: ${order.orderId || clientOrderId}...`);
    const cancelResult = await adapter.cancelOrder(
      TEST_SYMBOL,
      order.orderId,
      order.clientOrderId
    );
    log.info(`訂單已撤銷: ${JSON.stringify(cancelResult)}`);

    // 5. 再次查詢確認訂單已撤銷
    log.info(`再次查詢確認訂單已撤銷: ${order.orderId || clientOrderId}...`);
    await new Promise(resolve => setTimeout(resolve, 3000)); // 等待 3 秒讓撤銷生效
    const finalOrderDetails = await adapter.getOrderDetail(
      TEST_SYMBOL,
      order.orderId,
      order.clientOrderId
    );
    log.info(`最終訂單詳情: ${JSON.stringify(finalOrderDetails)}`);

    if (finalOrderDetails.state === "canceled") {
      log.info("訂單已成功撤銷，測試通過。");
    } else {
      log.error("訂單未成功撤銷，測試失敗。");
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "訂單未撤銷" });
    }

    // 6. 核對交易所無殘留訂單 (簡化：只檢查此訂單)
    log.info("檢查是否有其他活動訂單...");
    const openOrders = await adapter.getOpenOrders(TEST_SYMBOL);
    const remainingTestOrders = openOrders.filter(o => o.clientOrderId?.startsWith("maker-test-"));
    if (remainingTestOrders.length === 0) {
      log.info("沒有發現殘留的測試訂單，清理驗證通過。");
    } else {
      log.warn(`發現殘留測試訂單: ${JSON.stringify(remainingTestOrders)}，請手動清理。`);
      // 這裡可以選擇拋出錯誤或僅警告，為了安全起見，先警告
    }

    log.info("Maker-First 測試網送單驗收成功完成。");
  } catch (error) {
    log.error(`Maker-First 測試網送單驗收失敗: ${(error as any).message}`);
    throw error;
  }
}

runMakerFirstTest().catch(e => {
  log.error(`腳本執行錯誤: ${(e as any).message}`);
  process.exit(1);
});
