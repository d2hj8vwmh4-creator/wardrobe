import { writeFileSync } from 'fs';
const res = await fetch('https://api.github.com/repos/d2hj8vwmh4-creator/wardrobe/actions/runs?per_page=3', { headers: { 'Accept': 'application/vnd.github+json' } });
const d = await res.json();
writeFileSync('runs-now.json', JSON.stringify(d, null, 2));
for (const r of d.workflow_runs) {
  console.log(r.id, (r.head_sha || '').slice(0,7), r.name, r.status, r.conclusion || '');
}
