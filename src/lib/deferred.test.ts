import assert from "node:assert/strict";
import { test } from "node:test";
import Deferred from "./deferred.ts";

test("resolve settles the promise with the supplied value", async () => {
  const deferred = new Deferred<number>();

  deferred.resolve(42);

  assert.equal(await deferred.promise, 42);
});

test("reject settles the promise with the supplied reason", async () => {
  const deferred = new Deferred<never, Error>();
  const reason = new Error("something went wrong");

  deferred.reject(reason);

  await assert.rejects(deferred.promise, (error: Error) => error === reason);
});
