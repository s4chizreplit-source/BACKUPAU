/**
 * Google Drive "no bytes for viewers" detection.
 *
 * A Drive folder can be perfectly LISTABLE while every file in it refuses to
 * serve bytes: the owner can untick "viewers can download" (Drive then says
 * "Only the owner and editors can download this file"), or a file can be
 * temporarily rate-limited. Seen live: a 362-video campaign where every post
 * failed at publish time for exactly this. These helpers classify Drive's
 * small HTML block pages so flows can fail FAST with the real reason instead
 * of days of silent post failures.
 */

export const GDRIVE_LOCK_MESSAGE =
  "Google Drive is blocking downloads for these files: the owner has turned OFF downloading for viewers " +
  "(\"Only the owner and editors can download\"). Fix in Drive: open the folder, select all files → Share → " +
  "gear icon → tick \"Viewers and commenters can see the option to download, print, and copy\" — then try again.";

export const GDRIVE_QUOTA_MESSAGE =
  "Google Drive has temporarily rate-limited this file (too many recent downloads). " +
  "Wait a few hours or use a fresh copy of the file.";

/** Classify Drive's small HTML block pages. Null = not a recognized block
 *  (the virus-scan interstitial is NOT a block — the confirm flow handles it). */
export function classifyGDriveBlockPage(html: string): "download-locked" | "quota" | null {
  const t = html.replace(/&#0?39;/g, "'").replace(/&rsquo;/gi, "'").replace(/\s+/g, " ");
  if (/hasn't given you permission to download|only the owner and editors can download/i.test(t)) {
    return "download-locked";
  }
  if (/too many users have viewed or downloaded/i.test(t)) return "quota";
  return null;
}

/** One cheap probe: does this public Drive file serve bytes to a viewer?
 *  Returns a user-facing error when DEFINITIVELY download-locked, else null.
 *  Fails open (null) on network trouble or transient pages — never block a
 *  user flow on our own hiccup. */
export async function probeGDriveDownloadBlocked(fileId: string): Promise<string | null> {
  try {
    const r = await fetch(
      `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`,
      { redirect: "follow", signal: AbortSignal.timeout(8_000) },
    );
    const ct = r.headers.get("content-type") ?? "";
    if (!ct.includes("text/html")) {
      // Real bytes (or a redirect to them) — definitely downloadable.
      await r.body?.cancel().catch(() => {});
      return null;
    }
    const html = (await r.text()).slice(0, 65_536);
    return classifyGDriveBlockPage(html) === "download-locked" ? GDRIVE_LOCK_MESSAGE : null;
  } catch {
    return null;
  }
}
