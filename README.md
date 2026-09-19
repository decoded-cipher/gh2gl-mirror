# GitHub → GitLab Mirror

[![GH → GL Backup (staged, parallel)](https://github.com/decoded-cipher/gitlab-mirror/actions/workflows/mirror.yml/badge.svg)](https://github.com/decoded-cipher/gitlab-mirror/actions/workflows/mirror.yml)

Mirror **all repos you own on GitHub** (incl. archived; forks optional) to **GitLab**, enforcing private visibility, with parallel jobs, retries, and Discord notifications.

## Features
- Includes **public + private + archived** repositories
- Includes **forks** by default (see [Skip forks](#skip-forks) to exclude them)
- Forces **GitLab visibility = private** for every mirrored project
- Parallel mirroring in batched jobs (25 concurrent by default) with 3x retry and exponential backoff
- Skips the clone entirely when GitHub and GitLab refs already match
- Discord webhook notifications with per-repo status breakdown
- Zero per-repo config — run it from a single backup repo


## Repo layout

```
.github/workflows/mirror.yml   # Workflow with 3 jobs: discover → backup → notify
scripts/
  discover.js                   # Lists all repos you OWN (includes forks + archived) → matrix outputs
  backup.js                     # Ensures GitLab projects exist and mirrors one batch of repos
  lib.js                        # Shared helpers (git, ref comparison, slugs, retry, concurrency)
  notify.js                     # Sends a Discord notification with run summary (updated/unchanged/failed counts)
```


## Requirements

- **Node.js 20+** — provided by the runner image; the workflow installs nothing
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
- Emits the repo list plus a batch index list for the next job's matrix

### Job 2 — `backup` (matrix over batches)
The matrix runs one job per **batch** (25 by default), not one per repo, which keeps the run
under GitHub's hard limit of **256 matrix jobs per workflow run**. Each job takes every 25th repo
from the list and processes `CONCURRENCY` of them at a time via `scripts/backup.js`:
1. **Ensure** — resolves your GitLab **namespace** once per job, creates the project if missing,
   and sets visibility to `private` only when it isn't already
2. **Compare** — `git ls-remote` on both sides; when `refs/heads`, `refs/tags` and `refs/notes`
   already match, the clone is skipped and the repo is recorded as `unchanged`
3. **Mirror** — otherwise `git clone --mirror` from GitHub → `git push --mirror` to GitLab
4. Each repo gets **3 attempts** with exponential backoff, then a result file
   (`updated` / `unchanged` / `failed`)
5. **Upload** — one result artifact per batch for the notify job

### Job 3 — `notify`
- Downloads all batch result artifacts
- Runs `scripts/notify.js` to send a Discord embed with:
  - Overall status (success / failure)
  - Updated, unchanged, and failed repo counts
  - Every updated and failed repo name, packed to fit Discord's embed limits


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
Currently `backup.js` forces every project to `private`. To mirror visibility from GitHub (public → public, private → private), carry each repo's visibility from `discover.js` through `REPOS_JSON` and use it in `ensureProject()`.

### Tune parallelism
Three knobs, from coarsest to finest:
```yaml
strategy:
  max-parallel: 25      # batch jobs running at once
env:
  MAX_BATCHES: '25'     # batches discover.js splits the repo list into (discover job)
  CONCURRENCY: '3'      # repos mirrored simultaneously inside one batch job (backup job)
```
Lower these if you hit rate limits; raise them for speed if your runner and network allow.
Total repos in flight is roughly `max-parallel × CONCURRENCY`.


## Git LFS note

This flow uses `git clone --mirror` and `git push --mirror`, which mirror refs and **LFS pointers only**.
If you need to back up **LFS objects** as well, augment `backup.js` to install `git-lfs` and run:
```bash
git lfs install
git lfs fetch --all
git lfs push --all "<gitlab-remote-url>"
```
Consider enabling this only for repos that actually use LFS.
