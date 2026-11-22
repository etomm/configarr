import { MonitorTypes, NewItemMonitorTypes, type RootFolderResource } from "../__generated__/readarr/data-contracts";
import type { ServerCache } from "../cache";
import { ensureTags } from "../tags/tags";
import type { InputConfigRootFolderReadarr, InputConfigRootFolderReadarrMediaSettings, ReadarrMediaType } from "../types/config.types";
import { toEnumOrThrow } from "../util";
import { ConfigValidationError } from "../validation";
import type { ProfileAwareRootFolderApi, ProfileAwareRootFolderFields } from "./rootFolderBase";
import { ReadarrRootFolderSync } from "./rootFolderReadarr";

/** The per-media settings object Chaptarr returns as `ebook` / `audiobook`. */
export type ChaptarrMediaTypeSettingsResource = {
  qualityProfileId?: number;
  metadataProfileId?: number;
  monitored?: boolean;
  monitorExistingMode?: MonitorTypes;
  monitorExistingBooks?: boolean;
  monitorExisting?: number;
  monitorFuture?: boolean;
  monitorNewItems?: NewItemMonitorTypes;
  writeAudioBookShelfMetadataJson?: boolean;
  writeAudioBookShelfCover?: boolean;
  tags?: number[];
};

/** Chaptarr fields that the generated vanilla-Readarr contract does not declare. */
export type ChaptarrRootFolderFields = {
  /** 0 = mixed, 1 = audiobook, 2 = ebook. */
  folderType?: number;
  /** Legacy flat profile ids, still returned by the API and sent for older Chaptarr builds. */
  ebookQualityProfileId?: number;
  ebookMetadataProfileId?: number;
  audiobookQualityProfileId?: number;
  audiobookMetadataProfileId?: number;
  ebook?: ChaptarrMediaTypeSettingsResource;
  audiobook?: ChaptarrMediaTypeSettingsResource;
  placeEbooksWithAudiobooks?: boolean;
  defaultSyncMonitoredAcrossFormats?: boolean;
};

export type ChaptarrRootFolderResource = RootFolderResource & ChaptarrRootFolderFields;
export type ChaptarrRootFolderApi = ProfileAwareRootFolderApi<ChaptarrRootFolderResource>;

type ChaptarrRootFolderConfig = InputConfigRootFolderReadarr;
type BookSide = "ebook" | "audiobook";

const folderTypeByMediaType: Record<ReadarrMediaType, number> = {
  mixed: 0,
  audiobook: 1,
  ebook: 2,
};

export class ChaptarrRootFolderSync extends ReadarrRootFolderSync<ChaptarrRootFolderResource> {
  constructor(
    api: ChaptarrRootFolderApi,
    private readonly mediaType: ReadarrMediaType = "ebook",
  ) {
    super(api, "Chaptarr");
  }

  protected override validateRootFolderConfig(config: ChaptarrRootFolderConfig): void {
    const folderType = this.folderTypeFor(config);

    if (folderType === "audiobook" && config.ebook !== undefined) {
      throw new ConfigValidationError("Chaptarr 'ebook' settings are only valid for ebook or mixed root folders");
    }

    if (folderType === "ebook" && config.audiobook !== undefined) {
      throw new ConfigValidationError("Chaptarr 'audiobook' settings are only valid for audiobook or mixed root folders");
    }

    if (folderType !== "mixed" && config.place_ebooks_with_audiobooks !== undefined) {
      throw new ConfigValidationError("Chaptarr 'place_ebooks_with_audiobooks' is only valid for mixed root folders");
    }

    if (folderType !== "mixed" && config.default_sync_monitored_across_formats !== undefined) {
      throw new ConfigValidationError("Chaptarr 'default_sync_monitored_across_formats' is only valid for mixed root folders");
    }
  }

  protected override buildResource(config: ChaptarrRootFolderConfig, fields: ProfileAwareRootFolderFields): ChaptarrRootFolderResource {
    const result = super.buildResource(config, fields);
    const folderType = this.folderTypeFor(config);

    // Typed Chaptarr folders use their per-media profile ids instead of the defaults.
    delete result.defaultMetadataProfileId;
    delete result.defaultQualityProfileId;
    result.folderType = folderTypeByMediaType[folderType];

    // Only mixed folders expose these; Chaptarr forces the placement flag off on other types.
    if (folderType === "mixed") {
      if (config.place_ebooks_with_audiobooks !== undefined) {
        result.placeEbooksWithAudiobooks = config.place_ebooks_with_audiobooks;
      }
      if (config.default_sync_monitored_across_formats !== undefined) {
        result.defaultSyncMonitoredAcrossFormats = config.default_sync_monitored_across_formats;
      }
    }

    return result;
  }

  public override async resolveRootFolderConfig(
    config: ChaptarrRootFolderConfig,
    serverCache: ServerCache,
  ): Promise<ChaptarrRootFolderResource> {
    const resource = await super.resolveRootFolderConfig(config, serverCache);
    const folderType = this.folderTypeFor(config);
    const { quality, metadata } = await this.getProfileIdMaps(serverCache);

    if (folderType === "ebook" || folderType === "mixed") {
      this.applyMediaSettings(resource, "ebook", config, quality, metadata, serverCache);
    }

    if (folderType === "audiobook" || folderType === "mixed") {
      this.applyMediaSettings(resource, "audiobook", config, quality, metadata, serverCache);
    }

    return resource;
  }

  protected override extraComparableFields(resource: ChaptarrRootFolderResource): Record<string, unknown> {
    const fields = super.extraComparableFields(resource);
    fields.folderType = resource.folderType;

    if (resource.ebookQualityProfileId !== undefined) fields.ebookQualityProfileId = resource.ebookQualityProfileId;
    if (resource.ebookMetadataProfileId !== undefined) fields.ebookMetadataProfileId = resource.ebookMetadataProfileId;
    if (resource.audiobookQualityProfileId !== undefined) fields.audiobookQualityProfileId = resource.audiobookQualityProfileId;
    if (resource.audiobookMetadataProfileId !== undefined) {
      fields.audiobookMetadataProfileId = resource.audiobookMetadataProfileId;
    }

    if (resource.ebook !== undefined) fields.ebook = resource.ebook;
    if (resource.audiobook !== undefined) fields.audiobook = resource.audiobook;
    if (resource.placeEbooksWithAudiobooks !== undefined) {
      fields.placeEbooksWithAudiobooks = resource.placeEbooksWithAudiobooks;
    }
    if (resource.defaultSyncMonitoredAcrossFormats !== undefined) {
      fields.defaultSyncMonitoredAcrossFormats = resource.defaultSyncMonitoredAcrossFormats;
    }

    return fields;
  }

  protected override async createMissingTags(rootFolders: ChaptarrRootFolderConfig[], serverCache: ServerCache): Promise<void> {
    const missingTags = new Set<string>();

    for (const config of rootFolders) {
      const tagLists = [config.tags, config.ebook?.tags, config.audiobook?.tags];
      for (const tags of tagLists) {
        for (const tag of this.resolveTagIds(tags, serverCache).missing) {
          missingTags.add(tag);
        }
      }
    }

    await ensureTags(this.api, serverCache, [...missingTags]);
  }

  private folderTypeFor(config: ChaptarrRootFolderConfig): ReadarrMediaType {
    return config.folder_type ?? this.mediaType;
  }

  private applyMediaSettings(
    resource: ChaptarrRootFolderResource,
    side: BookSide,
    config: ChaptarrRootFolderConfig,
    qualityProfiles: Map<string, number>,
    metadataProfiles: Map<string, number>,
    serverCache: ServerCache,
  ): void {
    const settings = config[side];
    const qualityProfileId = resolveProfileId(
      settings?.quality_profile ?? fallbackProfile(config, side, "quality") ?? config.quality_profile,
      qualityProfiles,
      `Chaptarr ${side}`,
      "quality",
    );
    const metadataProfileId = resolveProfileId(
      settings?.metadata_profile ?? fallbackProfile(config, side, "metadata") ?? config.metadata_profile,
      metadataProfiles,
      `Chaptarr ${side}`,
      "metadata",
    );

    const mediaSettings = buildMediaSettings(
      side,
      settings,
      qualityProfileId,
      metadataProfileId,
      (tags) => this.resolveTagIds(tags, serverCache).ids,
    );

    if (side === "ebook") {
      resource.ebookQualityProfileId = qualityProfileId;
      resource.ebookMetadataProfileId = metadataProfileId;
      resource.ebook = mediaSettings;
    } else {
      resource.audiobookQualityProfileId = qualityProfileId;
      resource.audiobookMetadataProfileId = metadataProfileId;
      resource.audiobook = mediaSettings;
    }
  }
}

function buildMediaSettings(
  side: BookSide,
  settings: InputConfigRootFolderReadarrMediaSettings | undefined,
  qualityProfileId: number | undefined,
  metadataProfileId: number | undefined,
  resolveTags: (tags: string[]) => number[],
): ChaptarrMediaTypeSettingsResource {
  const result: ChaptarrMediaTypeSettingsResource = {};

  if (qualityProfileId !== undefined) result.qualityProfileId = qualityProfileId;
  if (metadataProfileId !== undefined) result.metadataProfileId = metadataProfileId;

  if (settings?.monitored !== undefined) result.monitored = settings.monitored;

  if (settings?.monitor_existing !== undefined) {
    result.monitorExistingMode = toEnumOrThrow(MonitorTypes, settings.monitor_existing, `Chaptarr ${side} monitor_existing`);
  } else if (settings?.monitor_existing_books !== undefined) {
    // Deprecated API alias; Chaptarr translates it to monitorExistingMode.
    result.monitorExistingBooks = settings.monitor_existing_books;
  }

  if (settings?.monitor_future !== undefined) result.monitorFuture = settings.monitor_future;
  if (settings?.monitor_new_items !== undefined) {
    result.monitorNewItems = toEnumOrThrow(NewItemMonitorTypes, settings.monitor_new_items, `Chaptarr ${side} monitor_new_items`);
  }
  if (settings?.write_audiobookshelf_metadata_json !== undefined) {
    result.writeAudioBookShelfMetadataJson = settings.write_audiobookshelf_metadata_json;
  }
  if (settings?.write_audiobookshelf_cover !== undefined) {
    result.writeAudioBookShelfCover = settings.write_audiobookshelf_cover;
  }
  if (settings?.tags !== undefined) result.tags = resolveTags(settings.tags);

  return result;
}

function fallbackProfile(config: ChaptarrRootFolderConfig, side: BookSide, kind: "quality" | "metadata"): string | undefined {
  if (side === "ebook") {
    return kind === "quality" ? config.ebook_quality_profile : config.ebook_metadata_profile;
  }
  return kind === "quality" ? config.audiobook_quality_profile : config.audiobook_metadata_profile;
}

function resolveProfileId(name: string | undefined, profiles: Map<string, number>, label: string, kind: string): number | undefined {
  if (name === undefined) return undefined;
  const id = profiles.get(name);
  if (id === undefined) throw new ConfigValidationError(`${label} ${kind} profile '${name}' not found on Chaptarr server`);
  return id;
}
