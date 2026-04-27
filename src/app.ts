import express from "express";
import { requestIdMiddleware } from "./infra/requestId.js";
import { logger } from "./infra/logger.js";
import { paymentsRouter } from "./payments/payments.routes.js";

export function createApp() {
  const app = express();

  app.use(express.json({ limit: "1mb" }));
  app.use(requestIdMiddleware);

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.use("/payments", paymentsRouter);

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err }, "unhandled_error");
    res.status(500).json({ error: "internal_server_error" });
  });

  return app;
}
