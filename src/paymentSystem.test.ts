import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import { Worker } from "bullmq";

type Started = Awaited<ReturnType<GenericContainer["start"]>>;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await sleep(100);
  }
  throw new Error("timeout");
}

let postgres: Started;
let redisContainer: Started;

let prisma: typeof import("./infra/prisma.js").prisma;
let redis: typeof import("./infra/redis.js").redis;
let paymentProcessingQueue: typeof import("./infra/queues.js").paymentProcessingQueue;
let refundProcessingQueue: typeof import("./infra/queues.js").refundProcessingQueue;
let paymentsDlqQueue: typeof import("./infra/queues.js").paymentsDlqQueue;
let paymentWorker: typeof import("./workers/paymentWorker.js").paymentWorker;
let refundWorker: typeof import("./workers/refundWorker.js").refundWorker;
let processPaymentJob: typeof import("./workers/paymentWorker.js").processPaymentJob;

let app: ReturnType<(typeof import("./app.js"))["createApp"]>;

beforeAll(async () => {
  postgres = await new GenericContainer("postgres:16")
    .withEnvironment({
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_USER: "postgres",
      POSTGRES_DB: "payment_system"
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections"))
    .start();

  redisContainer = await new GenericContainer("redis:7")
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
    .start();

  process.env.DATABASE_URL = `postgresql://postgres:postgres@${postgres.getHost()}:${postgres.getMappedPort(
    5432
  )}/payment_system?schema=public`;
  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
  process.env.LOG_LEVEL = "silent";
  process.env.GATEWAY_TIMEOUT_RATE = "0";
  process.env.GATEWAY_FAIL_FIRST_N = "0";
  process.env.GATEWAY_TIMEOUT_MS = "50";
  process.env.GATEWAY_LATENCY_MS_MIN = "1";
  process.env.GATEWAY_LATENCY_MS_MAX = "3";

  execSync("npx prisma migrate deploy", { stdio: "inherit", env: process.env });

  ({ prisma } = await import("./infra/prisma.js"));
  ({ redis } = await import("./infra/redis.js"));
  ({ paymentProcessingQueue, refundProcessingQueue, paymentsDlqQueue } = await import("./infra/queues.js"));
  ({ paymentWorker, processPaymentJob } = await import("./workers/paymentWorker.js"));
  ({ refundWorker } = await import("./workers/refundWorker.js"));
  const { createApp } = await import("./app.js");
  app = createApp();
});

afterAll(async () => {
  await Promise.all([paymentWorker.close(), refundWorker.close()]);
  await Promise.all([
    paymentProcessingQueue.close(),
    refundProcessingQueue.close(),
    paymentsDlqQueue.close()
  ]);
  await Promise.all([redis.quit(), prisma.$disconnect()]);
  await Promise.all([redisContainer.stop(), postgres.stop()]);
});

describe("Payment System", () => {
  it("pagamento sucesso", async () => {
    process.env.GATEWAY_TIMEOUT_RATE = "0";
    process.env.GATEWAY_FAIL_FIRST_N = "0";

    const userId = randomUUID();
    const idempotencyKey = `k_${randomUUID()}`;

    const createRes = await request(app).post("/payments").send({ userId, amount: 100, idempotencyKey });
    expect(createRes.status).toBe(201);
    expect(createRes.body.idempotencyKey).toBe(idempotencyKey);

    const paymentId = createRes.body.id as string;

    const payment = await waitFor(
      async () => {
        const p = await prisma.payment.findUnique({ where: { id: paymentId } });
        return p?.status === "SUCCESS" ? p : null;
      },
      10_000
    );
    expect(payment.status).toBe("SUCCESS");

    const ledger = await prisma.ledgerEntry.findMany({ where: { paymentId } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.type).toBe("DEBIT");
  });

  it("idempotência: mesmo key não duplica", async () => {
    process.env.GATEWAY_TIMEOUT_RATE = "0";
    process.env.GATEWAY_FAIL_FIRST_N = "0";

    const userId = randomUUID();
    const idempotencyKey = `k_${randomUUID()}`;

    const r1 = await request(app).post("/payments").send({ userId, amount: 200, idempotencyKey });
    const r2 = await request(app).post("/payments").send({ userId, amount: 200, idempotencyKey });

    expect([200, 201]).toContain(r1.status);
    expect([200, 201]).toContain(r2.status);
    expect(r1.body.id).toBe(r2.body.id);

    const payments = await prisma.payment.findMany({ where: { idempotencyKey } });
    expect(payments).toHaveLength(1);
  });

  it("retry até sucesso", async () => {
    process.env.GATEWAY_TIMEOUT_RATE = "0";
    process.env.GATEWAY_FAIL_FIRST_N = "2";

    const userId = randomUUID();
    const idempotencyKey = `k_${randomUUID()}`;

    const createRes = await request(app).post("/payments").send({ userId, amount: 300, idempotencyKey });
    expect([200, 201]).toContain(createRes.status);

    const paymentId = createRes.body.id as string;

    const payment = await waitFor(
      async () => {
        const p = await prisma.payment.findUnique({ where: { id: paymentId } });
        return p?.status === "SUCCESS" ? p : null;
      },
      10_000
    );
    expect(payment.status).toBe("SUCCESS");

    const processedEvent = await prisma.event.findFirst({
      where: { paymentId, type: "PaymentProcessed" },
      orderBy: { createdAt: "desc" }
    });
    expect(processedEvent?.payload).toMatchObject({ attempt: 3 });
  });

  it("falha -> DLQ", async () => {
    process.env.GATEWAY_TIMEOUT_RATE = "0";
    process.env.GATEWAY_FAIL_FIRST_N = "10";

    const userId = randomUUID();
    const idempotencyKey = `k_${randomUUID()}`;

    const createRes = await request(app).post("/payments").send({ userId, amount: 400, idempotencyKey });
    expect([200, 201]).toContain(createRes.status);
    const paymentId = createRes.body.id as string;

    const failed = await waitFor(
      async () => {
        const p = await prisma.payment.findUnique({ where: { id: paymentId } });
        return p?.status === "FAILED" ? p : null;
      },
      20_000
    );
    expect(failed.status).toBe("FAILED");

    const dlqJob = await waitFor(
      async () => paymentsDlqQueue.getJob(`dlq_payment-processing_payment_${paymentId}`),
      20_000
    );
    expect(dlqJob?.data.paymentId).toBe(paymentId);

    const ledger = await prisma.ledgerEntry.findMany({ where: { paymentId } });
    expect(ledger).toHaveLength(0);
  });

  it("concorrência: 2 workers não duplicam ledger", async () => {
    process.env.GATEWAY_TIMEOUT_RATE = "0";
    process.env.GATEWAY_FAIL_FIRST_N = "0";

    const userId = randomUUID();
    const idempotencyKey = `k_${randomUUID()}`;

    const createRes = await request(app).post("/payments").send({ userId, amount: 500, idempotencyKey });
    expect([200, 201]).toContain(createRes.status);
    const paymentId = createRes.body.id as string;

    const extraWorker = new Worker("payment-processing", processPaymentJob, {
      connection: redis,
      concurrency: 5
    });

    await paymentProcessingQueue.add(
      "duplicate_process",
      { paymentId },
      { jobId: `duplicate_${paymentId}` }
    );

    await waitFor(
      async () => {
        const p = await prisma.payment.findUnique({ where: { id: paymentId } });
        return p?.status === "SUCCESS" ? p : null;
      },
      10_000
    );

    const ledger = await prisma.ledgerEntry.findMany({ where: { paymentId } });
    expect(ledger.filter((l) => l.type === "DEBIT")).toHaveLength(1);

    await extraWorker.close();
  });

  it("refund: cria CREDIT e marca REFUNDED", async () => {
    process.env.GATEWAY_TIMEOUT_RATE = "0";
    process.env.GATEWAY_FAIL_FIRST_N = "0";

    const userId = randomUUID();
    const idempotencyKey = `k_${randomUUID()}`;

    const createRes = await request(app).post("/payments").send({ userId, amount: 600, idempotencyKey });
    const paymentId = createRes.body.id as string;

    await waitFor(
      async () => {
        const p = await prisma.payment.findUnique({ where: { id: paymentId } });
        return p?.status === "SUCCESS" ? p : null;
      },
      10_000
    );

    const refundRes = await request(app).post(`/payments/${paymentId}/refund`).send({});
    expect([200, 202]).toContain(refundRes.status);

    await waitFor(
      async () => {
        const p = await prisma.payment.findUnique({ where: { id: paymentId } });
        return p?.status === "REFUNDED" ? p : null;
      },
      10_000
    );

    const ledger = await prisma.ledgerEntry.findMany({ where: { paymentId } });
    expect(ledger.filter((l) => l.type === "DEBIT")).toHaveLength(1);
    expect(ledger.filter((l) => l.type === "CREDIT")).toHaveLength(1);
  });
});

