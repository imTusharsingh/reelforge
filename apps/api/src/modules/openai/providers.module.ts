import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { AssetModule } from "../asset/asset.module.js";
import { UsageBudgetModule } from "../usage-budget/usage-budget.module.js";
import { TokenVault } from "../social-accounts/token-vault.js";
import { ProviderKeys } from "./provider-keys.js";
import { ProviderLedger } from "./provider-ledger.js";
import { ProviderVideoHealth } from "./provider-video-health.js";
import { ProvidersRuntime } from "./providers.runtime.js";
import { ProvidersController } from "./providers.controller.js";
@Module({
  imports: [IdentityModule, WorkspaceModule, AssetModule, UsageBudgetModule],
  controllers: [ProvidersController],
  providers: [
    ProviderKeys,
    ProviderLedger,
    ProvidersRuntime,
    ProviderVideoHealth,
    {
      provide: TokenVault,
      useFactory: (): TokenVault => new TokenVault(process.env.PROVIDER_KEY_ENCRYPTION_KEY),
    },
  ],
  exports: [ProvidersRuntime],
})
export class ProvidersModule {}
