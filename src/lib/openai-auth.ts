import { createRemoteJWKSet, jwtVerify } from "jose";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// OAuth endpoints and permissions used by the open-source ChatGpt plan flow.
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
const CREDENTIALS_PATH = join(
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

/** Stable per-installation identifier and the signed-in account's credentials. */
interface CredentialStore {
  hostId: string;
  credentials?: ChatgptCredentials;
}

/** Token endpoint response fields used by this client. */
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

/** Creates a cryptographically random, URL-safe OAuth value. */
function randomUrlSafeValue(size = 32) {
  return randomBytes(size).toString("base64url");
}

/** Requires a non-empty string from an untyped OAuth response. */
function readString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`OpenAI token response did not include ${name}`);
  }
  return value;
}

/** Reads saved credentials and tightens their file permissions. */
async function readCredentialStore(): Promise<CredentialStore | undefined> {
  try {
    const content = await readFile(CREDENTIALS_PATH, "utf8");
    const store = JSON.parse(content) as CredentialStore;
    if (typeof store.hostId !== "string" || store.hostId.length === 0) {
      throw new Error("ChatGpt credential file has no host ID; remove it and sign in again");
    }
    await chmod(CREDENTIALS_PATH, 0o600);
    return store;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** Atomically saves credentials with owner-only file permissions. */
async function saveCredentialStore(store: CredentialStore) {
  await mkdir(dirname(CREDENTIALS_PATH), { recursive: true, mode: 0o700 });
  const temporaryPath = `${CREDENTIALS_PATH}.${randomUUID()}.tmp`;

  // Rename only after the full file has been written, so a crash won't truncate credentials.
  await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, CREDENTIALS_PATH);
  await chmod(CREDENTIALS_PATH, 0o600);
}

/** Exchanges an OAuth form and reports provider error codes without exposing tokens. */
async function exchangeToken(form: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const payload = (await response.json()) as Record<string, unknown>;

  if (!response.ok) {
    const error = typeof payload.error === "string" ? payload.error : "token_exchange_failed";
    throw new Error(`OpenAI token exchange failed: ${error}`);
  }

  return payload as unknown as TokenResponse;
}

/** Parses a space-separated OAuth scope value, using the request as fallback. */
function parseScopes(value: string | undefined, fallback: string[]) {
  return value ? value.split(/\s+/).filter(Boolean) : fallback;
}

/** Converts a token lifetime in seconds into an absolute expiry timestamp. */
function tokenExpiry(expiresIn: number) {
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("OpenAI token response included an invalid expiry");
  }
  return Date.now() + expiresIn * 1000;
}

/** Verifies the ID token signature and its OpenID Connect identity claims. */
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

/** Refuses to use the account's plan unless the user granted the required scope. */
function assertPlanScope(scopes: string[]) {
  if (!scopes.includes(REQUIRED_SCOPE)) {
    throw new Error("ChatGpt plan usage was not authorized. Sign in again and approve plan usage.");
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
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("The selected ChatGpt account did not match. Return to the bot and try again.");
      if (!settled) {
        settled = true;
        fail(new Error("OpenAI sign-in returned a different client ID"));
      }
      return;
    }
    if (!code || !clientId) {
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
    response.end("ChatGpt sign-in complete. You can close this page and return to the bot.");
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
    throw new Error("Could not start the local ChatGpt sign-in callback");
  }

  redirectUri = `http://${CALLBACK_HOST}:${address.port}${CALLBACK_PATH}`;

  const timeout = setTimeout(
    () => {
      if (!settled) {
        settled = true;
        fail(new Error("Timed out waiting for ChatGpt sign-in"));
      }
    },
    10 * 60 * 1000,
  );

  return {
    redirectUri,
    callbackResult,
    /** Stops accepting loopback requests after sign-in finishes or fails. */
    close: async () => {
      clearTimeout(timeout);
      if (!server.listening) return;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Runs the browser-based PKCE flow and returns verified, renewable credentials. */
async function signIn(
  hostId: string,
  existingCredentials?: ChatgptCredentials,
): Promise<ChatgptCredentials> {
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

  console.info("Sign in to ChatGpt for Awsta by opening this URL:");
  console.info(authorizationUrl.toString());

  try {
    const { code, clientId } = await callback.callbackResult;
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

    return {
      clientId,
      ...identity,
      idToken,
      accessToken,
      refreshToken,
      expiresAt: tokenExpiry(tokenResponse.expires_in),
      scopes,
    };
  } finally {
    await callback.close();
  }
}

/** Refreshes an access token and preserves the newest rotating refresh token. */
async function refresh(credentials: ChatgptCredentials): Promise<ChatgptCredentials> {
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
  return {
    ...credentials,
    accessToken: readString(tokenResponse.access_token, "access token"),
    refreshToken: tokenResponse.refresh_token ?? credentials.refreshToken,
    idToken: credentials.idToken,
    expiresAt: tokenExpiry(tokenResponse.expires_in),
    scopes,
  };
}

/**
 * Loads valid ChatGPT credentials, creating them on first use and refreshing them
 * near expiry. An invalid refresh grant starts a new consent flow for the same client.
 */
export async function getChatgptCredentials(): Promise<ChatgptCredentials> {
  if (!cachedStore) {
    cachedStore = await readCredentialStore();
    if (!cachedStore) {
      cachedStore = { hostId: `urn:uuid:${randomUUID()}` };
      await saveCredentialStore(cachedStore);
    }
  }

  if (!cachedStore.credentials) {
    signInInFlight ??= signIn(cachedStore.hostId);
    try {
      cachedStore.credentials = await signInInFlight;
      await saveCredentialStore(cachedStore);
    } finally {
      signInInFlight = undefined;
    }
  } else if (cachedStore.credentials.expiresAt <= Date.now() + 60_000) {
    const previousCredentials = cachedStore.credentials;
    refreshInFlight ??= refresh(previousCredentials).catch(async (error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes("invalid_grant")) {
        throw error;
      }
      console.info("ChatGpt authorization expired. Sign in again to continue.");
      return signIn(cachedStore!.hostId, previousCredentials);
    });
    try {
      cachedStore.credentials = await refreshInFlight;
      await saveCredentialStore(cachedStore);
    } finally {
      refreshInFlight = undefined;
    }
  }

  return cachedStore.credentials;
}
