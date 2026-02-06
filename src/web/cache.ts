import { createHash } from "crypto";
import { env } from "../env.js";

// ── Types ──

export interface CachedExplanation {
  text: string;
  driftRejected: boolean;
  createdAt: string;
  source: "cache" | "gemini" | "fallback";
}

interface CacheEntry extends CachedExplanation {
  expiresAt: number;
}

// ── In-memory store ──

const store = new Map<string, CacheEntry>();

// ── Key builder ──
// Uses only non-sensitive scenario metadata — never raw user payloads.

export function getExplainCacheKey(parts: {
  scenarioId: string;
  decision: string;
  denyCode?: string;
  actionType?: string;
  targetSystem?: string;
  driftRejected?: boolean;
}): string {
  const raw = [
    parts.scenarioId,
    parts.decision,
    parts.denyCode ?? "",
    parts.actionType ?? "",
    parts.targetSystem ?? "",
    String(!!parts.driftRejected),
  ].join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

// ── Getters / Setters ──

function ttlMs(): number {
  return (parseInt(env.EXPLAIN_CACHE_TTL_SECONDS, 10) || 86400) * 1000;
}

function cacheEnabled(): boolean {
  return env.EXPLAIN_CACHE_ENABLED === "true";
}

export function getCachedExplanation(key: string): CachedExplanation | null {
  if (!cacheEnabled()) return null;
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return { text: entry.text, driftRejected: entry.driftRejected, createdAt: entry.createdAt, source: "cache" };
}

export function setCachedExplanation(
  key: string,
  result: { text: string; driftRejected: boolean },
  source: "gemini" | "fallback",
): void {
  if (!cacheEnabled()) return;
  const entry: CacheEntry = {
    text: result.text,
    driftRejected: result.driftRejected,
    createdAt: new Date().toISOString(),
    source,
    expiresAt: Date.now() + ttlMs(),
  };
  store.set(key, entry);
  const textHash = createHash("sha256").update(result.text).digest("hex").slice(0, 12);
  console.log(`[cache] SET explanation key=${key} hash=${textHash} len=${result.text.length} source=${source}`);
}
