// Sends a Discord webhook embed summarizing the mirror workflow run.
// Env: DISCORD_WEBHOOK_URL, WORKFLOW_STATUS, REPO_COUNT, GITHUB_* (injected by Actions)

const {
  DISCORD_WEBHOOK_URL,
  WORKFLOW_STATUS,
  REPO_COUNT,
  BACKUP_RESULT,
  GITHUB_REPOSITORY,
  GITHUB_RUN_ID,
  GITHUB_RUN_NUMBER,
  GITHUB_WORKFLOW,
  GITHUB_REF_NAME,
  GITHUB_EVENT_NAME,
  GITHUB_ACTOR,
  GITHUB_SERVER_URL,
  GITHUB_SHA,
} = process.env;

if (!DISCORD_WEBHOOK_URL) {
  console.error("Missing DISCORD_WEBHOOK_URL");
  process.exit(1);
}

const runUrl = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
const commitUrl = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/commit/${GITHUB_SHA}`;
const repoUrl = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}`;

const allSucceeded = WORKFLOW_STATUS === "success";
const backupStatus = BACKUP_RESULT || "unknown";
const repoCount = REPO_COUNT || "?";

const statusEmoji = allSucceeded ? "✅" : "❌";
const statusText = allSucceeded ? "Succeeded" : "Failed";
const color = allSucceeded ? 0x2ecc71 : 0xe74c3c;

const triggerMap = {
  schedule: "⏰ Scheduled (cron)",
  workflow_dispatch: "🔘 Manual dispatch",
  push: "📤 Push",
  pull_request: "🔀 Pull request",
};
const triggerLabel = triggerMap[GITHUB_EVENT_NAME] || GITHUB_EVENT_NAME;

const now = new Date().toISOString();

const embed = {
  title: `${statusEmoji}  Mirror Workflow — ${statusText}`,
  url: runUrl,
  color,
  description: [
    `**${repoCount}** repositories processed from GitHub → GitLab.`,
    "",
    allSucceeded
      ? "All jobs completed successfully."
      : "One or more jobs encountered failures — check the run for details.",
  ].join("\n"),
  fields: [
    {
      name: "🔁 Workflow",
      value: `[\`${GITHUB_WORKFLOW}\`](${runUrl})`,
      inline: true,
    },
    {
      name: "#️⃣ Run",
      value: `[#${GITHUB_RUN_NUMBER}](${runUrl})`,
      inline: true,
    },
    {
      name: "📦 Repository",
      value: `[\`${GITHUB_REPOSITORY}\`](${repoUrl})`,
      inline: true,
    },
    {
      name: "🎯 Trigger",
      value: triggerLabel,
      inline: true,
    },
    {
      name: "🌿 Branch",
      value: `\`${GITHUB_REF_NAME}\``,
      inline: true,
    },
    {
      name: "👤 Actor",
      value: `\`${GITHUB_ACTOR}\``,
      inline: true,
    },
    {
      name: "🔢 Repos Discovered",
      value: `\`${repoCount}\``,
      inline: true,
    },
    {
      name: "📋 Discover Job",
      value: WORKFLOW_STATUS === "success" || backupStatus !== "unknown" ? "✅ Passed" : "❌ Failed",
      inline: true,
    },
    {
      name: "🪞 Backup Job",
      value: backupStatus === "success" ? "✅ All passed" : backupStatus === "failure" ? "❌ Some failed" : "⚠️ Unknown",
      inline: true,
    },
    {
      name: "🔗 Commit",
      value: `[\`${GITHUB_SHA?.slice(0, 7)}\`](${commitUrl})`,
      inline: true,
    },
    {
      name: "📊 Overall Status",
      value: allSucceeded ? "🟢 Success" : "🔴 Failure",
      inline: true,
    },
    {
      name: "⏱️ Timestamp",
      value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
      inline: true,
    },
  ],
  footer: {
    text: `GitHub Actions • ${GITHUB_REPOSITORY}`,
    icon_url: "https://github.githubassets.com/favicons/favicon-dark.svg",
  },
  timestamp: now,
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

  console.log("✓ Discord notification sent");
})();
