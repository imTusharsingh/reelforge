import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { AssetController } from "./asset.controller.js";
import { AssetService } from "./asset.service.js";
import { createStorageAdapter } from "./storage/storage.factory.js";
import { STORAGE_PORT } from "./storage/storage.port.js";
import type { StoragePort } from "./storage/storage.port.js";

const storageProvider = {
  provide: STORAGE_PORT,
  useFactory: (): StoragePort => createStorageAdapter(),
};

@Module({
  imports: [IdentityModule, WorkspaceModule],
  controllers: [AssetController],
  providers: [AssetService, storageProvider],
  exports: [AssetService, storageProvider],
})
export class AssetModule {}
