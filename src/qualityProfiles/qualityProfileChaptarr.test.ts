import { describe, expect, test } from "vitest";
import type { QualityProfileResource } from "../__generated__/readarr/data-contracts";
import { ServerCache } from "../cache";
import type { QualityProfilesClient } from "../clients/capabilities";
import type { CFProcessing, CustomFormatRequest } from "../customFormats/customFormat.types";
import type { QualityDefinitionShared } from "../qualityDefinitions/qualityDefinition.types";
import type { MergedConfigInstance } from "../types/config.types";
import type { QualityProfileShared } from "./qualityProfile.types";
import { QualityProfileChaptarrSync } from "./qualityProfileChaptarr";

const client = {} as QualityProfilesClient<QualityProfileResource>;

const formats: CustomFormatRequest[] = [
  { name: "audio-only", appliesTo: "audiobook" },
  { name: "ebook-only", appliesTo: "ebook" },
  { name: "both", appliesTo: "both" },
  { name: "untyped" },
];

describe("QualityProfileChaptarrSync", () => {
  test("adds the profile type Chaptarr requires", () => {
    const sync = new QualityProfileChaptarrSync(client, "ebook") as unknown as {
      toServerProfile(profile: { name: string }): Record<string, unknown>;
    };
    expect(sync.toServerProfile({ name: "Books" })).toMatchObject({ name: "Books", profileType: "ebook" });
  });

  test("keeps the existing profile type when updating", () => {
    const sync = new QualityProfileChaptarrSync(client, "mixed") as unknown as {
      toServerProfile(profile: { name: string; profileType: string }): Record<string, unknown>;
    };
    expect(sync.toServerProfile({ name: "Audio", profileType: "audiobook", items: [] } as never)).toMatchObject({
      name: "Audio",
      profileType: "audiobook",
    });
  });

  test("keeps only custom formats applicable to the profile media type", () => {
    const sync = new QualityProfileChaptarrSync(client, "ebook") as unknown as {
      customFormatsForProfile(items: CustomFormatRequest[], profile: unknown, serverMatch?: unknown): CustomFormatRequest[];
    };
    expect(sync.customFormatsForProfile(formats, {}).map((item) => item.name)).toEqual(["ebook-only", "both", "untyped"]);
  });

  test("uses the existing server profile's media side in mixed mode", () => {
    const sync = new QualityProfileChaptarrSync(client, "mixed") as unknown as {
      customFormatsForProfile(items: CustomFormatRequest[], profile: unknown, serverMatch?: unknown): CustomFormatRequest[];
    };
    expect(sync.customFormatsForProfile(formats, {}, { name: "Audio", profileType: "audiobook" }).map((item) => item.name)).toEqual([
      "audio-only",
      "both",
      "untyped",
    ]);
  });

  test("defaults an omitted media type to the ebook format side", () => {
    const sync = new QualityProfileChaptarrSync(client) as unknown as {
      customFormatsForProfile(items: CustomFormatRequest[], profile: unknown, serverMatch?: unknown): CustomFormatRequest[];
    };
    expect(sync.customFormatsForProfile(formats, {}).map((item) => item.name)).toEqual(["ebook-only", "both", "untyped"]);
  });

  const definitions: QualityDefinitionShared[] = [
    { id: 1, title: "EPUB", quality: { id: 1, name: "EPUB" } },
    { id: 2, title: "MP3", quality: { id: 10, name: "MP3" } },
    { id: 3, title: "M4B", quality: { id: 11, name: "M4B" } },
  ];

  test("does not admit a quality through a group label from the server profile", () => {
    const sync = new QualityProfileChaptarrSync(client, "ebook") as unknown as {
      qualityDefinitionsForProfile(
        definitions: QualityDefinitionShared[],
        serverMatch: QualityProfileShared,
        profile: unknown,
      ): QualityDefinitionShared[];
    };
    const serverProfile: QualityProfileShared = {
      name: "E-Book",
      items: [
        {
          name: "MP3",
          allowed: true,
          items: [{ allowed: true, items: [], quality: { id: 1, name: "EPUB" } }],
        },
      ],
    };

    expect(sync.qualityDefinitionsForProfile(definitions, serverProfile, {}).map((item) => item.quality?.name)).toEqual(["EPUB"]);
  });

  test("can add a configured quality the existing profile does not have", () => {
    const sync = new QualityProfileChaptarrSync(client, "ebook") as unknown as {
      qualityDefinitionsForProfile(
        definitions: QualityDefinitionShared[],
        serverMatch: QualityProfileShared,
        profile: unknown,
      ): QualityDefinitionShared[];
    };
    const withPdf: QualityDefinitionShared[] = [...definitions, { id: 3, title: "PDF", quality: { id: 3, name: "PDF" } }];
    const serverProfile: QualityProfileShared = {
      name: "E-Book",
      items: [{ allowed: true, items: [], quality: { id: 1, name: "EPUB" } }],
    };

    const result = sync.qualityDefinitionsForProfile(withPdf, serverProfile, {
      qualities: [{ name: "EPUB" }, { name: "PDF" }],
    });
    expect(result.map((item) => item.quality?.name)).toEqual(["EPUB", "PDF"]);
  });

  test("does not admit a quality through a config group label", () => {
    const sync = new QualityProfileChaptarrSync(client, "ebook") as unknown as {
      qualityDefinitionsForProfile(
        definitions: QualityDefinitionShared[],
        serverMatch: undefined,
        profile: { qualities: Array<{ name: string; qualities: string[] }> },
      ): QualityDefinitionShared[];
    };

    const filtered = sync.qualityDefinitionsForProfile(definitions, undefined, {
      qualities: [{ name: "MP3", qualities: ["EPUB"] }],
    });
    expect(filtered.map((item) => item.quality?.name)).toEqual(["EPUB"]);
  });

  test("does not score a custom format the profile's media type excludes on update", async () => {
    const cfMap = {
      carrIdMapping: new Map([
        ["audio-trash", { carrConfig: { configarr_id: "audio-trash", name: "audio-only" }, requestConfig: {} }],
        ["ebook-trash", { carrConfig: { configarr_id: "ebook-trash", name: "ebook-only" }, requestConfig: {} }],
      ]),
      cfNameToCarrConfig: new Map(),
    } satisfies CFProcessing;
    const config = {
      custom_formats: [
        { trash_ids: ["audio-trash"], assign_scores_to: [{ name: "E-Book", score: 100 }] },
        { trash_ids: ["ebook-trash"], assign_scores_to: [{ name: "E-Book", score: 25 }] },
      ],
      quality_profiles: [
        {
          name: "E-Book",
          min_format_score: 5,
          qualities: [{ name: "EPUB" }],
          upgrade: { allowed: false },
          score_set: "default",
        },
      ],
      customFormatDefinitions: [],
      media_management: {},
      media_naming: {},
    } as unknown as MergedConfigInstance;
    const serverProfile: QualityProfileShared = {
      id: 7,
      name: "E-Book",
      minFormatScore: 0,
      upgradeAllowed: false,
      items: [{ allowed: true, items: [], quality: { id: 1, name: "EPUB" } }],
      formatItems: [{ name: "ebook-only", format: 20, score: 0 }],
    };
    const cache = new ServerCache({
      qualityDefinitions: definitions,
      qualityProfiles: [serverProfile],
      customFormats: [
        { id: 30, name: "audio-only", appliesTo: "audiobook" },
        { id: 20, name: "ebook-only", appliesTo: "ebook" },
      ],
      languages: [],
    });

    const result = await new QualityProfileChaptarrSync(client, "ebook").calculateQualityProfilesDiff(cfMap, config, cache);

    const formatItems = result.changedQPs[0]?.formatItems ?? [];
    expect(formatItems.map((item) => item.name)).toEqual(["ebook-only"]);
    expect(formatItems.every((item) => item.format != null)).toBe(true);
  });

  test("scores an audiobook profile's formats in mixed mode", async () => {
    const cfMap = {
      carrIdMapping: new Map([["audio-trash", { carrConfig: { configarr_id: "audio-trash", name: "audio-only" }, requestConfig: {} }]]),
      cfNameToCarrConfig: new Map(),
    } satisfies CFProcessing;
    const config = {
      custom_formats: [{ trash_ids: ["audio-trash"], assign_scores_to: [{ name: "Audio", score: 100 }] }],
      quality_profiles: [
        {
          name: "Audio",
          min_format_score: 5,
          qualities: [{ name: "MP3" }],
          upgrade: { allowed: false },
          score_set: "default",
        },
      ],
      customFormatDefinitions: [],
      media_management: {},
      media_naming: {},
    } as unknown as MergedConfigInstance;
    const serverProfile: QualityProfileShared & { profileType: string } = {
      id: 8,
      name: "Audio",
      profileType: "audiobook",
      minFormatScore: 0,
      upgradeAllowed: false,
      items: [{ allowed: true, items: [], quality: { id: 10, name: "MP3" } }],
      formatItems: [{ name: "audio-only", format: 30, score: 0 }],
    };
    const cache = new ServerCache({
      qualityDefinitions: definitions,
      qualityProfiles: [serverProfile],
      customFormats: [
        { id: 30, name: "audio-only", appliesTo: "audiobook" },
        { id: 20, name: "ebook-only", appliesTo: "ebook" },
      ],
      languages: [],
    });

    const result = await new QualityProfileChaptarrSync(client, "mixed").calculateQualityProfilesDiff(cfMap, config, cache);

    const formatItems = result.changedQPs[0]?.formatItems ?? [];
    expect(formatItems).toEqual([expect.objectContaining({ name: "audio-only", format: 30, score: 100 })]);
  });

  test("treats an omitted media type as ebook when scoring updates", async () => {
    const cfMap = {
      carrIdMapping: new Map([
        ["audio-trash", { carrConfig: { configarr_id: "audio-trash", name: "audio-only" }, requestConfig: {} }],
        ["ebook-trash", { carrConfig: { configarr_id: "ebook-trash", name: "ebook-only" }, requestConfig: {} }],
      ]),
      cfNameToCarrConfig: new Map(),
    } satisfies CFProcessing;
    const config = {
      custom_formats: [
        { trash_ids: ["audio-trash"], assign_scores_to: [{ name: "E-Book", score: 100 }] },
        { trash_ids: ["ebook-trash"], assign_scores_to: [{ name: "E-Book", score: 25 }] },
      ],
      quality_profiles: [
        {
          name: "E-Book",
          min_format_score: 5,
          qualities: [{ name: "EPUB" }],
          upgrade: { allowed: false },
          score_set: "default",
        },
      ],
      customFormatDefinitions: [],
      media_management: {},
      media_naming: {},
    } as unknown as MergedConfigInstance;
    const serverProfile: QualityProfileShared = {
      id: 7,
      name: "E-Book",
      minFormatScore: 0,
      upgradeAllowed: false,
      items: [{ allowed: true, items: [], quality: { id: 1, name: "EPUB" } }],
      formatItems: [{ name: "ebook-only", format: 20, score: 0 }],
    };
    const cache = new ServerCache({
      qualityDefinitions: definitions,
      qualityProfiles: [serverProfile],
      customFormats: [
        { id: 30, name: "audio-only", appliesTo: "audiobook" },
        { id: 20, name: "ebook-only", appliesTo: "ebook" },
      ],
      languages: [],
    });

    const result = await new QualityProfileChaptarrSync(client).calculateQualityProfilesDiff(cfMap, config, cache);

    const formatItems = result.changedQPs[0]?.formatItems ?? [];
    expect(formatItems.map((item) => item.name)).toEqual(["ebook-only"]);
    expect(formatItems.every((item) => item.format != null)).toBe(true);
  });

  test("treats an omitted media type as ebook when creating a profile", async () => {
    const cfMap = {
      carrIdMapping: new Map([
        ["audio-trash", { carrConfig: { configarr_id: "audio-trash", name: "audio-only" }, requestConfig: {} }],
        ["ebook-trash", { carrConfig: { configarr_id: "ebook-trash", name: "ebook-only" }, requestConfig: {} }],
      ]),
      cfNameToCarrConfig: new Map(),
    } satisfies CFProcessing;
    const config = {
      custom_formats: [
        { trash_ids: ["audio-trash"], assign_scores_to: [{ name: "E-Book", score: 100 }] },
        { trash_ids: ["ebook-trash"], assign_scores_to: [{ name: "E-Book", score: 25 }] },
      ],
      quality_profiles: [
        {
          name: "E-Book",
          min_format_score: 0,
          qualities: [{ name: "EPUB" }],
          upgrade: { allowed: false, until_quality: "EPUB" },
          score_set: "default",
        },
      ],
      customFormatDefinitions: [],
      media_management: {},
      media_naming: {},
    } as unknown as MergedConfigInstance;
    const cache = new ServerCache({
      qualityDefinitions: definitions,
      qualityProfiles: [],
      customFormats: [
        { id: 30, name: "audio-only", appliesTo: "audiobook" },
        { id: 20, name: "ebook-only", appliesTo: "ebook" },
      ],
      languages: [],
    });

    const result = await new QualityProfileChaptarrSync(client).calculateQualityProfilesDiff(cfMap, config, cache);

    const formatItems = result.create[0]?.formatItems ?? [];
    expect(formatItems.map((item) => item.name)).toEqual(["ebook-only"]);
    expect(formatItems.every((item) => item.format != null)).toBe(true);
  });

  describe("Chaptarr profile flags", () => {
    const profileFlags = {
      confirm_automatic_upgrades: true,
      prefer_custom_formats_over_quality: true,
      convert_to_quality: "M4B",
    };
    const profileConfig = (overrides: Record<string, unknown> = {}) =>
      ({
        custom_formats: [],
        quality_profiles: [
          {
            name: "Audio",
            min_format_score: 0,
            qualities: [{ name: "EPUB" }, { name: "M4B" }],
            upgrade: { allowed: false, until_quality: "EPUB" },
            score_set: "default",
            ...overrides,
          },
        ],
        customFormatDefinitions: [],
        media_management: {},
        media_naming: {},
      }) as unknown as MergedConfigInstance;
    const emptyCfMap: CFProcessing = { carrIdMapping: new Map(), cfNameToCarrConfig: new Map() };

    test("applies the flags and resolves convert_to_quality to the M4B id", async () => {
      const cache = new ServerCache({ qualityDefinitions: definitions, qualityProfiles: [], languages: [] });

      const result = await new QualityProfileChaptarrSync(client, "mixed").calculateQualityProfilesDiff(
        emptyCfMap,
        profileConfig(profileFlags),
        cache,
      );

      expect(result.create[0]).toMatchObject({
        confirmAutomaticUpgrades: true,
        preferCustomFormatsOverQuality: true,
        convertToQualityId: 11,
      });
    });

    test("maps the legacy convert_mp3_to_m4b alias to M4B", async () => {
      const cache = new ServerCache({ qualityDefinitions: definitions, qualityProfiles: [], languages: [] });

      const result = await new QualityProfileChaptarrSync(client, "audiobook").calculateQualityProfilesDiff(
        emptyCfMap,
        profileConfig({ convert_mp3_to_m4b: true }),
        cache,
      );

      expect(result.create[0]).toMatchObject({ convertToQualityId: 11 });
    });

    test("updates an existing profile and is idempotent", async () => {
      const serverProfile: QualityProfileShared & {
        profileType: "audiobook";
        confirmAutomaticUpgrades: boolean;
        preferCustomFormatsOverQuality: boolean;
        convertToQualityId: number;
      } = {
        id: 9,
        name: "Audio",
        profileType: "audiobook",
        confirmAutomaticUpgrades: false,
        preferCustomFormatsOverQuality: false,
        convertToQualityId: 0,
        upgradeAllowed: false,
        items: [
          { allowed: true, items: [], quality: { id: 1, name: "EPUB" } },
          { allowed: true, items: [], quality: { id: 11, name: "M4B" } },
        ],
        formatItems: [],
      };
      const config = profileConfig(profileFlags);
      const cache = new ServerCache({ qualityDefinitions: definitions, qualityProfiles: [serverProfile], languages: [] });

      const diff = await new QualityProfileChaptarrSync(client, "mixed").calculateQualityProfilesDiff(emptyCfMap, config, cache);

      expect(diff.changedQPs).toHaveLength(1);
      expect(diff.changedQPs[0]).toMatchObject({
        confirmAutomaticUpgrades: true,
        preferCustomFormatsOverQuality: true,
        convertToQualityId: 11,
      });
      expect(diff.changes.get("Audio")).toEqual(
        expect.arrayContaining([
          { field: "confirmAutomaticUpgrades", from: false, to: true },
          { field: "preferCustomFormatsOverQuality", from: false, to: true },
          { field: "convertToQualityId", from: 0, to: 11 },
        ]),
      );

      const updatedCache = new ServerCache({
        qualityDefinitions: definitions,
        qualityProfiles: [{ ...serverProfile, ...diff.changedQPs[0] }],
        languages: [],
      });
      const second = await new QualityProfileChaptarrSync(client, "mixed").calculateQualityProfilesDiff(emptyCfMap, config, updatedCache);
      expect(second.changedQPs).toHaveLength(0);
      expect(second.noChanges).toEqual(["Audio"]);
    });

    test("rejects an unknown convert_to_quality target", async () => {
      const cache = new ServerCache({ qualityDefinitions: definitions, qualityProfiles: [], languages: [] });

      await expect(
        new QualityProfileChaptarrSync(client, "mixed").calculateQualityProfilesDiff(
          emptyCfMap,
          profileConfig({ convert_to_quality: "MP3" }),
          cache,
        ),
      ).rejects.toThrow("configured convert_to_quality 'MP3' was not found on the server");
    });
  });
});
