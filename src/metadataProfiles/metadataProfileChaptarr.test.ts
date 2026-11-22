import type { Mocked } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MetadataProfileResource } from "../__generated__/readarr/data-contracts";
import { ServerCache } from "../cache";
import type { MetadataProfilesClient } from "../clients/capabilities";
import type { InputConfigMetadataProfile } from "../types/config.types";
import { ChaptarrMetadataProfileSync } from "./metadataProfileChaptarr";
import { ReadarrMetadataProfileSync } from "./metadataProfileReadarr";

describe("ChaptarrMetadataProfileSync", () => {
  const mockApi: Mocked<MetadataProfilesClient<MetadataProfileResource>> = {
    getMetadataProfiles: vi.fn(),
    createMetadataProfile: vi.fn(),
    updateMetadataProfile: vi.fn(),
    deleteMetadataProfile: vi.fn(),
  };

  let serverCache: ServerCache;

  beforeEach(() => {
    vi.clearAllMocks();
    serverCache = new ServerCache();
  });

  describe("resolveConfig", () => {
    it("maps the Chaptarr profile type and toggles", async () => {
      const sync = new ChaptarrMetadataProfileSync(mockApi);
      const config: InputConfigMetadataProfile = {
        name: "E-Book",
        profile_type: "ebook",
        skip_omnibus: true,
        skip_missing_identifier_omnibus: false,
        skip_missing_asin: true,
      };

      const result = await sync.resolveConfig(config, serverCache);

      expect(result).toEqual({
        name: "E-Book",
        profileType: 2,
        skipOmnibus: true,
        skipMissingIdentifierOmnibus: false,
        skipMissingAsin: true,
      });
    });

    it.each([
      ["general", 0],
      ["audiobook", 1],
      ["ebook", 2],
    ] as const)("maps profile_type %s to %i", async (profileType, id) => {
      const sync = new ChaptarrMetadataProfileSync(mockApi);

      const result = await sync.resolveConfig({ name: "Profile", profile_type: profileType }, serverCache);

      expect(result).toMatchObject({ profileType: id });
    });
  });

  describe("calculateDiff", () => {
    it("detects the Chaptarr fields and is idempotent", async () => {
      const serverProfile: MetadataProfileResource & {
        profileType: number;
        skipOmnibus: boolean;
        skipMissingIdentifierOmnibus: boolean;
        skipMissingAsin: boolean;
      } = {
        id: 1,
        name: "E-Book",
        minPopularity: 0,
        skipMissingDate: false,
        skipMissingIsbn: false,
        skipPartsAndSets: false,
        skipSeriesSecondary: false,
        allowedLanguages: null,
        minPages: 0,
        ignored: [],
        profileType: 0,
        skipOmnibus: false,
        skipMissingIdentifierOmnibus: false,
        skipMissingAsin: false,
      };
      mockApi.getMetadataProfiles.mockResolvedValue([serverProfile]);

      const sync = new ChaptarrMetadataProfileSync(mockApi);
      const config: InputConfigMetadataProfile = {
        name: "E-Book",
        profile_type: "ebook",
        skip_omnibus: true,
        skip_missing_identifier_omnibus: true,
        skip_missing_asin: true,
      };

      const diff = await sync.calculateDiff([config], serverCache);

      expect(diff?.changed).toHaveLength(1);
      expect(diff?.changed[0]?.fieldChanges).toEqual([
        { field: "profileType", from: 0, to: 2 },
        { field: "skipOmnibus", from: false, to: true },
        { field: "skipMissingIdentifierOmnibus", from: false, to: true },
        { field: "skipMissingAsin", from: false, to: true },
      ]);

      const resolved = await sync.resolveConfig(config, serverCache);
      mockApi.getMetadataProfiles.mockResolvedValue([{ ...serverProfile, ...resolved }]);

      const inSync = await sync.calculateDiff([config], serverCache);
      expect(inSync).toBeNull();
    });
  });

  describe("vanilla Readarr", () => {
    it.each(["profile_type", "skip_omnibus", "skip_missing_identifier_omnibus", "skip_missing_asin"] as const)(
      "rejects %s",
      async (field) => {
        const sync = new ReadarrMetadataProfileSync(mockApi);
        const config: InputConfigMetadataProfile = { name: "Books", [field]: field === "profile_type" ? "ebook" : true };

        await expect(sync.resolveConfig(config, serverCache)).rejects.toThrow(`metadata_profiles.${field} is supported only by Chaptarr`);
      },
    );

    it("rejects the keys during diffing before any write", async () => {
      mockApi.getMetadataProfiles.mockResolvedValue([]);
      const sync = new ReadarrMetadataProfileSync(mockApi);

      await expect(sync.calculateDiff([{ name: "Books", profile_type: "ebook" }], serverCache)).rejects.toThrow(
        "metadata_profiles.profile_type is supported only by Chaptarr",
      );
      expect(mockApi.getMetadataProfiles).not.toHaveBeenCalled();
    });
  });
});
