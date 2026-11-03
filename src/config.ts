import { tmpdir } from "node:os";
import { join } from "node:path";
import ApplicationError from "./lib/application-error.ts";

export class MissingConfigurationError extends ApplicationError {
  public constructor(variable: string) {
    super(`Missing required environment variable: ${variable}`, { variable });
  }
}

export class TypeConfigurationError extends ApplicationError {
  public constructor(value: string, expectedType: string) {
    super(`Invalid integer configuration value: ${value}`, { value, expectedType });
  }
}

export interface Config {
  discordToken: string;
  prefix: string;
  adminIds: string[];
  openaiCredentialsFile: string;
  openaiModel: string;
  statusServer: {
    hostname: string;
    port: number;
  };
}

function split(predicate?: string) {
  return (predicate ?? "")
    .split(",")
    .map((userId) => userId.trim())
    .filter(Boolean);
}

function integer(predicate?: string, fallback?: number) {
  const value = Number.parseInt(predicate ?? "", 10);
  if (Number.isNaN(value)) {
    if (fallback !== undefined) return fallback;
    throw new TypeConfigurationError(predicate ?? "", "integer");
  }
  return value;
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

  const statusServerHostname = env.STATUS_SERVER_HOSTNAME ?? "0.0.0.0";
  const statusServerPort = integer(env.STATUS_SERVER_PORT, 3000);

  return {
    discordToken,
    prefix,
    adminIds,
    openaiCredentialsFile,
    openaiModel,
    statusServer: {
      hostname: statusServerHostname,
      port: statusServerPort,
    },
  } satisfies Config;
}
