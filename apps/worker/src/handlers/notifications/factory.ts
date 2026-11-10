import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "@reelforge/api/app-module";
import { ChannelReportsService, NotificationsService } from "@reelforge/api/notifications-service";

export type NotificationsRuntime = Readonly<{
  notifications: Pick<NotificationsService, "runIntake" | "fanOutPending" | "processDueDeliveries">;
  reports: Pick<ChannelReportsService, "runScheduleTick">;
  close: () => Promise<void>;
}>;

export async function createNotificationsRuntime(
  env: NodeJS.ProcessEnv,
): Promise<NotificationsRuntime> {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required by the notifications worker");
  const app: INestApplicationContext = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn"],
  });
  return {
    notifications: app.get(NotificationsService),
    reports: app.get(ChannelReportsService),
    close: async (): Promise<void> => {
      await app.close();
    },
  };
}
