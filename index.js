import dotenv from 'dotenv';
import { homedir } from 'os';
import { join } from 'path';
dotenv.config({ path: join(homedir(), '.secrets', 'agents-in-slack.env') });
import pkg from '@slack/bolt';
const { App } = pkg;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
});

app.event('app_mention', async ({ event, say }) => {
  await say({ text: `연결 확인. 받은 메시지: ${event.text}`, thread_ts: event.thread_ts || event.ts });
});

app.event('message', async ({ event, say }) => {
  if (event.channel_type !== 'im' || event.bot_id) return;
  await say({ text: `연결 확인. 받은 메시지: ${event.text}` });
});

await app.start();
console.log('Cerry Slack bot 연결됨 (Socket Mode)');
