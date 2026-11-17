export { issueDays } from "./issue-days.mjs";

const TTL_MS = 30_000;
const cache = new Map<string, { expiresAt: number; value: unknown }>();

export async function cachedIssueResponse<T>(key: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  for (const [cachedKey, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(cachedKey);
  }
  const cached = cache.get(key);
  if (cached) return cached.value as T;
  const value = await load();
  if (cache.size >= 14) cache.delete(cache.keys().next().value!);
  cache.set(key, { expiresAt: now + TTL_MS, value });
  return value;
}

export function invalidateIssueCache(): void {
  cache.clear();
}
