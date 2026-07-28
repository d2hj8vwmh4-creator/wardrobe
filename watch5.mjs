import { writeFileSync } from 'fs';
const REPO   = 'd2hj8vwmh4-creator/wardrobe';
const SHA    = '16dba6c';
const log = (m) => console.log('[' + new Date().toISOString().slice(11,19) + '] ' + m);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
  return { status: res.status, data: await res.json() };
}

log('waiting for run of ' + SHA);
let run = null;
for (let i = 0; i < 50 && !run; i++) {
  const { data } = await getJson(`https://api.github.com/repos/${REPO}/actions/runs?per_page=5`);
  run = (data.workflow_runs || []).find(r => (r.head_sha || '').startsWith(SHA));
  if (!run) { log('  not created yet (' + (i+1) + ')'); await sleep(15_000); }
}
if (!run) { log('RUN_NOT_FOUND'); process.exit(1); }
log('RUN_ID=' + run.id + ' run_number=' + run.run_number + ' status=' + run.status);

for (let i = 0; i < 50; i++) {
  const { data } = await getJson(`https://api.github.com/repos/${REPO}/actions/runs/${run.id}`);
  log('status=' + data.status + ' conclusion=' + (data.conclusion || ''));
  if (data.status === 'completed') {
    if (data.conclusion === 'success') {
      log('=== BUILD SUCCESS ===');
      const { data: arts } = await getJson(`https://api.github.com/repos/${REPO}/actions/runs/${run.id}/artifacts`);
      log('artifacts total=' + (arts.total_count || 0));
    } else {
      log('=== BUILD FAILED, fetching issue ===');
      const { data: issues } = await getJson(`https://api.github.com/repos/${REPO}/issues?state=all&per_page=10&sort=created&direction=desc`);
      const filtered = (issues || []).filter(x => !x.pull_request);
      const err = filtered.find(x => x.title.includes('Android build failed #' + run.run_number)) || filtered[0];
      if (err) {
        log('=== ISSUE #' + err.number + ': ' + err.title + ' ===');
        log(err.body);
      } else {
        log('NO ISSUE; recent issues:');
        for (const ii of filtered.slice(0,5)) log('  #' + ii.number + ' ' + ii.title);
      }
    }
    break;
  }
  await sleep(30_000);
}
log('DONE');
