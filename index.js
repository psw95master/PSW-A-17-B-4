import dotenv from 'dotenv';
import { homedir } from 'os';
import { join } from 'path';
dotenv.config({ path: join(homedir(), '.secrets', 'agents-in-slack.env') });

import pkg from '@slack/bolt';
const { App } = pkg;
import { query } from '@anthropic-ai/claude-agent-sdk';

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
async function runTurn({ client, channel, threadTs, sessionKey, text, files }) {
  const statusMsg = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: ':thinking_face: 생각 중...',
  });

  const session = sessions.get(sessionKey);
  const imageBlocks = await fetchImageBlocks(files);
  const content = imageBlocks.length ? [{ type: 'text', text }, ...imageBlocks] : text;

  const q = query({
    prompt: text && imageBlocks.length
      ? (async function* () {
          yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
        })()
      : text,
    options: {
      resume: session?.sdkSessionId,
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

  await client.chat.update({
    channel,
    ts: statusMsg.ts,
    text: finalText || '(응답 없음)',
  });

  return statusMsg.ts;
}

async function handleQuestion({ client, event, sessionKey, rawText }) {
  if (handledTs.has(event.ts)) return;
  handledTs.add(event.ts);

  const text = stripMention(rawText);
  const threadTs = event.thread_ts || event.ts;
  const isLogSave = LOG_SAVE_RE.test(text);

  await runTurn({
    client,
    channel: event.channel,
    threadTs,
    sessionKey,
    text,
    files: event.files,
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

// Edited-to-add-tag case, DM only for now — channel edits need the message.channels
// event subscription (broader scope, not requested yet). ponytail: add that scope +
// this same branch for channels if the edit-to-tag flow turns out to matter there too.
app.event('message', async ({ event, client }) => {
  if (event.subtype !== 'message_changed' || event.channel_type !== 'im') return;
  const msg = event.message;
  if (msg.bot_id) return;
  const sessionKey = `dm:${msg.user}`;
  await handleQuestion({ client, event: { ...msg, channel: event.channel }, sessionKey, rawText: msg.text });
});

await app.start();
const auth = await app.client.auth.test();
botUserId = auth.user_id;
console.log(`Cerry Slack bot 연결됨 (Socket Mode) - bot user: ${botUserId}`);
