import { Module } from "@nestjs/common";
import { createDatabaseClient, seedAllWorkspaceFoundations } from "@reelforge/database";
import { AuthGuard } from "./auth.guard.js";
import { IdentityService } from "./identity.service.js";
import { IdentityController } from "./identity.controller.js";

import { AccountEmailController } from "./account-email.controller.js";
import { AccountEmailService } from "./account-email.service.js";
import {
  ACCOUNT_EMAIL,
  createAccountEmailPort,
  type AccountEmailPort,
} from "./account-email.port.js";

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
  controllers: [IdentityController, AccountEmailController],
  providers: [
    databaseProvider,
    IdentityService,
    AuthGuard,
    AccountEmailService,
    {
      provide: ACCOUNT_EMAIL,
      useFactory: (): AccountEmailPort => createAccountEmailPort(process.env),
    },
  ],
  exports: [IdentityService, AuthGuard, "DATABASE"],
})
export class IdentityModule {}
