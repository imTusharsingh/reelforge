import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { test } from "vitest";
import { AppModule } from "../src/app.module.js";

test("serves the API for browser verification", async () => {
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = module.createNestApplication();
  app.setGlobalPrefix("api/v1");
  await app.listen(3301, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
  } finally {
    await app.close();
  }
});
