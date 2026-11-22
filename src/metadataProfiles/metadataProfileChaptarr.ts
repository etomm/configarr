import type { MetadataProfileResource } from "../__generated__/readarr/data-contracts";
import type { ServerCache } from "../cache";
import type { MetadataProfilesClient } from "../clients/capabilities";
import type { InputConfigChaptarrMetadataProfile, InputConfigMetadataProfile } from "../types/config.types";
import { ReadarrMetadataProfileSync } from "./metadataProfileReadarr";

type ChaptarrMetadataProfileResource = MetadataProfileResource & {
  profileType?: number;
  skipOmnibus?: boolean;
  skipMissingIdentifierOmnibus?: boolean;
  skipMissingAsin?: boolean;
};

const PROFILE_TYPE_IDS: Record<NonNullable<InputConfigChaptarrMetadataProfile["profile_type"]>, number> = {
  general: 0,
  audiobook: 1,
  ebook: 2,
};

export class ChaptarrMetadataProfileSync extends ReadarrMetadataProfileSync {
  constructor(api: MetadataProfilesClient<MetadataProfileResource>) {
    super(api, "CHAPTARR");
  }

  override async resolveConfig(config: InputConfigMetadataProfile, serverCache: ServerCache): Promise<MetadataProfileResource> {
    const base = await super.resolveConfig(config, serverCache);
    const chaptarr = config as InputConfigChaptarrMetadataProfile;
    const result: ChaptarrMetadataProfileResource = { ...base };

    if (chaptarr.profile_type !== undefined) {
      result.profileType = PROFILE_TYPE_IDS[chaptarr.profile_type];
    }
    if (chaptarr.skip_omnibus !== undefined) {
      result.skipOmnibus = chaptarr.skip_omnibus;
    }
    if (chaptarr.skip_missing_identifier_omnibus !== undefined) {
      result.skipMissingIdentifierOmnibus = chaptarr.skip_missing_identifier_omnibus;
    }
    if (chaptarr.skip_missing_asin !== undefined) {
      result.skipMissingAsin = chaptarr.skip_missing_asin;
    }

    return result;
  }

  protected override normalizeForComparison(profile: MetadataProfileResource) {
    const chaptarr = profile as ChaptarrMetadataProfileResource;
    return {
      ...super.normalizeForComparison(profile),
      profileType: chaptarr.profileType ?? 0,
      skipOmnibus: Boolean(chaptarr.skipOmnibus),
      skipMissingIdentifierOmnibus: Boolean(chaptarr.skipMissingIdentifierOmnibus),
      skipMissingAsin: Boolean(chaptarr.skipMissingAsin),
    };
  }
}
