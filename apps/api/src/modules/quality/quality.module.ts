import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { QualityService } from "./quality.service.js";

@Module({ imports: [IdentityModule], providers: [QualityService], exports: [QualityService] })
export class QualityModule {}
