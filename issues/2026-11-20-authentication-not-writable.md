# Authentication is only half-writable, which is why every deployment needs a side script

**Status:** proposed
**Severity:** medium — an entire config section cannot be declared, and the workaround duplicates Configarr
**Area:** `src/types/config.types.ts` (`HostConfigSchema`, ~L527), `src/hostConfig/`
**Found in:** `1.39.3-etomm.1`

---

## Summary

`host_config` can write the *mechanism* of authentication but not the *credentials* that mechanism
needs.

`HostConfigSchema` exposes:

```
authenticationMethod      authenticationRequired     allowedHosts
oidcAuthority             oidcClientId               oidcUserIdentifier
oidcScopes                oidcClientSecret           update_oidc_client_secret
enableSsl                 sslCertPath                sslKeyPath
```

and nothing else. There is no field for:

```
username
password
passwordConfirmation
```

That is not an oversight in the YAML — the keys do not exist in the schema, so they cannot be
declared at all.

## Why that matters

The common setup is authentication delegated to a proxy (Authelia, oauth2-proxy) with a local admin
account kept as a fallback:

```yaml
authenticationMethod: external
authenticationRequired: enabled
allowedHosts: ""
username: admin
password: <generated>
```

Configarr can converge the first three. The last two it cannot touch, so the instance is either left
with credentials someone typed in the UI — including defaults — or every deployment grows a small
script that does `GET /api/v1/config/host`, sets `username` / `password` /
`passwordConfirmation`, and `PUT`s it back. That script then also has to re-assert
`authenticationMethod` and `allowedHosts`, because otherwise the two writers take turns.

Once two writers touch the same object, the failure mode is not a diff — it is auth quietly flipping
between `external` and `forms`/`none` depending on which job ran last. This is exactly what happened
here: the seeded instance came with `authenticationMethod: none`, Configarr had no opinion on the
credentials, and a separate `auth-sync` job became the owner of the whole host-config auth block.

Two further consequences of the gap:

- The admin password is outside version control and outside the diff report, so a rotated or
  forgotten credential is invisible.
- The password is returned masked (`********`) by the API, so any future attempt to manage it needs
  the rotation semantics already used for `oidcClientSecret`
  (`property + update_<property>`), not a plain equality comparison.

## Proposal

Pick one, explicitly — the current half-way state is the worst option.

### Option A (recommended): make authentication fully declarable

Extend `HostConfigSchema` and the host-config adapters with:

```yaml
host_config:
  authentication_method: external
  authentication_required: enabled
  allowed_hosts: ""
  local_username: admin
  local_password: <secret>            # write-once, compared as SECRET_MASK
  rotate_local_password: true         # explicit re-write, mirrors update_oidc_client_secret
```

- `local_password` follows the existing `oidcClientSecret` pattern: masked in diffs, only written
  when the rotation flag is set, so it converges instead of churning.
- `passwordConfirmation` is filled from `local_password` internally; it is an API echo field, not a
  config value.
- With this in place, `auth-sync` scripts can be retired and authentication becomes one declared
  section like everything else.

### Option B: declare the boundary and enforce it

If authentication is to stay out of scope, say so in code rather than in a README:

- `manage_authentication: false` (default) removes the auth/OIDC/TLS keys from the writable set;
- validation **errors** when `host_config` declares any of them while the flag is false, naming the
  escape hatch;
- a log line records that authentication is managed externally.

This keeps today's architecture (auth-sync owns auth) but makes it contractual, and stops a future
`host_config` block from silently fighting the side job.

Either way, document the interaction: an `authenticationMethod` of `external` is meaningless without
the forward-auth middleware in front of the instance, which Configarr cannot verify.

## Acceptance criteria

- **A:** `local_username` / `local_password` are applied on the first run, masked in the diff report,
  and report `Unchanged` on the second. With `rotate_local_password: true` the password is written
  once, reported as one intentional change, and then compares equal.
- **A:** a credential left in the instance that differs from the declared one is corrected, including
  when the connection is otherwise working (no reliance on a failure to trigger a write).
- **B:** with `manage_authentication: false`, declaring `authenticationMethod` fails validation with a
  message that names the flag.
- **B:** with the flag false, Configarr performs no write to `authenticationMethod`,
  `authenticationRequired`, `allowedHosts`, OIDC or TLS fields — asserted by a round-trip test.
- Both: no secret value appears in logs or diff output.

## Tests

- `hostConfigSync.test.ts`: credential apply + `SECRET_MASK` in the diff; rotation writes once; second
  run is a no-op.
- `hostConfigSync.test.ts`: auth fields untouched / rejected, per the chosen option.
- A regression test that two consecutive runs produce zero updates for an unchanged instance.

## Risks / notes

- Option A is the cleaner end state but is a security-sensitive change: writing credentials from Git
  means the secret must come from a secret store (`!env`), never a literal in the YAML. State that
  requirement in the docs and keep the value masked on read.
- Option B is mostly a documentation/validation change and can ship quickly; it does not remove the
  need for an auth-sync script, it just makes the split honest.
- `host_config` itself is still Radarr v7 / Sonarr v5 only; Lidarr, Prowlarr and Chaptarr have no
  host-config sync at all (tracked in `2026-11-16-host-config-backup-settings.md`). Option A should
  either land together with that work or be scoped to the two supported types.
