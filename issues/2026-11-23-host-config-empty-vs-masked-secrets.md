# Host-config secrets: apps that return empty instead of a mask never converge

**Status:** implemented — validation by testing, with `test_secrets` as the escape hatch
**Severity:** medium — declaring a secret for such an app rewrites `config/host` on every run, so the config is never idempotent
**Area:** `src/hostConfig/hostConfigSync.ts`
**Found in:** `1.39.3-etomm.7`

---

## Summary

`syncHostConfig` assumes the host API answers with the `********` mask for secret fields. Chaptarr
answers with **empty strings**:

```
GET /chaptarr/api/v1/config/host
  username:          "admin"
  password:          ""          <- not "********"
  oidcClientSecret:  ""          <- not "********"
```

Consequence with `2026-11-22-chaptarr-oidc-auth-method-rejected.md` fixed (so `oidc` validates), a
declared `host_config` produces a permanent diff:

```
HostConfig (1 change)
  ~ General
      oidcClientSecret: ******** -> ********
      password: ******** -> ********
```

It is not a cosmetic diff: the job replays the change and PUTs the host resource on every run.

## Why the current logic writes

```ts
// oidcClientSecret
options.rotateOidcSecret ||
(current.oidcClientSecret !== SECRET_MASK && current.oidcClientSecret !== config.oidcClientSecret)
```
`"" !== "********"` and `"" !== <secret>` → always true.

```ts
// local_password
options.rotateLocalPassword || current.password == null || current.password === ""
```
`"" === ""` → always true. This branch exists to bootstrap a password the API never reports; on an app
that *always* returns empty, it can never become false.

Radarr/Sonarr/Lidarr/Prowlarr/Whisparr are unaffected: they return the mask, so a declared secret
compares equal and the migrated setups report "up to date".

## Proposal

Decide what "the API returned empty/null for a secret" means, and make it explicit per app:

1. **Treat empty/null like the mask** — i.e. "a value exists but is not readable" — when a secret is
   declared and rotation is not requested. Writing then requires `rotate_local_password: true` /
   `update_oidc_client_secret: true` once (bootstrap), after which the field is stable.
2. Alternatively add a per-app capability flag (e.g. `secretsAreMasked: boolean`), defaulting to
   `true`, and set it to `false` for Chaptarr. Same behaviour, no guessing.
3. Never treat "empty" as "unset" for a secret field: unset is `null`/absent, and both are already
   distinct states in the API.

Option 1 is smaller and keeps the config surface unchanged; option 2 is safer if another app behaves
differently.

## Acceptance criteria

- Chaptarr `host_config` with `local_password` and `oidcClientSecret` declared: one apply (with the
  rotation flags on) writes them; a second apply with the flags off reports no changes.
- A secret declared without rotation on an app that returns empty does **not** produce a diff.
- Radarr/Sonarr/Lidarr/Prowlarr behaviour is unchanged (mask → compares equal).
- With this fixed, the Chaptarr `auth-sync` CronJob can be deleted like the other four apps.

## Tests

- Unit: server `password: ""` + `rotate_local_password: false` → no change; `rotate_local_password: true`
  → one change, then none after the flag is removed.
- Unit: server `oidcClientSecret: ""` / `null` / `"********"` → no change in all three cases without
  rotation.
- E2E (`tests/arr-e2e/chaptarr.e2e.test.ts`): apply the host auth block once with rotation, assert the
  server state, then a second run with the flags off reports "up to date".

## Risks / notes

- Do not weaken the "wrong password is corrected on test failure" behaviour for download clients — that
  is a different path and relies on a connection test, which host-config secrets do not have.
- If option 1 is chosen, the first apply after upgrading needs the rotation flags set explicitly, which
  is worth a line in the docs alongside the existing `oidcClientSecret` rotation note.

## Validation by testing (empirical, 2026-11-23)

Rather than compare an unreadable value, ask the app — the same idea as the download-client connection
test. Probed against a live deployment (Chaptarr `0.9.1000`, Radarr/Sonarr/Lidarr/Prowlarr current).

### Local admin password: `POST <urlBase>/login` works on every app

```
app       authMethod   GET /login   POST /login (correct pw)      POST /login (wrong pw)
radarr    external     200          302 + auth cookie             302, no cookie
sonarr    external     200          302 + auth cookie             302, no cookie
lidarr    external     200          302 + auth cookie             302, no cookie
prowlarr  external     200          302 + auth cookie             302, no cookie
chaptarr  oidc         200          302 + auth cookie             302, no cookie
```

Key details for an implementation:

- Form fields are `username`, `password`, `rememberMe` (form-encoded), at `/<urlBase>/login`.
- **The status code does not discriminate** — both outcomes are `302`. The signal is the `Set-Cookie`
  auth cookie: present on success, absent on failure. A test must inspect the response headers, not
  just the code.
- It works even when `authenticationMethod` is `external` or `oidc`: the local account is still
  validated by the app itself, which is exactly the fallback account these secrets represent.

### OIDC client secret: testable at the authority, with a caveat

```
POST <issuer>/api/oidc/token   grant_type=client_credentials

correct secret → 400 {"error":"unauthorized_client"}   (client auth OK, grant not allowed)
wrong secret   → 401 {"error":"invalid_client"}        (client auth failed)
bogus code + correct secret (authorization_code) → 400 {"error":"invalid_grant"}
```

So `invalid_client` is the only "secret is wrong" answer; `unauthorized_client` / `invalid_grant` mean
authentication succeeded. No token needs to be minted to answer the question.

**Reachability is the catch.** Configarr's job runs with the Dolguldur egress placement, and from a pod
with the same nodeSelector/toleration the IdP was initially unreachable:

```
node-role worker + valinor.ercole.li/egress: dolguldur-vlan → discovery=000 (timeout)
Proxmox host (same LAN)                                      → discovery=200
```

The cause is not DNS: both views resolve `mandos.doomring.valinor.ercole.li` to the Traefik LAN VIP
`192.168.0.48`. Pods simply cannot reach that VIP, while they *can* reach the ingress Service
(`10.43.103.193`). Pinning the name to the ClusterIP in CoreDNS fixes it cluster-wide — same name,
same issuer, same `mandos-tls` certificate — and after that the probe works from a pod:

```
getent hosts mandos.doomring.valinor.ercole.li → 10.43.103.193
discovery                                       → 200
client_credentials, correct secret              → 400 unauthorized_client
client_credentials, wrong secret                → 401 invalid_client
```

So the OIDC probe is viable wherever split-DNS or routing makes the authority reachable from the job;
otherwise it must degrade to the rotation flag.

### Proposed algorithm

```
local_password declared:
  POST /login with local_username + local_password
  cookie present  → treat as equal, do not write (regardless of what GET reports)
  cookie absent   → write (or rotate, see below), then optionally re-test
  network error   → fall back to today's behaviour (declared-secret comparison / rotation flag)

oidcClientSecret declared:
  resolve issuer from oidcAuthority (discovery document)
  POST token endpoint, grant_type=client_credentials
  401 invalid_client → write
  anything else      → treat as equal
  unreachable        → fall back to rotation flag only
```

Recommendations:

- One attempt, no retries: never turn this into a brute-force loop, and never log the credentials or
  the responses beyond the error code.
- Keep the explicit rotation flags. A test can prove "this works", but only a human knows "I want to
  replace it" when both old and new work — e.g. rotating to a new password that happens to be valid
  elsewhere is impossible to distinguish from a no-op. Rotation remains the intent signal; the test
  prevents pointless rewrites.
- Add a `test_secrets: false` escape hatch, because a login per app per run has a cost and some
  deployments cannot reach the IdP.

This approach would remove the need for the empty-vs-mask special case entirely: the empty string never
enters the comparison, because the app itself answers whether the declared credential is the one in
use.

## Implementation (validation by testing)

`src/hostConfig/hostSecretProbe.ts` performs the probes; `syncHostConfig` treats a probe answer as the
comparison and falls back to the stored-value rules when it gets `undefined`.

- `local_password`: one `POST <base_url>/login` with the declared `local_username` (or the live
  username). An `*Auth`/ASP.NET auth cookie means the app already accepts it; a rejection writes the
  declared credentials. A 2xx/3xx/401/403 without that cookie is a rejection; any other status,
  network failure or timeout returns `undefined`.
- `oidcClientSecret`: discovery from `oidcAuthority` plus `client_credentials` at the token endpoint.
  `401 invalid_client` writes; `unauthorized_client`/`invalid_grant` (and a 2xx) mean the client
  authenticated; anything else returns `undefined`.
- Rotation flags still force a write without probing, so a valid-but-unproven secret can be bootstrapped.
- `test_secrets: false` disables both probes. `ssl_cert_password` has no endpoint and keeps the old
  stored-value behaviour.
- Probe attempts are single-shot and logged by outcome only, never with credentials or response bodies.

The empty string is still read as unreadable when the probe cannot answer, so an unreachable IdP or a
login endpoint the app refuses degrades to the existing rotation-flag semantics. `local_password`
probing is covered by the Radarr v5/v6 e2e; the v7 federated login endpoint rejects the local account
even when the same credentials are accepted by v5/v6, so that project skips the check. Chaptarr's host
API in the e2e container does not persist local credentials or `authenticationMethod`, so its live
coverage remains the unit fixtures and the stored-value fallback.
