// Clones a single GitHub repo (bare mirror) and pushes --mirror to GitLab (private enforced in ensure step).
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  REPO_NAME,
  GH_USER,
  GH_TOKEN,
  GITLAB_TOKEN,
  GITLAB_HOST,
  GITLAB_NAMESPACE,
} = process.env;

for (const k of ["REPO_NAME","GH_USER","GH_TOKEN","GITLAB_TOKEN","GITLAB_HOST","GITLAB_NAMESPACE"]) {
  if (!process.env[k]) { console.error(`Missing env: ${k}`); process.exit(1); }
}

function run(cmd) { execSync(cmd, { stdio: "inherit" }); }

const ghUrl = `https://x-access-token:${GH_TOKEN}@github.com/${GH_USER}/${REPO_NAME}.git`;
const glUrl = `https://oauth2:${GITLAB_TOKEN}@${GITLAB_HOST}/${GITLAB_NAMESPACE}/${REPO_NAME}.git`;

const work = mkdtempSync(join(tmpdir(), "mirror-"));
const bare = join(work, `${REPO_NAME}.git`);

try {
  rmSync(bare, { recursive: true, force: true });
} catch {}

try {
  console.log(`Cloning --mirror ${REPO_NAME}…`);
  run(`git clone --mirror "${ghUrl}" "${bare}"`);

  console.log(`Pushing --mirror to GitLab…`);
  run(`git -C "${bare}" remote set-url --push origin "${glUrl}"`);
  run(`git -C "${bare}" push --mirror "${glUrl}"`);

  console.log(`✓ Successfully mirrored ${REPO_NAME}`);
} catch (e) {
  console.error(`⚠ Failed to mirror ${REPO_NAME}: ${e.message}`);
  process.exit(0); // Exit with success to continue workflow
} finally {
  try { rmSync(work, { recursive: true, force: true }); } catch {}
}
