/**
 * Dropbox link classification — the regression that motivated this: a file
 * link copied INSIDE a shared folder (/scl/fo/<id>/<key>/…/file.mp4) was
 * treated as a folder link and rejected, even though it downloads fine.
 */
import { describe, it, expect } from "vitest";
import { dropboxLastSegment, isDropboxFolderPath } from "../lib/dropboxLink";

describe("isDropboxFolderPath", () => {
  it("true folder shares stay folders (share id/key only, trailing slash too)", () => {
    expect(isDropboxFolderPath("/scl/fo/2i3r7as95n8wo7p0ij0u1/AD8GHgxNzxBtIJ9dPdJT65E")).toBe(true);
    expect(isDropboxFolderPath("/scl/fo/2i3r7as95n8wo7p0ij0u1/AD8GHgxNzxBtIJ9dPdJT65E/")).toBe(true);
    expect(isDropboxFolderPath("/sh/abc123/xyz789")).toBe(true);
  });

  it("subfolder paths (no filename) are still folders", () => {
    expect(isDropboxFolderPath("/scl/fo/id/key/Hell%20Grind%20Film")).toBe(true);
    expect(isDropboxFolderPath("/scl/fo/id/key/Sub/Deeper")).toBe(true);
  });

  it("file-inside-folder paths are FILES (the user's real link shape)", () => {
    expect(isDropboxFolderPath("/scl/fo/2i3r7as95n8wo7p0ij0u1/AD8GHgxNzxBtIJ9dPdJT65E/Hell%20Grind%20Film/HELLGRIND_film.mp4")).toBe(false);
    expect(isDropboxFolderPath("/scl/fo/id/key/My%20Clip.mp4")).toBe(false);
    expect(isDropboxFolderPath("/sh/abc/xyz/movie.MOV")).toBe(false); // legacy + case-insensitive
  });

  it("non-folder paths are never folders, whatever they end in", () => {
    expect(isDropboxFolderPath("/scl/fi/abc123/video.mp4")).toBe(false);
    expect(isDropboxFolderPath("/s/abc123/video.mp4")).toBe(false);
    expect(isDropboxFolderPath("/scl/fi/abc123/notes.pdf")).toBe(false);
  });

  it("malformed percent-encoding never throws", () => {
    expect(isDropboxFolderPath("/scl/fo/id/key/%E0%A4%A")).toBe(true); // undecodable, no video ext
  });
});

describe("dropboxLastSegment", () => {
  it("decodes the final segment", () => {
    expect(dropboxLastSegment("/scl/fo/id/key/Hell%20Grind%20Film/HELLGRIND_film.mp4")).toBe("HELLGRIND_film.mp4");
    expect(dropboxLastSegment("/scl/fo/id/key/My%20Clip.mp4")).toBe("My Clip.mp4");
    expect(dropboxLastSegment("/scl/fo/id/key/")).toBe("key");
  });
});
