# Chaptarr host config rejects `authenticationMethod: oidc`

**Status:** implemented in `v1.39.3-etomm.7` (`a8a509f`) — superseded for the migration by the empty-secret issue below
**Severity:** medium — Chaptarr's authentication cannot be declared, so every deployment keeps a side script
**Area:** `src/hostConfig/hostConfigSync.ts`
**Found in:** `1.39.3-etomm.5`

---

## Summary

`HostConfigSync.validate()` rejects the fork's own authentication method before any app-specific handling:

```ts
const authenticationMethods = new Set(["none", "basic", "forms", "external"]);
...
if (config.authenticationMethod !== undefined && !authenticationMethods.has(config.authenticationMethod)) {
  throw new ConfigValidationError(`Unsupported authenticationMethod '${config.authenticationMethod}'`);
}
```

Chaptarr supports `oidc` — its host resource has the full OIDC block, and a plain `PUT /api/v1/config/host`
with `authenticationMethod: "oidc"` is accepted by the running instance (that is how the OIDC login is
configured today). But because `ChaptarrHostConfigSync` inherits the global set, this config is
rejected outright:

```yaml
chaptarr:
  chaptarr:
    media_type: mixed
    host_config:
      authenticationMethod: oidc
      oidcAuthority: https://example.com
      oidcClientId: dolguldur
      oidcClientSecret: !env OIDC_CLIENT_SECRET
      # ... fork fields
```

```
ConfigValidationError: Unsupported authenticationMethod 'oidc'
  at ChaptarrHostConfigSync.validate (hostConfigSync.ts:47090)
```

The practical consequence: Chaptarr's authentication (method, OIDC block, local admin fallback,
`allowedHosts`, `urlBase`, UI) has to stay in a separate script that does `GET` → mutate → `PUT`
against `/config/host`. That script is exactly what `2026-11-20-host-config-for-the-whole-family.md`
was meant to make unnecessary; the other four apps in the same deployment migrated cleanly and their
scripts were deleted.

## Why the global set is wrong here

`oidc` is not a Chaptarr invention layered on Readarr — it is the method this fork expects when the
OIDC fields are present. Readarr itself accepts `external`/`forms`/`basic`/`none`, so the set cannot
simply be extended globally: Radarr/Sonarr/Lidarr/Prowlarr/Whisparr should still reject `oidc` with a
clear error rather than pass it through to an API that does not understand it.

## Proposal

Make the allowed methods app-specific:

1. Keep the base set on `HostConfigSync` (Radarr/Sonarr/Lidarr/Prowlarr/Whisparr).
2. Override it in `FederatedHostConfigSync`/`ChaptarrHostConfigSync` to include `"oidc"` (and
   `"external"`, which the fork also accepts).
3. Validate declared `authenticationRequired` against the same per-app set (Chaptarr accepts the same
   three values today, so this is only a guard against typos).
4. Prefer asking the app when possible: if the host resource exposes its allowed methods in the API
   schema, validate against that instead of a hard-coded list. If it does not, keep the per-class set
   and document why.

## Acceptance criteria

- `host_config` with `authenticationMethod: oidc` and the OIDC block applies to a Chaptarr instance and
  a second run reports no changes (including `oidcClientSecret`, which must compare as `SECRET_MASK`
  unless `update_oidc_client_secret: true`).
- The fork-only fields (`oidc_allowed_emails`, `oidc_allowed_email_domains`,
  `oidc_require_email_verified`, `oidc_allow_any_verified_user`) round-trip unchanged.
- Declaring `oidc` on Radarr/Sonarr/Lidarr/Prowlarr/Whisparr still fails with the app-named error.
- With this in place, the Chaptarr `auth-sync` CronJob can be removed, like the other four apps.

## Tests

- Unit: `ChaptarrHostConfigSync.validate({ authenticationMethod: "oidc" })` does not throw; the base
  sync still throws for `oidc`.
- Unit: `authenticationRequired` invalid value rejected for every app.
- E2E: `tests/arr-e2e/chaptarr.e2e.test.ts` — apply `authenticationMethod: oidc` plus the OIDC block,
  assert the server state and an idempotent second run; assert the secret is masked in the diff.

## Risks / notes

- `oidc` on a non-fork app must remain an error; do not widen the global set.
- The OIDC client secret is masked on read, so the same rotate-vs-compare rules as `local_password`
  apply: never compare the masked value, only write when rotation is requested.
- If Chaptarr later adds another method, the per-app set is a single place to update — this is also an
  argument for reading the allowed values from the API if the schema ever exposes them.


## Implementation status (v1.39.3-etomm.7, `a8a509f`)

Shipped exactly as proposed: `authenticationMethods()` became an overridable method, the base set keeps
`none/basic/forms/external`, and `ChaptarrHostConfigSync` overrides it with the base set plus `oidc`.
The validation error now names the app: `<app> does not support authenticationMethod '<value>'`.

Verified against the live instance: a Chaptarr `host_config` with `authenticationMethod: oidc` and the
OIDC block now validates and runs (no `Unsupported authenticationMethod` error).

**The migration is still blocked by a different gap**, discovered in the same dry run: Chaptarr returns
empty strings rather than a mask for `password` and `oidcClientSecret`, so those fields never compare
equal and the job would rewrite the host config every run. See
`2026-11-23-host-config-empty-vs-masked-secrets.md`.