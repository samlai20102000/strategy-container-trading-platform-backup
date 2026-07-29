export interface StrategyApiBindingSummary {
  apiKeyId: number;
  exchange: string;
}

export interface SafeApiAccountSummary {
  id: number;
  label: string;
  exchange: string;
  isTestnet: boolean;
}

export type StrategyApiIdentityStatus = "resolved" | "loading" | "missing";

export interface StrategyApiIdentity {
  status: StrategyApiIdentityStatus;
  displayName: string;
  exchangeLabel: string;
  environmentLabel: "模擬" | "正式" | "未知";
  accountLabel: string;
}

/**
 * 只使用 apiKeys.list 已淨化的安全欄位形成策略卡片身分；
 * 絕不接觸或顯示 API key、secret、passphrase。
 */
export function getStrategyApiIdentity(
  strategy: StrategyApiBindingSummary,
  apiKeys: readonly SafeApiAccountSummary[] | undefined,
): StrategyApiIdentity {
  const fallbackExchange = (strategy.exchange || "API").toUpperCase();

  if (apiKeys === undefined) {
    return {
      status: "loading",
      displayName: `${fallbackExchange}｜API 資料載入中`,
      exchangeLabel: fallbackExchange,
      environmentLabel: "未知",
      accountLabel: "API 資料載入中",
    };
  }

  const apiAccount = apiKeys.find(account => account.id === strategy.apiKeyId);
  if (!apiAccount) {
    return {
      status: "missing",
      displayName: `${fallbackExchange}｜API #${strategy.apiKeyId} 未找到`,
      exchangeLabel: fallbackExchange,
      environmentLabel: "未知",
      accountLabel: `API #${strategy.apiKeyId} 未找到`,
    };
  }

  const exchangeLabel = (apiAccount.exchange || strategy.exchange || "API").toUpperCase();
  const environmentLabel = apiAccount.isTestnet ? "模擬" : "正式";
  const accountLabel = apiAccount.label.trim() || `API #${apiAccount.id}`;

  return {
    status: "resolved",
    displayName: `${exchangeLabel} ${environmentLabel}｜${accountLabel}`,
    exchangeLabel,
    environmentLabel,
    accountLabel,
  };
}
