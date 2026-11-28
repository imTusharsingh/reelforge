import { describe, expect, it } from "vitest";
import { deriveTextAttempt, type TextEvidenceKind } from "./text-attempt-store.js";

const dispatchKey = "local-dispatch";
const nonce = "sender-one";
const reservationId = "12345678-1234-4234-8234-123456789013";
const adjustmentId = "12345678-1234-4234-8234-123456789014";
type Event = { kind: TextEvidenceKind; data: object; nonce: string | null; eventKey?: string };
const event = (kind: TextEvidenceKind, data: object = {}, from: string | null = null): Event => ({
  kind,
  data,
  nonce: from,
});
const prepared = event("PREPARED", { dispatchKey, estimateMinor: 7, modelId: "fixture" });
const armed = event("ARMED", { reservationId }, nonce);
const sent = event("SENT_EVIDENCE", { dispatchKey, source: "transport" }, nonce);
const retired = event("SENDER_RETIRED", { dispatchKey }, nonce);
const confirmed = event("OWNER_CONFIRMED", { dispatchKey });
const rejected = event(
  "REJECTED",
  { dispatchKey, code: "UNAUTHENTICATED", httpStatus: 401 },
  nonce,
);

function evaluate(...events: Event[]): ReturnType<typeof deriveTextAttempt> {
  return deriveTextAttempt(
    dispatchKey,
    events.map((entry, index) => ({
      ...entry,
      sequence: index + 1,
    })),
  );
}

describe("paid text evidence reducer", () => {
  it("retains reserved unknown until positive safe evidence authorizes settlement", () => {
    expect(evaluate(prepared, armed, retired)).toMatchObject({
      phase: "ARMED",
      senderRetired: true,
      positiveSent: false,
      reservedMinor: 7,
      netMinor: 0,
    });
    expect(() => evaluate(prepared, armed, retired, confirmed)).toThrow("Contradictory");
    expect(() => evaluate(prepared, armed, sent, confirmed)).toThrow("Contradictory");
    expect(evaluate(prepared, armed, sent, retired, confirmed)).toMatchObject({
      phase: "OWNER_CONFIRMED",
      ownerConfirmed: true,
      reservedMinor: 0,
      netMinor: 7,
      grossMinor: 7,
    });
  });

  it("preserves historical owner bookings without treating unverifiable owner IDs as send evidence", () => {
    const ownerReceipt = event(
      "RECOVERED_RECEIPT",
      { dispatchKey, googleId: "unverified", source: "owner_reported" },
      nonce,
    );
    expect(evaluate(prepared, armed, retired, ownerReceipt)).toMatchObject({
      phase: "ARMED",
      positiveSent: false,
      googleId: null,
      reservedMinor: 7,
    });
    const historical = {
      ...event("OWNER_CONFIRMED", { dispatchKey, source: "legacy" }, nonce),
      eventKey: "legacy:OWNER_CONFIRMED:older-confirmation",
    };
    expect(evaluate(prepared, armed, retired, ownerReceipt, historical)).toMatchObject({
      phase: "OWNER_CONFIRMED",
      positiveSent: false,
      googleId: null,
      netMinor: 7,
    });
    expect(() =>
      evaluate(prepared, armed, retired, ownerReceipt, {
        ...historical,
        eventKey: "owner-confirmed",
      }),
    ).toThrow("Contradictory");
  });

  it("permits surrender only for the original unsent sender", () => {
    const surrender = event("NOT_DISPATCHED", { dispatchKey, source: "sender" }, nonce);
    expect(evaluate(prepared, armed, surrender)).toMatchObject({
      phase: "NOT_DISPATCHED",
      reservedMinor: 0,
      netMinor: 0,
      senderRetired: true,
    });
    expect(() => evaluate(prepared, armed, { ...surrender, nonce: "other" })).toThrow(
      "Contradictory",
    );
    expect(() => evaluate(prepared, armed, sent, surrender)).toThrow("Contradictory");
    expect(() => evaluate(prepared, armed, surrender, sent)).toThrow("Contradictory");
  });

  it.each([3, 7])(
    "reduces only the net cost when late rejection follows a credit of %s",
    (amountMinor) => {
      const credit = event("CREDIT", { adjustmentId, amountMinor });
      const booked = [prepared, armed, sent, retired, confirmed];
      expect(evaluate(...booked, credit)).toMatchObject({
        grossMinor: 7,
        netMinor: 7 - amountMinor,
      });
      for (const adjustments of [
        [credit, rejected],
        [rejected, credit],
      ])
        expect(evaluate(...booked, ...adjustments)).toMatchObject({
          phase: "REJECTED",
          ownerConfirmed: true,
          grossMinor: 0,
          netMinor: 0,
          reservedMinor: 0,
        });
    },
  );

  it("accepts late receipt enrichment but rejects contradictory ID, counter and local-key substitution", () => {
    const completed = event(
      "SUCCEEDED",
      { dispatchKey, usable: true, output: { ok: true } },
      nonce,
    );
    const prior = [prepared, armed, completed];
    const receipt = (googleId: string, tokens: number): Event =>
      event("RECOVERED_RECEIPT", { dispatchKey, googleId, usage: { tokens } }, nonce);
    expect(evaluate(...prior)).toMatchObject({
      phase: "SUCCEEDED",
      usable: true,
      googleId: null,
      grossMinor: 7,
      actualMinor: null,
    });
    expect(evaluate(...prior, receipt("google", 32))).toMatchObject({
      googleId: "google",
      usage: { tokens: 32 },
      output: { ok: true },
    });
    expect(() => evaluate(...prior, receipt(dispatchKey, 32))).toThrow("Contradictory");
    expect(() => evaluate(...prior, receipt("google", 32), receipt("other", 32))).toThrow(
      "Contradictory",
    );
    expect(() => evaluate(...prior, receipt("google", 32), receipt("google", 33))).toThrow(
      "Contradictory",
    );
  });

  it("bills a completed unusable response and accepts a definitive rejection with no earlier handoff proof", () => {
    expect(
      evaluate(prepared, armed, event("SUCCEEDED", { dispatchKey, usable: false }, nonce)),
    ).toMatchObject({
      reservedMinor: 0,
      netMinor: 7,
      usable: false,
      output: null,
      positiveSent: true,
    });
    expect(evaluate(prepared, armed, rejected)).toMatchObject({
      phase: "REJECTED",
      reservedMinor: 0,
      netMinor: 0,
      positiveSent: true,
    });
  });
});
