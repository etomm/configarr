import type { Mocked } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MonitorTypes, NewItemMonitorTypes } from "../__generated__/readarr/data-contracts";
import { ServerCache } from "../cache";
import { getEnvs } from "../env";
import type { InputConfigRootFolderReadarr } from "../types/config.types";
import { type ChaptarrRootFolderApi, ChaptarrRootFolderSync } from "./rootFolderChaptarr";

vi.mock("../env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../env")>();
  return {
    ...actual,
    getEnvs: vi.fn(() => ({ DRY_RUN: false, LOG_LEVEL: "silent", CONFIGARR_VERSION: "test" })),
  };
});

const setDryRun = (dryRun: boolean) =>
  vi.mocked(getEnvs).mockReturnValue({ DRY_RUN: dryRun, LOG_LEVEL: "silent", CONFIGARR_VERSION: "test" } as never);

describe("ChaptarrRootFolderSync", () => {
  const mockApi: Mocked<ChaptarrRootFolderApi> = {
    getRootfolders: vi.fn(),
    addRootFolder: vi.fn(),
    updateRootFolder: vi.fn(),
    deleteRootFolder: vi.fn(),
    getMetadataProfiles: vi.fn(),
    getQualityProfiles: vi.fn(),
    getTags: vi.fn(),
    createTag: vi.fn(),
    deleteTag: vi.fn(),
  };

  const config: InputConfigRootFolderReadarr = {
    path: "/books",
    name: "Books",
    metadata_profile: "Standard",
    quality_profile: "eBook",
  };

  let serverCache: ServerCache;

  beforeEach(() => {
    vi.clearAllMocks();
    setDryRun(false);
    serverCache = new ServerCache();
    serverCache.tags = [];
    mockApi.getQualityProfiles.mockResolvedValue([
      { id: 1, name: "eBook" },
      { id: 2, name: "Audiobook" },
    ]);
    mockApi.getMetadataProfiles.mockResolvedValue([
      { id: 10, name: "Standard" },
      { id: 20, name: "None" },
    ]);
  });

  it("adds folderType and the ebook profile pair for media_type ebook", async () => {
    const result = await new ChaptarrRootFolderSync(mockApi, "ebook").resolveRootFolderConfig(config, serverCache);
    expect(result).toMatchObject({
      folderType: 2,
      ebookQualityProfileId: 1,
      ebookMetadataProfileId: 10,
    });
    expect(result.audiobookQualityProfileId).toBeUndefined();
  });

  it("defaults an omitted media_type to ebook", async () => {
    const result = await new ChaptarrRootFolderSync(mockApi).resolveRootFolderConfig(config, serverCache);
    expect(result).toMatchObject({
      folderType: 2,
      ebookQualityProfileId: 1,
      ebookMetadataProfileId: 10,
    });
  });

  it("adds folderType and the audiobook profile pair for media_type audiobook", async () => {
    const result = await new ChaptarrRootFolderSync(mockApi, "audiobook").resolveRootFolderConfig(
      { ...config, quality_profile: "Audiobook" },
      serverCache,
    );
    expect(result).toMatchObject({
      folderType: 1,
      audiobookQualityProfileId: 2,
      audiobookMetadataProfileId: 10,
    });
    expect(result.ebookQualityProfileId).toBeUndefined();
  });

  it("resolves both profile pairs for a mixed folder", async () => {
    const result = await new ChaptarrRootFolderSync(mockApi, "mixed").resolveRootFolderConfig(
      {
        ...config,
        ebook_quality_profile: "eBook",
        audiobook_quality_profile: "Audiobook",
        audiobook_metadata_profile: "None",
      },
      serverCache,
    );
    expect(result).toMatchObject({
      folderType: 0,
      ebookQualityProfileId: 1,
      ebookMetadataProfileId: 10,
      audiobookQualityProfileId: 2,
      audiobookMetadataProfileId: 20,
    });
  });

  it("reports no change when a typed folder round-trips", async () => {
    mockApi.getRootfolders.mockResolvedValue([
      {
        path: "/books",
        id: 1,
        name: "Books",
        defaultTags: [],
        folderType: 2,
        ebookQualityProfileId: 1,
        ebookMetadataProfileId: 10,
      },
    ]);
    expect(await new ChaptarrRootFolderSync(mockApi, "ebook").calculateDiff([config], serverCache)).toBeNull();
  });

  it("detects ebook profile changes when media_type is omitted", async () => {
    mockApi.getRootfolders.mockResolvedValue([
      {
        path: "/books",
        id: 1,
        name: "Books",
        defaultTags: [],
        folderType: 2,
        ebookQualityProfileId: 2,
        ebookMetadataProfileId: 10,
      },
    ]);
    expect(await new ChaptarrRootFolderSync(mockApi).calculateDiff([config], serverCache)).not.toBeNull();
  });

  it("maps a nested ebook block to the per-media settings object", async () => {
    serverCache.tags = [{ id: 100, label: "ebooks" }];

    const result = await new ChaptarrRootFolderSync(mockApi, "ebook").resolveRootFolderConfig(
      {
        ...config,
        ebook: {
          quality_profile: "eBook",
          metadata_profile: "None",
          monitored: true,
          monitor_existing: "all",
          monitor_new_items: "all",
          tags: ["ebooks"],
          write_audiobookshelf_metadata_json: true,
          write_audiobookshelf_cover: true,
        },
      },
      serverCache,
    );

    expect(result.ebook).toEqual({
      qualityProfileId: 1,
      metadataProfileId: 20,
      monitored: true,
      monitorExistingMode: "all",
      monitorNewItems: "all",
      writeAudioBookShelfMetadataJson: true,
      writeAudioBookShelfCover: true,
      tags: [100],
    });
    expect(result.ebookQualityProfileId).toBe(1);
    expect(result.ebookMetadataProfileId).toBe(20);
    expect(result.audiobook).toBeUndefined();
  });

  it("prefers the nested block over flat per-media profile fields", async () => {
    const result = await new ChaptarrRootFolderSync(mockApi, "ebook").resolveRootFolderConfig(
      {
        ...config,
        ebook_quality_profile: "Audiobook",
        ebook_metadata_profile: "None",
        ebook: { quality_profile: "eBook", metadata_profile: "Standard" },
      },
      serverCache,
    );

    expect(result.ebook).toMatchObject({ qualityProfileId: 1, metadataProfileId: 10 });
  });

  it("falls back to the flat per-media profiles when a nested block only sets monitoring", async () => {
    const result = await new ChaptarrRootFolderSync(mockApi, "audiobook").resolveRootFolderConfig(
      {
        ...config,
        audiobook_quality_profile: "Audiobook",
        audiobook_metadata_profile: "None",
        audiobook: { monitored: false, monitor_existing: "missing", monitor_new_items: "none" },
      },
      serverCache,
    );

    expect(result.audiobook).toEqual({
      qualityProfileId: 2,
      metadataProfileId: 20,
      monitored: false,
      monitorExistingMode: "missing",
      monitorNewItems: "none",
    });
  });

  it("supports the deprecated Chaptarr monitoring aliases", async () => {
    const result = await new ChaptarrRootFolderSync(mockApi, "ebook").resolveRootFolderConfig(
      {
        ...config,
        ebook: { monitor_existing_books: true, monitor_future: true },
      },
      serverCache,
    );

    expect(result.ebook).toMatchObject({ monitorExistingBooks: true, monitorFuture: true });
    expect(result.ebook?.monitorExistingMode).toBeUndefined();
  });

  it("builds both media sides and the mixed-only flags, with folder_type overriding the instance", async () => {
    const result = await new ChaptarrRootFolderSync(mockApi, "ebook").resolveRootFolderConfig(
      {
        ...config,
        folder_type: "mixed",
        place_ebooks_with_audiobooks: true,
        default_sync_monitored_across_formats: false,
        ebook: { quality_profile: "eBook", metadata_profile: "Standard" },
        audiobook: { quality_profile: "Audiobook", metadata_profile: "None" },
      },
      serverCache,
    );

    expect(result).toMatchObject({
      folderType: 0,
      placeEbooksWithAudiobooks: true,
      defaultSyncMonitoredAcrossFormats: false,
      ebookQualityProfileId: 1,
      ebookMetadataProfileId: 10,
      audiobookQualityProfileId: 2,
      audiobookMetadataProfileId: 20,
    });
    expect(result.ebook).toMatchObject({ qualityProfileId: 1, metadataProfileId: 10 });
    expect(result.audiobook).toMatchObject({ qualityProfileId: 2, metadataProfileId: 20 });
  });

  it("rejects an ebook block on an audiobook-only folder", async () => {
    await expect(
      new ChaptarrRootFolderSync(mockApi, "audiobook").resolveRootFolderConfig({ ...config, ebook: { monitored: true } }, serverCache),
    ).rejects.toThrow("'ebook' settings are only valid for ebook or mixed root folders");
  });

  it("rejects an audiobook block on an ebook-only folder", async () => {
    await expect(
      new ChaptarrRootFolderSync(mockApi, "ebook").resolveRootFolderConfig({ ...config, audiobook: { monitored: true } }, serverCache),
    ).rejects.toThrow("'audiobook' settings are only valid for audiobook or mixed root folders");
  });

  it("rejects mixed-only flags on a typed folder", async () => {
    await expect(
      new ChaptarrRootFolderSync(mockApi, "ebook").resolveRootFolderConfig({ ...config, place_ebooks_with_audiobooks: true }, serverCache),
    ).rejects.toThrow("'place_ebooks_with_audiobooks' is only valid for mixed root folders");

    await expect(
      new ChaptarrRootFolderSync(mockApi, "audiobook").resolveRootFolderConfig(
        { ...config, default_sync_monitored_across_formats: true },
        serverCache,
      ),
    ).rejects.toThrow("'default_sync_monitored_across_formats' is only valid for mixed root folders");
  });

  it("stays idempotent when the server returns the nested per-media settings", async () => {
    mockApi.getRootfolders.mockResolvedValue([
      {
        path: "/books",
        id: 1,
        name: "Books",
        defaultTags: [],
        folderType: 0,
        placeEbooksWithAudiobooks: true,
        defaultSyncMonitoredAcrossFormats: false,
        ebookQualityProfileId: 1,
        ebookMetadataProfileId: 10,
        audiobookQualityProfileId: 2,
        audiobookMetadataProfileId: 20,
        ebook: {
          qualityProfileId: 1,
          metadataProfileId: 10,
          monitored: true,
          monitorExistingMode: MonitorTypes.All,
          monitorNewItems: NewItemMonitorTypes.All,
          writeAudioBookShelfMetadataJson: false,
          writeAudioBookShelfCover: true,
          tags: [],
        },
        audiobook: {
          qualityProfileId: 2,
          metadataProfileId: 20,
          monitored: false,
          monitorExistingMode: MonitorTypes.None,
          monitorNewItems: NewItemMonitorTypes.New,
          writeAudioBookShelfMetadataJson: true,
          writeAudioBookShelfCover: false,
          tags: [],
        },
      },
    ]);

    const mixedConfig: InputConfigRootFolderReadarr = {
      ...config,
      folder_type: "mixed",
      place_ebooks_with_audiobooks: true,
      default_sync_monitored_across_formats: false,
      ebook: {
        quality_profile: "eBook",
        metadata_profile: "Standard",
        monitored: true,
        monitor_existing: "all",
        monitor_new_items: "all",
        write_audiobookshelf_cover: true,
      },
      audiobook: {
        quality_profile: "Audiobook",
        metadata_profile: "None",
        monitored: false,
        monitor_existing: "none",
        monitor_new_items: "new",
        write_audiobookshelf_metadata_json: true,
      },
    };

    expect(await new ChaptarrRootFolderSync(mockApi, "mixed").calculateDiff([mixedConfig], serverCache)).toBeNull();

    mockApi.getRootfolders.mockResolvedValue([
      {
        path: "/books",
        id: 1,
        name: "Books",
        defaultTags: [],
        folderType: 0,
        placeEbooksWithAudiobooks: true,
        defaultSyncMonitoredAcrossFormats: false,
        ebookQualityProfileId: 1,
        ebookMetadataProfileId: 10,
        audiobookQualityProfileId: 2,
        audiobookMetadataProfileId: 20,
        ebook: {
          qualityProfileId: 1,
          metadataProfileId: 10,
          monitored: true,
          monitorExistingMode: MonitorTypes.None,
          monitorNewItems: NewItemMonitorTypes.All,
          writeAudioBookShelfMetadataJson: false,
          writeAudioBookShelfCover: true,
          tags: [],
        },
        audiobook: {
          qualityProfileId: 2,
          metadataProfileId: 20,
          monitored: false,
          monitorExistingMode: MonitorTypes.None,
          monitorNewItems: NewItemMonitorTypes.New,
          writeAudioBookShelfMetadataJson: true,
          writeAudioBookShelfCover: false,
          tags: [],
        },
      },
    ]);

    expect(await new ChaptarrRootFolderSync(mockApi, "mixed").calculateDiff([mixedConfig], serverCache)).not.toBeNull();
  });

  it("creates per-media tags before persisting a folder", async () => {
    serverCache.tags = [];
    mockApi.createTag.mockResolvedValue({ id: 300, label: "ebooks" });
    mockApi.getRootfolders.mockResolvedValue([]);

    const result = await new ChaptarrRootFolderSync(mockApi, "ebook").syncRootFolders(
      [{ ...config, ebook: { tags: ["ebooks"] } }],
      serverCache,
    );

    expect(mockApi.createTag).toHaveBeenCalledWith({ label: "ebooks" });
    expect(mockApi.addRootFolder).toHaveBeenCalledWith(expect.objectContaining({ ebook: expect.objectContaining({ tags: [300] }) }));
    expect(result.added).toBe(1);
  });
});
