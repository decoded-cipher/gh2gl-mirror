# GitHub → GitLab + Tangled Mirror

[![GH → GL Backup (staged, parallel)](https://github.com/decoded-cipher/gitlab-mirror/actions/workflows/gitlab.yml/badge.svg)](https://github.com/decoded-cipher/gitlab-mirror/actions/workflows/gitlab.yml)
[![GH → Tangled Backup (staged, parallel)](https://github.com/decoded-cipher/gitlab-mirror/actions/workflows/tangled.yml/badge.svg)](https://github.com/decoded-cipher/gitlab-mirror/actions/workflows/tangled.yml)

Mirror **all repos you own on GitHub** (incl. archived; forks optional) to **[GitLab](https://gitlab.com)** and **[Tangled](https://tangled.org)**, with parallel jobs, retries, and Discord notifications.

## Features
- **GitLab**: every repo — **public + private + archived** — with visibility forced to **private**
- **Tangled**: every **public** repo (Tangled has no private repos)
- Includes **forks** by default (see [Skip forks](#skip-forks) to exclude them)
- Parallel mirroring in batched jobs (25 concurrent by default) with 3x retry and exponential backoff
- Skips the clone entirely when GitHub and the destination's refs already match
- Discord webhook notifications with per-repo status breakdown
- Zero per-repo config — run it from a single backup repo


## Repo layout

```
.github/workflows/
  gitlab.yml                    # discover → backup → notify, on a weekly schedule
  tangled.yml                   # discover → mirror → notify, after gitlab.yml completes
scripts/
  lib.js                        # Shared helpers (git, ref comparison, slugs, retry, concurrency)
  gitlab/
    discover.js                 # Lists all repos you OWN (includes forks + archived) → matrix outputs
    mirror.js                   # Ensures GitLab projects exist and mirrors one batch of repos
    notify.js                   # Sends a Discord notification with run summary (updated/unchanged/failed counts)
  tangled/
    discover.js                 # Lists all PUBLIC repos you own (includes forks + archived) → matrix outputs
    mirror.js                   # Ensures Tangled repos exist and mirrors one batch of repos
    notify.js                   # Sends a Discord notification with run summary (updated/unchanged/failed counts)
```


## Requirements

- **Node.js 20+** — provided by the runner image; the workflows install nothing
- **Secrets** and **variables** in the backup repo → *Settings → Secrets and variables → Actions*

> `GH_USER` is taken automatically from `${{ github.repository_owner }}` in the workflows. No need to set it manually.

### Shared

| Secret | Purpose |
|---|---|
| `GH_PAT` | GitHub Personal Access Token — fine-grained with **Contents: Read** and **Metadata: Read** scopes (must include private repos you own) |
| `DISCORD_WEBHOOK_URL` | Discord webhook URL for run notifications (optional) |

### GitLab

| Secret | Purpose |
|---|---|
| `GITLAB_TOKEN` | GitLab Personal Access Token with **`api`** scope |
| `GITLAB_HOST` | GitLab hostname, usually `gitlab.com` (or your self-hosted domain) |
| `GITLAB_NAMESPACE` | Your GitLab **username** or **group path** where projects should live (e.g. `decoded-cipher`) |

### Tangled

| Secret | Purpose |
|---|---|
| `TANGLED_SSH_KEY` | Private half of an SSH key whose public half is added under Tangled *Settings → Keys* (Tangled pushes are SSH only) |
| `TANGLED_APP_PASSWORD` | App password for your Tangled account, used only when a repo needs creating |

| Variable | Purpose |
|---|---|
| `TANGLED_HANDLE` | Your Tangled handle (e.g. `arjunkrishna.dev`) — the Tangled workflow does nothing until this is set |
| `TANGLED_KNOT` | Knot to create repos on — optional, defaults to `knot1.tangled.sh` (Tangled's hosted knot) |

Generate the SSH key with `ssh-keygen -t ed25519 -N '' -C gh-mirror -f tangled_mirror`.
Tangled has no UI for app passwords, but your PDS does. For a `tngl.sh` account:
```bash
JWT=$(curl -s https://tngl.sh/xrpc/com.atproto.server.createSession \
  -H 'Content-Type: application/json' \
  -d '{"identifier":"<handle>","password":"<account password>"}' | jq -r .accessJwt)
curl -s https://tngl.sh/xrpc/com.atproto.server.createAppPassword \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"name":"gh-mirror"}' | jq -r .password
```


## Usage

### Manual run
1. Push the files to your backup repo
2. Go to **Actions → GH → GL Backup (staged, parallel)** or **GH → Tangled Backup (staged, parallel)** → **Run workflow**

### Scheduled run
`gitlab.yml` runs **every Monday at 00:00 UTC** via cron (`0 0 * * 1`), and `tangled.yml` starts
when it completes (pass or fail, not when cancelled). To change the schedule, edit the `cron`
expression in `.github/workflows/gitlab.yml`:

```yaml
on:
  schedule:
    - cron: '0 0 * * 1'   # every Monday at 00:00 UTC
  workflow_dispatch:
```


## How it works

Both workflows have the same three jobs.

### Job 1 — `discover`
- Runs `scripts/<gitlab|tangled>/discover.js` using your GitHub token
- Collects **all repos you own** (archived — and forks by default); GitLab gets public and
  private, Tangled gets public only
- Emits the repo list plus a batch index list for the next job's matrix

### Job 2 — `backup` / `mirror` (matrix over batches)
The matrix runs one job per **batch** (25 by default), not one per repo, which keeps the run
under GitHub's hard limit of **256 matrix jobs per workflow run**. Each job takes every 25th repo
from the list and processes `CONCURRENCY` of them at a time via `scripts/<gitlab|tangled>/mirror.js`:
1. **Ensure** — creates the destination repo if missing
   - **GitLab**: resolves your **namespace** once per job, creates the project, and sets visibility
     to `private` only when it isn't already
   - **Tangled**: checks your PDS for the `sh.tangled.repo` record; if missing, creates the repo on
     the knot and writes the record (so runs where every repo already exists never log in)
2. **Compare** — `git ls-remote` on both sides; when `refs/heads`, `refs/tags` and `refs/notes`
   already match, the clone is skipped and the repo is recorded as `unchanged`
3. **Mirror** — otherwise `git clone --mirror` from GitHub, then
   - **GitLab**: `git push --mirror`
   - **Tangled**: `git push --prune` of heads, tags and notes over SSH (a mirror push would also
     copy GitHub's `refs/pull/*`)
4. Each repo gets **3 attempts** with exponential backoff, then a result file
   (`updated` / `unchanged` / `failed`)
5. **Upload** — one result artifact per batch for the notify job

### Job 3 — `notify`
- Downloads all batch result artifacts
- Runs `scripts/<gitlab|tangled>/notify.js` to send a Discord embed with:
  - Overall status (success / failure)
  - Updated, unchanged, and failed repo counts
  - Every updated and failed repo name, packed to fit Discord's embed limits


## Customization

### Skip forks
Both `discover.js` scripts **include forks** by default. To exclude them, add `&& !r.fork` to the
owner check in `scripts/gitlab/discover.js` and/or `scripts/tangled/discover.js`:

```js
// Before (includes forks):
if (r.owner?.login === GH_USER) names.push(r.name);

// After (skips forks):
if (r.owner?.login === GH_USER && !r.fork) names.push(r.name);
```

### Keep public repos public on GitLab
Currently `scripts/gitlab/mirror.js` forces every project to `private`. To mirror visibility from GitHub (public → public, private → private), carry each repo's visibility from `scripts/gitlab/discover.js` through `REPOS_JSON` and use it in `ensureProject()`.

### Repos made private on GitHub
Tangled only ever receives public repos, but a repo made private on GitHub after it was mirrored
is **not** removed from Tangled — delete it there by hand.

### Tune parallelism
Three knobs per workflow, from coarsest to finest:
```yaml
strategy:
  max-parallel: 25      # batch jobs running at once
env:
  MAX_BATCHES: '25'     # batches discover.js splits the repo list into (discover job)
  CONCURRENCY: '3'      # repos mirrored simultaneously inside one batch job (backup / mirror job)
```
Lower these if you hit rate limits; raise them for speed if your runner and network allow.
Total repos in flight is roughly `max-parallel × CONCURRENCY`.


## Git LFS note

Mirroring moves refs and **LFS pointers only**.
If you need to back up **LFS objects** as well, augment `scripts/<gitlab|tangled>/mirror.js` to install `git-lfs` and run:
```bash
git lfs install
git lfs fetch --all
git lfs push --all "<destination-remote-url>"
```
Consider enabling this only for repos that actually use LFS.
