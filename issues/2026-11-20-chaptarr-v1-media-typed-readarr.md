# Chaptarr v1: a media-typed Readarr adapter

**Status:** proposed
**Severity:** high — Chaptarr cannot be fully declared today, and three of its settings are silently unmanageable
**Area:** `src/rootFolder/rootFolderReadarr.ts`, naming sync for Readarr, `src/qualityProfiles/qualityProfileReadarr.ts`, `src/types/config.types.ts`
**Found in:** `1.39.3-etomm.1` (Chaptarr `0.9.1000.0`)

---

## Summary

Chaptarr is a Readarr fork that makes **media type first-class**. Vanilla Readarr has one media
type and one naming set; Chaptarr has an ebook side and an audiobook side, with separate objects for
each. The Readarr adapter assumes the vanilla model, so three settings cannot be declared correctly.

Observed against a live instance, all three reproduced:

| Feature | What Configarr sends | What Chaptarr needs | Result |
|---|---|---|---|
| Root folder update | Readarr `RootFolderResource` without `folderType` | `folderType` (0 = Mixed, 1 = Audiobook, 2 = Ebook) plus per-type profile ids | `400 … missing required properties including: 'folderType'` |
| Root folder create | same | same | same 400, also through the facades |
| Ebook naming | `standardBookFormat` / `authorFolderFormat` | `ebookStandardBookFormat` / `ebookAuthorFolderFormat` | write lands on the *generic* fields, ebook naming never changes |
| Quality profiles | every quality from `qualitydefinition` | only the qualities of that profile's media type | the other media type is appended as `allowed: false` on every apply |

Root folder creation is not a workaround either: `POST` through `/readarr/gr/{ebook,audiobook}`
returns the same 400, because the facade does not inject `folderType`.

### Root folders

`src/rootFolder/rootFolderReadarr.ts` builds the payload field by field:

```ts
const result: RootFolderResource = {
  path: fields.path,
  name: fields.name,
  defaultMetadataProfileId: fields.defaultMetadataProfileId,
  defaultQualityProfileId: fields.defaultQualityProfileId,
  defaultTags: fields.defaultTags,
};
```

`Chaptarr.Api.V1.RootFolders.RootFolderResource` requires `folderType`, and for a typed folder also
`audiobookQualityProfileId` / `audiobookMetadataProfileId` (type 1) or the ebook equivalents (type 2).
A `PUT` that includes `folderType: 0` is accepted (`202`), so the API contract is not the problem.

Useful detail: a typed folder is not a cosmetic label. `folderType: 1` with no audiobook profiles is
rejected with `An audiobook quality profile is required`; `2` demands the ebook pair. `0` (Mixed)
carries both sub-objects (`ebook`, `audiobook`) with their own profiles and monitoring.

### Naming

The ebook facade only writes `ebookStandardBookFormat` when the payload **contains that key**.
Configarr always sends the plain Readarr keys, so a write through the ebook facade lands on the
generic fields — the same ones the audiobook side owns. Two instances pointed at the two facades
therefore overwrite each other's naming and the ebook format never applies.

### Quality profiles

`mapQualities()` enumerates `qualitydefinition` (9 qualities for Chaptarr: 5 ebook + 4 audiobook) and
appends every undeclared quality with `allowed: false`. Chaptarr's `E-Book` profile legitimately
contains only 5 items, and `Audiobook` only 4, so each apply adds the other media type as disabled
rows. Chaptarr accepts and stores them (`PUT` → `202`), which means the result *does* converge, but
the profiles are permanently wrong in content.

The facades filter `qualityprofile` but **not** `qualitydefinition`, so pointing an instance at
`/readarr/gr/ebook` does not help: all 9 qualities are visible from every endpoint.

## Proposal

Add an explicit media type to the Readarr instance and branch on it. Working name: **Chaptarr v1**.

```yaml
readarr:
  ebook:
    base_url: .../readarr/gr/ebook     # or .../chaptarr for the global API
    media_type: ebook                  # ebook | audiobook | mixed (default: unset = vanilla Readarr)
```

1. **Root folders** — when `media_type` is set, emit `folderType` (`ebook` → 2, `audiobook` → 1,
   `mixed` → 0) and the per-type profile ids. Reuse the existing `quality_profile` /
   `metadata_profile` keys, mapping them into `ebook*` or `audiobook*` according to `media_type`.
   A `mixed` folder needs both pairs; accept either a nested `ebook:` / `audiobook:` block or
   `<type>_quality_profile` keys.
2. **Naming** — map `standardBookFormat` → `ebookStandardBookFormat` and `authorFolderFormat` →
   `ebookAuthorFolderFormat` when `media_type: ebook`; keep the generic keys for `audiobook` and for
   vanilla Readarr. Send the full object on `PUT` (the facade requires the key to be present).
3. **Quality profiles** — when `media_type` is set, restrict the known qualities to that media type
   so the profile is built from its own qualities only. Preferred: read the profile's existing items
   and treat their quality set as the universe (a Chaptarr profile already knows what it may contain).
4. **Validation** — `media_type` on a non-Chaptarr target should warn; `folderType` on vanilla
   Readarr must never be sent (it would 400).

If branching inside the Readarr adapter proves too tangled, a separate `chaptarr` arr type is
acceptable — the config surface above is what matters.

## Acceptance criteria

- A `PUT` to a Chaptarr root folder produced by Configarr returns `202` and does not change any
  other field (round-trip diff empty).
- Creating a typed folder through the adapter works, including for a facade base URL.
- With `media_type: ebook`, applying naming changes `ebookStandardBookFormat` /
  `ebookAuthorFolderFormat` and leaves `standardBookFormat` / `authorFolderFormat` untouched.
- With `media_type: ebook`, an `E-Book` profile diff reports no change once applied — no foreign
  qualities are added.
- Vanilla Readarr behaviour is byte-identical (no `folderType`, no `ebook*` keys in payloads).

## Tests

- `rootFolderReadarr.test.ts`: payload for each `media_type`; rejection when a typed folder lacks its
  profile pair; unchanged payload when `media_type` is unset.
- Naming: ebook instance writes `ebook*`; audiobook instance writes generic; both against a facade
  stub that rejects unknown keys.
- Quality profiles: 9-quality definition list + 5-item profile + `media_type: ebook` → no diff.

## Risks / notes

- `folderType` values are documented by the API error only (`0 Mixed, 1 Audiobook, 2 Ebook`); pin
  them in a named enum and cover with a test so a Chaptarr change is caught.
- A Mixed folder carries two profile pairs; the current flat YAML schema cannot express that without
  either nested keys or `<type>_*` keys. Decide before implementing.
