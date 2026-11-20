# Full host-config coverage, so the auth-sync scripts can be deleted

**Status:** proposed
**Severity:** medium — it is the last thing keeping a side script in every deployment
**Area:** `src/hostConfig/`, `src/arr/{lidarr,prowlarr,readarr,chaptarr}Syncer.ts`, `src/types/config.types.ts`
**Found in:** `1.39.3-etomm.1`
**Depends on:** `2026-11-20-authentication-not-writable.md` (credentials + rotation), `2026-11-16-host-config-backup-settings.md` (backup fields on all apps)

---

## Summary

Today every deployment of this stack ships a small `auth-sync` script per app: a CronJob that does
`GET /api/v1/config/host`, sets the authentication fields, and `PUT`s them back. It exists because
`host_config` either cannot express the fields or is not implemented for that app.

The goal of this issue is to make `host_config` sufficient everywhere, so those scripts and their
CronJobs can be **deleted**, and authentication becomes an ordinary declared section.

## Current matrix

| App | Host config adapter | Fields applied |
|---|---|---|
| Radarr | `RadarrHostConfigSync` | full (auth, OIDC, TLS, backup, general after plan 2) |
| Sonarr | `SonarrHostConfigSync` | full |
| Whisparr | `WhisparrHostConfigSync` | full |
| Lidarr | `BackupHostConfigSync` | backup only |
| Prowlarr | `BackupHostConfigSync` | backup only |
| Chaptarr (as Readarr) | `BackupHostConfigSync` | backup only |

`mediaPipeline.ts:239` still throws `host_config requires Radarr v7 or Sonarr v5`, and the three
"backup only" apps accept a `host_config` block whose non-backup keys are dropped without a word.

## What the scripts actually do (the checklist to replace them)

| Setting | Radarr / Sonarr / Lidarr / Prowlarr | Chaptarr |
|---|---|---|
| `authenticationMethod` | `external` | `oidc` |
| `authenticationRequired` | `enabled` | `enabled` |
| `allowedHosts` | `""` | `""` |
| `urlBase` | `/radarr2`, `/sonarr`, … | `/chaptarr` |
| local credentials | `username` / `password` / `passwordConfirmation` | same |
| OIDC | — | authority, clientId, clientSecret, scopes, allowed emails, allowed domains, requireEmailVerified, allowAnyVerifiedUser |
| general | `logLevel`, `analyticsEnabled` | — |
| other | — | UI settings, ebook naming (moves to plans 1/2) |

Nothing above may be lost when the scripts go. `urlBase` in particular has no schema field at all
today — only `calibre_url_base` exists — so it is currently pinned by the script *and* by the
`<APP>__SERVER__URLBASE` environment variable. The plan should decide which one owns it: adding
`url_base` to `host_config` is the cleaner answer if we want the script gone.

## Proposal

1. **Add `ReadarrHostConfigSync`, `LidarrHostConfigSync`, `ProwlarrHostConfigSync`** modelled on the
   Radarr/Sonarr adapters. Wire them in `readarrSyncer.ts`, `lidarrSyncer.ts` and
   `prowlarrSyncer.ts` in place of `BackupHostConfigSync` (which keeps existing as the base class for
   the backup-only behaviour and for apps whose version exposes nothing else).
2. **Relax the gate** in `mediaPipeline.ts`: version-dependent fields are validated per field, not per
   app. A field the target's version does not expose is an error naming the field, not a blanket
   "requires Radarr v7 or Sonarr v5".
3. **Add `url_base`** to `HostConfigSchema` and the adapters, so the URL base is declarable instead of
   script-pinned. Keep the env var supported; if both are present they must agree, otherwise the sync
   should win and say so in the log.
4. **Chaptarr's fork-specific fields**: `oidcAllowedEmails`, `oidcAllowedEmailDomains`,
   `oidcRequireEmailVerified`, `oidcAllowAnyVerifiedUser`. These exist only on the fork, so gate them
   behind the Readarr/Chaptarr target rather than adding them to the vanilla Readarr contract.
5. **Retirement procedure** (documented, per app):
   - declare `host_config` including credentials and `url_base`;
   - run with `DRY_RUN=true` and confirm the diff is exactly the intended fields;
   - apply, verify the UI still authenticates (both the forward-auth path and the local account);
   - delete the `auth-sync` CronJob and its ConfigMap from the app's kustomization;
   - confirm a second Configarr run is clean.

## Acceptance criteria

- For each of Lidarr, Prowlarr and Chaptarr, declaring the auth block produces the expected diff and
  applies it; a second run reports no changes.
- A drift test (change `authenticationMethod` in the UI, run the job) corrects it, proving the
  declaration is authoritative.
- `url_base` is applied from YAML and converging.
- After the retirement steps, an app runs with no `auth-sync` CronJob and keeps its auth stable across
  nightly runs.
- Unsupported fields on an older version fail validation with the field name in the message.

## Tests

- One `hostConfigSync` suite per new adapter: apply, idempotency, preserve unrelated fields.
- Chaptarr: OIDC block including the fork-only fields; assert vanilla Readarr rejects them.
- `url_base`: applied, idempotent, and disagreement with the env var logs a warning.
- Regression: an app without a full adapter still rejects auth fields explicitly (no silent drop) —
  this is the validation half of `2026-11-20-settings-parsed-but-never-sent.md`.

## Risks / notes

- **Lockout.** Writing `authenticationMethod`/credentials wrong can make the UI unreachable. Apply
  credentials first, switch the method last, and keep a documented break-glass (`kubectl set env` or
  editing `config.xml`/DB) in the retirement notes.
- **Two writers during migration.** Do not declare auth in Configarr while the script still runs; the
  retirement order above avoids the overlap.
- **Fork drift.** Chaptarr's host API will move faster than Readarr's. Keep fork-only fields isolated
  in one adapter so a Chaptarr change does not touch the others.
- Once this lands together with the other two plans, the `auth-sync` scripts, their ConfigMaps and
  their CronJobs can be removed from every app in the homelab repo — that is the actual success
  criterion, not just "the fields exist".
