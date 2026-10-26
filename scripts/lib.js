// Shared helpers. Node built-ins only — the workflow never installs anything.
import { spawnSync } from "node:child_process";

const secrets = [];

export function registerSecrets(...values) {
  for (const value of values) if (value) secrets.push(value);
}

export function redact(text) {
  return secrets.reduce((acc, value) => acc.split(value).join("***"), String(text ?? ""));
}

// Node's fetch reports every network error as "fetch failed"; the cause names the real one.
export function errorText(err) {
  const cause = err.cause?.code || err.cause?.message;
  return redact(cause ? `${err.message} (${cause})` : err.message);
}

// GitLab.com caps bursts per user; withRetry waits these out instead of counting them as failures.
const RATE_LIMITED = /\b429\b|rate limit exceeded/i;

export function rateLimitError(message, seconds = 60) {
  const err = new Error(message);
  err.retryAfterMs = seconds * 1000;
  return err;
}

export function git(args, { allowFail = false } = {}) {
  const res = spawnSync("git", args, { encoding: "utf8", maxBuffer: 1 << 26 });
  if (res.error) throw res.error;
  const out = redact(`${res.stdout || ""}${res.stderr || ""}`.trim());
  if (res.status !== 0 && !allowFail) {
    throw RATE_LIMITED.test(out) ? rateLimitError(out) : new Error(out || `git ${args[0]} exited ${res.status}`);
  }
  return { ok: res.status === 0, out };
}

// GitHub advertises refs/pull/*, GitLab adds refs/merge_requests/* — neither survives a mirror.
const MIRRORED_REF = /^refs\/(heads|tags|notes)\//;

export function parseRefs(lsRemoteOutput) {
  const refs = new Map();
  for (const line of lsRemoteOutput.split("\n")) {
    const [sha, ref] = line.split("\t");
    if (!sha || !ref || !MIRRORED_REF.test(ref)) continue;
    refs.set(ref, sha);
  }
  return refs;
}

// null means unreadable, never empty, so a failed lookup falls back to a full mirror.
export function remoteRefs(url) {
  const { ok, out } = git(["ls-remote", url], { allowFail: true });
  if (!ok && RATE_LIMITED.test(out)) throw rateLimitError(out);
  return ok ? parseRefs(out) : null;
}

export function sameRefs(a, b) {
  if (!a || !b || a.size !== b.size) return false;
  for (const [ref, sha] of a) if (b.get(ref) !== sha) return false;
  return true;
}

export function glSlug(name) {
  return name
    .replace(/[^A-Za-z0-9_.-]/g, "-")
    .replace(/^[-_.]+/, "")
    .replace(/(?:\.git|\.atom)$/i, "")
    .replace(/[-_.]+$/, "") || "repo";
}

// Stride, not contiguous slices: alphabetical neighbours tend to be similar in size.
export function selectBatch(items, index, count) {
  return items.filter((_, i) => i % count === index);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function withRetry(fn, { attempts = 3, baseDelayMs = 1000, rateLimitWaits = 8, onRetry } = {}) {
  let failures = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const limited = err.retryAfterMs !== undefined && rateLimitWaits-- > 0;
      if (!limited && ++failures >= attempts) throw err;
      onRetry?.(attempt, err);
      // Jitter so the parallel jobs don't all hit the next window together.
      await sleep(limited ? err.retryAfterMs + Math.random() * 30_000 : baseDelayMs * 2 ** (failures - 1));
    }
  }
}

export async function pool(items, limit, worker) {
  const iter = items[Symbol.iterator]();
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (;;) {
        const { value, done } = iter.next();
        if (done) return;
        await worker(value);
      }
    }),
  );
}
