import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getUserByEmail, logAudit, readAllData, updateUser, listCustomRoles } from "@/lib/db";
import { DEMO_ACCOUNTS } from "@/lib/seed-users";
import {
  verifyPassword, signSession, ROLE_KEYS,
  SESSION_COOKIE, SESSION_TTL_SECONDS,
} from "@/lib/auth";

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { body = null; }
  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");
  if (!email || !password) {
    return NextResponse.json({ ok: false, error: "Email and password are required" }, { status: 400 });
  }

  // Look up by DB first; fall back to in-memory demo list so the five seeded
  // accounts always work even if the Supabase users table isn't reachable
  // yet (e.g. PostgREST schema cache hasn't refreshed after migration).
  let user = null;
  try { user = await getUserByEmail(email); } catch {}

  if (user) {
    // Normal path: verify the bcrypt hash. If the file user has no hash
    // (e.g. it was lazy-seeded by a class-teacher reassignment before the
    // user's first sign-in), fall back to the demo password so the demo
    // accounts keep working with their documented credentials.
    let ok = false;
    if (user.passwordHash) {
      ok = await verifyPassword(password, user.passwordHash);
    } else {
      const demo = DEMO_ACCOUNTS.find((a) => a.email.toLowerCase() === email);
      ok = !!demo && demo.password === password;
    }
    if (!ok) {
      // The account exists, so name it — an admin reviewing the log needs to
      // tell "someone is guessing at Mary's account" apart from "someone is
      // trying addresses that don't exist".
      logAudit(user.name || email, "Sign in failed", email, {
        actorId: user.id, actorRole: user.role,
        entityType: "auth", entityId: email, meta: { reason: "bad_password" },
      }).catch(() => {});
      return NextResponse.json({ ok: false, error: "Invalid email or password" }, { status: 401 });
    }
  } else {
    const demo = DEMO_ACCOUNTS.find((a) => a.email.toLowerCase() === email);
    if (!demo || demo.password !== password) {
      logAudit("Unknown", "Sign in failed", email, {
        entityType: "auth", entityId: email, meta: { reason: "no_account" },
      }).catch(() => {});
      return NextResponse.json({ ok: false, error: "Invalid email or password" }, { status: 401 });
    }
    user = { id: demo.id, email: demo.email, name: demo.name, role: demo.role, linkedId: demo.linkedId || null };
  }

  // Accept any of the seven canonical roles OR a real custom-role id.
  // Custom roles created on the Custom Roles screen have ids like
  // "role-office-zgp5" — we look them up in the custom_roles table here so
  // a freshly-provisioned custom-role user can actually sign in.
  if (!ROLE_KEYS.includes(user.role)) {
    let customOk = false;
    try {
      const custom = await listCustomRoles();
      customOk = !!custom.find((r) => r.id === user.role);
    } catch {}
    if (!customOk) {
      logAudit(user.name || email, "Sign in failed", email, {
        actorId: user.id, actorRole: user.role,
        entityType: "auth", entityId: email, meta: { reason: "invalid_role", role: user.role },
      }).catch(() => {});
      return NextResponse.json({ ok: false, error: "Account has no valid role" }, { status: 403 });
    }
  }

  // Parent auto-link: if a parent account signs in with no linkedId
  // set, OR with a linkedId that no longer resolves to an active student
  // (data drift between Supabase + file fallback, or the linked student
  // was archived), re-link to the first active student so the
  // child-scoped screens always have a target. Production installs set
  // linkedId explicitly during enquiry conversion; this fallback covers
  // demo seeds + any drift.
  if (user.role === "parent") {
    try {
      const data = await readAllData();
      const active = (data.addedStudents || []).filter(
        (s) => (s.status ?? "active") !== "archived"
      );
      const linkedExists = user.linkedId && active.some((s) => s.id === user.linkedId);
      if (!linkedExists && active.length > 0) {
        const target = active[0];
        await updateUser(user.id, { linkedId: target.id }).catch(() => {});
        user = { ...user, linkedId: target.id };
      } else if (!user.linkedId) {
        // No active students at all → leave linkedId null; child-scoped
        // screens will show "No child linked" instead of crashing.
      }
    } catch {}
  }

  const token = await signSession({
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    linkedId: user.linkedId || null,
    linkedClasses: Array.isArray(user.linkedClasses) ? user.linkedClasses : [],
  });

  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });

  // Audit log is best-effort and MUST NOT block the sign-in response — fire it
  // and forget so a slow audit write never freezes "Signing in…".
  logAudit(user.name, "Sign in", user.email).catch(() => {});

  return NextResponse.json({
    ok: true,
    user: {
      id: user.id, email: user.email, name: user.name, role: user.role,
      linkedId: user.linkedId || null,
      linkedClasses: Array.isArray(user.linkedClasses) ? user.linkedClasses : [],
    },
  });
}
