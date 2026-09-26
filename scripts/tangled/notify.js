// Sends a Discord notification with the Tangled run summary.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const {
  DISCORD_WEBHOOK_URL,
  DISCOVER_RESULT,
  MIRROR_RESULT,
  REPO_COUNT,
  RESULTS_DIR,
  GITHUB_REPOSITORY,
  GITHUB_RUN_ID,
  GITHUB_RUN_NUMBER,
  GITHUB_SERVER_URL,
} = process.env;

if (!DISCORD_WEBHOOK_URL) {
  console.log("DISCORD_WEBHOOK_URL not set, skipping notification");
  process.exit(0);
}

const FIELD_VALUE_LIMIT = 1024;
// Discord caps the whole embed at 6000 chars; the fixed fields and text stay well under the rest.
const LIST_CHAR_BUDGET = 4500;
const MARKER_ROOM = 40;

const runUrl = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
const repoCount = parseInt(REPO_COUNT, 10) || 0;
const mirrorOk = MIRROR_RESULT === "success" || MIRROR_RESULT === "skipped";
const jobsOk = DISCOVER_RESULT === "success" && mirrorOk;

function readResults() {
  const counts = { updated: 0, unchanged: 0, failed: 0 };
  const names = { updated: [], failed: [] };
  try {
    for (const file of readdirSync(RESULTS_DIR)) {
      if (!file.endsWith(".txt")) continue;
      const repo = file.replace(/\.txt$/, "");
      const status = readFileSync(join(RESULTS_DIR, file), "utf8").trim();
      if (status === "updated") names.updated.push(repo);
      else if (status !== "unchanged") names.failed.push(repo);
      counts[status === "updated" || status === "unchanged" ? status : "failed"]++;
    }
  } catch {}
  names.updated.sort();
  names.failed.sort();
  return { counts, names };
}

// Comma-packs names into as many fields as needed, drawing from a budget shared across lists.
function listFields(label, repos, budget) {
  if (repos.length === 0) return [];
  const chunks = [""];
  let shown = 0;
  for (const repo of repos) {
    const last = chunks.length - 1;
    const sep = chunks[last] ? ", " : "";
    if (budget.left < sep.length + repo.length) break;
    if (chunks[last].length + sep.length + repo.length > FIELD_VALUE_LIMIT - MARKER_ROOM) chunks.push(repo);
    else chunks[last] += sep + repo;
    budget.left -= sep.length + repo.length;
    shown++;
  }
  if (shown < repos.length) chunks[chunks.length - 1] += ` … and **${repos.length - shown}** more`;
  return chunks.map((value, i) => ({ name: i ? "​" : `${label} (${repos.length})`, value, inline: false }));
}

(async () => {
  const { counts, names } = readResults();
  const ok = jobsOk && counts.failed === 0;

  const fields = [
    { name: "Run", value: `[#${GITHUB_RUN_NUMBER}](${runUrl})`, inline: true },
    { name: "Discover", value: DISCOVER_RESULT === "success" ? "Passed" : "Failed", inline: true },
    { name: "Mirror", value: { success: "All passed", skipped: "Nothing to mirror", failure: "Some failed" }[MIRROR_RESULT] || "Unknown", inline: true },
    { name: "Updated", value: `**${counts.updated}**`, inline: true },
    { name: "Unchanged", value: `${counts.unchanged}`, inline: true },
    { name: "Failed", value: counts.failed > 0 ? `**${counts.failed}**` : "0", inline: true },
  ];

  const budget = { left: LIST_CHAR_BUDGET };
  const failedFields = listFields("Failed repos", names.failed, budget);
  const updatedFields = listFields("Updated repos", names.updated, budget);
  fields.push(...updatedFields, ...failedFields);

  const embed = {
    title: ok ? "Tangled Mirror — Success" : "Tangled Mirror — Failed",
    url: runUrl,
    color: ok ? 0x2ecc71 : 0xe74c3c,
    description: ok
      ? `Mirrored **${repoCount}** public repositories from GitHub to Tangled.\nAll jobs completed successfully.\n​`
      : `Tangled mirror run completed with failures — **${repoCount}** public repositories were processed.\n[View workflow logs](${runUrl}) for details.\n​`,
    fields,
    footer: {
      text: GITHUB_REPOSITORY,
      icon_url: "https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png",
    },
    timestamp: new Date().toISOString(),
  };

  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "GitHub Mirror Bot",
      avatar_url: "https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png",
      embeds: [embed],
    }),
  });

  if (!res.ok) {
    console.error(`Discord webhook failed: ${res.status} ${res.statusText}\n${await res.text()}`);
    process.exit(1);
  }

  console.log("Discord notification sent");
})();
