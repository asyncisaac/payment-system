import { logger } from "../infra/logger.js";
import { paymentWorker } from "./paymentWorker.js";
import { refundWorker } from "./refundWorker.js";

logger.info({ queues: [paymentWorker.name, refundWorker.name] }, "workers_started");

async function shutdown(signal: string) {
  logger.info({ signal }, "workers_shutting_down");
  await Promise.all([paymentWorker.close(), refundWorker.close()]);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

