# Auth ownership: one writer, and secrets that can actually converge

**Status:** proposed
**Severity:** medium — two writers can fight over authentication, and password updates never settle
**Area:** `src/types/config.types.ts` (`HostConfigSchema`), `src/downloadClients/`, `src/notifications/`, `src/hostConfig/hostConfigSync.ts`
**Found in:** `1.39.3-etomm.1`

---

## Summary

Two problems with the same root: Configarr treats authentication and credentials as ordinary mutable
fields, while in practice they have a single legitimate owner and a comparison model that does not
work.

### 1. Authentication has two possible writers

`HostConfigSchema` exposes `authenticationMethod`, `authenticationRequired`, `allowedHosts`, the OIDC
block, `enableSsl`, `sslCertPath` and `sslKeyPath`. A deployment that puts authentication behind a
forward-auth proxy (Authelia in our case) therefore has two candidates writing those fields:

- an auth-sync job doing `GET` → set → `PUT /config/host`, and
- Configarr, if the same keys appear in `host_config`.

Whichever runs last wins. Symptoms are auth quietly flipping between `external` and whatever the other
writer believes, exactly the failure mode the side job was meant to prevent.

The right split, stated plainly: **Configarr owns configuration; auth-sync owns authentication.** Auth
is not a setting to converge, it is a security boundary with an external system of record.

### 2. Masked passwords can never compare equal

The API returns stored credentials masked (`********`). With `update_password: true` on download
clients (and the equivalent for notifications, root folders with Calibre, etc.), Configarr compares
the declared secret with the masked value returned by the server. They never match, so the client is
rewritten and re-tested **on every run**, forever:

```
Download clients diff - Create: 0, Update: 1, Unchanged: 1     <- same client, every run
```

`update_password: false` stops the churn but also means a wrong password is never corrected — which
is how a stale Deluge password survived several applies until the connection test failed.

## Proposal

1. **Make auth ownership explicit.** Options, in order of preference:
   - a per-instance `manage_authentication: false` (default) that removes the auth/OIDC/TLS keys from
     the writable set, so they can only be set by something else; and
   - a validation error when `host_config` declares an auth field while `manage_authentication` is
     false, instead of silently dropping it.

   `host_config` should keep the backup policy and the general settings from the sibling issue; only
   the security fields move behind the switch.
2. **Model secret rotation instead of secret comparison.** A secret is either:
   - **declared as a placeholder** — the server value is accepted as correct (compare as equal), or
   - **declared with an explicit rotation flag** (`password_rotate: true` / `rotate_credentials:`),
     which writes it once and then compares equal thereafter.

   Follow the pattern already used for `oidcClientSecret` (`SECRET_MASK` + `rotateSecret`), and apply
   it uniformly to download clients, notifications, Calibre and any other masked field.
3. **Report secret writes distinctly** in the diff report — a rotated secret should be visible as an
   intentional change, not as a permanent one-line diff.

## Acceptance criteria

- With `manage_authentication: false`, a `host_config` block containing `authenticationMethod` is
  rejected at validation with a message naming the escape hatch.
- With auth managed elsewhere, Configarr never changes `authenticationMethod`, `authenticationRequired`,
  `allowedHosts`, OIDC or TLS fields — verified by a round-trip test.
- A download client with a password declared as a placeholder reports `Unchanged` on the second run.
- A client with `password_rotate: true` writes once, reports one change, and is `Unchanged`
  afterwards.
- A genuinely wrong password is still corrected when its test fails (existing
  `update_password_on_test_fail` behaviour preserved).

## Tests

- `hostConfigSync.test.ts`: auth fields untouched when disabled; error when declared while disabled.
- `downloadClientReadarr.test.ts` / Radarr equivalent: placeholder → unchanged; rotation → one diff
  then stable; test-failure path still writes.
- A regression test asserting two consecutive runs produce zero updates for the same client.

## Risks / notes

- This is a breaking change for anyone relying on Configarr to set auth today. Gate it behind the new
  flag with a deprecation note, and default `manage_authentication` to `true` for one release if
  compatibility matters more than correctness.
- The masked-comparison problem also affects `extraComparableFields` in `rootFolderReadarr.ts`, which
  already excludes `password` by hand. Centralise the rule rather than excluding per adapter.
