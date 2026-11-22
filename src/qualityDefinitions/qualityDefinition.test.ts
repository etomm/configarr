import { describe, expect, test, vi } from "vitest";
import type { QualityDefinitionsClient } from "../clients/capabilities";
import * as env from "../env";
import { InputConfigArrInstanceSchema } from "../types/config.types";
import {
  InputConfigQualityDefinitionQualityBaseSchema,
  InputConfigQualityDefinitionQualityPreferredSchema,
  type TrashQualityDefinition,
  TrashQualityDefinitionQualitySchema,
  TrashQualityDefinitionSchema,
} from "../types/trashguide.types";
import { ConfigValidationError } from "../validation";
import {
  interpolateSize,
  QualityDefinitionPreferredSync,
  QualityDefinitionSync,
  qualityDefinitionsToDiffEntries,
} from "./qualityDefinition";
import type { QualityDefinitionShared } from "./qualityDefinition.types";

const createApi = () => ({
  getQualityDefinitions: vi.fn(),
  updateQualityDefinitions: vi.fn(),
});

const createSync = () => {
  const api = createApi();
  return {
    api,
    sync: new QualityDefinitionSync<QualityDefinitionShared>(api as unknown as QualityDefinitionsClient<QualityDefinitionShared>),
  };
};

describe("QualityDefinitions", () => {
  const server: QualityDefinitionShared[] = [
    {
      quality: {
        id: 0,
        name: "Unknown",
        resolution: 0,
      },
      title: "Unknown",
      weight: 1,
      minSize: 1,
      maxSize: 199.9,
      preferredSize: 194.9,
      id: 1,
    },
    {
      quality: {
        id: 1,
        name: "SDTV",
        resolution: 480,
      },
      title: "SDTV",
      weight: 2,
      minSize: 2,
      maxSize: 100,
      preferredSize: 95,
      id: 2,
    },
  ];

  const client = {
    trash_id: "aed34b9f60ee115dfa7918b742336277",
    type: "movie",
    qualities: [
      {
        quality: "SDTV",
        min: 2,
        preferred: 95,
        max: 100,
      },
    ],
  };

  const api = {
    getQualityDefinitions: vi.fn(),
    updateQualityDefinitions: vi.fn(),
  } satisfies QualityDefinitionsClient<QualityDefinitionShared>;

  const preferredSync = new QualityDefinitionPreferredSync(api);
  const plainSync = new QualityDefinitionSync(api);

  test("QualityDefinitionPreferredSync.calculateDiff - expect restData to always contain all server QDs", async () => {
    const result = preferredSync.calculateDiff(server, client.qualities);

    expect(result.restData.length).toBe(2);
  });

  test("QualityDefinitionPreferredSync.calculateDiff - no diff", async () => {
    const result = preferredSync.calculateDiff(server, client.qualities);

    expect(result.changeMap.size).toBe(0);
  });

  test("QualityDefinitionPreferredSync.calculateDiff - diff min size", async () => {
    const clone: TrashQualityDefinition = JSON.parse(JSON.stringify(client));
    clone.qualities[0]!.min = 3;

    const result = preferredSync.calculateDiff(server, clone.qualities);

    expect(result.changeMap.size).toBe(1);
  });

  test("QualityDefinitionPreferredSync.calculateDiff - diff max size", async () => {
    const clone: TrashQualityDefinition = JSON.parse(JSON.stringify(client));
    clone.qualities[0]!.max = 3;

    const result = preferredSync.calculateDiff(server, clone.qualities);

    expect(result.changeMap.size).toBe(1);
  });

  test("QualityDefinitionPreferredSync.calculateDiff - diff preferred size", async () => {
    const clone: TrashQualityDefinition = JSON.parse(JSON.stringify(client));
    clone.qualities[0]!.preferred = 3;

    const result = preferredSync.calculateDiff(server, clone.qualities);

    expect(result.changeMap.size).toBe(1);
  });

  test("QualityDefinitionPreferredSync.calculateDiff - ignore not available qualities on server", async () => {
    const clone: TrashQualityDefinition = JSON.parse(JSON.stringify(client));
    clone.qualities[0]!.quality = "New";

    const result = preferredSync.calculateDiff(server, clone.qualities);

    expect(result.changeMap.size).toBe(0);
    expect(result.restData.length).toBe(2);
  });

  test("QualityDefinitionPreferredSync.calculateDiff - throws for unknown qualities when enforcement is on", () => {
    const spy = vi.spyOn(env, "getEnvs").mockReturnValue({ CONFIGARR_ENFORCE_CONFIG_VALIDATION: true } as ReturnType<typeof env.getEnvs>);
    const clone: TrashQualityDefinition = JSON.parse(JSON.stringify(client));
    clone.qualities[0]!.quality = "New";

    try {
      expect(() => preferredSync.calculateDiff(server, clone.qualities)).toThrow(ConfigValidationError);
    } finally {
      spy.mockRestore();
    }
  });

  test("QualityDefinitionPreferredSync.calculateDiff - min size diff produces a structured FieldChange", async () => {
    const clone: TrashQualityDefinition = JSON.parse(JSON.stringify(client));
    clone.qualities[0]!.min = 3;

    const result = preferredSync.calculateDiff(server, clone.qualities);

    expect(result.changeMap.get("SDTV")).toEqual([{ field: "minSize", from: 2, to: 3 }]);
  });

  test("qualityDefinitionsToDiffEntries - converts a changeMap into DiffEntry[]", () => {
    const changeMap = new Map([["SDTV", [{ field: "minSize", from: 2, to: 3 }]]]);

    const entries = qualityDefinitionsToDiffEntries(changeMap);

    expect(entries).toEqual([
      { resourceType: "QualityDefinition", name: "SDTV", action: "update", fieldChanges: [{ field: "minSize", from: 2, to: 3 }] },
    ]);
  });

  test("QualityDefinitionSync.calculateDiff - rejects preferredSize (used by Readarr)", async () => {
    const clone: TrashQualityDefinition = JSON.parse(JSON.stringify(client));
    clone.qualities[0]!.preferred = 3;

    expect(() => plainSync.calculateDiff(server, clone.qualities)).toThrow("no preferred size");
  });

  test("interpolateSize - expected values", async () => {
    expect(interpolateSize(0, 100, 50, 0.5)).toBe(50);
    expect(interpolateSize(0, 100, 50, 0.0)).toBe(0);
    expect(interpolateSize(0, 100, 50, 1.0)).toBe(100);
    expect(interpolateSize(0, 100, 50, 0.25)).toBe(25);

    expect(interpolateSize(2, 100, 95, 0.5)).toBe(95);
    expect(interpolateSize(2, 100, 95, 0.0)).toBe(2);
    expect(interpolateSize(2, 100, 95, 1.0)).toBe(100);
  });

  describe("QualityDefinitionSync.persist", () => {
    test("writes the computed restData and returns the server response", async () => {
      const { api, sync } = createSync();
      const updatedFromServer: QualityDefinitionShared[] = [{ ...server[1]!, minSize: 3 }];
      api.updateQualityDefinitions.mockResolvedValue(updatedFromServer);

      const qualities = [{ quality: "SDTV", min: 3, max: 100 }];

      const result = await sync.persist(server, qualities, true);

      expect(api.updateQualityDefinitions).toHaveBeenCalledTimes(1);
      expect(api.updateQualityDefinitions).toHaveBeenCalledWith([{ ...server[1]!, minSize: 3 }, { ...server[0]! }]);
      expect(result.changeMap.size).toBe(1);
      expect(result.restData).toBe(updatedFromServer);
    });

    test("does not write anything when write is false but still reports the changeMap", async () => {
      const { api, sync } = createSync();

      const result = await sync.persist(server, [{ quality: "SDTV", min: 3, max: 100 }], false);

      expect(api.updateQualityDefinitions).not.toHaveBeenCalled();
      expect(result.changeMap.get("SDTV")).toEqual([{ field: "minSize", from: 2, to: 3 }]);
      expect(result.restData).toHaveLength(2);
    });

    test("does not write when there are no changes", async () => {
      const { api, sync } = createSync();

      const result = await sync.persist(server, [{ quality: "SDTV", min: 2, max: 100 }], true);

      expect(api.updateQualityDefinitions).not.toHaveBeenCalled();
      expect(result.changeMap.size).toBe(0);
      expect(result.restData.map((q) => q.quality?.name)).toEqual(["SDTV", "Unknown"]);
    });

    test("propagates write failures", async () => {
      const { api, sync } = createSync();
      api.updateQualityDefinitions.mockRejectedValue(new Error("500 from server"));

      await expect(sync.persist(server, [{ quality: "SDTV", min: 3, max: 100 }], true)).rejects.toThrow("500 from server");
    });

    test("loads the server qualities through the api", async () => {
      const { api, sync } = createSync();
      api.getQualityDefinitions.mockResolvedValue(server);

      await expect(sync.loadFromServer()).resolves.toBe(server);
    });
  });

  test("interpolateSize - should fail", async () => {
    expect(() => interpolateSize(0, 100, 50, -0.5)).toThrowError();
    expect(() => interpolateSize(0, 100, 50, 1.1)).toThrowError();
  });
});

describe("QualityDefinition size values", () => {
  const api = {
    getQualityDefinitions: vi.fn(),
    updateQualityDefinitions: vi.fn(),
  } satisfies QualityDefinitionsClient<QualityDefinitionShared>;
  const preferredSync = new QualityDefinitionPreferredSync(api);
  const server: QualityDefinitionShared[] = [
    {
      id: 1,
      quality: { id: 1, name: "SDTV", resolution: 480 },
      title: "SDTV",
      weight: 2,
      minSize: 2,
      maxSize: 200,
      preferredSize: 95,
    },
  ];

  test("omitted size validates and produces no diff", () => {
    const parsed = InputConfigQualityDefinitionQualityPreferredSchema.parse({ quality: "SDTV", min: 2 });
    expect(parsed).toEqual({ quality: "SDTV", min: 2 });

    const result = preferredSync.calculateDiff(server, [parsed]);
    expect(result.changeMap.size).toBe(0);
  });

  test("max: unlimited is normalised to null and clears a numeric server value once", () => {
    const parsed = InputConfigQualityDefinitionQualityPreferredSchema.parse({ quality: "SDTV", max: "unlimited" });
    expect(parsed.max).toBeNull();

    const result = preferredSync.calculateDiff(server, [parsed]);
    expect(result.changeMap.get("SDTV")).toEqual([{ field: "maxSize", from: 200, to: null }]);
    expect(result.restData.find((entry) => entry.quality?.name === "SDTV")?.maxSize).toBeNull();

    const stable = preferredSync.calculateDiff(result.restData, [parsed]);
    expect(stable.changeMap.size).toBe(0);
  });

  test("max: unlimited is idempotent against server null and 0", () => {
    const configured = [{ quality: "SDTV", max: null as number | null }];
    expect(preferredSync.calculateDiff([{ ...server[0]!, maxSize: null }], configured).changeMap.size).toBe(0);
    expect(preferredSync.calculateDiff([{ ...server[0]!, maxSize: 0 }], configured).changeMap.size).toBe(0);
  });

  test("max: 0 declared also treats server null as unlimited", () => {
    const result = preferredSync.calculateDiff([{ ...server[0]!, maxSize: null }], [{ quality: "SDTV", max: 0 }]);
    expect(result.changeMap.size).toBe(0);
  });

  test("preferred: 0 is written once and then stable", () => {
    const configured = [{ quality: "SDTV", preferred: 0 }];
    const first = preferredSync.calculateDiff(server, configured);

    expect(first.changeMap.get("SDTV")).toEqual([{ field: "preferredSize", from: 95, to: 0 }]);
    expect(first.restData.find((entry) => entry.quality?.name === "SDTV")?.preferredSize).toBe(0);

    const second = preferredSync.calculateDiff(first.restData, configured);
    expect(second.changeMap.size).toBe(0);
  });

  test("preferred: unlimited clears the field and is idempotent", () => {
    const configured = [{ quality: "SDTV", preferred: null as number | null }];
    const first = preferredSync.calculateDiff(server, configured);

    expect(first.changeMap.get("SDTV")).toEqual([{ field: "preferredSize", from: 95, to: null }]);
    expect(preferredSync.calculateDiff(first.restData, configured).changeMap.size).toBe(0);
  });

  test("min: unlimited is rejected while min: null clears explicitly", () => {
    expect(InputConfigQualityDefinitionQualityPreferredSchema.safeParse({ quality: "SDTV", min: "unlimited" }).success).toBe(false);
    expect(InputConfigQualityDefinitionQualityPreferredSchema.parse({ quality: "SDTV", min: null }).min).toBeNull();
  });

  test.each(["Readarr", "Chaptarr"])("rejects preferred on %s with an app-named validation error", (arrLabel) => {
    const sync = new QualityDefinitionSync(api, { arrLabel });

    expect(() => sync.calculateDiff(server, [{ quality: "SDTV", preferred: 50 }])).toThrow(arrLabel);
  });

  test("preferred_ratio with an unlimited size is rejected", () => {
    const result = InputConfigArrInstanceSchema.safeParse({
      base_url: "http://radarr:7878",
      api_key: "key",
      quality_definition: {
        preferred_ratio: 0.5,
        qualities: [{ quality: "SDTV", max: "unlimited" }],
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join(" ")).toContain("preferred_ratio");
  });

  test("the base config variant rejects preferred", () => {
    expect(InputConfigQualityDefinitionQualityBaseSchema.safeParse({ quality: "SDTV", preferred: 50 }).success).toBe(false);
  });

  test("TRaSH quality-size data stays strict and still requires every size", () => {
    expect(TrashQualityDefinitionQualitySchema.safeParse({ quality: "SDTV", min: 1, preferred: 2 }).success).toBe(false);
    expect(
      TrashQualityDefinitionSchema.safeParse({
        trash_id: "aed34b9f60ee115dfa7918b742336277",
        type: "movie",
        qualities: [{ quality: "SDTV", min: 1, preferred: 2 }],
      }).success,
    ).toBe(false);
  });
});
