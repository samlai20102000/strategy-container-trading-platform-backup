import { listApiKeys } from './server/db';
import { createAdapter } from './server/exchanges/factory';
import { OKXAdapter } from './server/exchanges/okx';

async function main() {
  const keys = await listApiKeys(1);
  const okxKey = keys.find(k => k.exchange === 'okx' && k.label.includes('KAMA'));
  if (!okxKey) { console.log('No OKX key found'); process.exit(1); }
  
  const adapter = createAdapter(okxKey) as OKXAdapter;
  // Call the raw API to see all fields
  const data = await (adapter as any).request("GET", "/api/v5/account/balance", { ccy: "USDT" });
  const account = data.data?.[0];
  console.log('Account level fields:');
  console.log('  totalEq:', account?.totalEq);
  console.log('  imr:', account?.imr);
  console.log('  mmr:', account?.mmr);
  console.log('  mgnRatio:', account?.mgnRatio);
  console.log('  adjEq:', account?.adjEq);
  console.log('  ordFroz:', account?.ordFroz);
  console.log('  isoEq:', account?.isoEq);
  console.log('  notionalUsd:', account?.notionalUsd);
  const detail = account?.details?.find((d: any) => d.ccy === "USDT");
  console.log('\nUSDT detail:');
  console.log('  availBal:', detail?.availBal);
  console.log('  cashBal:', detail?.cashBal);
  console.log('  frozenBal:', detail?.frozenBal);
  console.log('  ordFrozen:', detail?.ordFrozen);
  console.log('  upl:', detail?.upl);
  console.log('  mgnRatio:', detail?.mgnRatio);
  console.log('  imr:', detail?.imr);
  console.log('  mmr:', detail?.mmr);
  process.exit(0);
}
main();
