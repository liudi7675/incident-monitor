/**
 * api-push.mjs — 通过 GitHub Contents API 更新远端文件（绕过 git push 通道）
 * 用法: node api-push.mjs <path-in-repo> <local-file> <commit-message>
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const [,, repoPath, localFile, message] = process.argv;
if (!repoPath || !localFile || !message) {
  console.error('用法: node api-push.mjs <repo-path> <local-file> <message>');
  process.exit(1);
}

function getToken() {
  // 优先使用环境变量 GH_TOKEN（git credential fill 在 Node spawnSync 下可能 ETIMEDOUT）
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  const out = execSync('git credential fill', {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8', timeout: 20000, shell: process.env.SHELL || undefined,
  });
  const m = out.match(/^password=(.+)$/m);
  if (!m) throw new Error('未找到 git 凭据 token');
  return m[1].trim();
}

const token = getToken();
const REPO = 'liudi7675/incident-monitor';
const auth = { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'incident-monitor' };

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: auth,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}

const base = `https://api.github.com/repos/${REPO}/contents/${repoPath}`;
// 1. 获取远端文件 sha
let sha = null;
const get = await api('GET', base + '?ref=main');
if (get.status === 200) sha = get.json.sha;
else if (get.status !== 404) { console.error('获取远端文件失败:', get.status, JSON.stringify(get.json).slice(0, 200)); process.exit(1); }

// 2. PUT 更新
const content = readFileSync(localFile).toString('base64');
const put = await api('PUT', base, { message, content, sha: sha || undefined, branch: 'main' });
if (put.status === 200 || put.status === 201) {
  console.log(`✅ 已更新 ${repoPath}（commit: ${put.json.commit.sha.slice(0, 7)}）`);
} else {
  console.error('更新失败:', put.status, JSON.stringify(put.json).slice(0, 300));
  process.exit(1);
}
