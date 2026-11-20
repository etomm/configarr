import type { DiffEntry } from "../diffReport/diffReport.types";
import { getEnvs } from "../env";
import { logger } from "../logger";
import type { ArrType } from "../types/common.types";
import type { UiConfigType } from "../types/config.types";
import { compareObjectsCarr } from "../util";
import { ConfigValidationError } from "../validation";
import type { UiConfigSyncResult } from "./uiConfig.types";

/**
 * The generated UI resources differ per app but share the fields we manage.
 * The concrete return type is therefore narrowed at this boundary.
 */
type UiConfigClient = {
  getUiConfig(): Promise<unknown>;
  updateUiConfig(id: string, data: unknown): Promise<unknown>;
};

/**
 * Type guard to validate that server config has the required id field
 */
function hasValidId(config: Record<string, unknown>): config is Record<string, unknown> & { id: number } {
  return typeof config.id === "number" && config.id > 0;
}

/**
 * Sync UI config for a specific *Arr instance
 */
export async function syncUiConfig(
  client: UiConfigClient,
  arrType: ArrType,
  uiConfig: UiConfigType | undefined,
): Promise<UiConfigSyncResult> {
  // If ui_config is undefined/not present, skip management entirely
  if (uiConfig === undefined) {
    logger.debug(`No UI config specified for ${arrType}`);
    return { updated: false, arrType, fieldChanges: [] };
  }

  try {
    // Fetch current server UI config
    logger.debug(`Fetching UI config from ${arrType}...`);
    const serverConfig = await client.getUiConfig();
    if (serverConfig === null || typeof serverConfig !== "object") {
      throw new Error(`UI config for ${arrType} is not an object`);
    }

    // Generated types don't have index signatures; compare through a plain record.
    const serverConfigRecord = serverConfig as Record<string, unknown>;

    // Apply only what this product exposes: the same UI resource is not guaranteed to
    // carry every field across *arr versions.
    const declared = (uiConfig !== null && typeof uiConfig === "object" ? Object.entries(uiConfig) : []).filter(
      ([, value]) => value !== undefined,
    );
    const unsupported = declared.filter(([key]) => !Object.hasOwn(serverConfigRecord, key)).map(([key]) => key);
    if (unsupported.length) {
      throw new ConfigValidationError(`${arrType} ui_config does not expose ${unsupported.join(", ")}`);
    }
    const supported = Object.fromEntries(declared.filter(([key]) => Object.hasOwn(serverConfigRecord, key)));
    if (Object.keys(supported).length === 0) {
      return { updated: false, arrType, fieldChanges: [] };
    }

    // Calculate diff directly using compareObjectsCarr
    const { changes, equal } = compareObjectsCarr(serverConfigRecord, supported);

    if (equal) {
      logger.info(`UI config for ${arrType} is already up-to-date`);
      return { updated: false, arrType, fieldChanges: [] };
    }

    logger.info(`UI config changes detected for ${arrType}: ${changes.length} differences`);
    logger.debug(changes, `UI config changes for ${arrType}`);

    // Respect dry-run mode
    if (getEnvs().DRY_RUN) {
      logger.info(`DryRun: Would update UI config for ${arrType}`);
      return { updated: true, arrType, fieldChanges: changes };
    }

    // Validate server config has required id field
    if (!hasValidId(serverConfigRecord)) {
      throw new Error(`UI config for ${arrType} is missing required 'id' field`);
    }

    // Execute update - merge server config with local config
    const updatedConfig = {
      ...serverConfigRecord,
      ...supported,
    };

    await client.updateUiConfig(String(serverConfigRecord.id), updatedConfig);
    logger.info(`Successfully updated UI config for ${arrType}`);
    return { updated: true, arrType, fieldChanges: changes };
  } catch (error: unknown) {
    if (error instanceof ConfigValidationError) throw error;
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to sync UI config for ${arrType}: ${errorMessage}`);
    throw new Error(`UI config sync failed for ${arrType}: ${errorMessage}`);
  }
}

export function uiConfigDiffToDiffEntries(result: UiConfigSyncResult): DiffEntry[] {
  if (!result.updated) {
    return [];
  }
  return [{ resourceType: "UiConfig", name: result.arrType, action: "update", fieldChanges: result.fieldChanges }];
}
