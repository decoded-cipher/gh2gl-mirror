// Node 20+ (global fetch). Mirrors all personal GitHub repos you own (no forks, include archived)
// to GitLab namespace with matching visibility. Pushes --mirror (branches, tags, deletions).

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  GH_USER,
  GH_TOKEN,
  GITLAB_TOKEN,
  GITLAB_HOST,
  GITLAB_NAMESPACE,
} = process.env;

function requireEnv(name) {
  if (!process.env[name]) throw new Error(`Missing env: ${name}`);
}
["GH_USER", "GH_TOKEN", "GITLAB_TOKEN", "GITLAB_HOST", "GITLAB_NAMESPACE"].forEach(
  requireEnv
);

const GH_API = "https://api.github.com";
const GL_API = `https://${GITLAB_HOST}/api/v4`;

async function ghFetch(path, params = {}) {
  const url = new URL(`${GH_API}${path}`);
  // Support pagination params
  if (params.query) {
    Object.entries(params.query).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  const res = await fetch(url, {
    headers: {
      Authorization: `token ${GH_TOKEN}`,
      "User-Agent": "mirror-script",
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

async function glFetch(path, opts = {}) {
  const url = `${GL_API}${path}`;
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers: {
      "PRIVATE-TOKEN": GITLAB_TOKEN,
      "Content-Type": "application/json",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  // For GET existence checks we often just need status
  if (opts.raw) return res;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab API ${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

async function listAllOwnedRepos() {
  // Use /users/:username/repos to list public+private owned by the user (requires token & correct visibility via affiliation)
  // Safer: use /user/repos?affiliation=owner to ensure ownership.
  const per_page = 100;
  let page = 1;
  const out = [];
  while (true) {
    const items = await ghFetch(`/user/repos`, {
      query: {
        affiliation: "owner",
        per_page: String(per_page),
        page: String(page),
        sort: "full_name",
        direction: "asc",
      },
    });
    if (!items.length) break;
    // Filter: owner is you, skip forks, include archived
    for (const r of items) {
      if (r.owner?.login === GH_USER && !r.fork) {
        out.push({
          name: r.name,
          private: !!r.private,
          archived: !!r.archived, // included; informational
        });
      }
    }
    if (items.length < per_page) break;
    page++;
  }
  return out;
}

async function resolveGitLabNamespaceId() {
  // Try group path first (works for groups/subgroups), then user by username
  // groups?search= matches group name, not full path reliably; try direct /namespaces search instead
  // Fallback sequence to be robust across cloud/self-hosted
  // 1) /namespaces?search= (returns groups/users)
  let ns;
  try {
    const data = await glFetch(`/namespaces?search=${encodeURIComponent(GITLAB_NAMESPACE)}`);
    ns = data.find(
      (n) =>
        n.full_path?.toLowerCase() === GITLAB_NAMESPACE.toLowerCase() ||
        n.path?.toLowerCase() === GITLAB_NAMESPACE.toLowerCase()
    );
  } catch {
    // ignore and try next
  }
  if (ns?.id) return { id: ns.id, kind: ns.kind }; // kind: group/user

  // 2) /groups
  try {
    const groups = await glFetch(`/groups?search=${encodeURIComponent(GITLAB_NAMESPACE)}`);
    const g = groups.find(
      (x) =>
        x.full_path?.toLowerCase() === GITLAB_NAMESPACE.toLowerCase() ||
        x.path?.toLowerCase() === GITLAB_NAMESPACE.toLowerCase()
    );
    if (g?.id) return { id: g.id, kind: "group" };
  } catch {}

  // 3) /users?username=
  try {
    const users = await glFetch(`/users?username=${encodeURIComponent(GITLAB_NAMESPACE)}`);
    if (users[0]?.id) return { id: users[0].id, kind: "user" };
  } catch {}

  throw new Error(`GitLab namespace '${GITLAB_NAMESPACE}' not found`);
}

function ghRepoUrl(name) {
  // token auth via HTTPS
  return `https://x-access-token:${GH_TOKEN}@github.com/${GH_USER}/${name}.git`;
}
function glRepoUrl(name) {
  return `https://oauth2:${GITLAB_TOKEN}@${GITLAB_HOST}/${GITLAB_NAMESPACE}/${name}.git`;
}
function glProjectPathEncoded(name) {
  // encode namespace/repo for path segments (GitLab expects %2F for slash)
  return encodeURIComponent(`${GITLAB_NAMESPACE}/${name}`);
}

async function ensureGitLabProject(nsId, repoName, visibility) {
  const enc = glProjectPathEncoded(repoName);

  // Check existence
  const head = await glFetch(`/projects/${enc}`, { raw: true });
  if (head.ok) {
    // Ensure visibility matches
    await glFetch(`/projects/${enc}`, {
      method: "PUT",
      body: { visibility },
    }).catch(() => {}); // best-effort
    return;
  }
  // Create
  await glFetch(`/projects`, {
    method: "POST",
    body: {
      name: repoName,
      namespace_id: nsId,
      visibility,
    },
  });
}

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: "inherit", ...opts });
}

async function mirrorRepo(tmpDir, repo) {
  const { name, private: isPrivate } = repo;
  const gh = ghRepoUrl(name);
  const gl = glRepoUrl(name);

  // Fresh bare mirror clone, then push --mirror
  const dir = join(tmpDir, `${name}.git`);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
  run(`git clone --mirror "${gh}" "${dir}"`);
  run(`git -C "${dir}" remote set-url --push origin "${gl}"`);
  run(`git -C "${dir}" push --mirror "${gl}"`);
}

(async () => {
  console.log(`→ Listing owned GitHub repos for ${GH_USER} (no forks, including archived)...`);
  const repos = await listAllOwnedRepos();
  console.log(`Found ${repos.length} repos.`);

  const ns = await resolveGitLabNamespaceId();
  console.log(`→ GitLab namespace '${GITLAB_NAMESPACE}' resolved to id=${ns.id} (${ns.kind})`);

  const tmp = mkdtempSync(join(tmpdir(), "mirror-"));

  for (const r of repos) {
    const vis = r.private ? "private" : "public";
    console.log(`\n=== ${r.name} (GitHub visibility: ${vis}${r.archived ? ", archived" : ""}) ===`);
    try {
      await ensureGitLabProject(ns.id, r.name, vis);
      await mirrorRepo(tmp, r);
      console.log(`✔ Mirrored ${r.name}`);
    } catch (e) {
      console.error(`✖ Failed ${r.name}:`, e.message);
      // continue with next repo
    }
  }

  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
  console.log("\nAll done.");
})().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
