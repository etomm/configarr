import { afterEach, describe, expect, test, vi } from "vitest";
import { probeLocalPassword, probeOidcClientSecret } from "./hostSecretProbe";

function stubFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request | URL | string, init?: RequestInit) => {
      const url = new URL(request instanceof URL || typeof request === "string" ? request : request.url);
      requests.push({ url: url.toString(), init });
      return handler(url, init);
    }),
  );
  return requests;
}

describe("host secret probes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("accepts a Servarr auth cookie and rejects a failed login page", async () => {
    stubFetch(() => new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": "RadarrAuth=session; path=/; httponly" } }));
    await expect(probeLocalPassword("http://radarr.test", "admin", "secret")).resolves.toBe(true);

    stubFetch(() => new Response(null, { status: 302, headers: { Location: "/login?loginFailed=true" } }));
    await expect(probeLocalPassword("http://radarr.test", "admin", "wrong")).resolves.toBe(false);
  });

  test("recognises the ASP.NET auth cookie and ignores unrelated cookies", async () => {
    stubFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: [
            ["Set-Cookie", "Antiforgery=token; path=/"],
            ["Set-Cookie", ".AspNetCore.Cookies=session; path=/; httponly"],
          ],
        }),
    );
    await expect(probeLocalPassword("http://arr.test/base", "admin", "secret")).resolves.toBe(true);
  });

  test("returns undefined when the login endpoint cannot answer", async () => {
    stubFetch(() => new Response(null, { status: 404 }));
    await expect(probeLocalPassword("http://arr.test", "admin", "secret")).resolves.toBeUndefined();

    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(probeLocalPassword("http://arr.test", "admin", "secret")).resolves.toBeUndefined();
  });

  test("posts the credentials to the login endpoint under the url base", async () => {
    const requests = stubFetch(() => new Response(null, { status: 302 }));
    await probeLocalPassword("http://arr.test/base/", "admin", "secret");
    expect(requests[0]?.url).toBe("http://arr.test/base/login");
    expect(requests[0]?.init?.method).toBe("POST");
  });

  test("treats refused grants as proof that the OIDC client authenticated", async () => {
    stubFetch((url) =>
      url.pathname === "/.well-known/openid-configuration"
        ? Response.json({ token_endpoint: "https://idp.test/token" })
        : Response.json({ error: "unauthorized_client" }, { status: 400 }),
    );
    await expect(probeOidcClientSecret("https://idp.test", "radarr", "secret")).resolves.toBe(true);

    stubFetch((url) =>
      url.pathname === "/.well-known/openid-configuration"
        ? Response.json({ token_endpoint: "https://idp.test/token" })
        : Response.json({ error: "invalid_grant" }, { status: 400 }),
    );
    await expect(probeOidcClientSecret("https://idp.test", "radarr", "secret")).resolves.toBe(true);
  });

  test("treats invalid_client as a rejected secret", async () => {
    stubFetch((url) =>
      url.pathname === "/.well-known/openid-configuration"
        ? Response.json({ token_endpoint: "https://idp.test/token" })
        : Response.json({ error: "invalid_client" }, { status: 401 }),
    );
    await expect(probeOidcClientSecret("https://idp.test", "radarr", "wrong")).resolves.toBe(false);
  });

  test("returns undefined for an unreachable or ambiguous authority", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(probeOidcClientSecret("https://idp.test", "radarr", "secret")).resolves.toBeUndefined();

    stubFetch((url) =>
      url.pathname === "/.well-known/openid-configuration"
        ? Response.json({ token_endpoint: "https://idp.test/token" })
        : Response.json({ error: "server_error" }, { status: 500 }),
    );
    await expect(probeOidcClientSecret("https://idp.test", "radarr", "secret")).resolves.toBeUndefined();
  });

  test("does not send the secret without a complete OIDC configuration", async () => {
    const requests = stubFetch(() => Response.json({}));
    await expect(probeOidcClientSecret("", "radarr", "secret")).resolves.toBeUndefined();
    await expect(probeOidcClientSecret("https://idp.test", "", "secret")).resolves.toBeUndefined();
    expect(requests).toHaveLength(0);
  });
});
