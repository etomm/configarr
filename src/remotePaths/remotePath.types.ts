import { z } from "zod";
import { ArrType } from "../types/common.types";
import { InputConfigRemotePath } from "../types/config.types";
import { DiffEntry } from "../diffReport/diffReport.types";

/**
 * Absolute paths: POSIX (`/…`), Windows drive (`X:/…` or `X:\…`) and UNC (`\\server\share`).
 * Drive-relative (`X:…`) and single-backslash (`\…`) paths are not absolute on Windows.
 */
const ABSOLUTE_PATH_REGEX = /^([a-zA-Z]:[\\/]|\\\\|\/)/;

/**
 * Zod schema for validating remote path configuration
 */
export const RemotePathConfigSchema = z.object({
  host: z.string().min(1, "Host is required"),
  remote_path: z
    .string()
    .min(1, "Remote path is required")
    .regex(ABSOLUTE_PATH_REGEX, "Remote path must be an absolute path (start with /, X:/ or \\\\server\\share)"),
  local_path: z
    .string()
    .min(1, "Local path is required")
    .regex(ABSOLUTE_PATH_REGEX, "Local path must be an absolute path (start with /, X:/ or \\\\server\\share)"),
});

/**
 * Result of a remote path mapping sync operation
 */
export interface RemotePathSyncResult {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  arrType: ArrType;
  diffEntries: DiffEntry[];
}

/**
 * Remote path mapping resource (common interface used by syncer)
 * Individual clients use their specific generated types
 */
export interface RemotePathMappingResource {
  id?: number;
  host?: string | null;
  remotePath?: string | null;
  localPath?: string | null;
}

/**
 * Internal diff calculation result
 */
export interface RemotePathDiff {
  toCreate: InputConfigRemotePath[];
  toUpdate: Array<{ id: number; config: InputConfigRemotePath; server: RemotePathMappingResource }>;
  toDelete: Array<{ id: number; host?: string | null; remotePath?: string | null }>;
  unchanged: number;
}
