import { Queue } from "bullmq";
import { redis } from "./redis.js";

export const paymentProcessingQueue = new Queue("payment-processing", {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 200 },
    removeOnComplete: true,
    removeOnFail: false
  }
});

export const refundProcessingQueue = new Queue("refund-processing", {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 200 },
    removeOnComplete: true,
    removeOnFail: false
  }
});

export const paymentsDlqQueue = new Queue("payments_dlq", {
  connection: redis,
  defaultJobOptions: { removeOnComplete: true, removeOnFail: false }
});

