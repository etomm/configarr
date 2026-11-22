import { describe, expect, test, vi } from "vitest";
import { ChaptarrMediaManagementSync } from "./mediaManagementChaptarr";

function stubApi(serverNaming: Record<string, unknown>) {
  const api = {
    getNaming: vi.fn(async () => serverNaming),
    updateNaming: vi.fn(async (_id: string, _data: Record<string, unknown>) => serverNaming),
    getMediamanagement: vi.fn(async () => ({ id: 2 })),
    updateMediamanagement: vi.fn(async () => ({ id: 2 })),
  };
  return api;
}

describe("ChaptarrMediaManagementSync", () => {
  test("maps generic book naming to the ebook keys for media_type ebook", async () => {
    const api = stubApi({
      id: 1,
      standardBookFormat: "old",
      authorFolderFormat: "old",
      ebookStandardBookFormat: null,
      ebookAuthorFolderFormat: null,
    });

    const sync = new ChaptarrMediaManagementSync(api as never, "ebook");
    const diff = await sync.persistNaming({ standardBookFormat: "{Author}/{Title}", authorFolderFormat: "{Author}" }, true);

    expect(api.updateNaming).toHaveBeenCalledWith(
      "1",
      expect.objectContaining({
        ebookStandardBookFormat: "{Author}/{Title}",
        ebookAuthorFolderFormat: "{Author}",
        standardBookFormat: "old",
        authorFolderFormat: "old",
      }),
    );
    expect(diff?.changes).toEqual([
      { field: "ebookStandardBookFormat", from: null, to: "{Author}/{Title}" },
      { field: "ebookAuthorFolderFormat", from: null, to: "{Author}" },
    ]);
  });

  test("keeps the generic keys for audiobook and vanilla Readarr", async () => {
    for (const mediaType of ["audiobook", undefined] as const) {
      const api = stubApi({ id: 1, standardBookFormat: "old", authorFolderFormat: "old" });
      const sync = new ChaptarrMediaManagementSync(api as never, mediaType);
      await sync.persistNaming({ standardBookFormat: "{Author}/{Title}" }, true);
      expect(api.updateNaming).toHaveBeenCalledWith("1", expect.objectContaining({ standardBookFormat: "{Author}/{Title}" }));
      expect(api.updateNaming.mock.calls[0]?.[1]).not.toHaveProperty("ebookStandardBookFormat");
    }
  });

  test("is idempotent when the ebook keys already match", async () => {
    const api = stubApi({
      id: 1,
      standardBookFormat: "old",
      ebookStandardBookFormat: "{Author}/{Title}",
      ebookAuthorFolderFormat: "{Author}",
    });
    const sync = new ChaptarrMediaManagementSync(api as never, "ebook");
    const diff = await sync.persistNaming({ standardBookFormat: "{Author}/{Title}", authorFolderFormat: "{Author}" }, true);
    expect(diff).toBeNull();
    expect(api.updateNaming).not.toHaveBeenCalled();
  });

  test("maps the explicit ebook naming fields and keeps media_naming_api", async () => {
    const api = stubApi({
      id: 1,
      ebookRenameBooks: false,
      ebookReplaceIllegalCharacters: false,
      ebookColonReplacementFormat: 0,
      ebookStandardBookFormat: null,
    });
    const sync = new ChaptarrMediaManagementSync(api as never, "ebook");
    const config = {
      media_naming_api: { standardBookFormat: "{Author}/{Title}" },
      ebook_rename_books: true,
      ebook_replace_illegal_characters: true,
      ebook_colon_replacement_format: 3,
    } as never;

    const naming = sync.resolveNamingConfig(config);
    expect(naming).toEqual({
      standardBookFormat: "{Author}/{Title}",
      ebookRenameBooks: true,
      ebookReplaceIllegalCharacters: true,
      ebookColonReplacementFormat: 3,
    });

    const diff = await sync.persistNaming(naming, true);

    expect(api.updateNaming).toHaveBeenCalledWith(
      "1",
      expect.objectContaining({
        ebookRenameBooks: true,
        ebookReplaceIllegalCharacters: true,
        ebookColonReplacementFormat: 3,
        ebookStandardBookFormat: "{Author}/{Title}",
      }),
    );
    expect(diff?.changes).toEqual(
      expect.arrayContaining([
        { field: "ebookRenameBooks", from: false, to: true },
        { field: "ebookReplaceIllegalCharacters", from: false, to: true },
        { field: "ebookColonReplacementFormat", from: 0, to: 3 },
        { field: "ebookStandardBookFormat", from: null, to: "{Author}/{Title}" },
      ]),
    );
  });

  test("uses the explicit ebook naming fields without a media_naming_api block", async () => {
    const api = stubApi({ id: 1, ebookRenameBooks: false });
    const sync = new ChaptarrMediaManagementSync(api as never, "audiobook");

    const naming = sync.resolveNamingConfig({ ebook_rename_books: true } as never);

    expect(naming).toEqual({ ebookRenameBooks: true });
    await sync.persistNaming(naming, true);
    expect(api.updateNaming).toHaveBeenCalledWith("1", expect.objectContaining({ ebookRenameBooks: true }));
  });

  test("is idempotent when the explicit ebook fields already match", async () => {
    const api = stubApi({ id: 1, ebookRenameBooks: true, ebookReplaceIllegalCharacters: true, ebookColonReplacementFormat: 3 });
    const sync = new ChaptarrMediaManagementSync(api as never, "ebook");

    const diff = await sync.persistNaming(
      sync.resolveNamingConfig({
        ebook_rename_books: true,
        ebook_replace_illegal_characters: true,
        ebook_colon_replacement_format: 3,
      } as never),
      true,
    );

    expect(diff).toBeNull();
    expect(api.updateNaming).not.toHaveBeenCalled();
  });
});
