import { NextResponse } from "next/server";
import fs from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { getSession } from "@/lib/auth";
import {
  listProgressVideos, saveProgressVideo, getProgressVideoFor,
  newProgressVideoId, activeSponsoredStudentIds, readAllData, logAudit,
} from "@/lib/db";
import {
  videoKey, ensureMediaDir, deleteMediaFile, mediaDiskFree,
  MAX_VIDEO_BYTES, ALLOWED_VIDEO_TYPES,
} from "@/lib/media";

export const dynamic = "force-dynamic";
// Node runtime, not edge: this route writes to the filesystem.
export const runtime = "nodejs";

const CAN_UPLOAD = new Set(["admin", "principal", "teacher", "coordinator"]);
const CAN_MANAGE = new Set(["admin", "principal"]);

// GET /api/progress-videos?studentId=&period=&limit=&offset=
//
// Each role is handed an explicit audience; nothing falls through to a
// default. A role not named here gets nothing rather than staff access.
export async function GET(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });

  const sp = new URL(req.url).searchParams;
  const period = sp.get("period") || undefined;
  const limit = Math.min(Math.max(Number(sp.get("limit")) || 60, 1), 200);
  const offset = Math.max(Number(sp.get("offset")) || 0, 0);
  const askedStudent = sp.get("studentId") || undefined;

  try {
    const role = session.role;

    if (role === "parent") {
      // A parent sees their own child only. The requested studentId is
      // ignored entirely — the session's link is the authority.
      if (!session.linkedId) return NextResponse.json({ ok: true, videos: [], total: 0, hasMore: false });
      const out = await listProgressVideos({
        studentId: session.linkedId, period, limit, offset, audience: "parent",
      });
      return NextResponse.json({ ok: true, ...out });
    }

    if (role === "donor") {
      const ids = session.linkedId ? await activeSponsoredStudentIds(session.linkedId) : [];
      // Narrow to one sponsored student if asked, but never beyond the set.
      const scope = askedStudent && ids.includes(askedStudent) ? [askedStudent] : ids;
      const out = await listProgressVideos({
        studentIds: scope, period, limit, offset, audience: "donor",
      });
      return NextResponse.json({ ok: true, ...out });
    }

    if (CAN_UPLOAD.has(role)) {
      const out = await listProgressVideos({
        studentId: askedStudent, period, limit, offset, audience: "staff",
      });
      return NextResponse.json({ ok: true, ...out, disk: mediaDiskFree() });
    }

    return NextResponse.json({ ok: false, error: "Not authorised" }, { status: 403 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || "Failed" }, { status: 500 });
  }
}

// POST /api/progress-videos — multipart upload.
//
// The file is streamed straight to disk. The VPS has a few hundred MB of free
// RAM; buffering concurrent 25 MB uploads at month-end would push it into swap
// and take the CRM down with it. Nothing here calls .arrayBuffer() on the file.
export async function POST(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });
  if (!CAN_UPLOAD.has(session.role)) {
    return NextResponse.json({ ok: false, error: "Not authorised to upload videos" }, { status: 403 });
  }

  let form;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "Expected a multipart upload" }, { status: 400 });
  }

  const file = form.get("file");
  const studentId = String(form.get("studentId") || "").trim();
  const period = String(form.get("period") || "").trim();
  const title = String(form.get("title") || "").trim();
  const note = String(form.get("note") || "").trim();
  const visibleToParent = String(form.get("visibleToParent") || "true") !== "false";
  // Donor visibility is opt-in per video, never inherited from the upload
  // defaults: a sponsor seeing a named minor on video is a decision somebody
  // should make deliberately for that video.
  const visibleToDonor = String(form.get("visibleToDonor") || "false") === "true";

  if (!file || typeof file.stream !== "function") {
    return NextResponse.json({ ok: false, error: "No file received" }, { status: 400 });
  }
  if (!studentId) return NextResponse.json({ ok: false, error: "studentId required" }, { status: 400 });
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return NextResponse.json({ ok: false, error: "period must be YYYY-MM" }, { status: 400 });
  }

  const mimeType = String(file.type || "").toLowerCase();
  if (!ALLOWED_VIDEO_TYPES.has(mimeType)) {
    return NextResponse.json({
      ok: false,
      error: `${mimeType || "That file type"} is not a supported video. Use MP4, MOV, WebM, MKV or 3GP.`,
    }, { status: 415 });
  }
  if (file.size && file.size > MAX_VIDEO_BYTES) {
    return NextResponse.json({
      ok: false,
      error: `That video is ${(file.size / 1048576).toFixed(0)} MB. The limit is ${(MAX_VIDEO_BYTES / 1048576).toFixed(0)} MB.`,
    }, { status: 413 });
  }

  // Confirm the student exists before writing bytes, so a typo cannot leave
  // an orphan file on disk.
  let student = null;
  try {
    const data = await readAllData();
    student = (data.addedStudents || []).find((s) => s.id === studentId) || null;
  } catch {}
  if (!student) return NextResponse.json({ ok: false, error: "Student not found" }, { status: 404 });

  // Refuse when the disk is nearly full rather than writing a truncated file.
  const disk = mediaDiskFree();
  if (disk && file.size && disk.freeBytes < file.size + 512 * 1024 * 1024) {
    return NextResponse.json({
      ok: false,
      error: `Not enough disk space (${(disk.freeBytes / 1073741824).toFixed(1)} GB free). Tell your administrator before uploading more.`,
    }, { status: 507 });
  }

  const previous = await getProgressVideoFor(studentId, period).catch(() => null);

  const id = newProgressVideoId();
  const key = videoKey({ studentId, period, id, mimeType });
  const fullPath = ensureMediaDir(key);

  // Count bytes as they pass and abort past the cap. file.size is a client-
  // supplied hint; this is the check that actually holds.
  let written = 0;
  let overflow = false;
  async function* capped(source) {
    for await (const chunk of source) {
      written += chunk.length;
      if (written > MAX_VIDEO_BYTES) { overflow = true; throw new Error("too large"); }
      yield chunk;
    }
  }

  try {
    await pipeline(
      Readable.fromWeb(file.stream()),
      capped,
      fs.createWriteStream(fullPath)
    );
  } catch (e) {
    deleteMediaFile(key);
    if (overflow) {
      return NextResponse.json({
        ok: false,
        error: `That video exceeds the ${(MAX_VIDEO_BYTES / 1048576).toFixed(0)} MB limit.`,
      }, { status: 413 });
    }
    return NextResponse.json({ ok: false, error: `Upload failed: ${e.message}` }, { status: 500 });
  }

  try {
    const saved = await saveProgressVideo({
      id, studentId, period, title: title || null, note: note || null,
      storageKey: key, mimeType, sizeBytes: written,
      originalName: file.name || null,
      uploadedBy: session.name || "Staff", uploadedById: session.sub || null,
      visibleToParent, visibleToDonor,
    });

    // The row now points at the new file, so the superseded one can go.
    // Deleting it earlier would lose the old video if the write above failed.
    if (previous?.storageKey && previous.storageKey !== key) {
      deleteMediaFile(previous.storageKey);
    }

    try {
      await logAudit(session.name || "Staff", "Uploaded progress video", `${studentId} ${student.name} · ${period}`, {
        actorId: session.sub, actorRole: session.role,
        entityType: "progress_video", entityId: id,
        meta: {
          period, sizeBytes: written, mimeType,
          visibleToParent, visibleToDonor,
          replaced: previous?.id || null,
        },
      });
    } catch {}

    return NextResponse.json({ ok: true, video: saved, replaced: previous?.id || null });
  } catch (e) {
    // The row did not save, so the bytes are unreferenced. Remove them.
    deleteMediaFile(key);
    return NextResponse.json({ ok: false, error: e.message || "Could not save the video" }, { status: 500 });
  }
}
