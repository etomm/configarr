import { describe, it, expect } from "vitest";
import { RemotePathConfigSchema } from "./remotePath.types";

describe("RemotePathTypes", () => {
  it("should validate correct remote path config", () => {
    const config = {
      host: "transmission",
      remote_path: "/downloads",
      local_path: "/data/downloads",
    };
    expect(() => RemotePathConfigSchema.parse(config)).not.toThrow();
  });

  it("should reject missing host", () => {
    const config = {
      remote_path: "/downloads",
      local_path: "/data/downloads",
    };
    expect(() => RemotePathConfigSchema.parse(config)).toThrow();
  });

  it("should reject empty host", () => {
    const config = {
      host: "",
      remote_path: "/downloads",
      local_path: "/data/downloads",
    };
    expect(() => RemotePathConfigSchema.parse(config)).toThrow();
  });

  it("should reject missing remote_path", () => {
    const config = {
      host: "transmission",
      local_path: "/data/downloads",
    };
    expect(() => RemotePathConfigSchema.parse(config)).toThrow();
  });

  it("should reject missing local_path", () => {
    const config = {
      host: "transmission",
      remote_path: "/downloads",
    };
    expect(() => RemotePathConfigSchema.parse(config)).toThrow();
  });

  describe("absolute path forms", () => {
    const parse = (remotePath: string, localPath = "/data/downloads") =>
      RemotePathConfigSchema.parse({ host: "transmission", remote_path: remotePath, local_path: localPath });

    it.each([
      ["POSIX", "/downloads"],
      ["Windows drive with forward slash", "D:/downloads"],
      ["Windows drive with backslash", String.raw`D:\downloads`],
      ["UNC", String.raw`\\server\share\sub\dir`],
      ["forward-slash UNC", "//server/share/downloads"],
    ])("should accept a %s remote_path", (_name, remotePath) => {
      expect(() => parse(remotePath)).not.toThrow();
    });

    it("should accept a UNC local_path", () => {
      expect(() => parse("/downloads", String.raw`\\server\share`)).not.toThrow();
    });

    it.each([
      ["relative path", "downloads"],
      ["drive-relative path", String.raw`C:downloads`],
      ["single leading backslash", String.raw`\server\downloads`],
      ["empty path", ""],
    ])("should reject a %s", (_name, remotePath) => {
      expect(() => parse(remotePath)).toThrow(/must be an absolute path/);
    });
  });
});
