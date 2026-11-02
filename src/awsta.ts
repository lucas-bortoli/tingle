import { Client, type Message } from "discord.js";
import type OpenAI from "openai";
import * as z from "zod";
import type { Config } from "./config.ts";
import ApplicationError from "./lib/application-error.ts";
import Deferred from "./lib/deferred.ts";
import createLogger from "./lib/logger.ts";
import { Personalities, type Personality } from "./personality.ts";
import { ToolExecutionError, type Tool } from "./tools/_tool.ts";

const logger = createLogger("Awsta");

export default class Awsta {
  public config!: Config;
  public client!: Client;
  public openai!: OpenAI;

  private addReaction(message: Message, emoji: string): () => Promise<void> {
    const reaction = message.react(emoji).catch(() =>
      logger.warn("failed to add temporary reaction", {
        messageId: message.id,
        messageGuildId: message.guildId,
        emoji,
      }),
    );

    return async () => {
      const addedReaction = await reaction;
      if (!addedReaction) return;

      await addedReaction.users.remove(this.client.user!.id).catch(() =>
        logger.warn("failed to remove temporary reaction", {
          messageId: message.id,
          messageGuildId: message.guildId,
          emoji,
        }),
      );
    };
  }

  private async upsertReply(_message: Message) {}

  /**
   * Executes a tool with arguments already parsed from its schema.
   */
  private async invokeTool<A extends z.ZodType>(
    message: Message,
    personality: Personality,
    tool: Tool<A>,
    args: z.output<A>,
  ) {
    logger.debug("Invoking tool", { name: tool.name, args: args });
    try {
      const result = await tool.execute(args);
      return result;
    } catch (cause) {
      throw new ToolExecutionError(
        tool.name,
        { toolName: tool.name, messageId: message.id, personality: personality.name },
        { cause },
      );
    }
  }

  /**
   * Resolves and dispatches a command entered with the configured prefix.
   */
  private async handleLegacyMessageCommandDispatch(message: Message, personality: Personality) {
    logger.debug("handleLegacyMessageCommandDispatch", {
      personality: personality.name,
      content: message.content,
    });

    const argList = message.content.split(" ").filter((s) => s.trim().length);
    const toolName = argList.shift()!.slice(this.config.prefix.length).toLowerCase();
    const tool = personality.tools.find((t) => t.name === toolName || t.aliases.includes(toolName));

    if (!tool) return message.react("❓");

    const args = tool.parsePositionalArgs(argList);

    return this.invokeTool(message, personality, tool, args);
  }

  /**
   * Uses the model to route a natural-language message to a tool or reply.
   */
  private async handleNaturalLanguageCommandDispatch(message: Message, personality: Personality) {
    logger.debug("handleNaturalLanguageCommandDispatch", {
      personality: personality.name,
      content: message.content,
    });

    const commandTools = personality.tools.map((tool) => {
      return {
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.argsSchema.toJSONSchema(),
        strict: true,
      } satisfies OpenAI.Responses.Tool;
    });

    const replyTool = {
      type: "function",
      name: "reply",
      description: "Simply sends a message to the user. No other action is taken",
      parameters: z
        .object({
          content: z.string(),
        })
        .toJSONSchema(),
      strict: true,
    } satisfies OpenAI.Responses.Tool;

    const removeWaitReaction = this.addReaction(message, "🧠");

    let calledTool: OpenAI.Responses.ResponseFunctionToolCall | null = null;

    try {
      const responseStream = await this.openai.responses.create({
        instructions: `You are a chatbot named ${personality.name}. You're stateless - you don't see previous user turns. And also, you only have access to the text content of the user query. Below, is a user query, you must interpret it and route to the appropriate tool. If not enough information is supplied, you can send the user a message explaining what happened. If the user's intent is just chatting, or is something you can answer with your intrinsic knowledge, you can send them a reply. Match the user's language.`,
        model: this.config.openaiModel,
        tool_choice: "auto",
        tools: [...commandTools, replyTool],
        input: [{ role: "user", content: message.cleanContent.slice(0, 256) }],
        max_output_tokens: 128,
        store: false,
        stream: true,
        reasoning: { effort: "none" },
      });

      for await (const chunk of responseStream) {
        logger.debug("Response chunk", { type: chunk.type });

        if (chunk.type === "response.output_item.done") {
          if (chunk.item.type === "function_call") {
            // we got the response
            responseStream.controller.abort();
            calledTool = chunk.item;
            break;
          }
        }
      }
    } catch (error) {
      logger.error("Error handling natural language command", {
        error,
        messageAuthor: message.author,
        messageContent: message.content,
      });
    } finally {
      await removeWaitReaction();
    }

    if (calledTool === null) {
      message.reply("Desculpe, não consegui interpretar sua mensagem.");
    } else if (calledTool?.name === "reply") {
      // TODO use Zod here instead of naive JSON parse
      const argsObject = JSON.parse(calledTool.arguments);
      message.reply(argsObject.content);
    } else {
      // TODO use Zod here instead of naive JSON parse
      const argsObject = JSON.parse(calledTool.arguments);
      const tool = personality.tools.find((tool) => tool.name === calledTool.name)!;
      const args = tool.argsSchema.parse(argsObject);

      // dispatch command
      this.invokeTool(message, personality, tool, args);
    }
  }

  /**
   * Runs initialization that depends on the Discord client being ready.
   */
  private async handlePostCreation() {}

  /**
   * Processes a newly created message for the applicable personality.
   */
  private async handleUserMessageCreate(message: Message) {
    if (message.author.bot || message.guildId === null) return;

    const personality = Personalities.find((p) => {
      if (p.guildWhitelist !== null && !p.guildWhitelist.includes(message.guildId!)) return false;
      if (p.userWhitelist !== null && !p.userWhitelist.includes(message.author.id)) return false;
      return true;
    });

    if (!personality) return;

    let removeGearReaction: (() => void) | null = null;

    try {
      if (message.content.startsWith(this.config.prefix)) {
        removeGearReaction = this.addReaction(message, "⚙️");
        await this.handleLegacyMessageCommandDispatch(message, personality);
      } else if (this.client.user && message.mentions.has(this.client.user?.id)) {
        removeGearReaction = this.addReaction(message, "⚙️");
        await this.handleNaturalLanguageCommandDispatch(message, personality);
      } else {
        // this message is not directed at us
      }
    } catch (error) {
      logger.error("Failed to handle message", {
        error,
        messageId: message.id,
        messageAuthor: message.author,
        messageContent: message.content,
      });

      if (error instanceof ApplicationError) {
        await message
          .reply("Não consegui processar essa solicitação.")
          .catch((replyError: unknown) => {
            logger.error("Failed to send message error reply", {
              replyError,
              messageId: message.id,
            });
          });
      }
    } finally {
      removeGearReaction?.();
    }
  }

  /**
   * Handles updates to user messages.
   */
  private async handleUserMessageUpdate(_message: { id: string }) {}

  /**
   * Handles deletion of user messages.
   */
  private async handleUserMessageDelete(_deletedMessage: { id: string }) {}

  /**
   * Prevents direct construction; use {@link create} to initialize the client.
   */
  private constructor() {
    // created in create() method
  }

  /**
   * Creates an instance and resolves after the Discord client is ready.
   */
  public static async create(config: Config, openai: OpenAI) {
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
    client.on("messageUpdate", instance.handleUserMessageUpdate.bind(instance));
    client.on("messageDelete", instance.handleUserMessageDelete.bind(instance));

    instance.config = config;
    instance.client = client;
    instance.openai = openai;

    client.login(config.discordToken).catch((cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      logger.error("Discord login failed", error);
      deferred.reject(error);
    });

    return deferred.promise;
  }
}
