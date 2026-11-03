import { EmbedBuilder } from "discord.js";
import * as z from "zod";
import { command } from "./_command.ts";

export default command({
  name: "help",
  aliases: ["ajuda", "h", "?"],
  description: "Lista todos os comandos disponíveis",
  argsSchema: z.object({}),
  parsePositionalArgs: () => ({}),
  execute: async (awsta, _args, message, personality) => {
    const embed = new EmbedBuilder();

    for (const command of personality.commands) {
      let aliases = command.aliases.map((a) => `\`${a}\``).join(", ");
      if (aliases) aliases = ` (${aliases})`;

      embed.addFields({
        name: `\`${command.name}\`${aliases}`,
        value: command.description,
      });
    }

    embed.setImage(awsta.client.user?.avatarURL({ size: 64 }) ?? null);

    message.reply({ embeds: [embed] });
  },
});
