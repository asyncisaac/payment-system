import { Prisma, JobEffectStatus, LedgerEntryType, PaymentStatus } from "@prisma/client";
import { Worker, type Job } from "bullmq";
import { fakeCharge } from "../gateway/fakeGateway.js";
import { prisma } from "../infra/prisma.js";
import { redis } from "../infra/redis.js";
import { paymentsDlqQueue } from "../infra/queues.js";
import { logger } from "../infra/logger.js";

export type PaymentJobData = { paymentId: string };

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

export async function processPaymentJob(job: Job<PaymentJobData>) {
  const paymentId = job.data.paymentId;
  const jobId = job.id ?? "unknown";
  const attempt = job.attemptsMade + 1;

  logger.info({ paymentId, jobId, attempt, status: "processing" }, "[worker] payment_processing");

  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) {
    await ensureJobEffect(jobId, paymentId, JobEffectStatus.skipped);
    return;
  }

  if (payment.status === PaymentStatus.SUCCESS || payment.status === PaymentStatus.REFUNDED) {
    await ensureJobEffect(jobId, paymentId, JobEffectStatus.skipped);
    return;
  }

  const existingJobEffect = await prisma.jobEffect.findUnique({ where: { jobId } });
  if (existingJobEffect) return;

  await prisma.payment.update({ where: { id: paymentId }, data: { status: PaymentStatus.PROCESSING } });

  try {
    const charge = await fakeCharge({ attempt });

    await prisma.$transaction(async (tx) => {
      try {
        await tx.ledgerEntry.create({
          data: {
            paymentId,
            userId: payment.userId,
            type: LedgerEntryType.DEBIT,
            amount: payment.amount
          }
        });
      } catch (err) {
        if (!(isKnownPrismaError(err) && err.code === "P2002")) throw err;
      }

      await tx.payment.update({ where: { id: paymentId }, data: { status: PaymentStatus.SUCCESS } });
      await tx.event.create({
        data: {
          aggregateId: paymentId,
          paymentId,
          type: "PaymentProcessed",
          payload: { jobId, attempt, authorizationId: charge.authorizationId }
        }
      });
    });

    await ensureJobEffect(jobId, paymentId, JobEffectStatus.executed);

    logger.info({ paymentId, jobId, attempt, status: "success" }, "[worker] payment_processed");
  } catch (err) {
    const maxAttempts = job.opts.attempts ?? 1;
    const isLastAttempt = attempt >= maxAttempts;

    if (isLastAttempt) {
      await prisma.$transaction(async (tx) => {
        await tx.payment.update({ where: { id: paymentId }, data: { status: PaymentStatus.FAILED } });
        await tx.event.create({
          data: {
            aggregateId: paymentId,
            paymentId,
            type: "PaymentFailed",
            payload: { jobId, attempt, error: err instanceof Error ? err.message : "unknown_error" }
          }
        });
      });
    }

    logger.warn({ paymentId, jobId, attempt, status: "failed" }, "[worker] payment_failed");
    throw err;
  }
}

export const paymentWorker = new Worker<PaymentJobData>("payment-processing", processPaymentJob, {
  connection: redis,
  concurrency: 5
});

paymentWorker.on("failed", async (job, err) => {
  if (!job) return;
  const maxAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < maxAttempts) return;

  await paymentsDlqQueue.add(
    "payment_failed",
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

