import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const {
  DISCORD_WEBHOOK_URL,
  WORKFLOW_STATUS,
  REPO_COUNT,
  BACKUP_RESULT,
  GH_TOKEN,
  CRON_SCHEDULE,
  RESULTS_DIR,
  GITHUB_REPOSITORY,
  GITHUB_RUN_ID,
  GITHUB_RUN_NUMBER,
  GITHUB_SERVER_URL,
  GITHUB_RUN_STARTED_AT,
} = process.env;

if (!DISCORD_WEBHOOK_URL) {
  console.error("Missing DISCORD_WEBHOOK_URL");
  process.exit(1);
}

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

  return { counts, names };
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function computeDuration() {
  if (!GITHUB_RUN_STARTED_AT) return null;
  const start = new Date(GITHUB_RUN_STARTED_AT).getTime();
  if (isNaN(start)) return null;
  return formatDuration(Date.now() - start);
}

function startedAtTimestamp() {
  if (!GITHUB_RUN_STARTED_AT) return null;
  const start = new Date(GITHUB_RUN_STARTED_AT).getTime();
  if (isNaN(start)) return null;
  return Math.floor(start / 1000);
}

function nextCronRun(cron) {
  if (!cron) return null;
  const [min, hour, , , dow] = cron.trim().split(/\s+/);
  const m = parseInt(min, 10);
  const h = parseInt(hour, 10);
  const dayOfWeek = parseInt(dow, 10);
  if ([m, h, dayOfWeek].some(isNaN)) return null;

  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(h, m, 0, 0);

  const currentDow = now.getUTCDay();
  let daysAhead = dayOfWeek - currentDow;
  if (daysAhead < 0 || (daysAhead === 0 && next <= now)) daysAhead += 7;
  next.setUTCDate(next.getUTCDate() + daysAhead);

  return Math.floor(next.getTime() / 1000);
}

const ghOwner = GITHUB_REPOSITORY?.split("/")[0] || "";

function formatRepoList(repos, { bulleted = false, cap = 20 } = {}) {
  const items = repos.slice(0, cap);
  const repoLink = (r) => `[${r}](${GITHUB_SERVER_URL}/${ghOwner}/${r})`;
  let list = bulleted
    ? items.map(r => `- ${repoLink(r)}`).join("\n")
    : items.map(r => repoLink(r)).join(", ");
  if (repos.length > cap) {
    list += bulleted
      ? `\n- ...and **${repos.length - cap}** more`
      : ` and **${repos.length - cap}** more`;
  }
  return list;
}

(async () => {
  const { counts, names } = readMirrorResults();
  const duration = computeDuration();
  const startedTs = startedAtTimestamp();
  const nextRunTs = nextCronRun(CRON_SCHEDULE);
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

  const startedLine = startedTs ? `<t:${startedTs}:f>` : "\u2014";
  const durationLine = duration || "\u2014";
  const nextRunLine = nextRunTs ? `<t:${nextRunTs}:f> (<t:${nextRunTs}:R>)` : "\u2014";

  fields.push(
    { name: "Started", value: startedLine, inline: true },
    { name: "Duration", value: `**${durationLine}**`, inline: true },
    { name: "Next run", value: nextRunLine, inline: true },
  );

  if (names.updated.length > 0) {
    fields.push(
      { name: `Updated repos (${names.updated.length})`, value: formatRepoList(names.updated, { bulleted: true }), inline: false },
    );
  }

  if (names.failed.length > 0) {
    fields.push(
      { name: `Failed repos (${names.failed.length})`, value: formatRepoList(names.failed, { bulleted: true }), inline: false },
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
