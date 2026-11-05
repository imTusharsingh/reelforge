import type { PrismaClient } from "@reelforge/database";

export type Principal = Readonly<{ userId: string; sessionId: string }>;
export type WorkspaceContext = Readonly<{ workspaceId: string; userId: string; role: "OWNER" | "EDITOR" | "VIEWER" }>;
export type Database = PrismaClient;
