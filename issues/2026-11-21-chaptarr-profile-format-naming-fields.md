# Chaptarr profiles, custom formats and naming: remaining unmanaged fields

**Status:** proposed
**Severity:** medium — Chaptarr-specific profile and custom-format behavior is only partially declarable
**Area:** `src/qualityProfiles/qualityProfileChaptarr.ts`, `src/metadataProfiles/metadataProfileChaptarr.ts`, `src/customFormats/customFormat.types.ts`, `src/mediaManagement/mediaManagementChaptarr.ts`, `src/types/config.types.ts`
**Depends on:** `feat/chaptarr-arr-type`

---

## Summary

The Chaptarr subclasses now set the required media type and filter qualities/custom formats by media side, but several Chaptarr-only fields are still not expressible in YAML.

### Metadata profiles

`MetadataProfileResource` adds:

- `profileType` — `0` general/none, `1` audiobook, `2` ebook
- `skipMissingIdentifierOmnibus`
- `skipOmnibus`
- `skipMissingAsin`

`InputConfigReadarrMetadataProfileSchema` does not include them, so they are stripped from the config and Chaptarr defaults the profile type.

### Quality profiles

`QualityProfileResource` adds:

- `confirmAutomaticUpgrades`
- `preferCustomFormatsOverQuality` (audiobook only)
- `convertToQualityId` (canonical conversion target)
- `convertMp3ToM4b` (legacy alias)

Configarr sets only the internal `profileType`; the rest are server defaults and cannot be declared.

### Custom formats

`appliesTo` (`both`, `ebook`, `audiobook`) exists only on Chaptarr. Configarr-created custom formats currently default to `both`, so a dual-library instance cannot create a media-specific custom format.

### Naming

Chaptarr exposes ebook-specific toggles in addition to the format strings already translated:

- `ebookRenameBooks`
- `ebookReplaceIllegalCharacters`
- `ebookColonReplacementFormat`

They are technically reachable through the passthrough `media_naming_api` map, but have no explicit schema field, documentation, or validation.

## Proposal

1. Extend the metadata-profile config with `profile_type` (`general`/`audiobook`/`ebook`) and the three omnibus/ASIN toggles.
2. Extend the quality-profile config with `confirm_automatic_upgrades`, `prefer_custom_formats_over_quality` and `convert_to_quality` (map the legacy `convert_mp3_to_m4b` to M4B).
3. Add `applies_to` to custom-format definitions, validated against Chaptarr; reject it on vanilla Readarr.
4. Add explicit `ebook_rename_books`, `ebook_replace_illegal_characters` and `ebook_colon_replacement_format` naming fields, mapping them to the Chaptarr keys.
5. Keep all of it inside the Chaptarr subclasses and reject Chaptarr-only keys elsewhere.

## Tests

- Unit: Chaptarr metadata/quality payloads include the new fields; Readarr rejects them.
- Chaptarr E2E: apply profile type, quality flags, media-specific custom format and ebook naming toggles; second run idempotent.
- Readarr E2E: no Chaptarr-only keys are sent or returned.
