CREATE TYPE "EmailChallengePurpose" AS ENUM ('RESET_PASSWORD', 'CHANGE_EMAIL');
ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMPTZ(6);

CREATE TABLE "email_challenges" (
  "user_id" UUID NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "purpose" "EmailChallengePurpose" NOT NULL,
  "token_hash" TEXT NOT NULL,
  "source_email" TEXT NOT NULL,
  "target_email" TEXT NOT NULL,
  "credential_fingerprint" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "issued_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "email_challenges_pkey" PRIMARY KEY ("user_id", "purpose")
);
CREATE UNIQUE INDEX "email_challenges_token_hash_key" ON "email_challenges" ("token_hash");
