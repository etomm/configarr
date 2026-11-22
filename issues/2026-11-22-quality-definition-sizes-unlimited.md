# Quality-definition sizes: unlimited values, per-app field sets and a `unlimited` keyword

**Status:** implemented in `v1.39.3-etomm.5` (`c1588a5`) — one residual gap, see "Implementation status" at the end
**Severity:** medium — a valid, common server state cannot be expressed without a misleading validation warning or an invented number
**Area:** `src/types/trashguide.types.ts`, `src/types/config.types.ts`, `src/qualityDefinitions/`, `tests/arr-e2e/`
**Found in:** `1.39.3-etomm.4`

---

## Summary

`TrashQualityDefinitionQualitySchema` requires `min`, `preferred` and `max` as plain numbers:

```ts
export const TrashQualityDefinitionQualitySchema = z.object({
  quality: z.string(),
  title: z.string().optional(),
  min: z.number(),
  preferred: z.number(),
  max: z.number(),
});
```

Every *arr app models these as nullable, and "no limit" is a first-class state:

- Radarr `BR-DISK` / `Raw-HD` and readarr `FLAC` ship with `maxSize = null`;
- the UI encodes "Unlimited" as `null` at the slider end;
- Lidarr has lossless rows with `preferredSize = null` (see evidence below).

A config that mirrors such an instance either invents a limit or omits the field, and omitting produces:

```
Validation warning [config file]: radarr.radarr.quality_definition.qualities.0.max:
  Invalid input: expected number, received undefined
lidarr.lidarr.quality_definition.qualities.31.preferred:
  Invalid input: expected number, received undefined
```

Both configs are correct and report "up to date"; the warning is a schema limitation, not drift.

## Upstream evidence

Gathered from `Radarr/Radarr@develop`, `Sonarr/Sonarr@develop`, `Lidarr/Lidarr@develop`,
`Readarr/Readarr@develop`, `Chaptarr/chaptarr@develop`, `Whisparr/Whisparr@{v2-develop,eros}`.

| App | Size fields | Nullable | Server validation |
|---|---|---|---|
| Radarr 5/6/7 | min, preferred, max | all `double?` | 0–2000; ordering checked only when both values present |
| Sonarr v4 (API v3) | min, preferred, max | all `double?` | same as Radarr |
| **Sonarr v5 (API v5)** | **none on the QD resource** — sizes live on profile items | nullable there | 0–1000 on profile items |
| Lidarr v2/v3 | min, preferred, max | all `double?` | **none** — no validator, no limits endpoint |
| **Readarr / Chaptarr** | **min, max only — no `preferredSize`** | `double?` | none; size check disabled (`"size restriction not implemented"`) |
| Whisparr v2/v3 | min, preferred, max | all `double?` | Radarr's validator |

Meaning of the values:

- `AcceptableSizeSpecification` (Radarr/Sonarr/Lidarr):
  `if (!MaxSize.HasValue || MaxSize.Value == 0) → "Max size is unlimited, skipping check"`.
  **So both `null` and `0` mean unlimited**; the UI sends `null`.
- The UI's slider maps its maximum to `null` (`maxSize: sliderMaxSize === slider.max ? null : …`).
- An omitted field on `PUT` **clears** the stored column (straight `ToModel()` mapping), which is why
  Configarr must keep copying the server object before writing.
- Lidarr's null `preferred` is a **migration artifact**, not the seed default:
  `075_quality_definition_preferred_size` did `PreferredSize = MaxSize - 5 WHERE MaxSize > 5`, leaving
  null for rows whose max was null. It is supported state (nullable column, UI can emit `null`), but a
  fresh instance seeds `PreferredSize = 895`.

## Proposal

### 1. Keep the TRaSH schema strict, add two config schemas

TRaSH-Guide data always carries all three numbers; user config does not. Split them:

```ts
// unchanged, still strict — TRaSH quality-size JSON only
export const TrashQualityDefinitionQualitySchema = z.object({
  quality: z.string(), title: z.string().optional(),
  min: z.number(), preferred: z.number(), max: z.number(),
});

// Base: apps whose API has no preferred size (Readarr, Chaptarr)
export const InputConfigQualityDefinitionQualityBaseSchema = z.object({
  quality: z.string(),
  title: z.string().optional(),
  min: SizeValueSchema.optional(),
  max: SizeValueSchema.optional(),
}).superRefine(atLeastOneSize);

// Preferred: apps that expose preferredSize (Radarr, Sonarr v4, Lidarr, Whisparr)
export const InputConfigQualityDefinitionQualityPreferredSchema =
  InputConfigQualityDefinitionQualityBaseSchema.extend({
    preferred: SizeValueSchema.optional(),
  });
```

`SizeValueSchema` accepts a number, `"unlimited"`, or `null` (see point 2). The instance schema selects
the variant by app: Readarr/Chaptarr → base (reject `preferred` with a *clear* error rather than
silently dropping it); Radarr/Sonarr v4/Lidarr/Whisparr → preferred.

### 2. Accept the keyword `unlimited`

```yaml
quality_definition:
  qualities:
    - quality: BR-DISK
      min: 187.4
      preferred: 350
      max: unlimited        # equivalent to max: null
    - quality: Raw-HD
      min: 187.4
      preferred: 350
      max: unlimited
```

- `unlimited` is normalised to `null` in the internal model and in the diff report (report `null`, or
  print `unlimited` in the human-readable line for clarity).
- `null` keeps working as an alternative spelling.
- Only the "upper" concept is affected: `min: unlimited` makes no sense and should be rejected;
  `preferred: unlimited` means "no preferred size" and is allowed on apps that have the field.

### 3. Diff semantics

| Declared | Meaning | Behaviour |
|---|---|---|
| field absent | unmanaged | do not compare, do not send; server value preserved |
| number | explicit | compare and write |
| `unlimited` / `null` | explicitly cleared | diff `from: <number>, to: null`, PUT `null` |
| `preferred: 0` | a real zero | must be written, not skipped |

Required code changes:

- `applyPreferredSizeDiff` currently uses `if (clonedQuality.preferred && …)` — truthiness means
  `preferred: 0` is silently ignored, and `null` is indistinguishable from "unset". Switch to
  `!== undefined` and handle `null` explicitly.
- For `max`, **treat server `null` and server `0` as equal** when comparing, otherwise a config with
  `max: unlimited` rewrites the row on every run.
- `interpolateSize(min, max, pref, ratio)` cannot handle null (`null - n`): reject `preferred_ratio`
  for entries that declare `unlimited`, or fall back to the TRaSH numbers.

### 4. Sonarr v5

Sonarr v5 has no sizes on `/qualitydefinition`; sizes live on profile items and a QD PUT carrying them
is silently ignored. The base/preferred split must therefore not be applied blindly to v5: a config
that sets QD sizes should produce a warning ("ignored on Sonarr v5; set quality_sizes on the profile")
instead of a silent no-op. `quality_sizes` itself should accept `unlimited` too.

## Tests

Unit (`src/qualityDefinitions/*.test.ts`):

- omitted size validates without warning and produces no diff;
- `max: unlimited` against server `200` → one change to `null`;
- `max: unlimited` against server `null` → no diff;
- `max: unlimited` against server `0` → no diff (null/0 equivalence);
- `preferred: 0` → written once, then stable;
- `preferred` on a Readarr/Chaptarr instance → validation error naming the app;
- `preferred_ratio` + `unlimited` → validation error;
- TRaSH data with a missing size still fails validation.

E2E (`tests/arr-e2e/`, the harness already runs Radarr 5.28/6.4/7.0, Sonarr 4+5, Lidarr, Readarr,
Chaptarr, Whisparr and already snapshots/restores quality definitions):

- Radarr: assert `BR-DISK`/`Raw-HD` are `maxSize === null`; sync `max: unlimited`; assert no diff and
  still `null`;
- Lidarr: PUT `preferredSize: null` (the migration state), then assert Configarr preserves it and does
  not churn;
- Readarr/Chaptarr: `FLAC` `maxSize === null`, and `preferred` is not present in the payload;
- Sonarr v5: QD size config yields the warning, not a silent drop.

## Acceptance criteria

- The two warning lines quoted above disappear for a config that mirrors a real instance.
- `max: unlimited` is accepted, normalised to `null`, and is idempotent across consecutive runs.
- A second run of every affected app reports "up to date".
- Readarr/Chaptarr reject `preferred` with a message that names the app, instead of dropping it.
- TRaSH-Guide parsing behaviour is unchanged (strict numbers).
- No change for existing configs that declare plain numbers.

## Risks / gotchas

- **Partial PUT clears fields.** "absent = unmanaged" is only safe because the syncer copies the server
  object before writing; any future code path that builds a fresh payload must be audited.
- **Rounding.** Sizes are floats; compare with the same rounding already applied by `roundToDecimal`
  or null-equivalence tests will flake.
- **Lidarr has no bounds**, so `unlimited` there is purely "no check"; do not "fix" values above the
  UI's clamp.
- **Sonarr v5's profile-size validator has a self-comparison bug** (`MinSize <= MinSize`), so it does
  not reject `min > preferred`; do not rely on it for validation.
- Naming: `unlimited` as a keyword is a config-surface decision. Keep `null` supported so existing
  YAML and generated configs do not break.

## Implementation status (v1.39.3-etomm.5, `c1588a5`)

Shipped and matching this issue:

- `SizeValueSchema` accepting a number, `"unlimited"` and `null`, normalised to `null`;
  `MinSizeValueSchema` deliberately without `"unlimited"`.
- TRaSH schema untouched; `InputConfigQualityDefinitionQualityBaseSchema` (no `preferred`) and
  `InputConfigQualityDefinitionQualityPreferredSchema` exist, with an "at least one size" refinement.
- Diff semantics: absent = unmanaged, `0` and `null` compared via `normalizeSize`, `preferred: 0`
  now written (the truthiness bug is fixed), `null`/`0` treated as equal for `max`.
- `preferred_ratio` rejected together with an unlimited size.
- Sonarr v5 emits an explicit warning that `quality_definition` sizes are ignored and that
  `quality_sizes` belongs on the profile; `quality_sizes` accepts `"unlimited"`.
- Unit tests for normalisation, idempotency, `min: unlimited` rejection, ratio rejection; e2e tests
  added for Radarr, Lidarr, Readarr, Chaptarr and Sonarr.

### Residual gap

`InputConfigQualityDefinitionQualityBaseSchema` is exported and unit-tested but **not wired to
Readarr/Chaptarr in production**: `src/types/config.types.ts` uses the *preferred* schema for every
instance, so declaring `preferred` on a Readarr/Chaptarr instance is not rejected with an app-naming
error — it is simply ignored by the Readarr sync path. Either the instance schema should select the
base variant for those apps, or the syncer should reject `preferred` explicitly.
