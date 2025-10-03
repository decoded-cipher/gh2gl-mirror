// Ensures a GitLab project exists for REPO_NAME under GITLAB_NAMESPACE and forces visibility=private.
const { REPO_NAME, GITLAB_TOKEN, GITLAB_HOST, GITLAB_NAMESPACE } = process.env;
if (!REPO_NAME || !GITLAB_TOKEN || !GITLAB_HOST || !GITLAB_NAMESPACE) {
  console.error("Missing env: REPO_NAME / GITLAB_TOKEN / GITLAB_HOST / GITLAB_NAMESPACE");
  process.exit(1);
}
const GL_API = `https://${GITLAB_HOST}/api/v4`;

async function gl(path, { method = "GET", body, raw = false } = {}) {
  const res = await fetch(GL_API + path, {
    method,
    headers: { "PRIVATE-TOKEN": GITLAB_TOKEN, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  if (!res.ok) throw new Error(`GitLab ${res.status} ${res.statusText}: ${await res.text()}`);
  return res.json();
}

async function resolveNamespaceId() {
  // Prefer /namespaces (works for users & groups), then fallback
  const q = encodeURIComponent(GITLAB_NAMESPACE);
  try {
    const ns = await gl(`/namespaces?search=${q}`);
    const found = ns.find(n =>
      (n.full_path || n.path || "").toLowerCase() === GITLAB_NAMESPACE.toLowerCase()
    );
    if (found?.id) return found.id;
  } catch {}
  try {
    const gs = await gl(`/groups?search=${q}`);
    const g = gs.find(x =>
      (x.full_path || x.path || "").toLowerCase() === GITLAB_NAMESPACE.toLowerCase()
    );
    if (g?.id) return g.id;
  } catch {}
  try {
    const us = await gl(`/users?username=${q}`);
    if (us[0]?.id) return us[0].id;
  } catch {}
  throw new Error(`GitLab namespace '${GITLAB_NAMESPACE}' not found`);
}

function encProjectPath() {
  return encodeURIComponent(`${GITLAB_NAMESPACE}/${REPO_NAME}`);
}

(async () => {
  try {
    const nsId = await resolveNamespaceId();
    const enc = encProjectPath();

    const head = await gl(`/projects/${enc}`, { raw: true });
    if (head.ok) {
      // force private
      await gl(`/projects/${enc}`, { method: "PUT", body: { visibility: "private" } }).catch(() => {});
      console.log(`✓ Project ${REPO_NAME} exists and is private`);
      process.exit(0);
    }

    // create private
    await gl(`/projects`, {
      method: "POST",
      body: { name: REPO_NAME, namespace_id: nsId, visibility: "private" },
    });
    console.log(`✓ Created project ${REPO_NAME}`);
  } catch (e) {
    console.error(`⚠ Skipping ${REPO_NAME}: ${e.message}`);
    process.exit(0); // Exit with success to continue workflow
  }
})();
