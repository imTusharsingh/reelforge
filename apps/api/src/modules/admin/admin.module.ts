import { Module, type MiddlewareConsumer, type NestModule } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { IdentityModule } from "../identity/identity.module.js";
import { OrchestrationModule } from "../orchestration/orchestration.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { AdminController } from "./admin.controller.js";
import { AdminService } from "./admin.service.js";
import { HttpAuditInterceptor } from "./audit.interceptor.js";
import { AuditModule } from "./audit.module.js";
import { EmergencyStopModule } from "./emergency-stop.module.js";
import { OpsMetricsController } from "./ops-metrics.controller.js";
import { RequestContextMiddleware } from "./request-context.middleware.js";

/**
 * M19 admin, security, audit & observability. Registers the global HTTP audit interceptor and the
 * request-context middleware (correlation id, traceparent, access log, metrics) for every route.
 */
@Module({
  imports: [IdentityModule, WorkspaceModule, OrchestrationModule, AuditModule, EmergencyStopModule],
  controllers: [AdminController, OpsMetricsController],
  providers: [AdminService, { provide: APP_INTERCEPTOR, useClass: HttpAuditInterceptor }],
})
export class AdminModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes("*");
  }
}
