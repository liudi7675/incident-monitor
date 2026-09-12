/**
 * wecom-notify.mjs — 企业微信群机器人推送工具（精选模式）
 * 用法:
 *   node wecom-notify.mjs --title "标题" --detail "详情（支持换行）" [--url 链接] [--mention]
 * Webhook 来源（三级回取）：环境变量 WECOM_WEBHOOK → 工作区 .workbuddy/wecom-webhook.txt
 * 密钥不入公开仓库；--mention 时用 text 消息类型 @所有人，否则用 markdown
 */
import { readFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
function argOf(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const title = argOf('--title');
const detail = argOf('--detail') || '';
const url = argOf('--url');
const mention = args.includes('--mention');

if (!title) {
  console.error('用法: node wecom-notify.mjs --title "标题" --detail "详情" [--url 链接] [--mention]');
  process.exit(1);
}

function getWebhook() {
  if (process.env.WECOM_WEBHOOK) return process.env.WECOM_WEBHOOK.trim();
  const f = 'C:/Users/Administrator/WorkBuddy/2026-08-29-15-32-42/.workbuddy/wecom-webhook.txt';
  if (existsSync(f)) {
    const t = readFileSync(f, 'utf8').trim();
    if (t) return t;
  }
  return null;
}

const webhook = getWebhook();
if (!webhook) {
  console.error('未找到企业微信 webhook（WECOM_WEBHOOK 或 .workbuddy/wecom-webhook.txt）');
  process.exit(1);
}

const payload = mention
  ? {
      msgtype: 'text',
      text: {
        content: `${title}\n${detail}${url ? '\n详情: ' + url : ''}`,
        mentioned_list: ['@all'],
      },
    }
  : {
      msgtype: 'markdown',
      markdown: {
        content: [
          `## 🚨 ${title}`,
          detail,
          url ? `[详细链接](${url})` : '',
        ].filter(Boolean).join('\n'),
      },
    };

const res = await fetch(webhook, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(15000),
});
const j = await res.json().catch(() => ({}));
if (j.errcode === 0) {
  console.log('✅ 企业微信推送成功');
} else {
  console.error('推送失败:', res.status, JSON.stringify(j));
  process.exit(1);
}
