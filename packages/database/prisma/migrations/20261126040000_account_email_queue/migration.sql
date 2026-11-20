CREATE TABLE "AccountEmailLimit" (
    "key" TEXT PRIMARY KEY,
    "count" INTEGER NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL
);
CREATE INDEX "AccountEmailLimit_expiresAt_idx" ON "AccountEmailLimit" ("expiresAt");

CREATE TABLE "AccountResetDelivery" (
    "id" UUID PRIMARY KEY,
    "email" TEXT NOT NULL,
    "code" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ NOT NULL
);
CREATE INDEX "AccountResetDelivery_availableAt_idx" ON "AccountResetDelivery" ("availableAt");
CREATE INDEX "AccountResetDelivery_expiresAt_idx" ON "AccountResetDelivery" ("expiresAt");
