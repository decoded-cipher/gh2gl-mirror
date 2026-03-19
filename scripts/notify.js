const {
  DISCORD_WEBHOOK_URL,
  WORKFLOW_STATUS,
  REPO_COUNT,
  BACKUP_RESULT,
  GITHUB_REPOSITORY,
  GITHUB_RUN_ID,
  GITHUB_RUN_NUMBER,
  GITHUB_EVENT_NAME,
  GITHUB_SERVER_URL,
} = process.env;

if (!DISCORD_WEBHOOK_URL) {
  console.error("Missing DISCORD_WEBHOOK_URL");
  process.exit(1);
}

const runUrl = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
const allSucceeded = WORKFLOW_STATUS === "success";
const backupStatus = BACKUP_RESULT || "unknown";
const repoCount = REPO_COUNT || "?";
const color = allSucceeded ? 0x2ecc71 : 0xe74c3c;
const timestamp = `<t:${Math.floor(Date.now() / 1000)}:R>`;

const triggerMap = {
  schedule: "Scheduled",
  workflow_dispatch: "Manual",
  push: "Push",
  pull_request: "Pull request",
};
const trigger = triggerMap[GITHUB_EVENT_NAME] || GITHUB_EVENT_NAME;

const discoverOk = WORKFLOW_STATUS === "success" || backupStatus !== "unknown";
const backupOk = backupStatus === "success";

const lines = [
  allSucceeded
    ? `Mirrored **${repoCount}** repos from GitHub to GitLab.`
    : `Mirror run had failures — [view logs](${runUrl}).`,
  "",
  `Repos: **${repoCount}** | Trigger: **${trigger}** | Run: [#${GITHUB_RUN_NUMBER}](${runUrl})`,
  "",
  `Discover: ${discoverOk ? "passed" : "failed"} | Backup: ${backupOk ? "all passed" : backupStatus === "failure" ? "some failed" : "unknown"}`,
  "",
  timestamp,
];

const embed = {
  title: allSucceeded ? "Mirror — Success" : "Mirror — Failed",
  url: runUrl,
  color,
  description: lines.join("\n"),
};

const payload = {
  username: "GitHub Mirror Bot",
  avatar_url: "https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png",
  embeds: [embed],
};

(async () => {
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
