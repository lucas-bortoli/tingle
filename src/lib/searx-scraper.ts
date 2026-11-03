import * as cheerio from "cheerio";
import ApplicationError from "./application-error.ts";
import createLogger from "./logger.ts";

const logger = createLogger("SearxScraper");

/** Public SearXNG instances used to distribute unauthenticated search requests. */
const DOMAINS = ["https://searxng.cz"];

/** Base error for failures while requesting or scraping SearXNG results. */
export class SearxSearchError extends ApplicationError {
  /** Creates a search error with optional structured context and original cause. */
  public constructor(
    message: string,
    context: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, context, options);
  }
}

/**
 * Searches a public SearXNG instance and extracts result URLs from its HTML page.
 *
 * The query text is intentionally omitted from logs to avoid recording user input.
 *
 * @param options - Search query, optional SearXNG language code, and result limit.
 * @returns Extracted result URLs, limited to `max` when provided.
 * @throws {SearxSearchError} When the HTTP request fails or the response cannot be scraped.
 */
export default async function search(options: { query: string; language?: string; max?: number }) {
  const pickedServer = DOMAINS[Math.floor(Math.random() * DOMAINS.length)];
  logger.info("Starting web search", {
    server: pickedServer,
    language: options.language ?? "auto",
  });

  try {
    const response = await fetch(`${pickedServer}/search`, {
      method: "POST",
      credentials: "omit",
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:159.0) Gecko/20100101 Firefox/159.0",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Content-Type": "application/x-www-form-urlencoded",
        Priority: "u=0, i",
      },
      body: new URLSearchParams({
        q: options.query,
        language: options.language ?? "auto",
      }).toString(),
    });

    if (!response.ok) {
      logger.warn("SearXNG returned an unsuccessful response", {
        server: pickedServer,
        status: response.status,
      });
      throw new SearxSearchError("SearXNG search request failed", {
        server: pickedServer,
        status: response.status,
      });
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    let { results } = $.extract({
      results: [
        {
          selector: ".result .url_header",
          value: "href",
        },
      ],
    });

    if (options.max !== undefined) {
      results = results.slice(0, options.max);
    }

    logger.info("Web search completed", {
      server: pickedServer,
      status: response.status,
      resultCount: results.length,
    });
    return results;
  } catch (cause) {
    if (cause instanceof SearxSearchError) {
      logger.error("Web search failed", { server: pickedServer, error: cause });
      throw cause;
    }
    logger.error("Web search failed unexpectedly", { server: pickedServer, cause });
    throw new SearxSearchError(
      "Could not search with SearXNG",
      { server: pickedServer },
      { cause },
    );
  }
}
