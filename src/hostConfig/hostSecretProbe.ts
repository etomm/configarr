import { logger } from "../logger";

/** One attempt, never a retry loop: the probe must not become a brute-force login. */
const PROBE_TIMEOUT_MS = 4_000;

/** Cookies an authenticated *arr session sets. Servarr names them `<App>Auth`; ASP.NET uses its own cookie. */
const AUTH_COOKIE_NAME = /^(?:\.AspNetCore\.Cookies|[A-Za-z0-9_-]*Auth)$/i;

export type HostSecretProbe = {
  /** `true` when the app accepts these credentials, `false` when it rejects them, `undefined` when it could not answer. */
  localPassword(username: string, password: string): Promise<boolean | undefined>;
  /** `true` when the authority accepts this client secret, `false` when it rejects it, `undefined` when it could not answer. */
  oidcClientSecret(authority: string, clientId: string, secret: string): Promise<boolean | undefined>;
};

function endpoint(baseUrl: string, path: string): URL | undefined {
  try {
    return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  } catch {
    return undefined;
  }
}

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const cookies = headers.getSetCookie?.();
  if (cookies) return cookies;

  const header = response.headers.get("set-cookie");
  return header ? [header] : [];
}

function hasAuthCookie(response: Response): boolean {
  return setCookies(response).some((cookie) => AUTH_COOKIE_NAME.test(cookie.split("=", 1)[0]?.trim() ?? ""));
}

/**
 * Ask the app itself whether the declared local account works. A successful login sets an
 * auth cookie; a rejected one does not, and the status code alone does not discriminate.
 * Any transport problem returns `undefined` so the caller can fall back to the stored value.
 */
export async function probeLocalPassword(baseUrl: string, username: string, password: string): Promise<boolean | undefined> {
  if (!username || !password) return undefined;
  const url = endpoint(baseUrl, "login");
  if (!url) return undefined;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password, rememberMe: "false" }),
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }

  if (hasAuthCookie(response)) return true;
  // A 2xx/3xx/401/403 without the cookie is an answered rejection. Other statuses mean the
  // endpoint itself is unavailable, so leave the decision to the caller's fallback.
  if (response.status < 400 || response.status === 401 || response.status === 403) return false;
  return undefined;
}

async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Test the declared OIDC client secret at the authority's token endpoint. `invalid_client`
 * is the only unambiguous rejection; `unauthorized_client` and `invalid_grant` prove the
 * client authenticated and only the requested grant was refused. Anything else, including an
 * unreachable authority, returns `undefined` so rotation remains the only intent signal.
 */
export async function probeOidcClientSecret(authority: string, clientId: string, secret: string): Promise<boolean | undefined> {
  if (!authority || !clientId || !secret) return undefined;

  const discoveryUrl = endpoint(authority, ".well-known/openid-configuration");
  if (!discoveryUrl) return undefined;

  let discovery: Record<string, unknown> | undefined;
  try {
    const response = await fetch(discoveryUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    discovery = await readJson(response);
  } catch {
    return undefined;
  }

  const tokenEndpoint = discovery?.token_endpoint;
  if (typeof tokenEndpoint !== "string") return undefined;

  let response: Response;
  try {
    response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: secret }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }

  if (response.ok) return true;

  const body = await readJson(response);
  const error = typeof body?.error === "string" ? body.error : undefined;

  if (response.status === 401 && error === "invalid_client") return false;
  if (error === "unauthorized_client" || error === "invalid_grant") return true;
  return undefined;
}

export function createHostSecretProbe(baseUrl: string): HostSecretProbe {
  return {
    localPassword: (username, password) => probeLocalPassword(baseUrl, username, password),
    oidcClientSecret: (authority, clientId, secret) => probeOidcClientSecret(authority, clientId, secret),
  };
}

/** Log only the decision, never the credentials or the raw response. */
export function logSecretProbe(appLabel: string, field: string, accepted: boolean | undefined): void {
  if (accepted === true) {
    logger.debug(`${appLabel} host config: declared ${field} is accepted, keeping it`);
  } else if (accepted === false) {
    logger.info(`${appLabel} host config: declared ${field} was rejected, updating it`);
  } else {
    logger.debug(`${appLabel} host config: could not test ${field}, falling back to the stored value`);
  }
}
