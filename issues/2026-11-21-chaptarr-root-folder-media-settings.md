# Chaptarr root folders: per-media settings are not declarable

**Status:** proposed
**Severity:** medium — folder type and profile ids converge, but monitoring, tags and AudioBookShelf sidecars cannot be declared
**Area:** `src/rootFolder/rootFolderChaptarr.ts`, `src/types/config.types.ts`, `tests/arr-e2e/chaptarr.e2e.test.ts`
**Depends on:** `2026-11-20-chaptarr-v1-media-typed-readarr.md`, `feat/chaptarr-arr-type`

---

## Summary

The Chaptarr root-folder sync currently manages `folderType` and the per-media quality/metadata profile ids. The Chaptarr API also exposes per-media settings that Configarr cannot express:

```text
Audiobook / Ebook (MediaTypeSettingsResource)
  qualityProfileId
  metadataProfileId
  monitored
  monitorExistingMode
  monitorExistingBooks
  monitorExisting
  monitorFuture
  monitorNewItems
  writeAudioBookShelfMetadataJson
  writeAudioBookShelfCover
  tags

RootFolderResource
  placeEbooksWithAudiobooks
  defaultSyncMonitoredAcrossFormats
```

The current readarr root-folder schema maps `monitor`, `monitor_new_items` and `tags` to the removed `defaultMonitorOption` / `defaultNewItemMonitorOption` / `defaultTags` fields. Chaptarr does not use those for typed folders, so declaring them has no effect.

## Proposal

1. Add `audiobook:` and `ebook:` blocks to a Chaptarr root-folder entry:

   ```yaml
   chaptarr:
     books:
       media_type: mixed
       root_folders:
         - path: /books
           name: Books
           folder_type: mixed
           audiobook:
             quality_profile: Audiobook
             metadata_profile: Audiobook Default
             monitored: true
             monitor_existing: all
             monitor_new_items: new
             tags: [audiobooks]
           ebook:
             quality_profile: E-Book
             metadata_profile: Ebook Default
             monitored: true
             monitor_existing: all
             monitor_new_items: all
             tags: [ebooks]
   ```

2. Map those blocks to the `Audiobook` / `Ebook` objects Chaptarr expects.
3. Keep the flat `quality_profile` / `metadata_profile` fallback for ebook and audiobook instances.
4. Reject settings that do not match the folder type (`ebook` block on an audiobook-only folder, and vice versa).
5. Support `place_ebooks_with_audiobooks` and `default_sync_monitored_across_formats` for mixed folders.

## Tests

- Chaptarr E2E: create ebook, audiobook and mixed folders; assert per-media monitoring, tags, ABS flags, and idempotency.
- Chaptarr E2E: mixed folder with both blocks; verify no default profile fields are sent.
- Unit: validation rejects mismatched media blocks.
- Readarr E2E: unchanged root-folder payload and no Chaptarr fields.
