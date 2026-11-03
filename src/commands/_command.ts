import type { Message } from "discord.js";
import type * as z from "zod";
import type Awsta from "../awsta.ts";
import ApplicationError, { type ErrorContext } from "../lib/application-error.ts";
import type { Personality } from "../personality.ts";

export interface Command<A extends z.ZodType> {
  name: string;
  aliases: string[];
  description: string;
  argsSchema: A;
  parsePositionalArgs: (positionalArgs: string[]) => z.output<A>;
  execute: (
    awsta: Awsta,
    args: z.output<A>,
    message: Message,
    personality: Personality,
  ) => Promise<void>;
}

export function command<A extends z.ZodType>(builder: {
  name: string;
  aliases: string[];
  description: string;
  argsSchema: A;
  parsePositionalArgs: (positionalArgs: string[]) => z.output<A>;
  execute: (
    awsta: Awsta,
    args: z.output<A>,
    message: Message,
    personality: Personality,
  ) => Promise<void>;
}) {
  return builder as Command<A>;
}

export class CommandExecutionError extends ApplicationError {
  public constructor(commandName: string, context: ErrorContext = {}, options?: ErrorOptions) {
    super(`Command "${commandName}" failed`, context, options);
  }
}
