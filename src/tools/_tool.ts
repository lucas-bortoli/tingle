import type * as z from "zod";
import ApplicationError, { type ErrorContext } from "../lib/application-error.ts";

export interface Tool<A extends z.ZodType> {
  name: string;
  aliases: string[];
  description: string;
  argsSchema: A;
  parsePositionalArgs: (positionalArgs: string[]) => Promise<z.output<A>>;
  execute: (args: z.output<A>) => Promise<void>;
}

export function tool<A extends z.ZodType>(builder: {
  name: string;
  aliases: string[];
  description: string;
  argsSchema: A;
  parsePositionalArgs: (positionalArgs: string[]) => Promise<z.output<A>>;
  execute: (args: z.output<A>) => Promise<void>;
}) {
  return builder as Tool<A>;
}

export class ToolExecutionError extends ApplicationError {
  public constructor(toolName: string, context: ErrorContext = {}, options?: ErrorOptions) {
    super(`Tool "${toolName}" failed`, context, options);
  }
}
