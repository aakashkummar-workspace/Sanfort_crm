// Server-side auth helpers.
//
// Sessions are stored as a signed JWT in an httpOnly cookie. The same JWT is
// verified by both API routes (Node runtime, this file) and the Edge-runtime
// middleware (lib/auth-edge.js) using `jose`, which works in both worlds.
//
// Roles: admin | academic_director | principal | teacher | parent

import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "vid360_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 8; // 8 hours

const SECRET_RAW =
  process.env.AUTH_SECRET ||
  // Dev fallback so the app still boots without an env. Loud-warn so
  // production deployments don't accidentally ship the dev secret.
  "dev-only-insecure-secret-change-me-in-production-please-32chars";

if (!process.env.AUTH_SECRET) {
  // eslint-disable-next-line no-console
  console.warn("[auth] AUTH_SECRET not set — using dev fallback. Do NOT use in production.");
}

const SECRET = new TextEncoder().encode(SECRET_RAW);

// Canonical roles. Anything else is rejected at login time unless it resolves
// to a real custom-role id. School / Trust Accountant were added in v2
// alongside the finance split; `donor` in v3 for sponsor dashboards, where
// linkedId holds a donors.id rather than a student or staff id.
export const ROLE_KEYS = [
  "admin", "academic_director", "principal", "teacher", "parent",
  "school_accountant", "trust_accountant", "transport_manager", "fees_manager",
  "donor",
];

export const ROLE_LABEL = {
  admin: "Admin",
  academic_director: "Academic Director",
  principal: "Principal",
  teacher: "Teacher",
  parent: "Parent",
  school_accountant: "School Accountant",
  trust_accountant: "Trust Accountant",
  transport_manager: "Transport Manager",
  fees_manager: "Fees Manager",
  donor: "Donor",
};

export async function hashPassword(plain) {
  return bcrypt.hash(String(plain), 10);
}

export async function verifyPassword(plain, hash) {
  if (!plain || !hash) return false;
  try { return await bcrypt.compare(String(plain), String(hash)); }
  catch { return false; }
}

export async function signSession(payload) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(SECRET);
}

export async function verifySession(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, SECRET);
    return payload;
  } catch {
    return null;
  }
}

// Read the current session from the request cookies. Returns null if no
// valid session — callers decide whether to redirect or 401.
export async function getSession() {
  const c = cookies().get(SESSION_COOKIE);
  if (!c) return null;
  return verifySession(c.value);
}
