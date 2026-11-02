import OpenAI from "openai";
import Awsta from "./awsta.ts";
import { loadConfig } from "./config.ts";
import createLogger from "./lib/logger.ts";
import { getChatgptCredentials } from "./lib/openai-auth.ts";

const logger = createLogger("Index");

const config = loadConfig(process.env);
const openaiCreds = await getChatgptCredentials();
const openai = new OpenAI({
  apiKey: openaiCreds.accessToken,
  maxRetries: 0,
});

Awsta.create(config, openai).catch((error) => {
  logger.error("Creation failed:", error);
});
