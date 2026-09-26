import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const {
  DISCORD_WEBHOOK_URL,
  WORKFLOW_STATUS,
  REPO_COUNT,
  BACKUP_RESULT,
  RESULTS_DIR,
  GITHUB_REPOSITORY,
  GITHUB_RUN_ID,
  GITHUB_RUN_NUMBER,
  GITHUB_SERVER_URL,
} = process.env;

if (!DISCORD_WEBHOOK_URL) {
  console.error("Missing DISCORD_WEBHOOK_URL");
  process.exit(1);
}

const FIELD_VALUE_LIMIT = 1024;
const EMBED_TOTAL_LIMIT = 6000;
const MAX_FIELDS = 25;

const runUrl = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
const allSucceeded = WORKFLOW_STATUS === "success";
const backupStatus = BACKUP_RESULT || "unknown";
const repoCount = parseInt(REPO_COUNT, 10) || 0;
const color = allSucceeded ? 0x2ecc71 : 0xe74c3c;

const discoverOk = WORKFLOW_STATUS === "success" || backupStatus !== "unknown";
const backupOk = backupStatus === "success";

function readMirrorResults() {
  const counts = { updated: 0, unchanged: 0, failed: 0 };
  const names = { updated: [], failed: [] };

  if (!RESULTS_DIR) return { counts, names };

  try {
    const files = readdirSync(RESULTS_DIR);
    for (const file of files) {
      if (!file.endsWith(".txt")) continue;
      const repoName = file.replace(/\.txt$/, "");
      const status = readFileSync(join(RESULTS_DIR, file), "utf8").trim();
      if (status === "updated") {
        counts.updated++;
        names.updated.push(repoName);
      } else if (status === "unchanged") {
        counts.unchanged++;
      } else {
        counts.failed++;
        names.failed.push(repoName);
      }
    }
  } catch {}

  names.updated.sort();
  names.failed.sort();

  return { counts, names };
}

const ghOwner = GITHUB_REPOSITORY?.split("/")[0] || "";
const repoLink = (r) => `[${r}](${GITHUB_SERVER_URL}/${ghOwner}/${r})`;
const moreMarker = (n) => ` \u2026 and **${n}** more`;

function embedLength(embed) {
  let total = (embed.title?.length || 0) + (embed.description?.length || 0);
  total += embed.footer?.text?.length || 0;
  for (const field of embed.fields) total += field.name.length + field.value.length;
  return total;
}

function repoListFields(label, repos, { charBudget, fieldBudget }) {
  if (repos.length === 0 || fieldBudget < 1 || charBudget < 1) return [];

  const name = `${label} (${repos.length})`;
  const linked = repos.map((r) => `- ${repoLink(r)}`).join("\n");
  if (linked.length <= FIELD_VALUE_LIMIT && name.length + linked.length <= charBudget) {
    return [{ name, value: linked, inline: false }];
  }

  const chunks = [];
  let current = "";
  let used = name.length;
  let shown = 0;

  for (const repo of repos) {
    if (current && current.length + 2 + repo.length > FIELD_VALUE_LIMIT) {
      chunks.push(current);
      current = "";
      if (chunks.length >= fieldBudget) break;
      used += 1;
    }
    const sep = current ? ", " : "";
    if (used + sep.length + repo.length > charBudget) break;
    current += sep + repo;
    used += sep.length + repo.length;
    shown++;
  }
  if (current) chunks.push(current);

  if (shown < repos.length) {
    let hidden = repos.length - shown;
    let last = chunks.pop() ?? "";
    let marker = moreMarker(hidden);
    while (last && last.length + marker.length > FIELD_VALUE_LIMIT) {
      const cut = last.lastIndexOf(", ");
      if (cut < 0) {
        last = "";
        break;
      }
      last = last.slice(0, cut);
      hidden++;
      marker = moreMarker(hidden);
    }
    chunks.push(last + marker);
  }

  return chunks.map((value, i) => ({
    name: i === 0 ? name : "\u200b",
    value,
    inline: false,
  }));
}

(async () => {
  const { counts, names } = readMirrorResults();
  const hasResults = counts.updated + counts.unchanged + counts.failed > 0;

  const description = allSucceeded
    ? `Mirrored **${repoCount}** repositories from GitHub to GitLab.\nAll jobs completed successfully.\n\u200b`
    : `Mirror run completed with failures — **${repoCount}** repositories were processed.\n[View workflow logs](${runUrl}) for details.\n\u200b`;

  const fields = [];

  fields.push(
    { name: "Run", value: `[#${GITHUB_RUN_NUMBER}](${runUrl})`, inline: true },
    { name: "Discover", value: discoverOk ? "Passed" : "Failed", inline: true },
    { name: "Backup", value: backupOk ? "All passed" : backupStatus === "failure" ? "Some failed" : "Unknown", inline: true },
  );

  if (hasResults) {
    fields.push(
      { name: "Updated", value: `**${counts.updated}**`, inline: true },
      { name: "Unchanged", value: `${counts.unchanged}`, inline: true },
      { name: "Failed", value: counts.failed > 0 ? `**${counts.failed}**` : `${counts.failed}`, inline: true },
    );
  } else {
    fields.push(
      { name: "Repos processed", value: `**${repoCount}**`, inline: true },
    );
  }

  const embed = {
    title: allSucceeded ? "Mirror \u2014 Success" : "Mirror \u2014 Failed",
    url: runUrl,
    color,
    description,
    fields,
    footer: {
      text: GITHUB_REPOSITORY,
      icon_url: "https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png",
    },
    timestamp: new Date().toISOString(),
  };

  const charBudget = EMBED_TOTAL_LIMIT - embedLength(embed) - 64;
  const fieldBudget = MAX_FIELDS - fields.length;

  const failedFields = repoListFields("Failed repos", names.failed, { charBudget, fieldBudget });
  const failedCost = failedFields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  const updatedFields = repoListFields("Updated repos", names.updated, {
    charBudget: charBudget - failedCost,
    fieldBudget: fieldBudget - failedFields.length,
  });

  fields.push(...updatedFields, ...failedFields);

  const payload = {
    username: "GitHub Mirror Bot",
    avatar_url: "https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png",
    embeds: [embed],
  };

  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Discord webhook failed: ${res.status} ${res.statusText}\n${body}`);
    process.exit(1);
  }

  console.log("Discord notification sent");
})();
