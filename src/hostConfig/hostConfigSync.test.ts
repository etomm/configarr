import { afterEach, describe, expect, test, vi } from "vitest";
import { LidarrClient } from "../clients/lidarr-client";
import { ProwlarrClient } from "../clients/prowlarr-client";
import { RadarrClient } from "../clients/radarr-client";
import { ReadarrClient } from "../clients/readarr-client";
import { SonarrClient } from "../clients/sonarr-client";
import { WhisparrClient } from "../clients/whisparr-client";
import { initEnvs } from "../env";
import { logger } from "../logger";
import type { HostConfig } from "./hostConfigSync";
import { ChaptarrHostConfigSync, FederatedHostConfigSync, HostConfigSync } from "./hostConfigSync";

type StoredHostSettings = Record<string, unknown>;

type StubOptions = {
  /** Password the simulated local login accepts, when the API deliberately hides the stored one. */
  loginPassword?: string;
  /** Let the login request fail at the transport layer instead of answering. */
  loginUnavailable?: boolean;
};

function stubHostApi(initial: StoredHostSettings, apiVersion?: "v3" | "v5", options: StubOptions = {}) {
  let stored = { ...initial };
  const requests: string[] = [];
  const writes: StoredHostSettings[] = [];
  let loginCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request, init?: RequestInit) => {
      const url = new URL(request.url ?? String(request));
      const path = url.pathname;
      requests.push(`${request.method} ${path}`);
      if (path === "/login") {
        if (options.loginUnavailable) throw new TypeError("fetch failed");
        loginCalls++;
        const form = new URLSearchParams(await new Response(init?.body ?? (await (request as Request).text())).text());
        const password = options.loginPassword ?? (typeof stored.password === "string" ? stored.password : undefined);
        const accepted = !!password && form.get("username") === stored.username && form.get("password") === password;
        return new Response(null, {
          status: 302,
          headers: accepted
            ? { Location: "/", "Set-Cookie": "LidarrAuth=session; path=/; httponly" }
            : { Location: "/login?returnUrl=&loginFailed=true" },
        });
      }
      if (path === "/api") return Response.json({ current: apiVersion ?? "v3" });
      if (request.method === "PUT") {
        const body = (await request.json()) as StoredHostSettings;
        writes.push(body);
        stored = { ...stored, ...body };
        return Response.json({ id: 1 }, { status: 202 });
      }
      return Response.json(stored);
    }),
  );
  return { requests, writes, loginCalls: () => loginCalls, stored: () => stored };
}

/** Simulates a Radarr host resource plus an IdP discovery/token endpoint. `undefined` makes discovery unreachable. */
function stubOidcApi(tokenResponse?: () => Response) {
  let stored: StoredHostSettings = {
    id: 1,
    oidcAuthority: "https://idp.test",
    oidcClientId: "radarr",
    oidcClientSecret: "********",
  };
  const writes: StoredHostSettings[] = [];
  const tokenBodies: string[] = [];
  let discoveryCalls = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request, init?: RequestInit) => {
      const url = new URL(request.url ?? String(request));
      if (url.hostname === "idp.test" && url.pathname === "/.well-known/openid-configuration") {
        discoveryCalls++;
        if (!tokenResponse) throw new TypeError("fetch failed");
        return Response.json({ token_endpoint: "https://idp.test/token" });
      }
      if (url.hostname === "idp.test" && url.pathname === "/token") {
        tokenBodies.push(await new Response(init?.body ?? "").text());
        return tokenResponse?.() ?? Response.json({ error: "invalid_client" }, { status: 401 });
      }
      if (request.method === "PUT") {
        const body = (await request.json()) as StoredHostSettings;
        writes.push(body);
        stored = { ...stored, ...body };
        return Response.json({ id: 1 }, { status: 202 });
      }
      return Response.json(stored);
    }),
  );

  return {
    writes,
    tokenBodies,
    get discoveryCalls() {
      return discoveryCalls;
    },
    stored: () => stored,
  };
}

const backup = { backup_folder: "Backups", backup_interval: 7, backup_retention: 28 } satisfies HostConfig;

describe("host settings synchronization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    initEnvs();
  });

  test("validates secret flags and well-known authentication values", () => {
    const sync = new FederatedHostConfigSync(new RadarrClient("http://radarr.test", "key"), "Radarr");
    expect(() => sync.validate({ oidcClientSecret: "********" })).toThrow("masked placeholder");
    expect(() => sync.validate({ update_oidc_client_secret: true })).toThrow("requires oidcClientSecret");
    expect(() => sync.validate({ local_password: "********" })).toThrow("masked placeholder");
    expect(() => sync.validate({ rotate_local_password: true })).toThrow("requires local_password");
    expect(() => sync.validate({ authenticationMethod: "magic" })).toThrow("Radarr does not support authenticationMethod 'magic'");
    expect(() => sync.validate({ authenticationRequired: "sometimes" })).toThrow("Unsupported authenticationRequired");
    expect(() => sync.validate(backup)).not.toThrow();
  });

  test("accepts oidc only on the Chaptarr fork", () => {
    const vanilla = [
      { label: "Radarr", sync: new FederatedHostConfigSync(new RadarrClient("http://radarr.test", "key"), "Radarr") },
      { label: "Sonarr", sync: new FederatedHostConfigSync(new SonarrClient("http://sonarr.test", "key"), "Sonarr") },
      { label: "Whisparr", sync: new FederatedHostConfigSync(new WhisparrClient("http://whisparr.test", "key"), "Whisparr") },
      { label: "Lidarr", sync: new HostConfigSync(new LidarrClient("http://lidarr.test", "key"), "Lidarr") },
      { label: "Readarr", sync: new HostConfigSync(new ReadarrClient("http://readarr.test", "key"), "Readarr") },
      { label: "Prowlarr", sync: new HostConfigSync(new ProwlarrClient("http://prowlarr.test", "key"), "Prowlarr") },
    ];
    for (const app of vanilla) {
      expect(() => app.sync.validate({ authenticationMethod: "oidc" })).toThrow(
        `${app.label} does not support authenticationMethod 'oidc'`,
      );
      expect(() => app.sync.validate({ authenticationMethod: "external" })).not.toThrow();
      expect(() => app.sync.validate({ authenticationRequired: "sometimes" })).toThrow("Unsupported authenticationRequired");
    }

    const chaptarr = new ChaptarrHostConfigSync(new ReadarrClient("http://readarr.test", "key"), "Chaptarr");
    expect(() => chaptarr.validate({ authenticationMethod: "oidc" })).not.toThrow();
    expect(() => chaptarr.validate({ authenticationMethod: "external" })).not.toThrow();
    expect(() => chaptarr.validate({ authenticationMethod: "magic" })).toThrow("Chaptarr does not support authenticationMethod 'magic'");
  });

  test("rejects fields outside the app's field group before reading the server", async () => {
    const api = stubHostApi({ id: 1 });
    const sync = new HostConfigSync(new LidarrClient("http://lidarr.test", "key"), "Lidarr");
    expect(() => sync.sync({ oidcScopes: "openid", log_level: "info" })).toThrow("Lidarr host configuration does not expose oidcScopes");
    expect(api.requests).toHaveLength(0);
  });

  test("applies general settings while preserving authentication fields", async () => {
    const api = stubHostApi({
      id: 1,
      authenticationMethod: "external",
      authenticationRequired: "enabled",
      allowedHosts: "localhost",
      logLevel: "debug",
      analyticsEnabled: true,
      instanceName: "old",
      urlBase: "/old",
    });
    const sync = new HostConfigSync(new LidarrClient("http://lidarr.test", "key"), "Lidarr");
    const diff = await sync.sync({ log_level: "info", analytics_enabled: false, instance_name: "media", url_base: "/new" });
    expect(diff[0]?.fieldChanges).toEqual([
      { field: "logLevel", from: "debug", to: "info" },
      { field: "analyticsEnabled", from: true, to: false },
      { field: "instanceName", from: "old", to: "media" },
      { field: "urlBase", from: "/old", to: "/new" },
    ]);
    expect(api.stored()).toMatchObject({
      authenticationMethod: "external",
      authenticationRequired: "enabled",
      allowedHosts: "localhost",
      logLevel: "info",
      analyticsEnabled: false,
      instanceName: "media",
      urlBase: "/new",
    });
    const second = await sync.sync({ log_level: "info", analytics_enabled: false, instance_name: "media", url_base: "/new" });
    expect(second).toEqual([]);
    expect(api.writes).toHaveLength(1);
  });

  test("sets an initially empty OIDC secret without disclosing it in the diff", async () => {
    let stored: StoredHostSettings = { id: 1, oidcClientSecret: "", oidcScopes: "openid", allowedHosts: "localhost" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        if (request.method === "PUT") {
          stored = { ...stored, ...(await request.json()) };
          return Response.json({ id: 1 }, { status: 202 });
        }
        return Response.json(stored);
      }),
    );
    const client = new RadarrClient("http://radarr.test", "key");
    const report = await new FederatedHostConfigSync(client, "Radarr").sync({ oidcClientSecret: "new-secret-value" });
    expect(stored.oidcClientSecret).toBe("new-secret-value");
    expect(stored.allowedHosts).toBe("localhost");
    expect(JSON.stringify(report)).not.toContain("new-secret-value");
  });

  test("preserves masked secrets unless rotation is explicitly requested", async () => {
    let writes = 0;
    let submitted = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        if (request.method === "PUT") {
          writes++;
          submitted = (await request.json()).oidcClientSecret;
          return Response.json({ id: 1 }, { status: 202 });
        }
        return Response.json({ id: 1, oidcClientSecret: "********", oidcScopes: "openid" });
      }),
    );
    const client = new RadarrClient("http://radarr.test", "key");
    const sync = new FederatedHostConfigSync(client, "Radarr");
    expect(await sync.sync({ oidcClientSecret: "rotate-to-this" })).toEqual([]);
    expect(writes).toBe(0);
    const report = await sync.sync({ oidcClientSecret: "rotate-to-this", update_oidc_client_secret: true });
    expect(writes).toBe(1);
    expect(submitted).toBe("rotate-to-this");
    expect(JSON.stringify(report)).not.toContain("rotate-to-this");
  });

  test("applies local credentials on the first run and stays quiet afterwards", async () => {
    const api = stubHostApi({ id: 1, username: "old", password: null, logLevel: "info" });
    const sync = new HostConfigSync(new LidarrClient("http://lidarr.test", "key"), "Lidarr");
    const report = await sync.sync({ local_username: "admin", local_password: "generated-secret" });
    expect(report[0]?.fieldChanges).toEqual([
      { field: "username", from: "old", to: "admin" },
      { field: "password", from: "********", to: "********" },
    ]);
    expect(JSON.stringify(report)).not.toContain("generated-secret");
    expect(api.stored()).toMatchObject({
      username: "admin",
      password: "generated-secret",
      passwordConfirmation: "generated-secret",
      logLevel: "info",
    });
    const second = await sync.sync({ local_username: "admin", local_password: "generated-secret" });
    expect(second).toEqual([]);
    expect(api.writes).toHaveLength(1);
  });

  test("rewrites a masked local password only with the rotation flag", async () => {
    const api = stubHostApi({ id: 1, username: "admin", password: "********" });
    const sync = new HostConfigSync(new LidarrClient("http://lidarr.test", "key"), "Lidarr");
    expect(await sync.sync({ local_password: "new-secret" })).toEqual([]);
    expect(api.writes).toHaveLength(0);
    const report = await sync.sync({ local_password: "new-secret", rotate_local_password: true });
    expect(report[0]?.fieldChanges).toEqual([{ field: "password", from: "********", to: "********" }]);
    expect(api.writes).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain("new-secret");
  });

  test("tests a declared local password and keeps it when the app accepts it", async () => {
    // Chaptarr reports an empty password even when one is stored; the probe is the only signal.
    const api = stubHostApi({ id: 1, username: "admin", password: "" }, undefined, { loginPassword: "generated-secret" });
    const sync = new HostConfigSync(new LidarrClient("http://lidarr.test", "key"), "Lidarr", "http://lidarr.test");
    const report = await sync.sync({ local_username: "admin", local_password: "generated-secret" });
    expect(report).toEqual([]);
    expect(api.loginCalls()).toBe(1);
    expect(api.writes).toHaveLength(0);
  });

  test("corrects a local password the app rejects without waiting for the rotation flag", async () => {
    const api = stubHostApi({ id: 1, username: "admin", password: "********" }, undefined, { loginPassword: "old-secret" });
    const sync = new HostConfigSync(new LidarrClient("http://lidarr.test", "key"), "Lidarr", "http://lidarr.test");
    const report = await sync.sync({ local_password: "new-secret" });
    expect(report[0]?.fieldChanges).toEqual([{ field: "password", from: "********", to: "********" }]);
    expect(api.loginCalls()).toBe(1);
    expect(api.writes).toHaveLength(1);
    expect(api.stored().password).toBe("new-secret");
    expect(JSON.stringify(report)).not.toContain("new-secret");
  });

  test("still rotates a local password the app already accepts when the flag is set", async () => {
    const api = stubHostApi({ id: 1, username: "admin", password: "********" }, undefined, { loginPassword: "new-secret" });
    const sync = new HostConfigSync(new LidarrClient("http://lidarr.test", "key"), "Lidarr", "http://lidarr.test");
    const report = await sync.sync({ local_password: "new-secret", rotate_local_password: true });
    expect(report[0]?.fieldChanges).toEqual([{ field: "password", from: "********", to: "********" }]);
    expect(api.loginCalls()).toBe(0);
    expect(api.writes).toHaveLength(1);
  });

  test("skips the local password probe with test_secrets: false", async () => {
    const api = stubHostApi({ id: 1, username: "admin", password: "" }, undefined, { loginPassword: "generated-secret" });
    const sync = new HostConfigSync(new LidarrClient("http://lidarr.test", "key"), "Lidarr", "http://lidarr.test");
    const report = await sync.sync({ local_username: "admin", local_password: "generated-secret", test_secrets: false });
    expect(report[0]?.fieldChanges).toEqual([{ field: "password", from: "********", to: "********" }]);
    expect(api.loginCalls()).toBe(0);
    expect(api.writes).toHaveLength(1);
  });

  test("falls back to the stored local password when the app cannot answer", async () => {
    const api = stubHostApi({ id: 1, username: "admin", password: "********" }, undefined, { loginUnavailable: true });
    const sync = new HostConfigSync(new LidarrClient("http://lidarr.test", "key"), "Lidarr", "http://lidarr.test");
    expect(await sync.sync({ local_password: "new-secret" })).toEqual([]);
    expect(api.writes).toHaveLength(0);
  });

  test("keeps a declared OIDC secret the authority accepts", async () => {
    const api = stubOidcApi(() => Response.json({ error: "unauthorized_client" }, { status: 400 }));
    const sync = new FederatedHostConfigSync(new RadarrClient("http://radarr.test", "key"), "Radarr", "http://radarr.test");
    const report = await sync.sync({
      oidcAuthority: "https://idp.test",
      oidcClientId: "radarr",
      oidcClientSecret: "declared-secret",
    });
    expect(report).toEqual([]);
    expect(api.tokenBodies).toEqual(["grant_type=client_credentials&client_id=radarr&client_secret=declared-secret"]);
    expect(api.writes).toHaveLength(0);
  });

  test("updates a declared OIDC secret the authority rejects", async () => {
    const api = stubOidcApi(() => Response.json({ error: "invalid_client" }, { status: 401 }));
    const sync = new FederatedHostConfigSync(new RadarrClient("http://radarr.test", "key"), "Radarr", "http://radarr.test");
    const report = await sync.sync({
      oidcAuthority: "https://idp.test",
      oidcClientId: "radarr",
      oidcClientSecret: "declared-secret",
    });
    expect(report[0]?.fieldChanges).toEqual([{ field: "oidcClientSecret", from: "********", to: "********" }]);
    expect(api.writes).toHaveLength(1);
    expect(api.stored().oidcClientSecret).toBe("declared-secret");
  });

  test("falls back to the stored OIDC secret when the authority is unreachable", async () => {
    const api = stubOidcApi(undefined);
    const sync = new FederatedHostConfigSync(new RadarrClient("http://radarr.test", "key"), "Radarr", "http://radarr.test");
    const report = await sync.sync({
      oidcAuthority: "https://idp.test",
      oidcClientId: "radarr",
      oidcClientSecret: "declared-secret",
    });
    expect(report).toEqual([]);
    expect(api.discoveryCalls).toBe(1);
    expect(api.writes).toHaveLength(0);
  });

  test("skips the OIDC probe with test_secrets: false", async () => {
    const api = stubOidcApi(() => Response.json({ error: "invalid_client" }, { status: 401 }));
    const sync = new FederatedHostConfigSync(new RadarrClient("http://radarr.test", "key"), "Radarr", "http://radarr.test");
    const report = await sync.sync({
      oidcAuthority: "https://idp.test",
      oidcClientId: "radarr",
      oidcClientSecret: "declared-secret",
      test_secrets: false,
    });
    expect(report).toEqual([]);
    expect(api.discoveryCalls).toBe(0);
    expect(api.writes).toHaveLength(0);
  });

  test("dry run reports a redacted secret change without writing", async () => {
    vi.stubEnv("DRY_RUN", "true");
    initEnvs();
    let writes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        if (request.method === "PUT") writes++;
        return Response.json({ id: 1, oidcClientSecret: "" });
      }),
    );
    const client = new RadarrClient("http://radarr.test", "key");
    const report = await new FederatedHostConfigSync(client, "Radarr").sync({ oidcClientSecret: "dry-secret" });
    expect(report).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain("dry-secret");
    expect(writes).toBe(0);
  });

  test("maps configured authentication and PEM settings while preserving other fields", async () => {
    let stored: StoredHostSettings = {
      id: 1,
      authenticationMethod: "external",
      authenticationRequired: "enabled",
      oidcAuthority: null,
      oidcClientId: null,
      oidcUserIdentifier: null,
      oidcScopes: null,
      oidcClientSecret: "********",
      enableSsl: false,
      sslCertPath: null,
      sslKeyPath: null,
      allowedHosts: "localhost",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        if (request.method === "PUT") {
          stored = { ...stored, ...(await request.json()) };
          return Response.json({ id: 1 }, { status: 202 });
        }
        return Response.json(stored);
      }),
    );
    const client = new RadarrClient("http://radarr.test", "key");
    await new FederatedHostConfigSync(client, "Radarr").sync({
      authenticationMethod: "oidc",
      authenticationRequired: "disabledForLocalhost",
      allowedHosts: "localhost,127.0.0.1",
      oidcAuthority: "https://identity.example.com",
      oidcClientId: "radarr",
      oidcUserIdentifier: "sub",
      oidcScopes: "openid",
      enableSsl: true,
      sslCertPath: "/config/cert.pem",
      sslKeyPath: "/config/key.pem",
    });
    expect(stored).toMatchObject({
      authenticationMethod: "oidc",
      authenticationRequired: "disabledForLocalhost",
      allowedHosts: "localhost,127.0.0.1",
      oidcAuthority: "https://identity.example.com",
      oidcClientId: "radarr",
      oidcUserIdentifier: "sub",
      oidcScopes: "openid",
      enableSsl: true,
      sslCertPath: "/config/cert.pem",
      sslKeyPath: "/config/key.pem",
      oidcClientSecret: "********",
    });
  });

  test("keeps the masked secret when another field changes", async () => {
    let submitted: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        if (request.method === "PUT") {
          submitted = await request.json();
          return Response.json({ id: 1 }, { status: 202 });
        }
        return Response.json({ id: 1, oidcClientSecret: "********", oidcScopes: "openid" });
      }),
    );
    const client = new RadarrClient("http://radarr.test", "key");
    const report = await new FederatedHostConfigSync(client, "Radarr").sync({
      oidcScopes: "openid profile",
      oidcClientSecret: "private-new-secret",
    });
    expect(submitted.oidcClientSecret).toBe("********");
    expect(submitted.oidcScopes).toBe("openid profile");
    expect(JSON.stringify(report)).not.toContain("private-new-secret");
  });

  test("applies Chaptarr-only OIDC fields when the instance exposes them", async () => {
    const api = stubHostApi({
      id: 1,
      oidcAllowedEmails: null,
      oidcAllowedEmailDomains: null,
      oidcRequireEmailVerified: false,
      oidcAllowAnyVerifiedUser: false,
    });
    const sync = new ChaptarrHostConfigSync(new ReadarrClient("http://readarr.test", "key"), "Readarr");
    const diff = await sync.sync({
      oidc_allowed_emails: "reader@example.com",
      oidc_allowed_email_domains: "example.com",
      oidc_require_email_verified: true,
    });
    expect(diff[0]?.fieldChanges).toEqual([
      { field: "oidcAllowedEmails", from: null, to: "reader@example.com" },
      { field: "oidcAllowedEmailDomains", from: null, to: "example.com" },
      { field: "oidcRequireEmailVerified", from: false, to: true },
    ]);
    expect(api.stored()).toMatchObject({ oidcAllowAnyVerifiedUser: false });
  });

  test("rejects Chaptarr-only OIDC fields on vanilla Readarr", async () => {
    const api = stubHostApi({ id: 1 });
    const sync = new ChaptarrHostConfigSync(new ReadarrClient("http://readarr.test", "key"), "Readarr");
    await expect(sync.sync({ oidc_require_email_verified: true })).rejects.toThrow(
      "Readarr host configuration does not expose oidc_require_email_verified",
    );
    expect(api.writes).toHaveLength(0);
  });

  test("uses Sonarr v5 General settings for authentication changes", async () => {
    const requests: string[] = [];
    let submitted: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        requests.push(`${request.method} ${path}`);
        if (path === "/api") return Response.json({ current: "v5" });
        if (request.method === "PUT") {
          submitted = await request.json();
          return Response.json({ id: 1 }, { status: 202 });
        }
        return Response.json({ id: 1, authenticationRequired: "enabled", oidcClientSecret: "********" });
      }),
    );
    const client = new SonarrClient("http://sonarr.test", "key");
    await new FederatedHostConfigSync(client, "Sonarr").sync({ authenticationRequired: "disabledForLocalhost" });
    expect(submitted.authenticationRequired).toBe("disabledForLocalhost");
    expect(submitted.oidcClientSecret).toBe("********");
    expect(requests).toEqual(["GET /api", "GET /api/v5/settings/general", "PUT /api/v5/settings/general/1"]);
  });

  test("does not disclose secrets echoed in a server validation error", async () => {
    const log = vi.spyOn(logger, "error");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        if (request.method === "PUT") return Response.json([{ errorMessage: "rejected secret leaked-value" }], { status: 400 });
        return Response.json({ id: 1, oidcClientSecret: "" });
      }),
    );
    const client = new RadarrClient("http://radarr.test", "key");
    await expect(new FederatedHostConfigSync(client, "Radarr").sync({ oidcClientSecret: "leaked-value" })).rejects.not.toThrow(
      "leaked-value",
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("leaked-value");
  });

  test("does not disclose a secret returned in a failed host settings read", async () => {
    const log = vi.spyOn(logger, "error");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([{ errorMessage: "server secret read-secret" }], { status: 500 })),
    );
    const client = new RadarrClient("http://radarr.test", "key");
    await expect(new FederatedHostConfigSync(client, "Radarr").sync({ oidcScopes: "openid" })).rejects.not.toThrow("read-secret");
    expect(JSON.stringify(log.mock.calls)).not.toContain("read-secret");
  });

  test("accepts the backup policy on every app and any version", () => {
    const apps = [
      { label: "Lidarr", create: () => new LidarrClient("http://lidarr.test", "key"), Sync: HostConfigSync },
      { label: "Readarr", create: () => new ReadarrClient("http://readarr.test", "key"), Sync: ChaptarrHostConfigSync },
      { label: "Prowlarr", create: () => new ProwlarrClient("http://prowlarr.test", "key"), Sync: HostConfigSync },
    ];
    for (const app of apps) {
      const sync = new app.Sync(app.create(), app.label);
      expect(() => sync.validate(backup)).not.toThrow();
    }
    expect(() => new FederatedHostConfigSync(new RadarrClient("http://radarr.test", "key"), "Radarr").validate(backup)).not.toThrow();
    expect(() => new FederatedHostConfigSync(new SonarrClient("http://sonarr.test", "key"), "Sonarr").validate(backup)).not.toThrow();
    expect(() => new FederatedHostConfigSync(new WhisparrClient("http://whisparr.test", "key"), "Whisparr").validate(backup)).not.toThrow();
  });

  test("syncs and re-reads the backup policy on Lidarr, Readarr and Prowlarr", async () => {
    const apps: Array<{
      label: string;
      path: string;
      create: () => LidarrClient | ReadarrClient | ProwlarrClient;
      Sync: typeof HostConfigSync;
    }> = [
      { label: "Lidarr", path: "/api/v1/config/host", create: () => new LidarrClient("http://lidarr.test", "key"), Sync: HostConfigSync },
      {
        label: "Readarr",
        path: "/api/v1/config/host",
        create: () => new ReadarrClient("http://readarr.test", "key"),
        Sync: ChaptarrHostConfigSync,
      },
      {
        label: "Prowlarr",
        path: "/api/v1/config/host",
        create: () => new ProwlarrClient("http://prowlarr.test", "key"),
        Sync: HostConfigSync,
      },
    ];
    for (const app of apps) {
      const api = stubHostApi({ id: 1, backupFolder: "Backups", backupInterval: 7, backupRetention: 28, logLevel: "info" });
      const sync = new app.Sync(app.create(), app.label);
      const diff = await sync.sync({ backup_interval: 1, backup_retention: 7 });
      expect(diff[0]?.fieldChanges).toEqual([
        { field: "backupInterval", from: 7, to: 1 },
        { field: "backupRetention", from: 28, to: 7 },
      ]);
      expect(api.requests).toEqual([`GET ${app.path}`, `PUT ${app.path}/1`]);
      expect(api.stored()).toMatchObject({ backupFolder: "Backups", backupInterval: 1, backupRetention: 7, logLevel: "info" });

      const second = await sync.sync({ backup_interval: 1, backup_retention: 7 });
      expect(second).toEqual([]);
      expect(api.writes).toHaveLength(1);
      vi.unstubAllGlobals();
    }
  });

  test("uses the versioned Sonarr host endpoint for backup settings", async () => {
    for (const version of ["v3", "v5"] as const) {
      const api = stubHostApi(
        { id: 1, backupFolder: "Backups", backupInterval: 7, backupRetention: 28, authenticationRequired: "enabled" },
        version,
      );
      const sync = new FederatedHostConfigSync(new SonarrClient("http://sonarr.test", "key"), "Sonarr");
      const diff = await sync.sync({ backup_interval: 1 });
      const hostPath = version === "v3" ? "/api/v3/config/host" : "/api/v5/settings/general";
      expect(api.requests).toEqual(["GET /api", `GET ${hostPath}`, `PUT ${hostPath}/1`]);
      expect(diff[0]?.fieldChanges).toEqual([{ field: "backupInterval", from: 7, to: 1 }]);
      expect(api.stored()).toMatchObject({ backupFolder: "Backups", backupInterval: 1, backupRetention: 28 });
      vi.unstubAllGlobals();
    }
  });

  test("syncs the backup policy on Radarr versions before v7", async () => {
    const api = stubHostApi({ id: 1, backupFolder: "Backups", backupInterval: 7, backupRetention: 28 });
    const sync = new FederatedHostConfigSync(new RadarrClient("http://radarr.test", "key"), "Radarr");
    const diff = await sync.sync({ backup_retention: 7 });
    expect(api.requests).toEqual(["GET /api/v3/config/host", "PUT /api/v3/config/host/1"]);
    expect(diff[0]?.fieldChanges).toEqual([{ field: "backupRetention", from: 28, to: 7 }]);
    expect(api.stored()).toMatchObject({ backupFolder: "Backups", backupInterval: 7, backupRetention: 7 });
  });

  test("syncs Whisparr's own settings and the backup policy", async () => {
    const api = stubHostApi({
      id: 1,
      backupFolder: "Backups",
      backupInterval: 7,
      backupRetention: 28,
      whisparrAutoMatchOnDate: true,
      whisparrCorruptFileDetection: false,
    });
    const sync = new FederatedHostConfigSync(new WhisparrClient("http://whisparr.test", "key"), "Whisparr");
    const diff = await sync.sync({ backup_interval: 1, whisparrAutoMatchOnDate: false });
    expect(api.requests).toEqual(["GET /api/v3/config/host", "PUT /api/v3/config/host/1", "GET /api/v3/config/host"]);
    expect(diff[0]?.fieldChanges).toEqual([
      { field: "whisparrAutoMatchOnDate", from: true, to: false },
      { field: "backupInterval", from: 7, to: 1 },
    ]);
    expect(api.stored()).toMatchObject({ whisparrAutoMatchOnDate: false, whisparrCorruptFileDetection: false, backupInterval: 1 });
  });

  test("dry run reports backup changes without writing them", async () => {
    vi.stubEnv("DRY_RUN", "true");
    initEnvs();
    const api = stubHostApi({ id: 1, backupFolder: "Backups", backupInterval: 7, backupRetention: 28 });
    const sync = new HostConfigSync(new LidarrClient("http://lidarr.test", "key"), "Lidarr");
    const report = await sync.sync({ backup_interval: 1 });
    expect(report[0]?.fieldChanges).toEqual([{ field: "backupInterval", from: 7, to: 1 }]);
    expect(api.writes).toHaveLength(0);
  });
});
