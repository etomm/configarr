import { describe, expect, test } from "vitest";
import type { QualityProfileResource } from "../__generated__/readarr/data-contracts";
import type { QualityProfilesClient } from "../clients/capabilities";
import type { CustomFormatRequest } from "../customFormats/customFormat.types";
import type { QualityDefinitionShared } from "../qualityDefinitions/qualityDefinition.types";
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

  test("keeps only custom formats applicable to the profile media type", () => {
    const sync = new QualityProfileChaptarrSync(client, "ebook") as unknown as {
      customFormatsForProfile(items: CustomFormatRequest[], profile: unknown): CustomFormatRequest[];
    };
    expect(sync.customFormatsForProfile(formats, {}).map((item) => item.name)).toEqual(["ebook-only", "both", "untyped"]);
  });

  const definitions: QualityDefinitionShared[] = [
    { id: 1, title: "EPUB", quality: { id: 1, name: "EPUB" } },
    { id: 2, title: "MP3", quality: { id: 10, name: "MP3" } },
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
});
