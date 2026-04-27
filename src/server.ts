import { createServer } from "node:http";
import { getEnv } from "./config.js";
import { createApp } from "./app.js";
import { logger } from "./infra/logger.js";

const env = getEnv();

const app = createApp();
const server = createServer(app);

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "api_listening");
});
