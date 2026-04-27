/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║                    AUTH MIDDLEWARE — FAST PATH                   ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Performance stack:
 *  1. JWT decoded locally via base64 (0ms — no network)
 *  2. User role served from L1 in-memory cache (~0ms)
 *  3. User role served from Redis cache (~1-3ms)
 *  4. Only on cold start: one DB query, then cached for 5 min
 */

import { Request, Response, NextFunction } from "express";
import { createClient } from "@supabase/supabase-js";
import prisma from "../config/prisma";
import { getCache, setCache, deleteCache, TTL, CacheKeys } from "../utils/cache";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseKey);

// Extend Request type
declare global {
  namespace Express {
    interface Request { user?: any; }
  }
}

// ── L1 In-Process User Cache (role + isVerified) ──────────────────────────
// This is the fastest layer — avoids even a Redis round trip for hot users
const L1_USER = new Map<string, { role: string; isVerified: boolean; exp: number }>();
const L1_TTL  = 5 * 60 * 1000; // 5 min in ms

function l1GetUser(id: string) {
  const e = L1_USER.get(id);
  if (!e || e.exp < Date.now()) { L1_USER.delete(id); return null; }
  return e;
}

function l1SetUser(id: string, role: string, isVerified: boolean) {
  L1_USER.set(id, { role, isVerified, exp: Date.now() + L1_TTL });
}

/** Call this after any role/isVerified change so next request is fresh */
export function invalidateUserCache(userId: string) {
  L1_USER.delete(userId);
  // Also clear from Redis (fire-and-forget)
  deleteCache(CacheKeys.USER_ROLE(userId)).catch(() => {});
  deleteCache(`cache:user:me:${userId}`).catch(() => {});
}

// ── User fetch: L1 → Redis → DB ──────────────────────────────────────────
async function resolveUser(userId: string): Promise<{ role: string; isVerified: boolean }> {
  // L1
  const l1 = l1GetUser(userId);
  if (l1) return l1;

  // Redis
  const redisKey = CacheKeys.USER_ROLE(userId);
  const cached = await getCache(redisKey);
  if (cached) {
    l1SetUser(userId, cached.role, cached.isVerified);
    return cached;
  }

  // DB (cold path — only on first request per user)
  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, isVerified: true },
  });

  const result = {
    role: (dbUser?.role as string) || "STUDENT",
    isVerified: dbUser?.isVerified || false,
  };

  // Warm both caches
  l1SetUser(userId, result.role, result.isVerified);
  await setCache(redisKey, result, TTL.USER_ROLE);

  return result;
}

// ── JWT local decode (no network, no package) ─────────────────────────────
function decodeToken(token: string): { id: string; exp: number } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8")
    );
    if (!payload.sub) return null;
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null; // expired
    return { id: payload.sub, exp: payload.exp };
  } catch {
    return null;
  }
}

// ── Middleware ─────────────────────────────────────────────────────────────
export const authenticateUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing or invalid authorization token" });
    }

    const token = authHeader.split(" ")[1];

    // Fast path: decode JWT locally
    let userId: string | null = null;
    const local = decodeToken(token);
    if (local) {
      userId = local.id;
    } else {
      // Fallback: verify with Supabase (only for malformed/legacy tokens)
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (error || !user) return res.status(401).json({ error: "Invalid token or session expired" });
      userId = user.id;
    }

    const userInfo = await resolveUser(userId);
    req.user = { id: userId, ...userInfo };
    next();
  } catch (err) {
    console.error("Auth error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

export const optionalAuth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.split(" ")[1];
      let userId: string | null = null;

      const local = decodeToken(token);
      if (local) {
        userId = local.id;
      } else {
        const { data: { user } } = await supabase.auth.getUser(token);
        if (user) userId = user.id;
      }

      if (userId) {
        const userInfo = await resolveUser(userId);
        req.user = { id: userId, ...userInfo };
      }
    }
    next();
  } catch {
    next(); // never block the request
  }
};
