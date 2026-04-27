/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║                    REDIS CONFIG — PRODUCTION GRADE               ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Features:
 * - Auto-reconnect with exponential backoff
 * - Circuit breaker — stops hammering a dead Redis
 * - Connection health monitoring
 * - Graceful fallback (no crash if Redis is down)
 */

let redisClient: any = null;
let isConnected = false;
let circuitOpen = false;
let circuitResetTimer: NodeJS.Timeout | null = null;
const CIRCUIT_RESET_MS = 30_000; // 30s cooldown before retry

if (process.env.REDIS_URL) {
  try {
    const { Redis } = require("ioredis");

    redisClient = new Redis(process.env.REDIS_URL, {
      // Connection
      connectTimeout: 4000,
      commandTimeout: 2000,      // Individual command max wait
      lazyConnect: false,         // Connect eagerly at startup

      // Retry strategy — exponential backoff, max 10s
      retryStrategy(times: number) {
        if (times > 5) {
          // After 5 retries, open the circuit breaker
          openCircuit();
          return null; // Stop retrying
        }
        return Math.min(times * 500, 10_000); // 500ms, 1s, 1.5s... up to 10s
      },

      // Don't queue commands when disconnected — fail fast
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });

    redisClient.on("connect", () => {
      isConnected = true;
      closeCircuit();
      console.log("✅ Redis connected");
    });

    redisClient.on("ready", () => {
      isConnected = true;
      closeCircuit();
    });

    redisClient.on("error", (err: Error) => {
      isConnected = false;
      // Only log once per burst to avoid log flooding
      if (!circuitOpen) console.warn("⚠️  Redis error:", err.message);
    });

    redisClient.on("close", () => {
      isConnected = false;
    });

    redisClient.on("reconnecting", () => {
      isConnected = false;
    });

    redisClient.on("end", () => {
      isConnected = false;
      openCircuit();
    });

  } catch (e) {
    console.warn("ioredis not available, caching disabled.");
  }
} else {
  console.warn("⚠️  REDIS_URL not set — running without Redis cache");
}

function openCircuit() {
  if (circuitOpen) return;
  circuitOpen = true;
  console.warn("🔴 Redis circuit breaker OPEN — will retry in 30s");
  circuitResetTimer = setTimeout(() => {
    circuitOpen = false;
    console.info("🟡 Redis circuit breaker reset — attempting reconnect...");
    redisClient?.connect().catch(() => {});
  }, CIRCUIT_RESET_MS);
}

function closeCircuit() {
  if (!circuitOpen) return;
  circuitOpen = false;
  if (circuitResetTimer) { clearTimeout(circuitResetTimer); circuitResetTimer = null; }
  console.info("🟢 Redis circuit breaker CLOSED");
}

/** True if Redis is healthy enough to serve a request */
export function isRedisReady(): boolean {
  return redisClient !== null && isConnected && !circuitOpen;
}

export const redis = redisClient;
