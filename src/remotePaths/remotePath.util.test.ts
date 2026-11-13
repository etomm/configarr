import { describe, it, expect } from "vitest";
import { normalizeRemotePath } from "./remotePath.util";

describe("normalizeRemotePath", () => {
  it.each([
    ["POSIX path", "/data/downloads", "/data/downloads"],
    ["POSIX path with trailing slash", "/data/downloads/", "/data/downloads"],
    ["POSIX path with repeated trailing slashes", "/data/downloads///", "/data/downloads"],
    ["UNC path", String.raw`\\server\share\downloads`, String.raw`\\server\share\downloads`],
    ["UNC path with trailing backslash", "\\\\server\\share\\downloads\\", String.raw`\\server\share\downloads`],
    ["UNC path with repeated trailing backslashes", "\\\\server\\share\\downloads\\\\\\", String.raw`\\server\share\downloads`],
    ["UNC path with trailing slash", String.raw`\\server\share\downloads/`, String.raw`\\server\share\downloads`],
    ["forward-slash UNC path", "//server/share/downloads", "//server/share/downloads"],
    ["forward-slash UNC path with trailing slash", "//server/share/downloads/", "//server/share/downloads"],
    ["Windows drive path with trailing backslash", "D:\\downloads\\", "D:\\downloads"],
    ["Windows drive path with trailing slash", "D:/downloads/", "D:/downloads"],
    ["Windows drive root", "C:\\", "C:"],
    ["POSIX root", "/", ""],
    ["empty path", "", ""],
  ])("normalizes a %s", (_name, input, expected) => {
    expect(normalizeRemotePath(input)).toBe(expected);
  });

  it("keeps a trailing backslash on a POSIX path, where it is a filename character", () => {
    expect(normalizeRemotePath("/data\\")).toBe("/data\\");
    expect(normalizeRemotePath("/data\\")).not.toBe(normalizeRemotePath("/data"));
  });

  it("keeps a trailing backslash on a forward-slash UNC path", () => {
    expect(normalizeRemotePath("//server/share\\")).toBe("//server/share\\");
    expect(normalizeRemotePath("//server/share\\")).not.toBe(normalizeRemotePath("//server/share"));
  });

  it("does not treat a forward-slash UNC path and a backslash UNC path as the same path", () => {
    expect(normalizeRemotePath("//server/share")).not.toBe(normalizeRemotePath(String.raw`\\server\share`));
  });
});
