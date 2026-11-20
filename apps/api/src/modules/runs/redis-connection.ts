import type { ConnectionOptions } from "bullmq";

export function parseRedisConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:")
    throw new Error("REDIS_URL must use redis:// or rediss://");
  const dbValue = url.pathname.replace(/^\//, "");
  const options: ConnectionOptions = {
    host: url.hostname,
    port: url.port.length > 0 ? Number(url.port) : 6379,
  };
  if (url.username.length > 0) options.username = decodeURIComponent(url.username);
  if (url.password.length > 0) options.password = decodeURIComponent(url.password);
  if (dbValue.length > 0) options.db = Number(dbValue);
  if (url.protocol === "rediss:") options.tls = {};
  return options;
}
