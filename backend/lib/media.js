// Where large media (progress videos) lives on disk.
//
// Deliberately NOT the database. `documents` base64-encodes files into a text
// column with a 2.5 MB cap; a 25 MB video is ~14x over that before base64
// inflates it by a third. 277 students x 10 months x 25 MB is ~68 GB — that
// belongs on a filesystem.
//
// MEDIA_ROOT is the single switch. Today it points at local disk; when the
// second VPS arrives, pointing it at a mount there is a one-line env change
// and nothing in the route or screen code moves. Keep it OUTSIDE the Next.js
// project directory in production: anything under the app root risks being
// swept by a build, and `.next` cleanup has already bitten this project once.

import fs from "fs";
import path from "path";

export const MEDIA_ROOT =
  process.env.MEDIA_ROOT || path.join(process.cwd(), "data", "media");

// Per-request cap. Enforced by the route as bytes arrive, not after, so an
// oversized upload is cut off mid-stream rather than buffered to completion
// and then rejected. 120 MB allows a generous month's video while still
// bounding what one request can write.
export const MAX_VIDEO_BYTES = Number(process.env.MAX_VIDEO_BYTES || 120 * 1024 * 1024);

export const ALLOWED_VIDEO_TYPES = new Set([
  "video/mp4",
  "video/quicktime",   // iPhone .mov — the most likely source here
  "video/webm",
  "video/x-matroska",
  "video/3gpp",        // older Android handsets
]);

const EXT_BY_TYPE = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/x-matroska": ".mkv",
  "video/3gpp": ".3gp",
};

export function extensionFor(mimeType) {
  return EXT_BY_TYPE[String(mimeType || "").toLowerCase()] || ".bin";
}

// Build the on-disk key for a video. Sharded by period so one directory never
// holds 277 x N files, which makes both `ls` and filesystem lookups slow.
//
// The key is composed ONLY from values we generate or validate — never from
// the uploaded filename. A name like "../../.env" must not be able to steer
// a write, and the original name is kept as metadata instead.
export function videoKey({ studentId, period, id, mimeType }) {
  const safeStudent = String(studentId).replace(/[^A-Za-z0-9_-]/g, "");
  const safePeriod = String(period).replace(/[^0-9-]/g, "");
  const safeId = String(id).replace(/[^A-Za-z0-9_-]/g, "");
  if (!safeStudent || !safePeriod || !safeId) throw new Error("bad video key parts");
  return path.posix.join("videos", safePeriod, `${safeStudent}__${safeId}${extensionFor(mimeType)}`);
}

// Resolve a storage key to an absolute path, refusing anything that escapes
// MEDIA_ROOT. Every read and delete goes through here: a stored key is data
// from the database, and this is the boundary that keeps a tampered row from
// reaching arbitrary files.
export function resolveMediaPath(storageKey) {
  const root = path.resolve(MEDIA_ROOT);
  const full = path.resolve(root, String(storageKey || ""));
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("storage key escapes media root");
  }
  return full;
}

export function ensureMediaDir(storageKey) {
  const full = resolveMediaPath(storageKey);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  return full;
}

export function mediaFileSize(storageKey) {
  try { return fs.statSync(resolveMediaPath(storageKey)).size; } catch { return null; }
}

export function mediaFileExists(storageKey) {
  try { return fs.existsSync(resolveMediaPath(storageKey)); } catch { return false; }
}

// Best-effort delete. A missing file is success: the goal is "the bytes are
// gone", and a failure here must never block removing the database row.
export function deleteMediaFile(storageKey) {
  try { fs.unlinkSync(resolveMediaPath(storageKey)); return true; } catch { return false; }
}

// ---------- change-report screenshots ----------
// Same storage root, same escape guard. These live under MEDIA_ROOT rather
// than public/ for the reason in the migration: a screenshot of a fees or
// student page is personal data about a child, and anything under a
// statically served directory is readable by whoever guesses the filename.

export const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;

// Strict: only the two formats html2canvas produces, and only base64.
const DATA_URL_RE = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;

// Decode a submitted data URL, or throw. Rejects on format and on size
// BEFORE anything touches the disk.
export function decodeScreenshot(dataUrl) {
  const m = DATA_URL_RE.exec(String(dataUrl || "").trim());
  if (!m) throw new Error("Screenshot must be a PNG or JPEG data URL");
  const buf = Buffer.from(m[2], "base64");
  if (!buf.length) throw new Error("Screenshot is empty");
  if (buf.length > MAX_SCREENSHOT_BYTES) {
    throw new Error(`Screenshot is ${(buf.length / 1048576).toFixed(1)} MB; the limit is 4 MB`);
  }
  return { buf, ext: m[1] === "png" ? ".png" : ".jpg" };
}

// Random filename — never anything the reporter supplied, and not derived
// from the report id either, so a filename cannot be guessed from a known id.
export function writeScreenshot(dataUrl) {
  const { buf, ext } = decodeScreenshot(dataUrl);
  const name = `${require("crypto").randomBytes(24).toString("hex")}${ext}`;
  const key = path.posix.join("change-reports", name);
  const full = ensureMediaDir(key);
  fs.writeFileSync(full, buf);
  return { file: name, bytes: buf.length };
}

// Resolve a stored screenshot filename to a path. basename() strips any
// directory part, so a tampered database value cannot walk out of the
// folder; resolveMediaPath then re-checks against the root.
export function screenshotPath(file) {
  const safe = path.basename(String(file || ""));
  if (!safe || safe === "." || safe === "..") throw new Error("bad screenshot name");
  return resolveMediaPath(path.posix.join("change-reports", safe));
}

export function deleteScreenshot(file) {
  try { fs.unlinkSync(screenshotPath(file)); return true; } catch { return false; }
}

// Free space on the media volume, so the upload screen can warn before the
// disk fills rather than after. Returns null where the platform doesn't
// support it, and callers must treat null as "unknown", not "fine".
export function mediaDiskFree() {
  try {
    fs.mkdirSync(path.resolve(MEDIA_ROOT), { recursive: true });
    const st = fs.statfsSync(path.resolve(MEDIA_ROOT));
    return { freeBytes: st.bsize * st.bavail, totalBytes: st.bsize * st.blocks };
  } catch {
    return null;
  }
}
