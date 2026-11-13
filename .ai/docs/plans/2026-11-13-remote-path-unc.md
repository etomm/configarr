# Remote path mappings: support UNC paths

**Spec:** [2026-11-13-remote-path-unc-design.md](../specs/2026-11-13-remote-path-unc-design.md)

## Steps

1. `src/remotePaths/remotePath.types.ts`
   - Add a shared absolute-path regex accepting POSIX, drive absolute and UNC forms.
   - Apply it to `remote_path` and `local_path`, and name all accepted forms in the message.
2. `src/remotePaths/remotePath.util.ts`
   - Add `normalizeRemotePath`: strips trailing `\` and `/` for Windows-style paths, only `/` for
     POSIX paths (a backslash is a filename character on Linux).
   - `remotePathSyncer.ts` and config duplicate detection (`src/config.ts`) both use it.
3. Tests
   - `remotePath.util.test.ts`: POSIX, UNC, drive root, repeated and mixed trailing separators, plus
     `/data\` vs `/data` and `//server/share` vs `\\server\share` staying distinct.
   - `remotePath.types.test.ts`: accepted forms (POSIX, `X:/`, `X:\`, UNC, `//server/share`, UNC local
     path) and rejected forms (relative, drive-relative, single leading `\`, empty).
   - `remotePathSyncer.test.ts`: UNC mapping with trailing `\` on the server is unchanged and stable on
     a second run, an absent UNC mapping is created with the exact config string, UNC `local_path`
     trailing `\` is unchanged, different servers do not match, and POSIX paths ending in `\` or
     colon-slash UNC forms do not match each other.
   - `config.test.ts`: UNC mapping passes config validation, non-absolute paths still fail at load,
     UNC duplicates that differ only by a trailing separator are rejected, different servers and
     forward-slash vs backslash UNC are not.
4. Docs: `docs/docs/configuration/config-file.md` — UNC example, YAML escaping note, accepted absolute
   forms and trailing-separator normalization.
5. Verification: `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm typecheck`.
