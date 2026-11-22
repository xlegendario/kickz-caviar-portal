// lib/perfWatch.js
//
// Measurement, not a fix. Since the deploy of 19-11-2026 the instance sits
// at 100% of its 0.5 CPU for most of every quarter hour, and in those
// minutes even /api/health takes 10 to 180 seconds. The code alone does not
// say which job does it, so this logs it:
//
//   [perf] job <name> took 48.2s          - a scheduled job over 10s
//   [perf] slow request GET /path 7.1s    - a request over 5s
//   [perf] blocked 3.4s | running: a, b   - the event loop stalled; which
//                                           jobs were in flight at the time
//
// Off with PERF_WATCH=off. Meant to come out again once the culprit is found.

import { monitorEventLoopDelay } from "node:perf_hooks";

const ENABLED = String(process.env.PERF_WATCH || "on").toLowerCase() !== "off";

const JOB_LOG_MS = 10_000;
const REQUEST_LOG_MS = 5_000;
const BLOCK_LOG_MS = 1_000;
const SAMPLE_MS = 10_000;

const running = new Map();
let nextRunId = 1;

function mb(bytes) {
  return Math.round(bytes / 1024 / 1024);
}

function inFlight(now = Date.now()) {
  return [...running.values()]
    .map((run) => `${run.name} (${Math.round((now - run.startedAt) / 1000)}s)`)
    .join(", ") || "none";
}

/* Wrap a scheduled job so its duration is logged and it shows as running. */
export function trackJob(name, fn) {
  if (!ENABLED || typeof fn !== "function") return fn;

  return async function trackedJob(...args) {
    const id = nextRunId++;
    const startedAt = Date.now();

    running.set(id, { name, startedAt });

    try {
      return await fn.apply(this, args);
    } finally {
      running.delete(id);

      const took = Date.now() - startedAt;

      if (took >= JOB_LOG_MS) {
        console.log(`[perf] job ${name} took ${(took / 1000).toFixed(1)}s`);
      }
    }
  };
}

/* Express middleware: requests that take long, and what ran meanwhile. */
export function slowRequestLogger(req, res, next) {
  if (!ENABLED) return next();

  const startedAt = Date.now();

  res.on("finish", () => {
    const took = Date.now() - startedAt;

    if (took >= REQUEST_LOG_MS) {
      console.log(
        `[perf] slow request ${req.method} ${String(req.originalUrl || req.url).split("?")[0]} ` +
          `${(took / 1000).toFixed(1)}s | running: ${inFlight()}`
      );
    }
  });

  next();
}

/* Sample the event loop; report stalls with memory and the jobs in flight. */
export function startPerfWatch() {
  if (!ENABLED) return;

  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  const timer = setInterval(() => {
    const maxMs = histogram.max / 1e6;

    if (maxMs >= BLOCK_LOG_MS) {
      const mem = process.memoryUsage();

      console.log(
        `[perf] blocked ${(maxMs / 1000).toFixed(1)}s | running: ${inFlight()} | ` +
          `rss ${mb(mem.rss)}MB heap ${mb(mem.heapUsed)}/${mb(mem.heapTotal)}MB`
      );
    }

    histogram.reset();
  }, SAMPLE_MS);

  timer.unref();

  console.log("[perf] watch on - PERF_WATCH=off to stop it");
}
