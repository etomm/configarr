# Host config: remaining supported fields are not declarable

**Status:** proposed
**Severity:** low — common host settings still require a side script or manual UI changes
**Area:** `src/hostConfig/hostConfigSync.ts`, `src/types/config.types.ts`
**Depends on:** `2026-11-20-host-config-for-the-whole-family.md`

---

## Summary

The transversal host sync manages general settings, credentials, backup, authentication, OIDC, TLS base and the Chaptarr OIDC extras. The same `HostConfigResource` also exposes fields that are still not in `HostConfigSchema`:

### Supported by multiple apps

- `trustedNetworks`
- `sslCertPassword` (secret, write-only)
- `logSizeLimit`
- `consoleLogLevel`
- `applicationUrl`
- `updateScriptPath`

### Prowlarr-only

- `historyCleanupDays`

### Deliberately risky / out of scope

- `bindAddress`, `port`, `sslPort`
- `apiKey`
- the proxy block (`proxyEnabled`, `proxyType`, `proxyHostname`, `proxyPort`, `proxyUsername`, `proxyPassword`, `proxyBypassFilter`, `proxyBypassLocalAddresses`)

Managing `apiKey` would rotate Configarr's own credential mid-run. Listening ports and bind addresses can make the instance unreachable. These should stay unmanaged unless there is a separate, explicit design for safe changes.

## Proposal

1. Add snake_case config fields for the safe/common fields:
   `trusted_networks`, `ssl_cert_password`, `log_size_limit`, `console_log_level`, `application_url`, `update_script_path`.
2. Add `history_cleanup_days` for Prowlarr.
3. Give `ssl_cert_password` the same masked/write-on-empty/rotation semantics as `local_password` and `oidcClientSecret`.
4. Let live capability detection reject a field the target does not expose, with the field name in the error.
5. Document the excluded fields and why.

## Tests

- Unit: general fields apply and preserve auth; `ssl_cert_password` is masked and write-once/rotation.
- Unit: Prowlarr `history_cleanup_days` applies; other apps reject it.
- E2E: Radarr/Sonarr/Lidarr/Prowlarr general field apply + idempotency; host fields not exposed on Readarr are rejected.
