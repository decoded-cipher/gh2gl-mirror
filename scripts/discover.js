// Outputs a compact JSON array of repo names you OWN (includes forks + archived).
// Uses GH fine-grained PAT with repo read.
const { GH_USER, GH_TOKEN } = process.env;
if (!GH_USER || !GH_TOKEN) {
  console.error("Missing GH_USER or GH_TOKEN");
  process.exit(1);
}

const GH_API = "https://api.github.com";

async function gh(path, query = {}) {
  const url = new URL(GH_API + path);
  Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, {
    headers: {
      Authorization: `token ${GH_TOKEN}`,
      "User-Agent": "mirror-discover",
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

(async () => {
  const per_page = 100;
  let page = 1, names = [];
  for (;;) {
    const list = await gh("/user/repos", {
      affiliation: "owner",
      per_page,
      page,
      sort: "full_name",
      direction: "asc",
    });
    if (list.length === 0) break;
    for (const r of list) {
      if (r.owner?.login === GH_USER) names.push(r.name);
    }
    if (list.length < per_page) break;
    page++;
  }
  // Print JSON (array of names) to stdout for job output
  process.stdout.write(JSON.stringify(names));
})().catch(e => { console.error(e); process.exit(1); });
