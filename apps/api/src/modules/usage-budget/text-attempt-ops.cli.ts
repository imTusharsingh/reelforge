import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createDatabaseClient } from "@reelforge/database";
import {
  ingestMatchedTextReceipt,
  ingestMatchedTextRejection,
} from "./text-attempt-receipt-recovery.js";
import { retireExitedTextSender } from "./text-sender-retirement.js";

const commands = {
  retire: retireExitedTextSender,
  receipt: ingestMatchedTextReceipt,
  reject: ingestMatchedTextRejection,
};

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { proof: { type: "string" }, apply: { type: "boolean" } },
    allowPositionals: true,
  });
  const [command] = positionals;
  const connection = process.env.DATABASE_URL;
  if (
    !connection ||
    !values.apply ||
    !values.proof ||
    positionals.length !== 1 ||
    (command !== "retire" && command !== "receipt" && command !== "reject")
  )
    throw new Error(
      "Pass retire|receipt|reject --proof <verified-audit.json> --apply and DATABASE_URL.",
    );
  const input: unknown = JSON.parse(await readFile(values.proof, "utf8"));
  const db = createDatabaseClient(connection);
  try {
    await commands[command](db, input);
    console.log("Operator evidence recorded and folded, or exact replay confirmed.");
  } finally {
    await db.$disconnect();
  }
}

await main().catch(() => {
  console.error(
    "Operator evidence did not finish; check proof schema, exact arm identity, audit times and DB access. After correcting connectivity, replay the same proof to finish safely.",
  );
  process.exitCode = 1;
});
