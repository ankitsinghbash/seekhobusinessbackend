/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║                   CACHE UTILITY — LAYERED STRATEGY               ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Layer 1: In-Process Memory (Map) — ~0ms, survives only within this process
 * Layer 2: Redis — ~1-3ms, shared across processes / restarts
 *
 * Read order:  L1 → L2 → DB
 * Write order: DB → L2 → L1
 * Invalidate:  L1 + L2
 */

import { redis, isRedisReady } from "../config/redis";

// Re-export for convenience
export { isRedisReady };

// ── Cache Key Definitions ─────────────────────────────────────────────────
export const CacheKeys = {
  SEARCH:           (q: string)                 => `cache:search:${q}`,
  CART:             (userId: string)            => `cache:cart:${userId}`,
  PURCHASES:        (userId: string)            => `cache:purchases:${userId}`,
  CREATOR_PROJECTS: (userId: string)            => `cache:creator:projects:${userId}`,
  CREATOR_PROJECT:  (projectId: string)         => `cache:creator:project:${projectId}`,
  VIDEO:            (videoId: string, uid?: string) => `cache:video:${videoId}:${uid || "public"}`,
  USER_ROLE:        (userId: string)            => `cache:user:role:${userId}`,
};

// ── TTL Presets (seconds) ─────────────────────────────────────────────────
export const TTL = {
  USER_ROLE:   5 * 60,        //  5 min — user roles/isVerified
  VIDEO:       5 * 60,        //  5 min — video access data
  CART:        2 * 60,        //  2 min — cart contents
  PROJECT:     3 * 60,        //  3 min — creator project detail
  PROJECTS:    3 * 60,        //  3 min — creator project list
  PURCHASES:   5 * 60,        //  5 min — purchase list
  SEARCH:      60 * 60,       //  1 hour — search results (rarely change)
};

// ── Layer 1: In-Process Memory Cache ─────────────────────────────────────
interface L1Entry { data: any; exp: number; }
const L1 = new Map<string, L1Entry>();
const L1_MAX_SIZE = 500; // max entries to avoid unbounded memory

function l1Get(key: string): any | null {
  const entry = L1.get(key);
  if (!entry) return null;
  if (entry.exp < Date.now()) { L1.delete(key); return null; }
  return entry.data;
}

function l1Set(key: string, data: any, ttlSeconds: number) {
  // Evict oldest entry if at capacity
  if (L1.size >= L1_MAX_SIZE) {
    const firstKey = L1.keys().next().value;
    if (firstKey) L1.delete(firstKey);
  }
  L1.set(key, { data, exp: Date.now() + ttlSeconds * 1000 });
}

function l1Del(key: string) { L1.delete(key); }
function l1DelPattern(pattern: string) {
  const prefix = pattern.replace(/\*/g, "");
  for (const key of L1.keys()) {
    if (key.startsWith(prefix)) L1.delete(key);
  }
}

// ── Layer 2: Redis ────────────────────────────────────────────────────────
async function redisGet(key: string): Promise<any | null> {
  if (!isRedisReady()) return null;
  try {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function redisSet(key: string, data: any, ttlSeconds: number) {
  if (!isRedisReady()) return;
  try {
    await redis.set(key, JSON.stringify(data), "EX", ttlSeconds);
  } catch { /* silent — fallback to L1 only */ }
}

async function redisDel(key: string) {
  if (!isRedisReady()) return;
  try { await redis.del(key); } catch { }
}

async function redisDelPattern(pattern: string) {
  if (!isRedisReady()) return;
  try {
    // Use SCAN instead of KEYS — non-blocking even on large datasets
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        const pipeline = redis.pipeline();
        keys.forEach((k: string) => pipeline.del(k));
        await pipeline.exec();
      }
    } while (cursor !== "0");
  } catch { }
}

// ── Public API ────────────────────────────────────────────────────────────

/** Read: L1 → Redis → null */
export async function getCache(key: string): Promise<any | null> {
  // L1 hit
  const l1 = l1Get(key);
  if (l1 !== null) return l1;

  // L2 hit — also warm L1
  const l2 = await redisGet(key);
  if (l2 !== null) {
    l1Set(key, l2, 60); // Warm L1 with 60s TTL (shorter than Redis TTL)
    return l2;
  }

  return null;
}

/** Write: Redis → L1 */
export async function setCache(key: string, data: any, ttlSeconds: number = 300) {
  await redisSet(key, data, ttlSeconds);
  l1Set(key, data, Math.min(ttlSeconds, 60)); // L1 max 60s
}

/** Delete single key from both layers */
export async function deleteCache(key: string) {
  l1Del(key);
  await redisDel(key);
}

/** Delete all keys matching a pattern (uses SCAN, not KEYS) */
export async function deleteCachePattern(pattern: string) {
  l1DelPattern(pattern);
  await redisDelPattern(pattern);
}

/** Stats for debugging */
export function getCacheStats() {
  return {
    l1Size: L1.size,
    redisReady: isRedisReady(),
  };
}
