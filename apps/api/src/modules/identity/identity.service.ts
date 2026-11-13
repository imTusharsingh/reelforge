import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Database, Principal } from "./identity.types.js";
import {
  createSessionToken,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from "./auth.crypto.js";

function normalizeDisplayName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 80) {
    throw new BadRequestException("Display name must be between 1 and 80 characters.");
  }
  if (/[\p{Cc}]/u.test(trimmed)) {
    throw new BadRequestException("Display name contains invalid characters.");
  }
  return trimmed;
}

@Injectable()
export class IdentityService {
  public constructor(@Inject("DATABASE") private readonly db: Database) {}

  public async register(
    email: string,
    password: string,
    displayName?: string,
  ): Promise<{ userId: string; token: string }> {
    const normalizedEmail = email.trim().toLowerCase();
    const passwordHash = await hashPassword(password);
    const token = createSessionToken();
    const data = {
      email: normalizedEmail,
      credential: { create: { passwordHash } },
      sessions: {
        create: {
          tokenHash: hashSessionToken(token),
          expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
        },
      },
      ...(displayName === undefined ? {} : { displayName }),
    };
    const user = await this.db.user.create({
      data,
      select: { id: true },
    });
    await this.db.authEvent.create({
      data: { userId: user.id, eventType: "auth.registered", outcome: "success" },
    });
    return { userId: user.id, token };
  }

  public async login(email: string, password: string): Promise<{ userId: string; token: string }> {
    const user = await this.db.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      include: { credential: true },
    });
    const valid = await verifyPassword(
      password,
      user?.credential?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );
    if (!user || !valid) {
      await this.db.authEvent.create({
        data: { ...(user ? { userId: user.id } : {}), eventType: "auth.login", outcome: "failure" },
      });
      throw new UnauthorizedException("Invalid credentials");
    }
    const token = createSessionToken();
    await this.db.session.create({
      data: {
        userId: user.id,
        tokenHash: hashSessionToken(token),
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
      },
    });
    await this.db.authEvent.create({
      data: { userId: user.id, eventType: "auth.login", outcome: "success" },
    });
    return { userId: user.id, token };
  }

  public async principalForToken(token: string): Promise<Principal> {
    const session = await this.db.session.findUnique({
      where: { tokenHash: hashSessionToken(token) },
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date())
      throw new UnauthorizedException("Unauthenticated");
    return { userId: session.userId, sessionId: session.id };
  }

  public async revoke(principal: Principal): Promise<void> {
    await this.db.session.update({
      where: { id: principal.sessionId },
      data: { revokedAt: new Date() },
    });
    await this.db.authEvent.create({
      data: { userId: principal.userId, eventType: "auth.logout", outcome: "success" },
    });
  }

  public async me(userId: string): Promise<{
    userId: string;
    email: string;
    displayName: string | null;
  }> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, displayName: true },
    });
    if (!user) throw new UnauthorizedException("Unauthenticated");
    return { userId: user.id, email: user.email, displayName: user.displayName };
  }

  public async updateProfile(
    userId: string,
    displayName: string,
  ): Promise<{ userId: string; email: string; displayName: string | null }> {
    const normalized = normalizeDisplayName(displayName);
    const user = await this.db.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: { displayName: normalized },
        select: { id: true, email: true, displayName: true },
      });
      await tx.authEvent.create({
        data: { userId, eventType: "auth.profile_updated", outcome: "success" },
      });
      return updated;
    });
    return { userId: user.id, email: user.email, displayName: user.displayName };
  }

  public async changePassword(
    principal: Principal,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ ok: true; revokedSessions: number }> {
    const now = new Date();
    const recentFailures = await this.db.authEvent.count({
      where: {
        userId: principal.userId,
        eventType: "auth.password_changed",
        outcome: "failure",
        occurredAt: { gte: new Date(now.getTime() - 15 * 60 * 1000) },
      },
    });
    if (recentFailures >= 5) {
      await this.db.authEvent.create({
        data: {
          userId: principal.userId,
          eventType: "auth.password_changed",
          outcome: "rate_limited",
        },
      });
      throw new HttpException(
        { message: "Too many attempts. Try again later.", code: "TOO_MANY_ATTEMPTS" },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = await this.db.user.findUnique({
      where: { id: principal.userId },
      include: { credential: true },
    });
    if (!user) throw new UnauthorizedException("Unauthenticated");

    const valid = await verifyPassword(
      currentPassword,
      user.credential?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );
    if (!user.credential || !valid) {
      await this.db.authEvent.create({
        data: {
          userId: principal.userId,
          eventType: "auth.password_changed",
          outcome: "failure",
        },
      });
      throw new UnauthorizedException({
        message: "Invalid credentials",
        code: "INVALID_CREDENTIALS",
      });
    }

    if (newPassword === currentPassword) {
      throw new BadRequestException("New password must differ from the current password.");
    }
    const passwordHash = await hashPassword(newPassword);

    const revokedSessions = await this.db.$transaction(async (tx) => {
      await tx.passwordCredential.upsert({
        where: { userId: principal.userId },
        update: { passwordHash },
        create: { userId: principal.userId, passwordHash },
      });
      const revoked = await tx.session.updateMany({
        where: {
          userId: principal.userId,
          id: { not: principal.sessionId },
          revokedAt: null,
        },
        data: { revokedAt: now },
      });
      await tx.authEvent.create({
        data: {
          userId: principal.userId,
          eventType: "auth.password_changed",
          outcome: "success",
        },
      });
      return revoked.count;
    });

    return { ok: true, revokedSessions };
  }
}
