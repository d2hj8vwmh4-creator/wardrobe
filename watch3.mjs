// 监听 run 30339698691，完成后从 step summary / Issue 拿到真实错误
import { writeFileSync } from 'fs';
const RUN_ID = '30339698691';
const REPO   = 'd2hj8vwmh4-creator/wardrobe';

const log = (m) => console.log('[' + new Date().toISOString().slice(11,19) + '] ' + m);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
  return { status: res.status, data: await res.json() };
}

log('start watching run ' + RUN_ID);

let completed = null;
for (let i = 0; i < 60; i++) {
  const { data: run } = await getJson(`https://api.github.com/repos/${REPO}/actions/runs/${RUN_ID}`);
  log(`run status=${run.status} conclusion=${run.conclusion || ''} (attempt ${i+1})`);
  if (run.status === 'completed') { completed = run; break; }
  await sleep(30_000);
}

if (!completed) { log('TIMED_OUT'); process.exit(2); }

log('=== RUN COMPLETED ===');
log('conclusion = ' + completed.conclusion);

// 列出每个步骤的状态与耗时
const { data: jobs } = await getJson(`https://api.github.com/repos/${REPO}/actions/runs/${RUN_ID}/jobs`);
for (const j of jobs.jobs) {
  log('JOB: ' + j.name + ' conclusion=' + j.conclusion);
  for (const s of j.steps) {
    log('  step[' + s.number + '] ' + s.name + ' => ' + s.conclusion);
  }
}

// 失败时拉最新 Issue 的内容（公开仓库未认证可读）
if (completed.conclusion !== 'success') {
  log('=== FETCHING ISSUE (build-failed) ===');
  const { data: issues } = await getJson(`https://api.github.com/repos/${REPO}/issues?state=all&per_page=5&sort=created&direction=desc`);
  const filtered = issues.filter(x => !x.pull_request);
  for (const i of filtered.slice(0, 5)) log('issue: #' + i.number + ' ' + i.title);
  const err_issue = filtered.find(x => x.title.includes('Android build failed #' + completed.run_number));
  if (err_issue) {
    log('=== ISSUE BODY ===');
    log(err_issue.body);
  } else {
    log('NO issue created; falling back to annotations');
    const { data: anns } = await getJson(`https://api.github.com/repos/${REPO}/actions/runs/${RUN_ID}/annotations`);
    for (const a of anns) {
      log('--- annotation level=' + a.annotation_level + ' path=' + a.path + ' ---');
      log(a.message);
    }
  }
}

log('DONE');
