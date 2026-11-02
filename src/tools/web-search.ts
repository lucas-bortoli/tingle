import * as z from "zod";
import { L } from "../i18n.ts";
import { tool } from "./_tool.ts";

export default tool({
  name: "search",
  aliases: ["google", "g"],
  description: L((l) => l.tools.search.description),
  argsSchema: z.object({
    query: z.string(),
  }),
  parsePositionalArgs: (positionalArgs) => {
    return Promise.resolve({
      query: positionalArgs[0],
    });
  },
  execute: async (_args) => {},
});
