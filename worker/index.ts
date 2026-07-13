import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import cron from "node-cron";
import { pollAllUsers } from "./poll";
import { computeAllTastegraphs } from "../lib/tastegraph/compute";

/**
 * Worker entrypoint (run via `npm run worker`, i.e. `tsx worker/index.ts`).
 * Schedules:
 *  - every POLL_INTERVAL_MINUTES minutes: pollAllUsers()
 *  - daily at 04:10 server time: computeAllTastegraphs()
 */

loadEnv();

const POLL_INTERVAL_MINUTES = Math.max(
  1,
  Number.parseInt(process.env.POLL_INTERVAL_MINUTES ?? "30", 10) || 30
);
const POLL_CRON_EXPRESSION = `*/${POLL_INTERVAL_MINUTES} * * * *`;
const COMPUTE_CRON_EXPRESSION = "10 4 * * *";

let shuttingDown = false;

async function runPoll(): Promise<void> {
  if (shuttingDown) return;
  try {
    await pollAllUsers();
  } catch (err) {
    console.error("[worker] pollAllUsers failed:", err);
  }
}

async function runCompute(): Promise<void> {
  if (shuttingDown) return;
  try {
    await computeAllTastegraphs();
  } catch (err) {
    console.error("[worker] computeAllTastegraphs failed:", err);
  }
}

function main(): void {
  const pollTask = cron.schedule(POLL_CRON_EXPRESSION, runPoll);
  const computeTask = cron.schedule(COMPUTE_CRON_EXPRESSION, runCompute);

  console.log("[worker] deepcut worker started");
  console.log(
    `[worker] schedule: poll every ${POLL_INTERVAL_MINUTES}min (cron "${POLL_CRON_EXPRESSION}"), ` +
      `tastegraph compute daily at 04:10 (cron "${COMPUTE_CRON_EXPRESSION}")`
  );

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] received ${signal}, shutting down gracefully...`);
    pollTask.stop();
    computeTask.stop();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

/**
 * Minimal .env loader (no external deps) so `tsx worker/index.ts` picks up the
 * same variables as `next dev` does automatically. Existing process.env values
 * take precedence over the file.
 */
function loadEnv(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;

  const contents = readFileSync(envPath, "utf8");
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

main();
