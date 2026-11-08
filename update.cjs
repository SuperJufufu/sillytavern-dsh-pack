
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const GH = 'C:\\Program Files\\GitHub CLI\\gh.exe';
const REPO = 'SuperJufufu/sillytavern-dsh-pack';
const ROOT = 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\showcase-push';
function gh(args, input) { try { return execFileSync(GH, args, { input, encoding:'utf8', maxBuffer: 64*1024*1024 }).trim(); } catch(e){ throw new Error((e.stderr||e.stdout||e.message||'').toString().slice(0,800)); } }
function walk(dir, base, out) { for (const n of fs.readdirSync(dir)) { const f=path.join(dir,n); const st=fs.statSync(f); if (st.isDirectory()) walk(f,base,out); else out.push(f); } return out; }
(async () => {
  const ref = JSON.parse(gh(['api','repos/'+REPO+'/git/ref/heads/main']));
  const cur = ref.object.sha;
  const commit = JSON.parse(gh(['api','repos/'+REPO+'/git/commits/'+cur]));
  const tree = commit.tree.sha;
  console.log('current:', cur, 'tree:', tree);
  const changed = walk(ROOT, ROOT, []);
  const entries = [];
  for (const full of changed) {
    const rel = path.relative(ROOT, full).replace(/\\/g,'/');
    const content = fs.readFileSync(full).toString('base64');
    const blob = JSON.parse(gh(['api','--method','POST','repos/'+REPO+'/git/blobs','--input','-'], JSON.stringify({ content, encoding:'base64' })));
    entries.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha });
    console.log('blob', rel, blob.sha.slice(0,8));
  }
  const newTree = JSON.parse(gh(['api','--method','POST','repos/'+REPO+'/git/trees','--input','-'], JSON.stringify({ base_tree: tree, tree: entries })));
  console.log('new tree:', newTree.sha);
  const newCommit = JSON.parse(gh(['api','--method','POST','repos/'+REPO+'/git/commits','--input','-'], JSON.stringify({
    message: 'demo: bind characters and regenerate showcase images\n\nscene/closeup/avatar now share the same character sheet so the same character appears across angles.',
    tree: newTree.sha,
    parents: [cur],
    author: { name: 'SuperJufufu', email: 'SuperJufufu@users.noreply.github.com', date: new Date().toISOString() },
    committer: { name: 'SuperJufufu', email: 'SuperJufufu@users.noreply.github.com', date: new Date().toISOString() },
  })));
  console.log('new commit:', newCommit.sha);
  const patch = JSON.parse(gh(['api','--method','PATCH','repos/'+REPO+'/git/refs/heads/main','--input','-'], JSON.stringify({ sha: newCommit.sha, force: false })));
  console.log('ref now:', patch.object.sha);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
