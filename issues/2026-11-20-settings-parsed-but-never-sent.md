# Settings parsed but never sent: general host fields and Prowlarr's UI config

**Status:** proposed
**Severity:** medium — the YAML validates, the diff stays silent, and the setting is simply never applied
**Area:** `src/types/config.types.ts` (`HostConfigSchema`), `src/hostConfig/`, `src/arr/prowlarrSyncer.ts`, `src/uiConfigs/uiConfigSyncer.ts`
**Found in:** `1.39.3-etomm.1`

---

## Summary

Two independent cases where a setting is accepted by the schema but cannot reach the server. Both are
invisible: no error, no diff entry, no log line. They were found by comparing a hand-managed instance
against its declared config and noticing fields that never moved.

### 1. General host settings are not in `host_config`

`HostConfigSchema` (strict) covers authentication, the OIDC block, TLS and the backup policy. It has
no field for the rest of Settings → General:

- `logLevel`
- `analyticsEnabled`
- `updateAutomatically`, `updateMechanism`, `branch`
- `instanceName`, `launchBrowser`, `certificateValidation`

Declaring any of them fails validation (strict schema), so there is no silent drop — but the setting
is equally unreachable. In practice these end up enforced by a side job (a script doing
`GET/PUT /config/host`), which is exactly the duplication this project exists to remove. `logLevel`
in particular is a common drift source: an instance left on `debug` after troubleshooting stays there.

Related, and already tracked separately: `host_config` is implemented only for Radarr v7 and Sonarr
v5 (see `2026-11-16-host-config-backup-settings.md`). This issue is about the *fields*, not the
targets.

### 2. Prowlarr accepts `ui_config` and ignores it

`mediaPipeline.ts:426` performs the UI sync:

```ts
const uiConfigResult = await syncUiConfig(client, arrType, config.ui_config);
```

`src/arr/prowlarrSyncer.ts` does not use `mediaPipeline` — it orchestrates its own sections (host
config, download clients, notifications, providers, tags) and never imports `syncUiConfig`. So a
Prowlarr instance with `ui_config` validates, runs, reports "everything unchanged", and changes
nothing. Confirmed on a live instance: the block was declared, the diff reported no difference, and
the values stayed at their old settings.

## Proposal

1. **Extend `HostConfigSchema` and the adapters** with the general fields above. Follow the existing
   pattern: map a curated field list to the host API names, compare only those, and leave everything
   else (auth, OIDC secrets) untouched.
2. **Call the UI sync from the Prowlarr syncer**, mirroring `mediaPipeline`: `syncUiConfig`,
   `uiConfigDiffToDiffEntries`, same ordering guarantee (naming → media management → UI → profiles).
3. **Make silent no-ops impossible.** Cheapest version: during validation, warn (or error, behind a
   flag) when a section is present in the config but the target arr type does not implement it.
   Restrict the check to sections that are parsed for every type — `ui_config`, `media_naming_api`,
   `quality_profiles`, `media_management` — and list the types that support each. A section silently
   doing nothing is worse than a rejected config.

## Acceptance criteria

- `log_level: info` and `analytics_enabled: false` in `host_config` produce a diff entry and are
  applied; a second run reports no change.
- `ui_config` on Prowlarr produces a diff entry and is applied; the UI values change on the live
  instance.
- Declaring `ui_config` on an arr type without UI support produces a warning naming the section and
  the type.
- No change to vanilla Radarr/Sonarr behaviour when the new keys are absent.

## Tests

- `hostConfigSync.test.ts`: apply `logLevel`/`analyticsEnabled`; ensure auth/OIDC fields are still
  preserved from the live object (the merge must not clear them).
- `prowlarrSyncer.test.ts`: a `ui_config` block results in exactly one `syncUiConfig` call and a
  corresponding diff entry.
- Validation: `ui_config` against each arr type yields the expected support matrix.

## Risks / notes

- `updateAutomatically` and `branch` interact with the image-updater setup most of us use; applying
  them from Configarr could fight a GitOps image bump. Document the interaction before enabling, or
  leave those two out; `logLevel` and `analyticsEnabled` are the safe core.
- Keep the strict schema. Strictness is what turned a silent drop into an error for Radarr back in
  the day; the general fields must be added explicitly, not via passthrough.
