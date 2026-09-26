// Ensures GitLab projects exist and mirrors this job's slice of the repo list into them.
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
  GITLAB_TOKEN,
  GITLAB_HOST,
  GITLAB_NAMESPACE,
  RESULTS_DIR,
  CONCURRENCY,
} = process.env;

for (const key of ["REPOS_JSON", "BATCH_INDEX", "BATCH_COUNT", "GH_USER", "GH_TOKEN", "GITLAB_TOKEN", "GITLAB_HOST", "GITLAB_NAMESPACE"]) {
  if (!process.env[key]) {
    console.error(`Missing env: ${key}`);
    process.exit(1);
  }
}

registerSecrets(GH_TOKEN, GITLAB_TOKEN);

const GL_API = `https://${GITLAB_HOST}/api/v4`;

async function gl(path, { method = "GET", body, raw = false } = {}) {
  const res = await fetch(GL_API + path, {
    method,
    headers: { "PRIVATE-TOKEN": GITLAB_TOKEN, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  if (!res.ok) throw new Error(`GitLab ${res.status} ${res.statusText}: ${redact(await res.text())}`);
  return res.json();
}

async function resolveNamespaceId() {
  const q = encodeURIComponent(GITLAB_NAMESPACE);
  const wanted = GITLAB_NAMESPACE.toLowerCase();
  for (const path of [`/namespaces?search=${q}`, `/groups?search=${q}`]) {
    try {
      const found = (await gl(path)).find((n) => (n.full_path || n.path || "").toLowerCase() === wanted);
      if (found?.id) return found.id;
    } catch {}
  }
  try {
    const users = await gl(`/users?username=${q}`);
    if (users[0]?.id) return users[0].id;
  } catch {}
  throw new Error(`GitLab namespace '${GITLAB_NAMESPACE}' not found`);
}

let namespacePromise;
const namespaceId = () => (namespacePromise ??= resolveNamespaceId().catch((err) => {
  namespacePromise = undefined;
  throw err;
}));

// GitLab has no website field, so the GitHub homepage rides along in the description.
const projectDescription = (repo) => [repo.description, repo.homepage].filter(Boolean).join(" · ");

async function ensureProject(repo, log) {
  const path = glSlug(repo.name);
  const enc = encodeURIComponent(`${GITLAB_NAMESPACE}/${path}`);
  const res = await gl(`/projects/${enc}`, { raw: true });
  const description = projectDescription(repo);

  if (res.ok) {
    const project = await res.json();
    const changes = {};
    if (project.visibility !== "private") changes.visibility = "private";
    if ((project.description ?? "") !== description) changes.description = description;
    if (Object.keys(changes).length) {
      await gl(`/projects/${enc}`, { method: "PUT", body: changes });
      log(`updated ${Object.keys(changes).join(", ")}`);
    }
    return path;
  }
  if (res.status !== 404) throw new Error(`GitLab ${res.status} ${res.statusText}`);

  await gl("/projects", {
    method: "POST",
    body: { name: repo.name, path, namespace_id: await namespaceId(), visibility: "private", description },
  });
  log("created project");
  return path;
}

function mirror(repo, glPath, log) {
  const ghUrl = `https://x-access-token:${GH_TOKEN}@github.com/${GH_USER}/${repo}.git`;
  const glUrl = `https://oauth2:${GITLAB_TOKEN}@${GITLAB_HOST}/${GITLAB_NAMESPACE}/${glPath}.git`;

  if (sameRefs(remoteRefs(ghUrl), remoteRefs(glUrl))) {
    log("refs already match, clone skipped");
    return "unchanged";
  }

  const work = mkdtempSync(join(tmpdir(), "mirror-"));
  try {
    const bare = join(work, `${glPath}.git`);
    git(["clone", "--mirror", ghUrl, bare]);
    const { out } = git(["-C", bare, "push", "--mirror", glUrl]);
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
    const glPath = await withRetry(() => ensureProject(repo, log), {
      onRetry: (n, err) => log(`ensure attempt ${n} failed: ${redact(err.message)}`),
    });
    status = await withRetry(() => mirror(repo.name, glPath, log), {
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
