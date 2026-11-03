import type { Snowflake } from "discord.js";
import type z from "zod";
import type { Command } from "./commands/_command.ts";
import help from "./commands/help.ts";
import webSearch from "./commands/web-search.ts";

export interface InvocationLimit {
  /** Maximum allowed invocations per user during the time window. */
  count: number;
  /** Length of the rate-limit window in milliseconds. */
  windowMs: number;
  /** Reply sent when a user exceeds the invocation limit. */
  message: string;
}

export interface Personality {
  name: string;
  userWhitelist: Snowflake[] | null;
  guildWhitelist: Snowflake[] | null;
  commands: Command<z.ZodType>[];
  invocationLimit: InvocationLimit;
}

const GUILD_ENDER_CHEST: Snowflake = "723189769412018228";
const USER_PANTHEON: Snowflake = "717061233500618772";

const TingleDevPersonality: Personality = {
  name: "TingleDev",
  userWhitelist: [USER_PANTHEON],
  guildWhitelist: [GUILD_ENDER_CHEST],
  commands: [help, webSearch],
  invocationLimit: {
    count: 5,
    windowMs: 60_000,
    message: "Please wait a little before asking me again!",
  },
};

const TingleGenericPersonality: Personality = {
  name: "Tingle",
  userWhitelist: null,
  guildWhitelist: null,
  commands: [help, webSearch],
  invocationLimit: {
    count: 5,
    windowMs: 60_000,
    message: "Please wait a little before asking me again!",
  },
};

export const Personalities = [TingleDevPersonality, TingleGenericPersonality];
