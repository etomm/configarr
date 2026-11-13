# Remote path mappings: support UNC paths

**Status:** implemented (2026-11-13)
**Plan:** [2026-11-13-remote-path-unc.md](../plans/2026-11-13-remote-path-unc.md)

## Problem

`RemotePathConfigSchema` only accepted POSIX (`/…`) or drive (`X:…`) paths. A Windows download client
on a network share reports a UNC path (`\\server\share\…`), which failed validation at config load and
aborted the whole instance run.

Fixing validation alone exposed a second bug: the syncer stripped only `/` when comparing paths, while
\*arr stores UNC mappings with a trailing `\`. A `\\server\share` mapping was therefore re-created on
every run.

## Decisions

- **Accepted absolute forms:** POSIX (`/…`), drive absolute (`X:\…` and `X:/…`), UNC (`\\server\share…`)
  and forward-slash UNC (`//server/share…`, already covered by the POSIX form).
- **Rejected forms:** relative (`downloads`), drive-relative (`X:…`) and single leading backslash
  (`\…`), because none of them is an absolute path on Windows. Drive-relative was previously accepted
  by accident; rejecting it is the correct behaviour and the issue asked for it.
- **No payload rewriting:** the UNC string is sent to \*arr unchanged. Forward-slash UNC is not
  converted to backslash UNC, because \*arr may treat the two forms differently when matching.
- **Normalization only in comparison, separator set depends on path style:** Windows-style paths
  (drive-qualified and `\\` UNC) strip trailing `\` and `/`; POSIX and `//server/share` paths strip
  only `/`. On Linux a backslash is an ordinary filename character, so `/data\` is not `/data`, and
  `//server/share` is not `\\server\share`. Roots normalize to `X:`/empty, which is unambiguous
  because both sides go through the same function and config values are validated as absolute.
- **One shared normalizer:** `normalizeRemotePath` lives in `src/remotePaths/remotePath.util.ts` and is
  used by both the syncer and config duplicate detection, which previously had its own slash-only
  copy of the logic.

## Out of scope

- `update_password_on_test_fail` behaviour for clients with an intentionally empty password (related
  but separate issue).
