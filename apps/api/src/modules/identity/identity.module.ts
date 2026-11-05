import { Module } from "@nestjs/common";
import { createDatabaseClient } from "@reelforge/database";
import { AuthGuard } from "./auth.guard.js";
import { IdentityService } from "./identity.service.js";
import { IdentityController } from "./identity.controller.js";

const databaseProvider = {
  provide: "DATABASE",
  useFactory: (): ReturnType<typeof createDatabaseClient> =>
    createDatabaseClient(process.env.DATABASE_URL ?? ""),
};
@Module({
  controllers: [IdentityController],
  providers: [databaseProvider, IdentityService, AuthGuard],
  exports: [IdentityService, AuthGuard, "DATABASE"],
})
export class IdentityModule {}
