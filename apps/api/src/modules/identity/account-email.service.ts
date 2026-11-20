import { lockIdentityUser } from "./identity-lock.js";
import {
  BadRequestException,
  ConflictException,
  Inject,
  HttpException,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Prisma } from "@reelforge/database";
import { ACCOUNT_EMAIL, type AccountEmailPort, type EmailPurpose } from "./account-email.port.js";
import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from "./auth.crypto.js";
import type { Database } from "./identity.types.js";

import { AccountResetQueue } from "./account-reset-queue.js";
import { claimEmailQuota } from "./account-email-admission.js";

const invalidCode = (): BadRequestException => new BadRequestException("Invalid or expired code");

@Injectable()
export class AccountEmailService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(AccountEmailService.name);
  private readonly queue: AccountResetQueue;
  private timer?: ReturnType<typeof setInterval>;
  private draining: Promise<void> | undefined;
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    @Inject(ACCOUNT_EMAIL) private readonly mail: AccountEmailPort,
  ) {
    this.queue = new AccountResetQueue(db);
  }

  public onModuleInit(): void {
    this.timer = setInterval(() => {
      this.draining ??= this.processResetDelivery()
        .then(() => undefined)
        .catch(() => this.log.warn("Account reset queue temporarily unavailable"))
        .finally(() => {
          this.draining = undefined;
        });
    }, 1000);
    this.timer.unref();
  }

  public async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.draining;
  }

  private requireRelay(): void {
    if (this.mail.available === false)
      throw new ServiceUnavailableException("Account email delivery is not configured");
  }

  public async requestReset(email: string, source: string): Promise<void> {
    this.requireRelay();
    await this.queue.enqueue(email, source).catch((cause: unknown) => {
      throw new ServiceUnavailableException("Account recovery queue is unavailable", { cause });
    });
  }

  public async processResetDelivery(): Promise<void> {
    await this.queue.purge();
    if (this.mail.available === false) return;
    const job = await this.queue.take();
    if (!job) return;
    try {
      let code = job.code;
      if (!code) {
        const user = await this.db.user.findUnique({
          where: { email: job.email },
          include: { credential: true },
        });
        if (user?.credential)
          code = await this.issue(
            user.id,
            job.email,
            job.email,
            user.credential.passwordHash,
            "RESET_PASSWORD",
            (tx, issued) => this.queue.saveCode(tx, job, issued),
          );
      }
      if (code) {
        const challenge = await this.db.emailChallenge.findUnique({
          where: { tokenHash: hashSessionToken(code) },
        });
        if (challenge && challenge.expiresAt > new Date())
          await this.mail.send({ to: job.email, purpose: "RESET_PASSWORD", code });
      }
    } catch {
      this.log.warn("Password reset delivery attempt failed");
      await this.queue.finish(job, true);
      return;
    }
    await this.queue.finish(job, false);
  }

  public async requestEmailChange(userId: string, email: string, password: string): Promise<void> {
    this.requireRelay();
    const admitted = await this.db.$transaction(async (tx) => {
      if (!(await claimEmailQuota(tx, "change:user", userId, 5, 900))) return false;
      return claimEmailQuota(tx, "change:destination", email, 5, 900);
    });
    if (!admitted) throw new HttpException("Too many attempts. Try again later.", 429);
    const user = await this.db.user.findUnique({
      where: { id: userId },
      include: { credential: true },
    });
    if (!user?.credential || !(await verifyPassword(password, user.credential.passwordHash))) {
      await this.db.authEvent.create({
        data: {
          userId,
          eventType: "auth.email_change_requested",
          outcome: "failure",
        },
      });
      throw new UnauthorizedException("Invalid credentials");
    }
    if (user.email === email) throw new BadRequestException("Enter a different email address");
    if (await this.db.user.findUnique({ where: { email }, select: { id: true } }))
      throw new ConflictException("Email address is unavailable");
    const code = await this.issue(
      user.id,
      user.email,
      email,
      user.credential.passwordHash,
      "CHANGE_EMAIL",
    );
    if (!code) throw new HttpException("Wait a minute and request a new code.", 429);
    await this.deliver(email, "CHANGE_EMAIL", code);
  }

  private async deliver(to: string, purpose: EmailPurpose, code: string): Promise<void> {
    try {
      await this.mail.send({ to, purpose, code });
    } catch {
      await this.db.emailChallenge.deleteMany({ where: { tokenHash: hashSessionToken(code) } });
      throw new ServiceUnavailableException("Account email delivery failed");
    }
  }

  private async issue(
    userId: string,
    sourceEmail: string,
    targetEmail: string,
    passwordHash: string,
    purpose: EmailPurpose,
    onIssued?: (tx: Prisma.TransactionClient, code: string) => Promise<void>,
  ): Promise<string | null> {
    const code = createSessionToken();
    return this.db.$transaction(async (tx) => {
      await lockIdentityUser(tx, userId);
      const current = await tx.user.findUnique({
        where: { id: userId },
        include: { credential: true },
      });
      if (current?.email !== sourceEmail || current.credential?.passwordHash !== passwordHash)
        return null;
      const now = Date.now();
      const key = { userId, purpose };
      const previous = await tx.emailChallenge.findUnique({ where: { userId_purpose: key } });
      if (previous && previous.issuedAt.getTime() > now - 60_000) return null;
      const data = {
        sourceEmail,
        targetEmail,
        tokenHash: hashSessionToken(code),
        credentialFingerprint: hashSessionToken(passwordHash),
        issuedAt: new Date(now),
        expiresAt: new Date(now + 30 * 60_000),
      };
      await tx.emailChallenge.upsert({
        where: { userId_purpose: key },
        create: { ...key, ...data },
        update: data,
      });
      await onIssued?.(tx, code);
      return code;
    });
  }

  public async resetPassword(code: string, password: string): Promise<void> {
    await this.consume(code, "RESET_PASSWORD", async (tx, userId, _target, passwordHash, now) => {
      const changed = await tx.passwordCredential.updateMany({
        where: { userId, passwordHash },
        data: { passwordHash: await hashPassword(password) },
      });
      if (changed.count !== 1) throw invalidCode();
      await tx.user.update({ where: { id: userId }, data: { emailVerifiedAt: now } });
    });
  }

  public async confirmEmail(code: string): Promise<void> {
    try {
      await this.consume(
        code,
        "CHANGE_EMAIL",
        async (tx, userId, targetEmail, _passwordHash, now) => {
          await tx.user.update({
            where: { id: userId },
            data: { email: targetEmail, emailVerifiedAt: now },
          });
        },
      );
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002")
        throw new ConflictException("Email address is unavailable");
      throw error;
    }
  }

  private async consume(
    code: string,
    purpose: EmailPurpose,
    apply: (
      tx: Prisma.TransactionClient,
      userId: string,
      target: string,
      passwordHash: string,
      now: Date,
    ) => Promise<void>,
  ): Promise<void> {
    const tokenHash = hashSessionToken(code);
    await this.db.$transaction(async (tx) => {
      const row = await tx.emailChallenge.findUnique({ where: { tokenHash } });
      if (row?.purpose !== purpose) throw invalidCode();
      await lockIdentityUser(tx, row.userId);
      const now = new Date();
      const claimed = await tx.emailChallenge.deleteMany({
        where: { tokenHash, expiresAt: { gt: now } },
      });
      if (claimed.count !== 1) throw invalidCode();
      const user = await tx.user.findUnique({
        where: { id: row.userId },
        include: { credential: true },
      });
      if (
        !user?.credential ||
        user.email !== row.sourceEmail ||
        hashSessionToken(user.credential.passwordHash) !== row.credentialFingerprint
      )
        throw invalidCode();
      await apply(tx, user.id, row.targetEmail, user.credential.passwordHash, now);
      await tx.emailChallenge.deleteMany({ where: { userId: user.id } });
      await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.authEvent.create({
        data: {
          userId: user.id,
          outcome: "success",
          eventType: purpose === "RESET_PASSWORD" ? "auth.password_reset" : "auth.email_verified",
        },
      });
    });
  }
}
