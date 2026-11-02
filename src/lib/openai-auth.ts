import { createRemoteJWKSet, jwtVerify } from "jose";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import ApplicationError from "./application-error.ts";
import createLogger from "./logger.ts";

const logger = createLogger("OpenaiAuth");

// OAuth endpoints and permissions used by the open-source ChatGPT plan flow.
const AUTHORIZATION_ENDPOINT = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_ENDPOINT = "https://auth.openai.com/api/accounts/oauth/token";
const ISSUER = "https://auth.openai.com";
const JWKS_URI = `${ISSUER}/.well-known/jwks.json`;
const RESOURCE = "https://api.openai.com/v1";
const REQUIRED_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", REQUIRED_SCOPE];

// The callback only listens on the local machine; OAuth returns to this path.
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/auth/callback";

// Store credentials under the user's config directory, never in the project.
const DEFAULT_CREDENTIALS_PATH = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  "awsta",
  "chatgpt.json",
);

export interface ChatgptCredentials {
  clientId: string;
  subject: string;
  email?: string;
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

/**
 * Runtime token renewal failed; callers must restart with interactive sign-in.
 */
export class ChatgptTokenRefreshError extends ApplicationError {
  public constructor(options?: ErrorOptions) {
    super("Could not refresh ChatGPT credentials automatically", {}, options);
  }
}

/**
 * Stable per-installation identifier and the signed-in account's credentials.
 */
interface CredentialStore {
  hostId: string;
  credentials?: ChatgptCredentials;
}

/**
 * Token endpoint response fields used by this client.
 */
interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  scope?: string;
}

const jwks = createRemoteJWKSet(new URL(JWKS_URI));

// Reuse credentials and collapse simultaneous refresh/sign-in requests.
let cachedStore: CredentialStore | undefined;
let signInInFlight: Promise<ChatgptCredentials> | undefined;
let refreshInFlight: Promise<ChatgptCredentials> | undefined;
let credentialsPath = DEFAULT_CREDENTIALS_PATH;

/** Sets the credential file path before any auth operation starts. */
export function setCredentialsPath(path: string): void {
  if (cachedStore || signInInFlight || refreshInFlight) {
    throw new Error("ChatGPT credential path must be configured before authentication starts");
  }
  credentialsPath = path;
}

/**
 * Creates a cryptographically random, URL-safe OAuth value.
 */
function randomUrlSafeValue(size = 32) {
  return randomBytes(size).toString("base64url");
}

/** Redacts token contents while retaining a short prefix and suffix for correlation. */
function redactToken(token: string): string {
  if (token.length <= 12) return "*".repeat(token.length);
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

/** Formats a clickable OSC 8 link while leaving readable text in unsupported terminals. */
function terminalLink(label: string, url: string): string {
  return `\u001b]8;;${url}\u001b\\${label}\u001b]8;;\u001b\\`;
}

/**
 * Requires a non-empty string from an untyped OAuth response.
 */
function readString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`OpenAI token response did not include ${name}`);
  }
  return value;
}

/**
 * Reads saved credentials and tightens their file permissions.
 */
async function readCredentialStore(): Promise<CredentialStore | undefined> {
  try {
    const content = await readFile(credentialsPath, "utf8");
    const store = JSON.parse(content) as CredentialStore;
    if (typeof store.hostId !== "string" || store.hostId.length === 0) {
      throw new Error("ChatGPT credential file has no host ID; remove it and sign in again");
    }
    await chmod(credentialsPath, 0o600);
    logger.debug("Loaded saved credentials", {
      hasCredentials: Boolean(store.credentials),
      expiresAt: store.credentials?.expiresAt,
    });
    return store;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      logger.info("No saved credentials found; startup sign-in is required");
      return undefined;
    }
    logger.error("Failed to read credential store", { error });
    throw error;
  }
}

/**
 * Atomically saves credentials with owner-only file permissions.
 */
async function saveCredentialStore(store: CredentialStore) {
  await mkdir(dirname(credentialsPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${credentialsPath}.${randomUUID()}.tmp`;

  // Rename only after the full file has been written, so a crash won't truncate credentials.
  await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, credentialsPath);
  await chmod(credentialsPath, 0o600);
  logger.debug("Saved credential store", {
    hasCredentials: Boolean(store.credentials),
    expiresAt: store.credentials?.expiresAt,
  });
}

/**
 * Exchanges an OAuth form and reports provider error codes without exposing tokens.
 */
async function exchangeToken(form: URLSearchParams): Promise<TokenResponse> {
  const grantType = form.get("grant_type") ?? "unknown";
  logger.debug("Exchanging OAuth token", { grantType });
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const payload = (await response.json()) as Record<string, unknown>;

  if (!response.ok) {
    const error = typeof payload.error === "string" ? payload.error : "token_exchange_failed";
    logger.warn("OAuth token exchange failed", { grantType, status: response.status, error });
    throw new Error(`OpenAI token exchange failed: ${error}`);
  }

  logger.debug("OAuth token exchange succeeded", { grantType });
  return payload as unknown as TokenResponse;
}

/**
 * Parses a space-separated OAuth scope value, using the request as fallback.
 */
function parseScopes(value: string | undefined, fallback: string[]) {
  return value ? value.split(/\s+/).filter(Boolean) : fallback;
}

/**
 * Converts a token lifetime in seconds into an absolute expiry timestamp.
 */
function tokenExpiry(expiresIn: number) {
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("OpenAI token response included an invalid expiry");
  }
  return Date.now() + expiresIn * 1000;
}

/**
 * Verifies the ID token signature and its OpenID Connect identity claims.
 */
async function validateIdToken(idToken: string, clientId: string, nonce: string) {
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: ISSUER,
    audience: clientId,
  });
  if (payload.nonce !== nonce) {
    throw new Error("OpenAI ID token nonce did not match the sign-in request");
  }

  return {
    subject: readString(payload.sub, "ID token subject"),
    email: typeof payload.email === "string" ? payload.email : undefined,
  };
}

/**
 * Refuses to use the account's plan unless the user granted the required scope.
 */
function assertPlanScope(scopes: string[]) {
  if (!scopes.includes(REQUIRED_SCOPE)) {
    throw new Error("ChatGPT plan usage was not authorized. Sign in again and approve plan usage.");
  }
}

/**
 * Starts a one-time loopback callback listener and returns its URI and result promise.
 * The state and optional client ID bind the callback to the request that started it.
 */
async function startCallbackServer(expectedState: string, expectedClientId?: string) {
  let finish!: (result: { code: string; clientId: string }) => void;
  let fail!: (error: Error) => void;
  let settled = false;
  const callbackResult = new Promise<{ code: string; clientId: string }>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });

  let redirectUri = "";
  const server = createServer((request, response) => {
    const callbackUrl = new URL(request.url ?? "/", redirectUri);
    if (request.method !== "GET" || callbackUrl.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end("Not found");
      return;
    }

    const state = callbackUrl.searchParams.get("state") ?? "";
    const actualState = Buffer.from(state);
    const expectedStateBuffer = Buffer.from(expectedState);
    // Compare the callback state before accepting either a code or an OAuth error.
    const stateMatches =
      actualState.length === expectedStateBuffer.length &&
      timingSafeEqual(actualState, expectedStateBuffer);

    if (!stateMatches) {
      logger.warn("Rejected OAuth callback with mismatched state");
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Sign-in state did not match. Return to the bot and try again.");
      if (!settled) {
        settled = true;
        fail(new Error("OpenAI sign-in state validation failed"));
      }
      return;
    }

    const oauthError = callbackUrl.searchParams.get("error");
    if (oauthError) {
      logger.warn("OAuth provider returned an authorization error", { error: oauthError });
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Sign-in was not completed. You can close this page.");
      if (!settled) {
        settled = true;
        fail(new Error(`OpenAI sign-in was not completed: ${oauthError}`));
      }
      return;
    }

    const code = callbackUrl.searchParams.get("code");
    const returnedClientId = callbackUrl.searchParams.get("client_id");
    const clientId = returnedClientId ?? expectedClientId;
    if (expectedClientId && returnedClientId && returnedClientId !== expectedClientId) {
      logger.warn("Rejected OAuth callback for a different client ID");
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("The selected ChatGPT account did not match. Return to the bot and try again.");
      if (!settled) {
        settled = true;
        fail(new Error("OpenAI sign-in returned a different client ID"));
      }
      return;
    }
    if (!code || !clientId) {
      logger.warn("Rejected incomplete OAuth callback", {
        hasCode: Boolean(code),
        hasClientId: Boolean(clientId),
      });
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("The sign-in response was incomplete. Return to the bot and try again.");
      if (!settled) {
        settled = true;
        fail(new Error("OpenAI sign-in callback did not include a code or client ID"));
      }
      return;
    }

    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    });
    response.end("ChatGPT sign-in complete. You can close this page and return to the bot.");
    if (!settled) {
      settled = true;
      finish({ code, clientId });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, CALLBACK_HOST, resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not start the local ChatGPT sign-in callback");
  }

  redirectUri = `http://${CALLBACK_HOST}:${address.port}${CALLBACK_PATH}`;
  logger.info("Waiting for OAuth callback", { host: CALLBACK_HOST, port: address.port });

  const timeout = setTimeout(
    () => {
      if (!settled) {
        settled = true;
        logger.warn("OAuth callback timed out");
        fail(new Error("Timed out waiting for ChatGPT sign-in"));
      }
    },
    10 * 60 * 1000,
  );

  return {
    redirectUri,
    callbackResult,
    /**
     * Stops accepting loopback requests after sign-in finishes or fails.
     */
    close: async () => {
      clearTimeout(timeout);
      if (!server.listening) return;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Runs the browser-based PKCE flow and returns verified, renewable credentials.
 */
async function runInteractiveOAuth(
  hostId: string,
  existingCredentials?: ChatgptCredentials,
): Promise<ChatgptCredentials> {
  logger.info("Starting interactive OAuth sign-in", {
    returningUser: Boolean(existingCredentials),
  });
  const state = randomUrlSafeValue();
  const nonce = randomUrlSafeValue();
  const verifier = randomUrlSafeValue(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const callback = await startCallbackServer(state, existingCredentials?.clientId);
  const { redirectUri } = callback;
  const authorizationUrl = new URL(AUTHORIZATION_ENDPOINT);
  const authorizationParameters = new URLSearchParams({
    client_id: existingCredentials?.clientId ?? "dynamic_agent_client",
    ext_agent_host_id: hostId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES.join(" "),
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  if (existingCredentials) {
    authorizationParameters.set("id_token_hint", existingCredentials.idToken);
    if (existingCredentials.email) {
      authorizationParameters.set("login_hint", existingCredentials.email);
    }
  } else {
    // The first authorization dynamically registers this local open-source client.
    authorizationParameters.set("agent_name_hint", "awsta");
  }
  authorizationUrl.search = authorizationParameters.toString();

  logger.info("Open this URL to sign in to ChatGPT for Awsta:");
  logger.info(terminalLink(authorizationUrl.toString(), authorizationUrl.toString()));

  try {
    const { code, clientId } = await callback.callbackResult;
    logger.info("OAuth callback received; exchanging authorization code");
    const tokenResponse = await exchangeToken(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: RESOURCE,
      }),
    );

    const accessToken = readString(tokenResponse.access_token, "access token");
    const idToken = readString(tokenResponse.id_token, "ID token");
    const refreshToken = readString(tokenResponse.refresh_token, "refresh token");
    const scopes = parseScopes(tokenResponse.scope, SCOPES);
    assertPlanScope(scopes);
    const identity = await validateIdToken(idToken, clientId, nonce);
    logger.info("Interactive OAuth sign-in succeeded", {
      subject: identity.subject,
      email: identity.email,
      accessToken: redactToken(accessToken),
      refreshToken: redactToken(refreshToken),
      scopes,
      expiresAt: tokenExpiry(tokenResponse.expires_in),
    });

    return {
      clientId,
      ...identity,
      idToken,
      accessToken,
      refreshToken,
      expiresAt: tokenExpiry(tokenResponse.expires_in),
      scopes,
    };
  } catch (error) {
    logger.error("Interactive OAuth sign-in failed", { error });
    throw error;
  } finally {
    await callback.close();
    logger.debug("Closed OAuth callback listener");
  }
}

/**
 * Refreshes an access token and preserves the newest rotating refresh token.
 */
async function refresh(credentials: ChatgptCredentials): Promise<ChatgptCredentials> {
  logger.info("Refreshing ChatGPT access token", { expiresAt: credentials.expiresAt });
  const tokenResponse = await exchangeToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: credentials.clientId,
      refresh_token: credentials.refreshToken,
      resource: RESOURCE,
    }),
  );

  const scopes = parseScopes(tokenResponse.scope, credentials.scopes);
  assertPlanScope(scopes);
  const refreshedCredentials = {
    ...credentials,
    accessToken: readString(tokenResponse.access_token, "access token"),
    refreshToken: tokenResponse.refresh_token ?? credentials.refreshToken,
    idToken: credentials.idToken,
    expiresAt: tokenExpiry(tokenResponse.expires_in),
    scopes,
  };
  logger.info("ChatGPT access token refreshed", {
    accessToken: redactToken(refreshedCredentials.accessToken),
    refreshToken: redactToken(refreshedCredentials.refreshToken),
    expiresAt: refreshedCredentials.expiresAt,
    scopes,
  });
  return refreshedCredentials;
}

/** Loads saved credentials at startup, refreshing silently or signing in if none exist. */
export async function initializeAuthInteractive(): Promise<ChatgptCredentials> {
  logger.info("Initializing ChatGPT authentication");
  if (!cachedStore) {
    cachedStore = await readCredentialStore();
    if (!cachedStore) {
      cachedStore = { hostId: `urn:uuid:${randomUUID()}` };
      logger.info("No saved ChatGPT credentials; interactive sign-in is required");
      signInInFlight ??= runInteractiveOAuth(cachedStore.hostId);
    }
  }

  try {
    if (signInInFlight) {
      cachedStore.credentials = await signInInFlight;
    } else if (
      cachedStore.credentials &&
      cachedStore.credentials.expiresAt <= Date.now() + 60_000
    ) {
      logger.info("Saved ChatGPT access token is expired or near expiry; refreshing silently", {
        expiresAt: cachedStore.credentials.expiresAt,
      });
      refreshInFlight ??= refresh(cachedStore.credentials);
      cachedStore.credentials = await refreshInFlight;
    }

    if (!cachedStore.credentials) {
      throw new ChatgptTokenRefreshError(
        new Error("Saved ChatGPT credential store does not contain credentials"),
      );
    }

    await saveCredentialStore(cachedStore);
    logger.info("ChatGPT authentication initialized", {
      subject: cachedStore.credentials.subject,
      email: cachedStore.credentials.email,
      expiresAt: cachedStore.credentials.expiresAt,
      scopes: cachedStore.credentials.scopes,
    });
    return cachedStore.credentials;
  } catch (error) {
    logger.error("ChatGPT authentication initialization failed", { error });
    throw error;
  } finally {
    signInInFlight = undefined;
    refreshInFlight = undefined;
  }
}

/**
 * Returns a valid token, refreshing silently when needed; never starts browser OAuth.
 */
export async function getTokenAutoRefresh(): Promise<string> {
  if (!cachedStore) cachedStore = await readCredentialStore();
  if (!cachedStore?.credentials) {
    logger.error("Cannot provide runtime access token: credentials are missing");
    throw new ChatgptTokenRefreshError(
      new Error("No saved ChatGPT credentials; sign in at startup"),
    );
  }

  const credentials = cachedStore.credentials;
  if (credentials.expiresAt <= Date.now() + 60_000) {
    logger.debug("Access token is expiring soon; starting silent refresh", {
      expiresAt: credentials.expiresAt,
    });
    refreshInFlight ??= refresh(credentials).catch((cause: unknown) => {
      throw new ChatgptTokenRefreshError({ cause });
    });
    try {
      cachedStore.credentials = await refreshInFlight;
      await saveCredentialStore(cachedStore);
    } catch (cause) {
      logger.error("Silent token refresh failed; interactive sign-in is required", { cause });
      if (cause instanceof ChatgptTokenRefreshError) throw cause;
      throw new ChatgptTokenRefreshError({ cause });
    } finally {
      refreshInFlight = undefined;
    }
  }

  logger.debug("Providing ChatGPT access token", {
    accessToken: redactToken(cachedStore.credentials.accessToken),
    expiresAt: cachedStore.credentials.expiresAt,
  });

  return cachedStore.credentials.accessToken;
}
