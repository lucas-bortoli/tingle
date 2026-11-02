export interface Config {
  discordToken: string;
  prefix: string;
}

export function loadConfig(env: NodeJS.ProcessEnv) {
  const discordToken = env.DISCORD_TOKEN;

  if (!discordToken) {
    throw new Error("Missing required environment variable: DISCORD_TOKEN");
  }

  const prefix = env.PREFIX ?? ".";

  return {
    discordToken,
    prefix,
  } satisfies Config;
}
