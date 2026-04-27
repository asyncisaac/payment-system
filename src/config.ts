import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgresql://postgres:postgres@localhost:5432/payment_system?schema=public"),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default("info"),
  GATEWAY_TIMEOUT_RATE: z.coerce.number().min(0).max(1).default(0.15),
  GATEWAY_LATENCY_MS_MIN: z.coerce.number().int().nonnegative().default(100),
  GATEWAY_LATENCY_MS_MAX: z.coerce.number().int().nonnegative().default(800),
  GATEWAY_TIMEOUT_MS: z.coerce.number().int().positive().default(600)
});

export const env = envSchema.parse(process.env);
