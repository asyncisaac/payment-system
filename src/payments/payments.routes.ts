import { Prisma, PaymentStatus } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../infra/prisma.js";
import { logger } from "../infra/logger.js";
import { paymentProcessingQueue, refundProcessingQueue } from "../infra/queues.js";

const createPaymentSchema = z.object({
  userId: z.string().uuid(),
  amount: z.number().int().positive(),
  idempotencyKey: z.string().min(1).max(200)
});

function isKnownPrismaError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError;
}

export const paymentsRouter = Router();

paymentsRouter.post("/", async (req, res, next) => {
  try {
    const body = createPaymentSchema.parse(req.body);
    const requestId = req.requestId ?? "unknown";

    let payment = await prisma.payment.findUnique({ where: { idempotencyKey: body.idempotencyKey } });
    let created = false;

    if (!payment) {
      try {
        payment = await prisma.$transaction(async (tx) => {
          const createdPayment = await tx.payment.create({
            data: {
              userId: body.userId,
              amount: body.amount,
              status: PaymentStatus.PENDING,
              idempotencyKey: body.idempotencyKey
            }
          });

          await tx.event.create({
            data: {
              aggregateId: createdPayment.id,
              paymentId: createdPayment.id,
              type: "PaymentCreated",
              payload: { requestId, userId: body.userId, amount: body.amount }
            }
          });

          return createdPayment;
        });

        created = true;
      } catch (err) {
        if (!(isKnownPrismaError(err) && err.code === "P2002")) throw err;
        payment = await prisma.payment.findUnique({ where: { idempotencyKey: body.idempotencyKey } });
      }
    }

    if (!payment) {
      res.status(500).json({ error: "payment_create_failed" });
      return;
    }

    await paymentProcessingQueue.add(
      "process_payment",
      { paymentId: payment.id },
      { jobId: `payment_${payment.id}` }
    );

    logger.info(
      { requestId, paymentId: payment.id, jobId: `payment_${payment.id}` },
      "[api] payment_enqueued"
    );

    res.status(created ? 201 : 200).json(payment);
  } catch (err) {
    next(err);
  }
});

paymentsRouter.get("/:id", async (req, res, next) => {
  try {
    const paymentId = z.string().uuid().parse(req.params.id);

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { ledgerEntries: { orderBy: { createdAt: "asc" } } }
    });

    if (!payment) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    res.status(200).json(payment);
  } catch (err) {
    next(err);
  }
});

paymentsRouter.get("/", async (req, res, next) => {
  try {
    const statusParam = typeof req.query.status === "string" ? req.query.status : undefined;
    const statuses = statusParam
      ? statusParam
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map((s) => PaymentStatus[s as keyof typeof PaymentStatus])
          .filter(Boolean)
      : undefined;

    const payments = await prisma.payment.findMany({
      where: statuses && statuses.length > 0 ? { status: { in: statuses } } : undefined,
      orderBy: { createdAt: "desc" },
      take: 50
    });

    res.status(200).json(payments);
  } catch (err) {
    next(err);
  }
});

paymentsRouter.post("/:id/refund", async (req, res, next) => {
  try {
    const paymentId = z.string().uuid().parse(req.params.id);
    const requestId = req.requestId ?? "unknown";

    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    if (payment.status === PaymentStatus.REFUNDED) {
      res.status(200).json(payment);
      return;
    }

    if (payment.status !== PaymentStatus.SUCCESS) {
      res.status(409).json({ error: "payment_not_refundable", status: payment.status });
      return;
    }

    await prisma.event.create({
      data: {
        aggregateId: paymentId,
        paymentId,
        type: "RefundRequested",
        payload: { requestId }
      }
    });

    await refundProcessingQueue.add("process_refund", { paymentId }, { jobId: `refund_${paymentId}` });

    logger.info(
      { requestId, paymentId, jobId: `refund_${paymentId}` },
      "[api] refund_enqueued"
    );

    res.status(202).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

