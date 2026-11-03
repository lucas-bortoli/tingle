import * as z from "zod";
import search from "../lib/searx-scraper.ts";
import { command } from "./_command.ts";

/** Formats one result with its current one-based position and total count. */
const formatLink = (results: string[], index: number) =>
  `${index + 1}/${results.length} ${results[index]}`;

/** Searches the web and lets the requesting user page through the result URLs. */
export default command({
  name: "search",
  aliases: ["google", "g"],
  description: "Pesquisa na internet",
  argsSchema: z.object({
    query: z.string(),
  }),
  parsePositionalArgs: (positionalArgs) => {
    return {
      query: positionalArgs.join(" "),
    };
  },
  execute: async (_awsta, args, message) => {
    // Fetch a generous result set so reaction-based pagination has room to move.
    const results = await search({ query: args.query, language: "pt-BR", max: 99 });

    if (results.length === 0) {
      message.reply("Nenhum resultado encontrado!");
      return;
    }

    let index = 0;

    const ourReply = await message.reply(formatLink(results, index));

    try {
      // Add navigation controls, then wait for this user to choose a direction.
      await ourReply.react("⬅️");
      await ourReply.react("➡️");

      while (true) {
        const reactions = await ourReply.awaitReactions({
          filter: (reaction, user) =>
            user.id === message.author.id &&
            (reaction.emoji.name === "⬅️" || reaction.emoji.name === "➡️"),
          dispose: true,
          max: 1,
          maxEmojis: 1,
          time: 30_000,
        });

        const reaction = reactions.first();
        if (!reaction) {
          // No valid reaction arrived before the collector timed out.
          break;
        }

        // Keep the index within the valid array range.
        if (reaction.emoji.name === "⬅️" && index > 0) {
          index--;
        } else if (reaction.emoji.name === "➡️" && index < results.length - 1) {
          index++;
        }

        await ourReply.edit(formatLink(results, index));
        await reaction.users.remove(message.author.id);
      }
    } finally {
      // Remove navigation reactions even if an edit or collector operation fails.
      await ourReply.reactions.removeAll();
    }
  },
});
