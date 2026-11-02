import OpenAI from "openai";
import Awsta from "./awsta.ts";
import { loadConfig } from "./config.ts";
import createLogger from "./lib/logger.ts";
import * as openaiAuth from "./lib/openai-auth.ts";

const logger = createLogger("Index");
const config = loadConfig(process.env);

openaiAuth.setCredentialsPath(config.openaiCredentialsFile);
await openaiAuth.initializeAuthInteractive();

const openai = new OpenAI({
  apiKey: openaiAuth.getTokenAutoRefresh,
  maxRetries: 0,
});

Awsta.create(config, openai).catch((error) => {
  logger.error("Creation failed:", error);
});
