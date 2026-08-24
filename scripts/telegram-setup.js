'use strict';

// Finds your Telegram chat id, so the token never has to be pasted anywhere but
// .env.
//
//   1. Talk to @BotFather in Telegram, send /newbot, and follow it.
//   2. Put the token it gives you in .env as TELEGRAM_BOT_TOKEN=...
//   3. Open your new bot in Telegram and send it any message at all.
//   4. node scripts/telegram-setup.js
//
// Run it from anywhere in the repository. It reads the token, asks Telegram who
// has been talking to the bot, and prints the line to add. The token is never
// printed, never logged, and never leaves this machine except in the request
// that has to carry it.

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');

require(path.join(ROOT, 'mcp-server', 'env')).load();

const token = process.env.TELEGRAM_BOT_TOKEN;

function die(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

if (!token) {
  die('TELEGRAM_BOT_TOKEN is not set.\n\n'
    + '  Talk to @BotFather in Telegram, send /newbot, and follow it. It replies with a\n'
    + '  token. Put it in .env as:\n\n'
    + '      TELEGRAM_BOT_TOKEN=1234567890:AA...\n\n'
    + '  Then send your new bot any message, and run this again.');
}

// Never interpolated into output. Only the shape is ever shown, so a mistyped
// token can be diagnosed without displaying it.
if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
  die('TELEGRAM_BOT_TOKEN does not look like a bot token.\n\n'
    + '  Expected something shaped like 1234567890:AA followed by ~35 characters.\n'
    + `  What is in .env is ${token.length} characters and does not match that shape.`);
}

https.get(`https://api.telegram.org/bot${token}/getUpdates`, (res) => {
  let body = '';
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch (err) {
      die(`Telegram answered with something that is not JSON (HTTP ${res.statusCode}).`);
    }

    if (!payload.ok) {
      // description can echo the request; the token is in the path, not the
      // description, but the whole payload is not printed for that reason.
      die(`Telegram rejected the request: ${payload.description || 'no reason given'}\n\n`
        + '  A 401 here means the token is wrong. Check it against what @BotFather sent.');
    }

    const chats = new Map();
    for (const update of payload.result || []) {
      const message = update.message || update.channel_post;
      if (message && message.chat) chats.set(String(message.chat.id), message.chat);
    }

    if (!chats.size) {
      die('The token works, but nobody has messaged this bot yet.\n\n'
        + '  Open the bot in Telegram — the username @BotFather gave you — press Start,\n'
        + '  send it anything, and run this again.\n\n'
        + '  Telegram only keeps recent updates, so if you messaged it days ago, send\n'
        + '  another one now.');
    }

    console.log('\n  Found:\n');
    for (const [id, chat] of chats) {
      const who = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ')
        || chat.username || '(no name)';
      console.log(`    ${who}  —  ${chat.type}  —  chat id ${id}`);
    }

    const [first] = [...chats.keys()];
    const alreadySet = /^\s*TELEGRAM_CHAT_ID\s*=\s*\S/m.test(fs.readFileSync(ENV_FILE, 'utf8'));

    console.log('\n  Add this line to .env:\n');
    console.log(`    TELEGRAM_CHAT_ID=${first}`);
    if (alreadySet) {
      console.log('\n  (TELEGRAM_CHAT_ID is already set in .env — replace it if it differs.)');
    }
    console.log('\n  Then restart the MCP server and try:\n');
    console.log('    send_telegram_digest with dryRun: true   — composes without sending');
    console.log('    send_telegram_digest                     — actually sends\n');
  });
}).on('error', (err) => {
  die(`Could not reach Telegram: ${err.code || err.message}`);
});
