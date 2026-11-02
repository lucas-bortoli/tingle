import { Client, type Message } from "discord.js";
import type { Config } from "./config.ts";
import Deferred from "./lib/deferred.ts";
import createLogger from "./lib/logger.ts";

const logger = createLogger("Awsta");

export default class Awsta {
  public config!: Config;
  public client!: Client;

  private async handlePostCreation() {}

  private async handleUserMessageCreate(message: Message) {
    if (!message.content.startsWith(this.config.prefix)) return;

    const args = message.content.split(" ").filter((s) => s.trim().length);
    const command = args.shift()!.slice(this.config.prefix.length).toLowerCase();

    logger.info("User Message", {
      author: message.author.displayName,
      content: message.content,
      command,
      args,
    });

    if (command === "help") {
      message.reply("Hello World!");
    }
  }

  private async handleUserMessageDelete(_deletedMessage: { id: string }) {}

  private constructor() {
    // created in create() method
  }

  public static async create(config: Config) {
    const deferred = new Deferred<Awsta, Error>();
    const instance = new Awsta();
    const client = new Client({
      intents: ["Guilds", "GuildMessages", "MessageContent"],
    });

    client.once("clientReady", () => {
      logger.info("Client logged in successfully", { userName: client.user?.displayName });
      deferred.resolve(instance);
      instance.handlePostCreation();
    });

    client.once("error", (e) => {
      const error = e instanceof Error ? e : new Error(String(e));
      logger.error("Failed to create client:", error);
      deferred.reject(error);
    });

    client.on("messageCreate", instance.handleUserMessageCreate.bind(instance));
    client.on("messageDelete", instance.handleUserMessageDelete.bind(instance));

    instance.config = config;
    instance.client = client;

    client.login(config.discordToken).catch((cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      logger.error("Discord login failed", error);
      deferred.reject(error);
    });

    return deferred.promise;
  }
}
