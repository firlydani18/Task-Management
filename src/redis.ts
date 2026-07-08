import Redis from "ioredis";
import { config } from "./config";

const defaultTtlSeconds = 60;

export const redis = config.redisUrl
  ? new Redis(config.redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2000,
      lazyConnect: true,
    })
  : null;
let redisUsable = Boolean(redis);

if (redis) {
  // Avoid unhandled error spam when Redis server is down.
  redis.on("error", () => {
    redisUsable = false;
  });
  redis.on("ready", () => {
    redisUsable = true;
  });
}

export async function getCachedJson<T>(key: string): Promise<T | null> {
  if (!redis || !redisUsable) return null;
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    redisUsable = false;
    return null;
  }
}

export async function setCachedJson(key: string, value: unknown, ttl = defaultTtlSeconds) {
  if (!redis || !redisUsable) return;
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttl);
  } catch {
    redisUsable = false;
  }
}

export async function deleteCache(key: string) {
  if (!redis || !redisUsable) return;
  try {
    await redis.del(key);
  } catch {
    redisUsable = false;
  }
}

export async function checkRedisConnection(): Promise<boolean> {
  if (!redis) return false;
  try {
    await Promise.race([
      redis.ping(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Redis ping timeout")), 2000);
      }),
    ]);
    redisUsable = true;
    return true;
  } catch {
    redisUsable = false;
    return false;
  }
}

export async function deleteByPattern(pattern: string) {
  if (!redis || !redisUsable) return;
  try {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch {
    redisUsable = false;
  }
}
