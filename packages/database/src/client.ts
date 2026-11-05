import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

export function createDatabaseClient(connectionString: string): PrismaClient {
  if (connectionString.trim().length === 0) {
    throw new Error("A database connection string is required.");
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
