# GitHub → GitLab Mirror

[![GH → GL Backup (staged, parallel)](https://github.com/decoded-cipher/gitlab-mirror/actions/workflows/mirror.yml/badge.svg)](https://github.com/decoded-cipher/gitlab-mirror/actions/workflows/mirror.yml)

Mirror **all repos you own on GitHub** (incl. archived; forks optional) to **GitLab**, enforcing private visibility, with parallel jobs, retries, and Discord notifications.

## Features
- Includes **public + private + archived** repositories
- Includes **forks** by default (see [Skip forks](#skip-forks) to exclude them)
- Forces **GitLab visibility = private** for every mirrored project
- Parallel mirroring (up to 25 concurrent jobs) with 2x retry on failure
- Discord webhook notifications with per-repo status breakdown
- Zero per-repo config — run it from a single backup repo


## Repo layout

```
.github/workflows/mirror.yml   # Workflow with 3 jobs: discover → backup → notify
scripts/
  discover.js                   # Lists all repos you OWN (includes forks + archived) → JSON array of names
  ensure.js                     # Ensures GitLab project exists under your namespace; forces visibility=private
  mirror.js                     # Mirrors a single repo (git clone --mirror → git push --mirror)
  notify.js                     # Sends a Discord notification with run summary (updated/unchanged/failed counts)
```


## Requirements

- **Node.js 20** (set up automatically by the workflow)
- **Secrets** (in the backup repo → *Settings → Secrets and variables → Actions*):

| Secret | Purpose |
|---|---|
| `GH_PAT` | GitHub Personal Access Token — fine-grained with **Contents: Read** and **Metadata: Read** scopes (must include private repos you own) |
| `GITLAB_TOKEN` | GitLab Personal Access Token with **`api`** scope |
| `GITLAB_HOST` | GitLab hostname, usually `gitlab.com` (or your self-hosted domain) |
| `GITLAB_NAMESPACE` | Your GitLab **username** or **group path** where projects should live (e.g. `decoded-cipher`) |
| `DISCORD_WEBHOOK_URL` | Discord webhook URL for run notifications (optional — the notify job exits gracefully if missing) |

> `GH_USER` is taken automatically from `${{ github.repository_owner }}` in the workflow. No need to set it manually.


## Usage

### Manual run
1. Push the files to your backup repo
2. Go to **Actions → GH → GL Backup (staged, parallel) → Run workflow**

### Scheduled run
The workflow is pre-configured to run **every Monday at 00:00 UTC** via cron (`0 0 * * 1`). To change the schedule, edit the `cron` expression in `.github/workflows/mirror.yml`:

```yaml
on:
  schedule:
    - cron: '0 0 * * 1'   # every Monday at 00:00 UTC
  workflow_dispatch:
```


## How it works

### Job 1 — `discover`
- Runs `scripts/discover.js` using your GitHub token
- Collects **all repos you own** (public, private, archived — and forks by default)
- Emits a JSON array of repo names to the next job

### Job 2 — `backup` (matrix)
For each repo name (matrix, `max-parallel: 25`, `fail-fast: false`):
1. **Ensure** — `scripts/ensure.js`
   - Resolves your GitLab **namespace** (user or group)
   - Creates the project if it doesn't exist and **forces visibility to `private`**
2. **Mirror** — `scripts/mirror.js`
   - `git clone --mirror` from GitHub → `git push --mirror` to GitLab
   - Writes a per-repo result file (`updated` / `unchanged` / `failed`) for the notify step
   - Step has **2x retry** with backoff to handle transient failures
3. **Upload** — per-repo result files are uploaded as artifacts for the notify job

### Job 3 — `notify`
- Downloads all mirror result artifacts
- Runs `scripts/notify.js` to send a Discord embed with:
  - Overall status (success / failure)
  - Updated, unchanged, and failed repo counts
  - Links to updated and failed repos
  - Run duration and next scheduled run time


## Customization

### Skip forks
By default `discover.js` **includes forks**. To exclude them, change one line in `scripts/discover.js`:

```js
// Before (includes forks):
if (r.owner?.login === GH_USER) names.push(r.name);

// After (skips forks):
if (r.owner?.login === GH_USER && !r.fork) names.push(r.name);
```

### Keep public repos public on GitLab
Currently `ensure.js` forces every project to `private`. To mirror visibility from GitHub (public → public, private → private), pass visibility from `discover.js` through the matrix and update `ensure.js` to set it accordingly.

### Tune parallelism
In the `backup` job strategy:
```yaml
strategy:
  max-parallel: 25
```
Lower this if you hit rate limits; raise it for speed if your runner and network allow.


## Git LFS note

This flow uses `git clone --mirror` and `git push --mirror`, which mirror refs and **LFS pointers only**.
If you need to back up **LFS objects** as well, augment `mirror.js` to install `git-lfs` and run:
```bash
git lfs install
git lfs fetch --all
git lfs push --all "<gitlab-remote-url>"
```
Consider enabling this only for repos that actually use LFS.
