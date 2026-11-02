import { tmpdir } from "node:os";
import { join } from "node:path";
import ApplicationError from "./lib/application-error.ts";

export class MissingConfigurationError extends ApplicationError {
  public constructor(variable: string) {
    super(`Missing required environment variable: ${variable}`, { variable });
  }
}

export interface Config {
  discordToken: string;
  prefix: string;
  adminIds: string[];
  openaiCredentialsFile: string;
  openaiModel: string;
}

function split(predicate?: string) {
  return (predicate ?? "")
    .split(",")
    .map((userId) => userId.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv) {
  const discordToken = env.DISCORD_TOKEN;
  if (!discordToken) {
    throw new MissingConfigurationError("DISCORD_TOKEN");
  }

  const openaiModel = env.OPENAI_MODEL;
  if (!openaiModel) {
    throw new MissingConfigurationError("OPENAI_MODEL");
  }

  const prefix = env.PREFIX ?? ".";
  const adminIds = split(env.BOT_ADMINS);

  const openaiCredentialsFile =
    env.AWSTA_OPENAI_CREDS_FILE ?? join(tmpdir(), "awsta", "chatgpt.json");

  return {
    discordToken,
    prefix,
    adminIds,
    openaiCredentialsFile,
    openaiModel,
  } satisfies Config;
}
