import { randomUUID } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import { z } from "zod";

export const linuxSenderIdentity = z.strictObject({
  bootId: z.uuid(),
  pidNamespace: z.string().regex(/^pid:\[\d+\]$/),
  uid: z.int().nonnegative(),
  startTicks: z.string().regex(/^\d+$/),
});
export const textSenderIdentity = z.strictObject({
  incarnation: z.uuid(),
  pid: z.int().positive(),
  platform: z.string().min(1).max(40),
  linux: linuxSenderIdentity.optional(),
});
export type TextSenderIdentity = z.infer<typeof textSenderIdentity>;

function readProcessStat(pid: number | "self"): { state: string; startTicks: string } {
  const content = readFileSync(`/proc/${pid}/stat`, "utf8");
  const expectedPid = pid === "self" ? process.pid : pid;
  if (content.slice(0, content.indexOf(" ")) !== String(expectedPid))
    throw new Error("procfs does not expose the expected PID mapping");
  // The parenthesized command can contain both spaces and closing parentheses.
  const fields = content
    .slice(content.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  return z
    .object({ state: z.string().length(1), startTicks: linuxSenderIdentity.shape.startTicks })
    .parse({ state: fields[0], startTicks: fields[19] });
}

function localLinuxIdentity(): NonNullable<TextSenderIdentity["linux"]> {
  return linuxSenderIdentity.parse({
    bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    pidNamespace: readlinkSync("/proc/self/ns/pid"),
    uid: process.geteuid?.(),
    startTicks: readProcessStat("self").startTicks,
  });
}

export function currentTextSenderIdentity(): TextSenderIdentity {
  const base = { incarnation: randomUUID(), pid: process.pid, platform: process.platform };
  try {
    return process.platform === "linux" ? { ...base, linux: localLinuxIdentity() } : base;
  } catch {
    // A restricted procfs must not prevent dispatch. Retirement will need the supervisor.
    return base;
  }
}

export function proveLocalTextSenderExit(identity: TextSenderIdentity): {
  result: "absent" | "exited" | "pid-reused";
  checkedAt: string;
} {
  const local = localLinuxIdentity();
  if (
    !identity.linux ||
    local.bootId !== identity.linux.bootId ||
    local.pidNamespace !== identity.linux.pidNamespace ||
    local.uid !== identity.linux.uid
  )
    throw new Error("Operator is not in the sender's Linux boot, PID namespace and effective UID");
  const checkedAt = new Date().toISOString();
  try {
    const observed = readProcessStat(identity.pid);
    if (observed.startTicks !== identity.linux.startTicks)
      return { result: "pid-reused", checkedAt };
    if (observed.state === "Z" || observed.state === "X") return { result: "exited", checkedAt };
    throw new Error("The exact worker process is still present");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return { result: "absent", checkedAt };
    throw error;
  }
}
