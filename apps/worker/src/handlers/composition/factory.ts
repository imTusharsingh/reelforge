import { createDatabaseClient } from "@reelforge/database";
import { AssetService } from "@reelforge/api/asset-service";
import { CompositionEngine, SpawnProcessRunner } from "@reelforge/api/composition-engine";
import { CompositionService } from "@reelforge/api/composition-service";
import { createStorageAdapter } from "@reelforge/api/storage-factory";

export function createCompositionPoller(env: NodeJS.ProcessEnv): {
  service: CompositionService;
  close: () => Promise<void>;
} {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required by the composition worker");
  const database = createDatabaseClient(env.DATABASE_URL);
  const storage = createStorageAdapter(env);
  const assets = new AssetService(database, storage);
  const service = new CompositionService(
    database,
    new CompositionEngine(new SpawnProcessRunner(), storage, assets),
    storage,
    assets,
  );
  return { service, close: () => database.$disconnect() };
}
