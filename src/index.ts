import Awsta from "./awsta.ts";
import { loadConfig } from "./config.ts";
import createLogger from "./lib/logger.ts";

const logger = createLogger("Index");

const config = loadConfig(process.env);

Awsta.create(config).catch((error) => {
  logger.error("Creation failed:", { config, error });
});
