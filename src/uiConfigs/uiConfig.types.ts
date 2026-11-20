import type { FieldChange } from "../diffReport/diffReport.types";
import type { ArrType } from "../types/common.types";

/**
 * Result of a UI config sync operation
 */
export interface UiConfigSyncResult {
  updated: boolean;
  arrType: ArrType;
  fieldChanges: FieldChange[];
}
