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

// Every turn replays the whole conversation, so a session left open keeps getting
// more expensive per message (a previous build hit ~370k tokens on one thread).
// Past this many context tokens the session is cut loose and the next message
// starts fresh. Transcripts stay on disk either way, so nothing is lost.
// Tune with SESSION_RESET_TOKENS in ~/.secrets/agents-in-slack.env; 0 disables.
const SESSION_RESET_TOKENS = Number(process.env.SESSION_RESET_TOKENS ?? 150000);

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
  let ctxTokens = 0;

  for await (const msg of q) {
    sdkSessionId = msg.session_id ?? sdkSessionId;

    // The closing 'result' message carries this turn's usage. Cache reads/creations
    // count as context too — they're what the replayed conversation costs.
    if (msg.type === 'result') {
      const u = msg.usage ?? {};
      ctxTokens =
        (u.input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0);
    }

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

  sessions.set(sessionKey, { sdkSessionId, ctxTokens });

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
  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: `${mention}${finalText || '(응답 없음)'}`,
  });

  return ctxTokens;
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

  const ctxTokens = await runTurn({
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
  } else if (SESSION_RESET_TOKENS > 0 && ctxTokens >= SESSION_RESET_TOKENS) {
    sessions.delete(sessionKey);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text:
        `:broom: 대화 맥락이 ${ctxTokens.toLocaleString()} 토큰까지 커져서 자동으로 정리했어요.\n` +
        `다음 메시지부터 새 세션으로 시작해 토큰이 다시 가벼워집니다. (기록은 디스크에 그대로 남아 있어요)`,
    });
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
  // "<key>\t<context tokens>" — key stays the first field so the shell helpers
  // can still pipe this straight into DELETE.
  const lines = [...sessions.entries()].map(
    ([k, s]) => `${k}\t${(s.ctxTokens ?? 0).toLocaleString()} 토큰`,
  );
  res.end((lines.join('\n') || '활성 세션 없음') + '\n');
}).listen(7391, '127.0.0.1');

await app.start();
const auth = await app.client.auth.test();
botUserId = auth.user_id;
console.log(`Cerry Slack bot 연결됨 (Socket Mode) - bot user: ${botUserId}`);
