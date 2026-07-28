import { writeFileSync } from 'fs';
const REPO = 'd2hj8vwmh4-creator/wardrobe';
const RUN_ID = '30339698691';

const res = await fetch(`https://api.github.com/repos/${REPO}/actions/runs/${RUN_ID}`, { headers: { 'Accept': 'application/vnd.github+json' } });
const run = await res.json();
console.log('RUN status =', run.status, '| conclusion =', run.conclusion || '(none)');
console.log('RUN url =', run.html_url);

// 步骤详情
const jres = await fetch(`https://api.github.com/repos/${REPO}/actions/runs/${RUN_ID}/jobs`, { headers: { 'Accept': 'application/vnd.github+json' } });
const jobs = await jres.json();
for (const j of jobs.jobs || []) {
  console.log('JOB:', j.name, '=>', j.conclusion);
  for (const s of j.steps) {
    console.log('  [' + s.number + ']', s.name, '=>', s.conclusion);
  }
}

// 失败时读 Issue
if (run.conclusion !== 'success') {
  const ires = await fetch(`https://api.github.com/repos/${REPO}/issues?state=all&per_page=5&sort=created&direction=desc`, { headers: { 'Accept': 'application/vnd.github+json' } });
  const issues = await ires.json();
  const filtered = issues.filter(x => !x.pull_request);
  const errIssue = filtered.find(x => x.title.includes('Android build failed #' + run.run_number));
  if (errIssue) {
    console.log('=== ISSUE #' + errIssue.number + ': ' + errIssue.title + ' ===');
    console.log(errIssue.body);
  } else {
    console.log('NO error issue found; listing recent issues:');
    for (const i of filtered.slice(0,5)) console.log('  #' + i.number, i.title);
  }
}
