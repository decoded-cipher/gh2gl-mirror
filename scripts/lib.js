// Shared helpers. Node built-ins only — the workflow never installs anything.
import { spawnSync } from "node:child_process";

const secrets = [];

export function registerSecrets(...values) {
  for (const value of values) if (value) secrets.push(value);
}

export function redact(text) {
  return secrets.reduce((acc, value) => acc.split(value).join("***"), String(text ?? ""));
}

export function git(args, { allowFail = false } = {}) {
  const res = spawnSync("git", args, { encoding: "utf8", maxBuffer: 1 << 26 });
  if (res.error) throw res.error;
  const out = redact(`${res.stdout || ""}${res.stderr || ""}`.trim());
  if (res.status !== 0 && !allowFail) throw new Error(out || `git ${args[0]} exited ${res.status}`);
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

export async function withRetry(fn, { attempts = 3, baseDelayMs = 1000, onRetry } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts) throw err;
      onRetry?.(attempt, err);
      await sleep(baseDelayMs * 2 ** (attempt - 1));
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
