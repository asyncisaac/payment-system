import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.header("x-request-id");
  const requestId = header && header.trim().length > 0 ? header.trim() : randomUUID();

  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);
  next();
}
