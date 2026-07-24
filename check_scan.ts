import { getDb } from './server/db';
import { scanState } from './drizzle/schema';
import { desc } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  const rows = await db.select({
    id: scanState.id,
    scanId: scanState.scanId,
    phase: scanState.currentPhase,
    gen: scanState.currentGeneration,
    maxGen: scanState.maxGenerations,
    mode: scanState.scanMode,
    taskUid: scanState.heartbeatTaskUid,
    error: scanState.error,
    createdAt: scanState.createdAt,
    updatedAt: scanState.updatedAt,
  }).from(scanState).orderBy(desc(scanState.createdAt));
  
  for (const r of rows) {
    console.log(JSON.stringify(r, null, 2));
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
