/**
 * Dropbox share-link classification — shared by the clipper download path
 * (routes/videoTools.ts) and the bulk-scheduler expansion (routes/social.ts).
 *
 * /scl/fi/… and /s/… links always point at a single file. /scl/fo/… and
 * /sh/… are FOLDER shares — but when a user copies the link of a specific
 * file INSIDE a shared folder, Dropbox appends the file's subpath to the
 * same folder-share prefix:
 *   /scl/fo/<share-id>/<key>/<subfolders…>/<file>.mp4?rlkey=…&st=…
 * Those are file links: the dl.dropboxusercontent.com host-swap (keeping
 * rlkey/st) serves the bytes directly — verified live with HTTP 206.
 * Only paths that stop at the share id/key, or at a subfolder, are true
 * folder links that need the ?preview= flow or per-file guidance.
 */
export const DROPBOX_VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;

/** Last path segment, decoded ("My%20Video.mp4" → "My Video.mp4").
 *  Malformed percent-encoding falls back to the raw segment. */
export function dropboxLastSegment(pathname: string): string {
  const raw = pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** True only for folder-share paths that do NOT end in a video filename. */
export function isDropboxFolderPath(pathname: string): boolean {
  const folderShare = /^\/sh\//.test(pathname) || pathname.startsWith("/scl/fo/");
  return folderShare && !DROPBOX_VIDEO_EXT.test(dropboxLastSegment(pathname));
}
