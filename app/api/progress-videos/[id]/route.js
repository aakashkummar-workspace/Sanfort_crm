import { NextResponse } from "next/server";
import fs from "fs";
import { Readable } from "stream";
import { getSession } from "@/lib/auth";
import {
  getProgressVideo, setProgressVideoVisibility, removeProgressVideo,
  activeSponsoredStudentIds, logAudit,
} from "@/lib/db";
import { resolveMediaPath, deleteMediaFile } from "@/lib/media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CAN_MANAGE = new Set(["admin", "principal"]);
const STAFF_VIEW = new Set(["admin", "principal", "teacher", "coordinator"]);

// Can this session watch this video? One function, used by playback and by
// the metadata read, so the two can never drift apart.
async function mayWatch(session, video) {
  if (!session || !video) return false;
  if (video.status && video.status !== "ready") return false;
  const role = session.role;
  if (STAFF_VIEW.has(role)) return true;
  if (role === "parent") {
    return video.visibleToParent !== false && session.linkedId === video.studentId;
  }
  if (role === "donor") {
    if (video.visibleToDonor !== true) return false;
    if (!session.linkedId) return false;
    const ids = await activeSponsoredStudentIds(session.linkedId);
    return ids.includes(video.studentId);
  }
  return false;
}

// GET /api/progress-videos/<id>          — metadata
// GET /api/progress-videos/<id>?play=1   — the bytes, with range support
//
// Range support is what makes a video seekable: without it the browser can
// only play from the start, and scrubbing re-downloads the whole file.
export async function GET(req, { params }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });

  const video = await getProgressVideo(params.id).catch(() => null);
  // Same response whether the video is missing or forbidden, so the id space
  // cannot be probed for which students have videos.
  if (!video || !(await mayWatch(session, video))) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  if (!new URL(req.url).searchParams.has("play")) {
    return NextResponse.json({ ok: true, video });
  }

  let full, size;
  try {
    full = resolveMediaPath(video.storageKey);
    size = fs.statSync(full).size;
  } catch {
    // The row exists but the bytes do not — a restore that missed the media
    // volume, most likely. Say so plainly rather than serving an empty file.
    return NextResponse.json({ ok: false, error: "The video file is missing from storage" }, { status: 410 });
  }

  const type = video.mimeType || "video/mp4";
  const range = req.headers.get("range");

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
        return new NextResponse(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" },
        });
      }
      end = Math.min(end, size - 1);
      const stream = fs.createReadStream(full, { start, end });
      return new NextResponse(Readable.toWeb(stream), {
        status: 206,
        headers: {
          "Content-Type": type,
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Accept-Ranges": "bytes",
          // Private: this is a named child. It must not sit in a shared cache.
          "Cache-Control": "private, max-age=0, no-store",
        },
      });
    }
  }

  return new NextResponse(Readable.toWeb(fs.createReadStream(full)), {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=0, no-store",
    },
  });
}

// PATCH — visibility only. Who may see a child's video is an admin decision,
// not something the uploading teacher can widen on their own.
export async function PATCH(req, { params }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });
  if (!CAN_MANAGE.has(session.role)) {
    return NextResponse.json({ ok: false, error: "Not authorised" }, { status: 403 });
  }

  let body; try { body = await req.json(); } catch { body = null; }
  const before = await getProgressVideo(params.id).catch(() => null);
  if (!before) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });

  try {
    const video = await setProgressVideoVisibility(params.id, {
      visibleToParent: typeof body?.visibleToParent === "boolean" ? body.visibleToParent : undefined,
      visibleToDonor: typeof body?.visibleToDonor === "boolean" ? body.visibleToDonor : undefined,
    });
    try {
      // Donor exposure is the change worth being able to find later, so it is
      // named in the action rather than buried in meta.
      const donorChanged = typeof body?.visibleToDonor === "boolean"
        && body.visibleToDonor !== before.visibleToDonor;
      await logAudit(
        session.name || "Admin",
        donorChanged
          ? `${body.visibleToDonor ? "Opened" : "Closed"} donor access to progress video`
          : "Changed progress video visibility",
        `${before.studentId} · ${before.period}`,
        {
          actorId: session.sub, actorRole: session.role,
          entityType: "progress_video", entityId: params.id,
          meta: {
            visibleToParent: video?.visibleToParent,
            visibleToDonor: video?.visibleToDonor,
            wasVisibleToDonor: before.visibleToDonor,
          },
        }
      );
    } catch {}
    return NextResponse.json({ ok: true, video });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || "Failed" }, { status: 500 });
  }
}

// DELETE — removes the row AND the bytes.
export async function DELETE(req, { params }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });
  if (!CAN_MANAGE.has(session.role)) {
    return NextResponse.json({ ok: false, error: "Not authorised" }, { status: 403 });
  }
  try {
    const removed = await removeProgressVideo(params.id, session.name);
    if (!removed) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    if (removed.storageKey) deleteMediaFile(removed.storageKey);
    try {
      await logAudit(session.name || "Admin", "Deleted progress video", `${removed.studentId} · ${removed.period}`, {
        actorId: session.sub, actorRole: session.role,
        entityType: "progress_video", entityId: params.id,
        meta: { period: removed.period, sizeBytes: removed.sizeBytes },
      });
    } catch {}
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || "Failed" }, { status: 500 });
  }
}
