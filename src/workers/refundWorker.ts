import { Prisma, JobEffectStatus, LedgerEntryType, PaymentStatus } from "@prisma/client";
import { Worker, type Job } from "bullmq";
import { prisma } from "../infra/prisma.js";
import { redis } from "../infra/redis.js";
import { paymentsDlqQueue } from "../infra/queues.js";
import { logger } from "../infra/logger.js";

export type RefundJobData = { paymentId: string };

function isKnownPrismaError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError;
}

async function ensureJobEffect(jobId: string, paymentId: string | null, status: JobEffectStatus) {
  try {
    await prisma.jobEffect.create({ data: { jobId, paymentId, status } });
  } catch (err) {
    if (isKnownPrismaError(err) && err.code === "P2002") return;
    throw err;
  }
}

export async function processRefundJob(job: Job<RefundJobData>) {
  const paymentId = job.data.paymentId;
  const jobId = job.id ?? "unknown";
  const attempt = job.attemptsMade + 1;

  logger.info({ paymentId, jobId, attempt, status: "processing" }, "[worker] refund_processing");

  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) {
    await ensureJobEffect(jobId, paymentId, JobEffectStatus.skipped);
    return;
  }

  if (payment.status === PaymentStatus.REFUNDED) {
    await ensureJobEffect(jobId, paymentId, JobEffectStatus.skipped);
    return;
  }

  const existingJobEffect = await prisma.jobEffect.findUnique({ where: { jobId } });
  if (existingJobEffect) return;

  if (payment.status !== PaymentStatus.SUCCESS) {
    await ensureJobEffect(jobId, paymentId, JobEffectStatus.skipped);
    return;
  }

  try {
    await prisma.$transaction(async (tx) => {
      try {
        await tx.ledgerEntry.create({
          data: {
            paymentId,
            userId: payment.userId,
            type: LedgerEntryType.CREDIT,
            amount: payment.amount
          }
        });
      } catch (err) {
        if (!(isKnownPrismaError(err) && err.code === "P2002")) throw err;
      }

      await tx.payment.update({ where: { id: paymentId }, data: { status: PaymentStatus.REFUNDED } });
      await tx.event.create({
        data: {
          aggregateId: paymentId,
          paymentId,
          type: "PaymentRefunded",
          payload: { jobId, attempt }
        }
      });
    });

    await ensureJobEffect(jobId, paymentId, JobEffectStatus.executed);
    logger.info({ paymentId, jobId, attempt, status: "refunded" }, "[worker] refund_processed");
  } catch (err) {
    logger.warn({ paymentId, jobId, attempt, status: "failed" }, "[worker] refund_failed");
    throw err;
  }
}

export const refundWorker = new Worker<RefundJobData>("refund-processing", processRefundJob, {
  connection: redis,
  concurrency: 5
});

refundWorker.on("failed", async (job, err) => {
  if (!job) return;
  const maxAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < maxAttempts) return;

  await paymentsDlqQueue.add(
    "refund_failed",
    {
      originalQueue: job.queueName,
      jobId: job.id,
      paymentId: job.data.paymentId,
      attemptsMade: job.attemptsMade,
      failedReason: err?.message,
      stacktrace: job.stacktrace
    },
    { jobId: `dlq_${job.queueName}_${job.id}` }
  );
});

