import assert from "node:assert/strict";
import { test } from "node:test";
import createLogger from "./logger.ts";

test("logger writes a colored level, tag, message, and inspected arguments", () => {
  const logger = createLogger("test");
  const originalWrite = process.stderr.write;
  let output = "";

  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += chunk;
    return true;
  }) as typeof process.stderr.write;

  try {
    logger.info("hello", { answer: 42 });
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.ok(output.includes("\u001b[37m[info] ["));
  assert.ok(output.includes("[test] hello\u001b[0m"));
  assert.match(output, /answer:.*42/s);
});
