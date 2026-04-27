import { randomUUID } from "node:crypto";
import { getEnv } from "../config.js";

export class GatewayTimeoutError extends Error {
  constructor(message = "gateway_timeout") {
    super(message);
    this.name = "GatewayTimeoutError";
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function fakeCharge(input?: { attempt?: number }) {
  const env = getEnv();
  const attempt = input?.attempt;
  if (attempt && env.GATEWAY_FAIL_FIRST_N > 0 && attempt <= env.GATEWAY_FAIL_FIRST_N) {
    await sleep(env.GATEWAY_TIMEOUT_MS);
    throw new GatewayTimeoutError();
  }

  const shouldTimeout = Math.random() < env.GATEWAY_TIMEOUT_RATE;

  if (shouldTimeout) {
    await sleep(env.GATEWAY_TIMEOUT_MS);
    throw new GatewayTimeoutError();
  }

  const latency =
    env.GATEWAY_LATENCY_MS_MIN +
    Math.floor(Math.random() * Math.max(1, env.GATEWAY_LATENCY_MS_MAX - env.GATEWAY_LATENCY_MS_MIN));

  await sleep(latency);
  return { authorizationId: randomUUID() };
}

