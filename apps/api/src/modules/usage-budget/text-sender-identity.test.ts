import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { currentTextSenderIdentity, proveLocalTextSenderExit } from "./text-sender-identity.js";

it.skipIf(process.platform !== "linux")(
  "matches exact live and exited Linux PIDs without signaling workers",
  async () => {
    const local = currentTextSenderIdentity();
    if (!local.linux) throw new Error("Expected local procfs in the Linux test environment");
    expect(() => proveLocalTextSenderExit(local)).toThrow("still present");
    expect(() =>
      proveLocalTextSenderExit({ ...local, linux: { ...local.linux!, pidNamespace: "pid:[0]" } }),
    ).toThrow("not in the sender");
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    await once(child, "spawn");
    const closed = once(child, "exit");
    try {
      if (!child.pid) throw new Error("Fixture exited before reporting PID");
      const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
      const startTicks = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/)[19]!;
      const sender = { ...local, pid: child.pid, linux: { ...local.linux, startTicks } };
      expect(() => proveLocalTextSenderExit(sender)).toThrow("still present");
      child.stdin.end();
      await closed;
      expect(proveLocalTextSenderExit(sender).result).toMatch(/absent|pid-reused/);
    } finally {
      child.stdin.end();
      await closed;
    }
  },
);
