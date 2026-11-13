/** Windows absolute paths: drive-qualified (`X:\…`, `X:/…`) or UNC (`\\server\share`). */
const WINDOWS_ABSOLUTE_PATH = /^([a-zA-Z]:[\\/]|\\\\)/;

/**
 * Normalize a path for comparison by removing trailing separators.
 *
 * *Arr apps append a trailing separator when they store a path. That is usually
 * `/`, but a Windows-hosted app uses `\` for drive and UNC paths.
 *
 * The separator set depends on the path style: on Linux a backslash is an
 * ordinary filename character, so `/data\` and `/data` are different paths, and
 * `//server/share` (a POSIX path) is different from `\\server\share` (UNC).
 * Only Windows-style paths strip `\` as well as `/`.
 *
 * Root paths normalize to `X:` or an empty string. That is unambiguous as long as
 * both sides of a comparison go through this function and config-authored values
 * are validated to be absolute.
 */
export function normalizeRemotePath(path: string): string {
  return WINDOWS_ABSOLUTE_PATH.test(path) ? path.replace(/[\\/]+$/, "") : path.replace(/\/+$/, "");
}
