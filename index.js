import dotenv from 'dotenv';
import { homedir } from 'os';
import { join } from 'path';
dotenv.config({ path: join(homedir(), '.secrets', 'agents-in-slack.env') });

import pkg from '@slack/bolt';
const { App } = pkg;
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createServer } from 'node:http';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
});

// sessionKey -> { sdkSessionId: string|null }
const sessions = new Map();
const handledTs = new Set();
const LOG_SAVE_RE = /로그\s*저장/;

let botUserId = null;

function stripMention(text) {
  return botUserId ? text.replace(new RegExp(`<@${botUserId}>`, 'g'), '').trim() : text.trim();
}

async function fetchImageBlocks(files = []) {
  const blocks = [];
  for (const f of files) {
    if (!f.mimetype?.startsWith('image/')) continue;
    const res = await fetch(f.url_private, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: f.mimetype, data: buf.toString('base64') },
    });
  }
  return blocks;
}

// Runs one turn against the Agent SDK, updating a Slack status message as it goes.
// Only posts final assistant text — tool_use/tool_result bodies never reach Slack.
async function runTurn({ client, channel, threadTs, sessionKey, text, files, user }) {
  const statusMsg = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: ':thinking_face: 생각 중...',
  });

  const session = sessions.get(sessionKey);
  const imageBlocks = await fetchImageBlocks(files);
  const content = [{ type: 'text', text: text || '(첨부 이미지 확인해줘)' }, ...imageBlocks];

  const q = query({
    prompt: imageBlocks.length
      ? (async function* () {
          yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
        })()
      : text,
    options: {
      resume: session?.sdkSessionId ?? undefined, // pre-registered sessions hold null, not undefined
      cwd: homedir(),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    },
  });

  let finalText = '';
  let sawToolUse = false;
  let sdkSessionId = session?.sdkSessionId ?? null;

  for await (const msg of q) {
    sdkSessionId = msg.session_id ?? sdkSessionId;

    if (msg.type === 'assistant') {
      const blocks = msg.message?.content ?? [];
      for (const b of blocks) {
        if (b.type === 'tool_use' && !sawToolUse) {
          sawToolUse = true;
          await client.chat.update({
            channel,
            ts: statusMsg.ts,
            text: ':hammer_and_wrench: 작업 중...',
          });
        }
        if (b.type === 'text') finalText += b.text;
      }
    }
  }

  sessions.set(sessionKey, { sdkSessionId });

  // chat.update is a silent edit — Slack doesn't push-notify for it. The status
  // message (생각 중/작업 중) stays an edit since it's just process noise, but the
  // actual answer has to be a fresh postMessage or nobody gets notified about it.
  await client.chat.update({
    channel,
    ts: statusMsg.ts,
    text: ':white_check_mark: 답변 완료',
  });

  // Thread-reply push notifications are far less reliable without an explicit
  // mention — "all new posts" channel settings mainly govern top-level messages.
  const mention = user ? `<@${user}> ` : '';
  const answerMsg = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: `${mention}${finalText || '(응답 없음)'}`,
  });

  return answerMsg.ts;
}

async function handleQuestion({ client, event, sessionKey, rawText }) {
  if (handledTs.has(event.ts)) return;
  handledTs.add(event.ts);

  const text = stripMention(rawText);
  const threadTs = event.thread_ts || event.ts;
  const isLogSave = LOG_SAVE_RE.test(text);

  // Register on first tag, not after the turn finishes — otherwise the very
  // first turn is invisible to the session list (and a turn that inspects the
  // list never sees itself, since it's still running).
  if (!sessions.has(sessionKey)) sessions.set(sessionKey, { sdkSessionId: null });

  await runTurn({
    client,
    channel: event.channel,
    threadTs,
    sessionKey,
    text,
    files: event.files,
    user: event.user,
  });

  if (isLogSave) {
    await client.reactions.add({ channel: event.channel, timestamp: threadTs, name: 'white_check_mark' });
    sessions.delete(sessionKey);
  }
}

// Channel: tag-gated, session keyed by thread (first tag activates the thread's session).
app.event('app_mention', async ({ event, client }) => {
  const sessionKey = `channel:${event.channel}:${event.thread_ts || event.ts}`;
  await handleQuestion({ client, event, sessionKey, rawText: event.text });
});

// DM: no tag needed, single active session per user.
app.event('message', async ({ event, client }) => {
  if (event.channel_type !== 'im' || event.bot_id || event.subtype) return;
  const sessionKey = `dm:${event.user}`;
  await handleQuestion({ client, event, sessionKey, rawText: event.text });
});

// Edited-to-add-tag case. DM edits are a no-op in practice (the original message
// already got answered, handledTs dedupes it) — this branch is really for channels,
// where an untagged message never fired app_mention and so was never answered.
app.event('message', async ({ event, client }) => {
  if (event.subtype !== 'message_changed') return;
  const msg = event.message;
  if (msg.bot_id) return;

  if (event.channel_type === 'im') {
    const sessionKey = `dm:${msg.user}`;
    await handleQuestion({ client, event: { ...msg, channel: event.channel }, sessionKey, rawText: msg.text });
    return;
  }

  if (!botUserId || !msg.text?.includes(`<@${botUserId}>`)) return; // only react if the edit added our tag
  const sessionKey = `channel:${event.channel}:${msg.thread_ts || msg.ts}`;
  await handleQuestion({ client, event: { ...msg, channel: event.channel }, sessionKey, rawText: msg.text });
});

// Slack blocks unregistered "/word" text client-side, so raw "/model" never reaches
// a bot. This single registered command is the workaround: "/cerry model foo" gets
// reconstructed as "/model foo" and forwarded like any other question.
app.command('/cerry', async ({ command, ack, client }) => {
  await ack();
  const text = `/${command.text}`;
  const channel = command.channel_id;
  const headerMsg = await client.chat.postMessage({
    channel,
    text: `<@${command.user_id}> ${text}`,
  });
  const sessionKey = `channel:${channel}:${headerMsg.ts}`;
  await handleQuestion({
    client,
    event: { ts: headerMsg.ts, channel, user: command.user_id, files: [] },
    sessionKey,
    rawText: text,
  });
});

// Sessions live only in this process's memory, so there's no way to inspect or
// close one from a terminal. This localhost-only endpoint is that window:
//   curl -s localhost:7391                 → 활성 세션 목록
//   curl -sX DELETE localhost:7391/<key>   → 해당 세션 종료 (로그·✅ 없이 그냥 닫기)
// 127.0.0.1 bound: reachable only from this Mac, whose shell users already have
// the bot's own (bypassPermissions) reach anyway.
createServer((req, res) => {
  const key = decodeURIComponent(req.url.slice(1));
  if (req.method === 'DELETE' && sessions.delete(key)) return res.end('closed\n');
  res.end(([...sessions.keys()].join('\n') || '활성 세션 없음') + '\n');
}).listen(7391, '127.0.0.1');

await app.start();
const auth = await app.client.auth.test();
botUserId = auth.user_id;
console.log(`Cerry Slack bot 연결됨 (Socket Mode) - bot user: ${botUserId}`);
