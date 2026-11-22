import test from "node:test";
import assert from "node:assert/strict";

import { createStockRefreshQueue, mapWithLimit } from "../lib/sellerApi.js";

test("the queue refreshes each waiting pair once, after the caller moved on", async () => {
  const done = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));

  const queue = createStockRefreshQueue(async (sku, size) => {
    await gate;
    done.push(`${sku}|${size}`);
  });

  queue.add("A", "42");
  queue.add("B", "43");
  queue.add("B", "43");

  assert.deepEqual(done, [], "nothing waited on");

  release();
  await queue.idle();

  assert.deepEqual(done, ["A|42", "B|43"]);
});

test("a pair asked for during its own refresh goes round again", async () => {
  const done = [];
  let queue;

  queue = createStockRefreshQueue(async (sku, size) => {
    done.push(`${sku}|${size}`);
    if (done.length === 1) queue.add("A", "42");
  });

  queue.add("A", "42");
  await queue.idle();

  assert.deepEqual(done, ["A|42", "A|42"]);
});

test("one failing refresh does not stop the rest", async () => {
  const done = [];
  const queue = createStockRefreshQueue(
    async (sku) => {
      if (sku === "A") throw new Error("Airtable down");
      done.push(sku);
    },
    { error() {} }
  );

  queue.add("A", "42");
  queue.add("B", "42");
  await queue.idle();

  assert.deepEqual(done, ["B"]);
});

test("mapWithLimit keeps order and never runs more than the limit", async () => {
  let inFlight = 0;
  let peak = 0;

  const out = await mapWithLimit([5, 1, 4, 2, 3], 2, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, n));
    inFlight--;
    return n * 10;
  });

  assert.deepEqual(out, [50, 10, 40, 20, 30]);
  assert.equal(peak, 2);
});
