'use strict';

const axios = require('axios').default;

// The Telegram Bot API, and nothing else. Credentials come from the
// environment, exactly like the provider key, and are never returned, logged,
// or interpolated into an error message: a bot token is a bearer credential
// that lives in the URL path, so a raw axios error would carry it in
// `err.config.url` and put it wherever that error is printed.

const BASE_URL = 'https://api.telegram.org';
const DEFAULT_TIMEOUT_MS = 10000;

class TelegramError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TelegramError';
  }
}

function timeoutMs() {
  const raw = Number(process.env.MCP_HTTP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function config() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const missing = [];
  if (!token) missing.push('TELEGRAM_BOT_TOKEN');
  if (!chatId) missing.push('TELEGRAM_CHAT_ID');
  if (missing.length) {
    throw new TelegramError(`${missing.join(' and ')} not set. Create a bot with @BotFather, `
      + 'put the token and your chat id in .env, and restart the server. See .env.example.');
  }
  return { token, chatId };
}

// Whether delivery is even possible, without throwing. Lets a caller report
// "not configured" as a state rather than as a failure.
function isConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

// Telegram answers 200 with `ok: false` for application-level problems — a bad
// chat id, a malformed entity — so a 200 is not success.
function describe(body) {
  if (!body) return 'empty response';
  const code = body.error_code ? `${body.error_code}: ` : '';
  return `${code}${body.description || 'no description'}`;
}

/**
 * Sends one message. Returns the message id Telegram assigned, which is the
 * only thing worth keeping — it is what proves the send happened.
 */
async function sendMessage(text, options = {}) {
  const { token, chatId } = config();
  if (typeof text !== 'string' || !text.trim()) {
    throw new TelegramError('refusing to send an empty message');
  }

  let res;
  try {
    res = await axios.post(`${BASE_URL}/bot${token}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      // The digest ends in a link to the bulletin; an unfurled preview of it
      // would bury the picks under a card.
      disable_web_page_preview: true,
      disable_notification: Boolean(options.silent)
    }, { timeout: timeoutMs() });
  } catch (err) {
    // Deliberately not `err.message`: an axios error stringifies its config,
    // and the token is in the URL. Only the status is safe to repeat.
    const status = err && err.response ? err.response.status : null;
    const detail = err && err.response && err.response.data
      ? describe(err.response.data) : null;
    if (status === 401 || status === 404) {
      throw new TelegramError('Telegram rejected the bot token. Check TELEGRAM_BOT_TOKEN.');
    }
    if (status === 400) {
      throw new TelegramError(`Telegram rejected the message (${detail || 'bad request'}). `
        + 'A malformed HTML entity or an unknown chat id will both do this.');
    }
    if (status) throw new TelegramError(`Telegram request failed with HTTP ${status}.`);
    if (err && err.code === 'ECONNABORTED') {
      throw new TelegramError(`Telegram request timed out after ${timeoutMs()}ms.`);
    }
    throw new TelegramError('Telegram request failed before a response arrived.');
  }

  if (!res.data || res.data.ok !== true) {
    throw new TelegramError(`Telegram refused the message (${describe(res.data)}).`);
  }

  return { messageId: res.data.result ? res.data.result.message_id : null };
}

module.exports = { sendMessage, isConfigured, TelegramError, BASE_URL };
