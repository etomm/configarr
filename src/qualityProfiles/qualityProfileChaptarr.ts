import type { QualityProfileResource } from "../__generated__/readarr/data-contracts";
import type { QualityProfilesClient } from "../clients/capabilities";
import type { CustomFormatRequest } from "../customFormats/customFormat.types";
import type { QualityDefinitionShared } from "../qualityDefinitions/qualityDefinition.types";
import type { ConfigQualityProfile, ReadarrMediaType } from "../types/config.types";
import type { QualityItem, QualityProfileShared } from "./qualityProfile.types";
import { QualityProfileReadarrSync } from "./qualityProfileReadarr";

type ChaptarrQualityProfileResource = QualityProfileResource & { profileType: "ebook" | "audiobook" };

export class QualityProfileChaptarrSync extends QualityProfileReadarrSync {
  constructor(
    api: QualityProfilesClient<QualityProfileResource>,
    private readonly mediaType?: ReadarrMediaType,
  ) {
    super(api, "CHAPTARR");
  }

  /**
   * Chaptarr lists ebook and audiobook qualities together. An existing profile already
   * knows its own set; a new profile uses only the qualities the config declares.
   */
  protected override qualityDefinitionsForProfile(
    definitions: QualityDefinitionShared[],
    serverMatch: QualityProfileShared | undefined,
    profile: ConfigQualityProfile,
  ): QualityDefinitionShared[] {
    if (this.mediaType === undefined) return definitions;

    const names = new Set<string>();
    if (serverMatch?.items != null) {
      const collect = (items: QualityItem[]) => {
        for (const item of items) {
          // Group labels are client-side names, not quality definitions. Only leaves
          // identify a quality; a group named like another media type must not admit it.
          const name = item.quality?.name;
          if (name != null) names.add(name);
          if (item.items) collect(item.items);
        }
      };
      collect(serverMatch.items);
    } else {
      for (const item of profile.qualities ?? []) {
        for (const quality of item.qualities ?? []) names.add(quality);
        if ((item.qualities?.length ?? 0) === 0 && item.name) names.add(item.name);
      }
    }

    if (names.size === 0) return definitions;

    const filtered = definitions.filter(
      (definition) =>
        (definition.quality?.name != null && names.has(definition.quality.name)) ||
        (definition.title != null && names.has(definition.title)),
    );
    return filtered.length > 0 ? filtered : definitions;
  }

  /**
   * Chaptarr requires a profile type on every quality profile. Mixed instances still
   * need one type per profile; ebook is the safe default when the instance is mixed.
   */
  protected override toServerProfile(profile: QualityProfileShared): QualityProfileResource {
    const profileType = this.mediaType === "audiobook" ? "audiobook" : "ebook";
    const result: ChaptarrQualityProfileResource = { ...profile, profileType };
    return result;
  }

  /** A profile must not receive custom formats that belong to the other media side. */
  protected override customFormatsForProfile(customFormats: CustomFormatRequest[], _profile: ConfigQualityProfile): CustomFormatRequest[] {
    if (this.mediaType === undefined) return customFormats;
    const appliesTo = this.mediaType === "audiobook" ? "audiobook" : "ebook";
    return customFormats.filter((format) => format.appliesTo == null || format.appliesTo === "both" || format.appliesTo === appliesTo);
  }
}
