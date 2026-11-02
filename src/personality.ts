import type { Snowflake } from "discord.js";
import type z from "zod";
import type { Tool } from "./tools/_tool.ts";
import webSearch from "./tools/web-search.ts";

export interface Personality {
  name: string;
  userWhitelist: Snowflake[] | null;
  guildWhitelist: Snowflake[] | null;
  tools: Tool<z.ZodType>[];
}

const GUILD_ENDER_CHEST: Snowflake = "723189769412018228";
const USER_PANTHEON: Snowflake = "717061233500618772";

const NavaliaDevPersonality: Personality = {
  name: "NavaliaDev",
  userWhitelist: [USER_PANTHEON],
  guildWhitelist: [GUILD_ENDER_CHEST],
  tools: [webSearch],
};

const NavaliaGenericPersonality: Personality = {
  name: "Navalia",
  userWhitelist: null,
  guildWhitelist: null,
  tools: [webSearch],
};

export const Personalities = [NavaliaDevPersonality, NavaliaGenericPersonality];
