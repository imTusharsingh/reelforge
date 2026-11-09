import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { InstagramNotConfiguredConnector, YouTubeConnector } from "@reelforge/social-providers";
import {
  SocialAccountsController,
  SocialOAuthCallbackController,
} from "./social-accounts.controller.js";
import { SocialAccountsService } from "./social-accounts.service.js";
import { TokenVault } from "./token-vault.js";

@Module({
  imports: [IdentityModule, WorkspaceModule],
  controllers: [SocialAccountsController, SocialOAuthCallbackController],
  providers: [
    SocialAccountsService,
    {
      provide: YouTubeConnector,
      useFactory: (): YouTubeConnector => {
        const clientId = process.env.YOUTUBE_OAUTH_CLIENT_ID;
        const clientSecret = process.env.YOUTUBE_OAUTH_CLIENT_SECRET;
        return new YouTubeConnector(
          clientId === undefined || clientSecret === undefined ? null : { clientId, clientSecret },
        );
      },
    },
    {
      provide: "INSTAGRAM_CONNECTOR",
      useFactory: (): InstagramNotConfiguredConnector => new InstagramNotConfiguredConnector(),
    },
    {
      provide: TokenVault,
      useFactory: (): TokenVault => new TokenVault(process.env.SOCIAL_TOKEN_ENCRYPTION_KEY),
    },
    {
      provide: "YOUTUBE_OAUTH_CALLBACK_URL",
      useFactory: (): string | undefined => process.env.YOUTUBE_OAUTH_CALLBACK_URL,
    },
  ],
  exports: [SocialAccountsService],
})
export class SocialAccountsModule {}
