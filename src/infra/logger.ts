import pino from "pino";
import { getEnv } from "../config.js";

const env = getEnv();

const transport =
  process.env.NODE_ENV === "production"
    ? undefined
    : {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard" }
      };

export const logger = pino({
  level: env.LOG_LEVEL,
  transport
});
