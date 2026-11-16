import { Module } from "@nestjs/common";
import { createDatabaseClient, seedAllWorkspaceFoundations } from "@reelforge/database";
import { AuthGuard } from "./auth.guard.js";
import { IdentityService } from "./identity.service.js";
import { IdentityController } from "./identity.controller.js";

const databaseProvider = {
  provide: "DATABASE",
  useFactory: async (): Promise<ReturnType<typeof createDatabaseClient>> => {
    const db = createDatabaseClient(process.env.DATABASE_URL ?? "");
    try {
      await seedAllWorkspaceFoundations(db);
      return db;
    } catch (error) {
      await db.$disconnect();
      throw error;
    }
  },
};
@Module({
  controllers: [IdentityController],
  providers: [databaseProvider, IdentityService, AuthGuard],
  exports: [IdentityService, AuthGuard, "DATABASE"],
})
export class IdentityModule {}
