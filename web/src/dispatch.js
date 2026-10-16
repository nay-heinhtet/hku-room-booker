// Nightly dispatcher. GitHub's own `schedule:` trigger routinely starts hours
// late, so at 23:50 HKT this sends a `scheduled-booking` repository_dispatch to
// every student repo the app is installed on. Each repo's workflow then checks
// whether anything is due and waits until midnight HKT before booking.
//
// Cost per student: 3 GitHub API calls (installation token, repo list,
// dispatch). Cloudflare's free plan allows 50 outbound requests per
// invocation (~15 students); Workers Paid raises that to 1,000+.

import { appJwt, gh, installationToken, paginate } from "./github.js";

const CONCURRENCY = 8;

async function mapLimit(items, limit, fn) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await fn(items[i]) };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function dispatchAll(env) {
  const jwt = await appJwt(env);
  const installations = await paginate(jwt, "/app/installations");

  const results = await mapLimit(installations, CONCURRENCY, async (inst) => {
    const token = await installationToken(jwt, inst.id);
    const repos = await gh(token, "/installation/repositories?per_page=100");
    const sent = [];
    for (const repo of repos.repositories) {
      await gh(token, `/repos/${repo.full_name}/dispatches`, {
        method: "POST",
        body: { event_type: "scheduled-booking" },
      });
      sent.push(repo.full_name);
    }
    return sent;
  });

  const summary = { installations: installations.length, dispatched: [], failed: [] };
  results.forEach((r, i) => {
    if (r.ok) summary.dispatched.push(...r.value);
    else summary.failed.push({ installation: installations[i].id, account: installations[i].account?.login, error: r.error.message });
  });
  console.log(JSON.stringify({ event: "nightly-dispatch", ...summary }));
  return summary;
}
