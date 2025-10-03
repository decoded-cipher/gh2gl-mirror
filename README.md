# GitHub → GitLab Mirror (staged, parallel)

[![GH → GL Backup (staged, parallel)](https://github.com/decoded-cipher/gitlab-mirror/actions/workflows/mirror.yml/badge.svg)](https://github.com/decoded-cipher/gitlab-mirror/actions/workflows/mirror.yml)


Mirror **all repos you own on GitHub** (incl. archived; forks optional) to **GitLab**, enforcing private visibility, with parallel jobs and retries.

## Features
- ✅ Includes **public + private + archived** repositories
- ✅ (Current code) **Includes forks** as well
- ✅ Forces **GitLab visibility = private** for each mirrored project
- ✅ Parallel mirroring with retries (fast + resilient)
- ✅ Zero per-repo config — run it from a single “backup” repo

> If you want to **skip forks**, see the short tweak under **[Customization → Skip forks]**.


## Repo layout

```
.github/workflows/mirror.yml   # Workflow with 2 jobs: discover → backup (ensure + mirror)
scripts/
  discover.js                            # Lists all repos you OWN (includes forks + archived) → JSON array of names
  ensure.js                              # Ensures GitLab project exists under your namespace; forces visibility=private
  mirror.js                              # Mirrors a single repo (git clone --mirror → git push --mirror)
```


## Requirements

- **Node.js**: Runner uses Node 20 (set by the workflow)
- **Secrets** (in the backup repo → *Settings → Secrets and variables → Actions*):
  - `GH_PAT`: GitHub Personal Access Token  
    - Scopes (fine-grained token): repository **Contents: Read**, **Metadata: Read** (include private repos you own).
  - `GITLAB_TOKEN`: GitLab Personal Access Token with **`api`** scope.
  - `GITLAB_HOST`: usually `gitlab.com` (or your self-hosted domain).
  - `GITLAB_NAMESPACE`: your GitLab **username** or **group path** where projects should live (e.g., `decoded-cipher` or `inovus-labs`).

> `GH_USER` is taken automatically from `\${{ github.repository_owner }}` in the workflow. No need to set it manually.


## Usage

### 1) Manual run
This repo’s workflow is currently configured with **`workflow_dispatch`** only:

1. Push the files to your backup repo
2. Go to **Actions → GH → GL Backup (staged, parallel) → Run workflow**

### 2) (Optional) Schedule it nightly
If you want a daily backup, add a cron trigger to the workflow:

```yaml
on:
  schedule:
    - cron: "37 1 * * *"   # daily at 01:37 UTC
  workflow_dispatch: {}
```

> Keep `workflow_dispatch` so you can still run it on-demand.


## How it works

### Job: `discover`
- Runs `scripts/discover.js` using your GitHub token
- Collects **all repos you own** (public, private, archived — **and forks in the current code**)  
- Emits a JSON list of repo names to the next job

### Job: `backup` (matrix)
For each repo name (matrix):
1. **Ensure** (Node): `scripts/ensure.js`  
   - Resolves your GitLab **namespace** (user/group)  
   - Creates the project if missing and **forces visibility to `private`** (even if the GitHub repo is public)
2. **Mirror** (Node): `scripts/mirror.js`  
   - `git clone --mirror` from GitHub → `git push --mirror` to GitLab  
   - Step has **2× retry** to handle transient failures

> Matrix parallelism (`max-parallel: 25`) scales well for 200+ repos while being gentle on rate limits.


## Customization

### Skip forks
Right now `discover.js` **includes forks**. To **exclude forks**, change one line in `scripts/discover.js`:

**Before** (includes forks):
```js
if (r.owner?.login === GH_USER) names.push(r.name);
```

**After** (skips forks):
```js
if (r.owner?.login === GH_USER && !r.fork) names.push(r.name);
```

### Keep public repos public on GitLab
Currently `ensure.js` **forces every project to `private`**.  
If you’d rather mirror visibility from GitHub (public → public, private → private), you can pass visibility from `discover.js` through the matrix and update `ensure.js` to set it accordingly. (Ask if you want the exact diff.)

### Tune parallelism
In the `backup` job:
```yaml
strategy:
  max-parallel: 25
```
Lower this if you hit rate limits; raise it for speed if your runner/network allows.


## Git LFS note

This flow uses `git clone --mirror` and `git push --mirror`, which **mirror refs and LFS pointers**.  
If you need to **back up LFS *objects*** as well, augment `mirror.js` to install `git-lfs` and run:
```bash
git lfs install
git lfs fetch --all
git lfs push --all "<gitlab-remote-url>"
```
(This is heavier; consider enabling it only for repos that actually use LFS.)
