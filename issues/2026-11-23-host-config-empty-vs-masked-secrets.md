# Host-config secrets: apps that return empty instead of a mask never converge

**Status:** proposed
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
