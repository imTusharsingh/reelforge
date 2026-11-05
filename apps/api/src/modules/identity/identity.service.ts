import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Database, Principal } from "./identity.types.js";
import {
  createSessionToken,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from "./auth.crypto.js";

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
}
