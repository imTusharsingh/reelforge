export const NOTIFICATION_EMAIL_PORT = Symbol("NOTIFICATION_EMAIL_PORT");
export const NOTIFICATIONS_CLOCK = Symbol("NOTIFICATIONS_CLOCK");
export const NOTIFICATIONS_CONFIG = Symbol("NOTIFICATIONS_CONFIG");

export type NotificationEmailMessage = Readonly<{
  to: string;
  subject: string;
  text: string;
  /** Stable per delivery so a configured provider can de-duplicate a resend. */
  idempotencyKey: string;
}>;

export type NotificationEmailResult = Readonly<{ providerMessageId: string }>;

/**
 * M17-T03 email port. No live adapter ships in M17: the sender/provider decision is still
 * pending (DECISION_LOG "Email sender"). The default adapter is NOT_CONFIGURED, which records
 * deliveries as SKIPPED_NOT_CONFIGURED and never reports a fake success.
 */
export interface NotificationEmailPort {
  isConfigured(): boolean;
  send(message: NotificationEmailMessage): Promise<NotificationEmailResult>;
}

export class NotificationEmailError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "NotificationEmailError";
  }
}

export class NotConfiguredNotificationEmail implements NotificationEmailPort {
  public isConfigured(): boolean {
    return false;
  }

  public send(): Promise<NotificationEmailResult> {
    return Promise.reject(
      new NotificationEmailError("Email sender is not configured", "EMAIL_NOT_CONFIGURED", false),
    );
  }
}

export type NotificationsConfig = Readonly<{
  /**
   * Rows newer than now - settleMs are not consumed yet, so late commits are not skipped.
   * R1 assumption: a source row commits within ~5 s of the timestamp it carries (short
   * transactions) and API/worker clocks are within ~30 s of each other (NTP). A row committed
   * later than `intakeSettleMs` after its own timestamp, net of skew, can be passed by the cursor and
   * is then never notified. Raise this if either assumption stops holding.
   */
  intakeSettleMs: number;
  /**
   * When a source has no cursor yet: false (default) starts at now - settleMs, so older rows are
   * ignored; true starts at the beginning and backfills every persisted row.
   */
  intakeBackfill: boolean;
  intakeBatchSize: number;
  intakeMaxPages: number;
  fanoutBatchSize: number;
  deliveryBatchSize: number;
  deliveryMaxAttempts: number;
  deliveryBaseBackoffMs: number;
  deliveryMaxBackoffMs: number;
  deliveryLeaseMs: number;
  /** A scheduled report is generated only once its period ended at least this long ago. */
  reportDelayMs: number;
}>;

export const DEFAULT_NOTIFICATIONS_CONFIG: NotificationsConfig = {
  intakeSettleMs: 30_000,
  intakeBackfill: false,
  intakeBatchSize: 200,
  intakeMaxPages: 10,
  fanoutBatchSize: 100,
  deliveryBatchSize: 50,
  deliveryMaxAttempts: 5,
  deliveryBaseBackoffMs: 60_000,
  deliveryMaxBackoffMs: 3_600_000,
  deliveryLeaseMs: 120_000,
  reportDelayMs: 2 * 3_600_000,
};

export function deliveryBackoffMs(config: NotificationsConfig, attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(config.deliveryMaxBackoffMs, config.deliveryBaseBackoffMs * 2 ** exponent);
}
