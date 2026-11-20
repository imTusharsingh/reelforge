import {
  BadRequestException,
  Body,
  Controller,
  Header,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AuthGuard, type AuthenticatedRequest } from "./auth.guard.js";
import { AccountEmailService } from "./account-email.service.js";

const email = z.string().trim().toLowerCase().max(254).pipe(z.email());
const code = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const resetRequest = z.strictObject({ email });
const resetConfirmation = z.strictObject({ code, password: z.string().min(12).max(1024) });
const changeRequest = z.strictObject({ email, password: z.string().min(1).max(1024) });
const changeConfirmation = z.strictObject({ code });

function input<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new BadRequestException("Invalid request");
  return parsed.data;
}

@Controller("auth")
export class AccountEmailController {
  public constructor(private readonly account: AccountEmailService) {}

  @Post("password-reset")
  @Header("Cache-Control", "no-store")
  @HttpCode(202)
  public async requestReset(@Body() body: unknown): Promise<void> {
    await this.account.requestReset(input(resetRequest, body).email);
  }

  @Post("password-reset/confirm")
  @Header("Cache-Control", "no-store")
  @HttpCode(204)
  public async confirmReset(@Body() body: unknown): Promise<void> {
    const { code, password } = input(resetConfirmation, body);
    await this.account.resetPassword(code, password);
  }

  @Post("me/email-change")
  @Header("Cache-Control", "no-store")
  @HttpCode(202)
  @UseGuards(AuthGuard)
  public async requestEmailChange(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<void> {
    const { email, password } = input(changeRequest, body);
    await this.account.requestEmailChange(request.principal.userId, email, password);
  }

  @Post("email-change/confirm")
  @Header("Cache-Control", "no-store")
  @HttpCode(204)
  public async confirmEmail(@Body() body: unknown): Promise<void> {
    await this.account.confirmEmail(input(changeConfirmation, body).code);
  }
}
