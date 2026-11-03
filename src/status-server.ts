import http from "node:http";
import Deferred from "./lib/deferred.ts";
import createLogger from "./lib/logger.ts";

/** Handles a status endpoint request. */
type HandlerFunction = (response: http.ServerResponse) => void;

let healthCheckFunction: HandlerFunction | null = null;

const logger = createLogger("StatusServer");

const server = http.createServer((request, response) => {
  const endpoint = `${request.method!.toUpperCase()} ${request.url?.split("?", 1)[0] ?? "/"}`;

  logger.debug("Request", { endpoint });

  if (endpoint === "GET /") {
    return response.end("Hello");
  } else if (endpoint === "GET /health" && healthCheckFunction) {
    return healthCheckFunction(response);
  } else {
    return response.writeHead(404).end(`Cannot ${endpoint}`);
  }
});

/**
 * Sets the handler used to respond to `GET /health` requests.
 *
 * @param handler - The health-check handler, or `null` to disable the route.
 */
export function setHealthCheckFunction(handler: typeof healthCheckFunction) {
  healthCheckFunction = handler;
}

/**
 * Starts the status HTTP server and resolves once it begins listening.
 *
 * The server responds to `GET /` with a greeting and delegates `GET /health`
 * to the configured health-check handler. Other requests receive a 404.
 *
 * @param port - The TCP port on which the server listens.
 * @param hostname - The network interface address to bind to. Defaults to
 * `0.0.0.0` so the server is reachable from outside the process.
 * @returns A promise that resolves when the server is listening, or rejects
 * if the server fails to bind.
 */
export default function initializeServer(port: number, hostname: string = "0.0.0.0") {
  const deferred = new Deferred<void, unknown>();

  function handleListenOk() {
    server.removeListener("listening", handleListenOk);
    server.removeListener("error", handleListenError);

    logger.info("Server listening", { hostname, port });

    deferred.resolve();
  }

  function handleListenError(error: unknown) {
    server.removeListener("listening", handleListenOk);
    server.removeListener("error", handleListenError);

    logger.error("Failed to listen", { hostname, port, error });

    deferred.reject(error);
  }

  server.once("listening", handleListenOk);
  server.once("error", handleListenError);

  server.listen(port, hostname);

  return deferred.promise;
}
