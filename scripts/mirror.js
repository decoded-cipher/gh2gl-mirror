import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  REPO_NAME,
  GH_USER,
  GH_TOKEN,
  GITLAB_TOKEN,
  GITLAB_HOST,
  GITLAB_NAMESPACE,
  RESULTS_DIR,
} = process.env;

for (const k of ["REPO_NAME","GH_USER","GH_TOKEN","GITLAB_TOKEN","GITLAB_HOST","GITLAB_NAMESPACE"]) {
  if (!process.env[k]) { console.error(`Missing env: ${k}`); process.exit(1); }
}

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf8", ...opts });
}

function glSlug(name) {
  return name
    .replace(/[^A-Za-z0-9_.-]/g, "-")
    .replace(/^[-_.]+/, "")
    .replace(/(?:\.git|\.atom)$/i, "")
    .replace(/[-_.]+$/, "") || "repo";
}

const glPath = glSlug(REPO_NAME);
const ghUrl = `https://x-access-token:${GH_TOKEN}@github.com/${GH_USER}/${REPO_NAME}.git`;
const glUrl = `https://oauth2:${GITLAB_TOKEN}@${GITLAB_HOST}/${GITLAB_NAMESPACE}/${glPath}.git`;

const work = mkdtempSync(join(tmpdir(), "mirror-"));
const bare = join(work, `${REPO_NAME}.git`);

function writeResult(status) {
  if (!RESULTS_DIR) return;
  try {
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(join(RESULTS_DIR, `${REPO_NAME}.txt`), status);
  } catch {}
}

try {
  rmSync(bare, { recursive: true, force: true });
} catch {}

try {
  console.log(`Cloning --mirror ${REPO_NAME}…`);
  run(`git clone --mirror "${ghUrl}" "${bare}"`, { stdio: "inherit" });

  console.log(`Pushing --mirror to GitLab…`);
  run(`git -C "${bare}" remote set-url --push origin "${glUrl}"`, { stdio: "inherit" });

  const pushOutput = run(`git -C "${bare}" push --mirror "${glUrl}" 2>&1`);
  console.log(pushOutput);

  const unchanged = pushOutput.includes("Everything up-to-date");
  writeResult(unchanged ? "unchanged" : "updated");

  console.log(unchanged
    ? `— ${REPO_NAME} (no changes)`
    : `✓ ${REPO_NAME} (updated)`);
} catch (e) {
  const detail = (e.stdout || e.stderr || "").toString().trim();
  console.error(`⚠ Failed to mirror ${REPO_NAME}: ${e.message}`);
  if (detail) console.error(detail);
  writeResult("failed");
  process.exit(0);
} finally {
  try { rmSync(work, { recursive: true, force: true }); } catch {}
}
