import IORedis from "ioredis";
import { getEnv } from "../config.js";

const env = getEnv();

export function createRedisConnection() {
  return new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

export const redis = createRedisConnection();

