// Ensures Tangled repos exist and mirrors this job's slice of the public repo list into them.
// The repo record lives on your PDS, the git data on a knot, and pushes go over SSH only.
import { resolveTxt } from "node:dns/promises";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  git, glSlug, pool, redact, registerSecrets, remoteRefs, sameRefs, selectBatch, withRetry,
} from "../lib.js";

const {
  REPOS_JSON,
  BATCH_INDEX,
  BATCH_COUNT,
  GH_USER,
  GH_TOKEN,
  TANGLED_HANDLE,
  TANGLED_APP_PASSWORD,
  TANGLED_SSH_KEY,
  TANGLED_KNOT,
  RESULTS_DIR,
  CONCURRENCY,
} = process.env;

for (const key of ["REPOS_JSON", "BATCH_INDEX", "BATCH_COUNT", "GH_USER", "GH_TOKEN", "TANGLED_HANDLE", "TANGLED_APP_PASSWORD", "TANGLED_SSH_KEY"]) {
  if (!process.env[key]) {
    console.error(`Missing env: ${key}`);
    process.exit(1);
  }
}

registerSecrets(GH_TOKEN, TANGLED_APP_PASSWORD);

const REPO_NSID = "sh.tangled.repo";
const DEFAULT_KNOT = "knot1.tangled.sh";
const KNOT = TANGLED_KNOT || DEFAULT_KNOT;
const SSH_HOST = KNOT === DEFAULT_KNOT ? "tangled.org" : KNOT;

// A GitHub mirror clone also carries refs/pull/*, which Tangled would keep.
const REFSPECS = ["+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*", "+refs/notes/*:refs/notes/*"];

// Tangled lowercases the record key and rejects "..".
const tangledSlug = (name) => glSlug(name).replace(/\.{2,}/g, ".").toLowerCase();

const DESCRIPTION_LIMIT = 140; // graphemes, per the sh.tangled.repo lexicon
const segmenter = new Intl.Segmenter();

function clip(text, max) {
  const graphemes = Array.from(segmenter.segment(text), (s) => s.segment);
  return graphemes.length <= max ? text : `${graphemes.slice(0, max - 1).join("").trimEnd()}…`;
}

// Undefined fields are dropped by JSON.stringify, which clears them on the record.
function recordMeta(repo) {
  const description = repo.description?.trim();
  const homepage = repo.homepage?.trim();
  return {
    description: description ? clip(description, DESCRIPTION_LIMIT) : undefined,
    website: homepage ? (/^https?:\/\//i.test(homepage) ? homepage : `https://${homepage}`) : undefined,
  };
}

const changedKeys = (value, meta) => Object.keys(meta).filter((k) => JSON.stringify(value[k]) !== JSON.stringify(meta[k]));

// Memoizes an async lookup, but forgets a failure so the next caller retries it.
function lazy(fn) {
  let promise;
  return () => (promise ??= fn().catch((err) => {
    promise = undefined;
    throw err;
  }));
}

async function xrpc(base, nsid, { token, query = {}, body } = {}) {
  const url = new URL(`/xrpc/${nsid}`, base);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body && { "Content-Type": "application/json" }),
    },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${nsid} ${res.status}: ${redact(data.message || data.error || res.statusText)}`);
    err.code = data.error;
    throw err;
  }
  return data;
}

async function resolveDid(handle) {
  if (handle.startsWith("did:")) return handle;
  try {
    const txt = (await resolveTxt(`_atproto.${handle}`)).flat().find((t) => t.startsWith("did="));
    if (txt) return txt.slice(4);
  } catch {}
  const res = await fetch(`https://${handle}/.well-known/atproto-did`);
  const did = (await res.text()).trim();
  if (res.ok && did.startsWith("did:")) return did;
  throw new Error(`Tangled handle '${handle}' did not resolve to a DID`);
}

async function resolvePds(did) {
  const docUrl = did.startsWith("did:web:")
    ? `https://${did.slice(8)}/.well-known/did.json`
    : `https://plc.directory/${did}`;
  const res = await fetch(docUrl);
  if (!res.ok) throw new Error(`DID document for ${did}: ${res.status} ${res.statusText}`);
  const pds = (await res.json()).service?.find((s) => s.id.endsWith("#atproto_pds"))?.serviceEndpoint;
  if (!pds) throw new Error(`DID document for ${did} lists no PDS`);
  return pds;
}

function configureSsh(privateKey) {
  const dir = mkdtempSync(join(tmpdir(), "tangled-ssh-"));
  const keyFile = join(dir, "id");
  writeFileSync(keyFile, privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`, { mode: 0o600 });
  process.env.GIT_SSH_COMMAND = [
    "ssh", "-i", keyFile, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${join(dir, "known_hosts")}`,
  ].join(" ");
}

const identity = lazy(async () => {
  const did = await resolveDid(TANGLED_HANDLE);
  return { did, pds: await resolvePds(did) };
});

// Only needed to create or update repos, so a run where nothing changed never logs in.
const session = lazy(async () => {
  const { did, pds } = await identity();
  const { accessJwt } = await xrpc(pds, "com.atproto.server.createSession", {
    body: { identifier: did, password: TANGLED_APP_PASSWORD },
  });
  registerSecrets(accessJwt);
  return accessJwt;
});

async function ensureRepo(repo, log) {
  const rkey = tangledSlug(repo.name);
  const url = `git@${SSH_HOST}:${TANGLED_HANDLE}/${rkey}`;
  const { did, pds } = await identity();
  const meta = recordMeta(repo);

  let existing;
  try {
    existing = await xrpc(pds, "com.atproto.repo.getRecord", { query: { repo: did, collection: REPO_NSID, rkey } });
  } catch (err) {
    if (err.code !== "RecordNotFound") throw err;
  }

  if (existing) {
    const changed = changedKeys(existing.value, meta);
    if (changed.length) {
      // Merged onto the stored record so fields set elsewhere (labels, spindle, ...) survive.
      await xrpc(pds, "com.atproto.repo.putRecord", {
        token: await session(),
        body: {
          repo: did,
          collection: REPO_NSID,
          rkey,
          record: { ...existing.value, ...meta },
          swapRecord: existing.cid,
        },
      });
      log(`updated ${changed.join(", ")}`);
    }
    return url;
  }

  const accessJwt = await session();
  const { token } = await xrpc(pds, "com.atproto.server.getServiceAuth", {
    token: accessJwt,
    query: { aud: `did:web:${KNOT}`, lxm: "sh.tangled.repo.create", exp: Math.floor(Date.now() / 1000) + 60 },
  });
  // Idempotent per name on the knot, so a retry after a failed record write reuses the same repo.
  const { repoDid } = await xrpc(`https://${KNOT}`, "sh.tangled.repo.create", {
    token,
    body: { rkey, name: rkey, defaultBranch: repo.branch || "main" },
  });
  if (!repoDid) throw new Error(`knot ${KNOT} returned no repo DID`);

  await xrpc(pds, "com.atproto.repo.createRecord", {
    token: accessJwt,
    body: {
      repo: did,
      collection: REPO_NSID,
      rkey,
      record: { $type: REPO_NSID, knot: KNOT, repoDid, createdAt: new Date().toISOString(), ...meta },
    },
  });
  log("created repo");
  return url;
}

function mirror(repo, tgUrl, log) {
  const ghUrl = `https://x-access-token:${GH_TOKEN}@github.com/${GH_USER}/${repo.name}.git`;

  if (sameRefs(remoteRefs(ghUrl), remoteRefs(tgUrl))) {
    log("refs already match, clone skipped");
    return "unchanged";
  }

  const work = mkdtempSync(join(tmpdir(), "mirror-"));
  try {
    const bare = join(work, "repo.git");
    git(["clone", "--mirror", ghUrl, bare]);
    const { out } = git(["-C", bare, "push", "--prune", tgUrl, ...REFSPECS]);
    if (out) log(out);
    return out.includes("Everything up-to-date") ? "unchanged" : "updated";
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function writeResult(repo, status) {
  if (!RESULTS_DIR) return;
  try {
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(join(RESULTS_DIR, `${repo}.txt`), status);
  } catch {}
}

const ICON = { updated: "✓", unchanged: "—", failed: "⚠" };

async function handle(repo) {
  const lines = [];
  const log = (message) => lines.push(redact(message));
  let status = "failed";

  try {
    const tgUrl = await withRetry(() => ensureRepo(repo, log), {
      onRetry: (n, err) => log(`ensure attempt ${n} failed: ${redact(err.message)}`),
    });
    status = await withRetry(() => mirror(repo, tgUrl, log), {
      onRetry: (n, err) => log(`mirror attempt ${n} failed: ${redact(err.message)}`),
    });
  } catch (err) {
    log(redact(err.message));
  }

  writeResult(repo.name, status);
  console.log(`::group::${ICON[status]} ${repo.name} (${status})`);
  for (const line of lines) console.log(line);
  console.log("::endgroup::");
  return status;
}

(async () => {
  configureSsh(TANGLED_SSH_KEY);
  const repos = selectBatch(JSON.parse(REPOS_JSON), Number(BATCH_INDEX), Number(BATCH_COUNT));
  const limit = Number(CONCURRENCY) || 3;
  console.log(`Batch ${BATCH_INDEX} of ${BATCH_COUNT}: ${repos.length} repos, concurrency ${limit}`);

  const tally = { updated: 0, unchanged: 0, failed: 0 };
  await pool(repos, limit, async (repo) => {
    tally[await handle(repo)]++;
  });

  console.log(`Done — ${tally.updated} updated, ${tally.unchanged} unchanged, ${tally.failed} failed`);
})().catch((err) => {
  console.error(redact(err.message));
  process.exit(1);
});
