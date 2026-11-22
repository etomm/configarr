import path from "node:path";
import type { QualityDefinitionsClient } from "../clients/capabilities";
import type { DiffEntry, FieldChange } from "../diffReport/diffReport.types";
import { getEnvs } from "../env";
import { logger } from "../logger";
import { cloneWithJSON, loadJsonFile, roundToDecimal } from "../util";
import { ConfigValidationError, warnOrThrowConfig } from "../validation";
import type { QualityDefinitionQuality, QualityDefinitionShared, QualityDefinitionSizeValue } from "./qualityDefinition.types";

/** A `null` or `0` max size both mean "unlimited" to the *arr apps. */
const isUnlimitedMax = (value: number | null | undefined): boolean => value == null || value === 0;

const normalizeSize = (value: number | null | undefined): number | null => value ?? null;

/**
 * Declared `max` matches when numbers are equal, and when both sides mean unlimited.
 * Server `0` and `null` are equivalent; without this a config with `max: unlimited`
 * would rewrite the row on every run.
 */
export const maxSizeMatches = (declared: QualityDefinitionSizeValue, server: number | null | undefined): boolean => {
  if (declared === null || declared === 0) {
    return isUnlimitedMax(server);
  }
  return server === declared;
};

export function applyPreferredSizeDiff(
  clonedQuality: QualityDefinitionQuality,
  serverQuality: QualityDefinitionShared,
  newData: QualityDefinitionShared,
  changes: FieldChange[],
) {
  // `undefined` is "unmanaged", so it must not be compared. `0` and `null` are real
  // declared values and therefore need `!== undefined` rather than a truthiness check.
  const declared = clonedQuality.preferred;
  if (declared !== undefined && normalizeSize(serverQuality.preferredSize) !== declared) {
    changes.push({ field: "preferredSize", from: normalizeSize(serverQuality.preferredSize), to: declared });
    newData.preferredSize = declared;
  }
}

export type QualityDefinitionSyncOptions = {
  arrLabel?: string;
  supportsPreferredSize?: boolean;
};

export class QualityDefinitionSync<T extends QualityDefinitionShared> {
  protected readonly arrLabel: string;
  protected readonly supportsPreferredSize: boolean;

  constructor(
    protected readonly api: QualityDefinitionsClient<T>,
    options: QualityDefinitionSyncOptions = {},
  ) {
    this.arrLabel = options.arrLabel ?? "this application";
    this.supportsPreferredSize = options.supportsPreferredSize ?? false;
  }

  protected getApi() {
    return this.api;
  }

  loadFromServer() {
    if (getEnvs().LOAD_LOCAL_SAMPLES) {
      return loadJsonFile<QualityDefinitionShared[]>(path.resolve(__dirname, "../../tests/samples/qualityDefinition.json"));
    }
    return this.getApi().getQualityDefinitions();
  }

  updateOnServer(restData: T[]) {
    return this.getApi().updateQualityDefinitions(restData);
  }

  /**
   * The shared input schema accepts the superset of fields (it cannot know the app), so
   * the app-level sync rejects `preferred` where the API has no preferred size instead
   * of silently dropping it.
   */
  protected validateConfiguredQualities(qualityDefinitions: QualityDefinitionQuality[]): void {
    if (this.supportsPreferredSize) {
      return;
    }
    const configured = qualityDefinitions.filter((quality) => quality.preferred !== undefined);
    if (configured.length === 0) {
      return;
    }
    const names = configured.map((quality) => quality.quality).join(", ");
    throw new ConfigValidationError(
      `QualityDefinition: 'preferred' is not supported by ${this.arrLabel} (its API has no preferred size). Remove it from: ${names}.`,
    );
  }

  protected diffPreferredSize(_clonedQuality: QualityDefinitionQuality, _serverQuality: T, _newData: T, _changes: FieldChange[]): void {}

  calculateDiff(serverQDs: T[], qualityDefinitions: QualityDefinitionQuality[]) {
    this.validateConfiguredQualities(qualityDefinitions);
    return calculateQualityDefinitionDiffCore(serverQDs, qualityDefinitions, (cloned, server, next, changes) =>
      this.diffPreferredSize(cloned, server, next, changes),
    );
  }

  async persist(serverQDs: T[], qualityDefinitions: QualityDefinitionQuality[], write: boolean) {
    const { changeMap, restData } = this.calculateDiff(serverQDs, qualityDefinitions);
    if (changeMap.size > 0 && write) {
      const updated = await this.updateOnServer(restData);
      return { changeMap, restData: updated };
    }
    return { changeMap, restData };
  }
}

export class QualityDefinitionPreferredSync<T extends QualityDefinitionShared> extends QualityDefinitionSync<T> {
  constructor(api: QualityDefinitionsClient<T>, options: Omit<QualityDefinitionSyncOptions, "supportsPreferredSize"> = {}) {
    super(api, { ...options, supportsPreferredSize: true });
  }

  protected diffPreferredSize(clonedQuality: QualityDefinitionQuality, serverQuality: T, newData: T, changes: FieldChange[]): void {
    applyPreferredSizeDiff(clonedQuality, serverQuality, newData, changes);
  }
}

export function interpolateSize(min: number, max: number, pref: number, ratio: number): number {
  if (ratio < 0 || ratio > 1) {
    throw new Error(`Unexpected ratio range. Should be between 0 <= ratio <= 1`);
  }
  if (ratio <= 0.5) {
    return roundToDecimal(min + (pref - min) * (ratio / 0.5), 1);
  } else {
    return roundToDecimal(pref + (max - pref) * ((ratio - 0.5) / 0.5), 1);
  }
}

export function calculateQualityDefinitionDiffCore<T extends QualityDefinitionShared>(
  serverQDs: T[],
  qualityDefinitions: QualityDefinitionQuality[],
  diffPreferredSize: (clonedQuality: QualityDefinitionQuality, serverQuality: T, newData: T, changes: FieldChange[]) => void,
): { changeMap: Map<string, FieldChange[]>; restData: T[] } {
  const serverMap = serverQDs.reduce((p, c) => {
    p.set(c.quality!.name!, c);
    return p;
  }, new Map<string, T>());

  const changeMap = new Map<string, FieldChange[]>();
  const restData: T[] = [];

  const missingServerQualities = new Map(serverMap);

  const mergedQualities = Object.values(
    qualityDefinitions.toReversed().reduce<{ [k: string]: QualityDefinitionQuality }>((p, c) => {
      if (p[c.quality] != null) {
        logger.debug(`QualityDefinition: Found duplicate for '${c.quality}'.`);
      } else {
        p[c.quality] = c;
        missingServerQualities.delete(c.quality);
      }

      return p;
    }, {}),
  );

  for (const quality of mergedQualities) {
    const clonedQuality = cloneWithJSON(quality);
    const serverQuality = serverMap.get(clonedQuality.quality);

    if (serverQuality) {
      const newData = cloneWithJSON(serverQuality);

      const changes: FieldChange[] = [];

      if (clonedQuality.min !== undefined && normalizeSize(serverQuality.minSize) !== clonedQuality.min) {
        changes.push({ field: "minSize", from: normalizeSize(serverQuality.minSize), to: clonedQuality.min });
        newData.minSize = clonedQuality.min;
      }
      if (clonedQuality.max !== undefined && !maxSizeMatches(clonedQuality.max, serverQuality.maxSize)) {
        changes.push({ field: "maxSize", from: normalizeSize(serverQuality.maxSize), to: clonedQuality.max });
        newData.maxSize = clonedQuality.max;
      }

      diffPreferredSize(clonedQuality, serverQuality, newData, changes);

      if (clonedQuality.title && serverQuality.title !== clonedQuality.title) {
        changes.push({ field: "title", from: serverQuality.title, to: clonedQuality.title });
        newData.title = clonedQuality.title;
      }

      if (changes.length > 0) {
        changeMap.set(serverQuality.quality!.name!, changes);
        restData.push(newData);
      } else {
        restData.push(serverQuality);
      }
    } else {
      warnOrThrowConfig(`QualityDefinition: Found definition which is not available in server '${clonedQuality.quality}'. Ignoring.`);
    }
  }

  if (missingServerQualities.size > 0) {
    logger.debug(
      `QualityDefinition: Found missing qualities will reuse server data: '${Array.from(missingServerQualities.values().map((e) => e.quality?.name || e.title))}'`,
    );
    restData.push(...missingServerQualities.values());
  }

  if (changeMap.size > 0) {
    logger.debug(Object.fromEntries(changeMap.entries()), `QualityDefinition diffs:`);
  }

  return { changeMap, restData };
}

export function qualityDefinitionsToDiffEntries(changeMap: Map<string, FieldChange[]>): DiffEntry[] {
  return Array.from(changeMap.entries()).map(([name, fieldChanges]) => ({
    resourceType: "QualityDefinition",
    name,
    action: "update" as const,
    fieldChanges,
  }));
}
