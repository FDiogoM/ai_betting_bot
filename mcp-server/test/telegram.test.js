'use strict';

const test = require('node:test');
const assert = require('node:assert');
const nock = require('nock');

const telegram = require('../notify/telegram');
const { buildDigest } = require('../notify/digest');

const TOKEN = '1234567890:AAsecretsecretsecretsecretsecretsecr';
const BASE = 'https://api.telegram.org';

test.beforeEach(() => {
  nock.cleanAll();
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  process.env.TELEGRAM_CHAT_ID = '99887766';
});

test.afterEach(() => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
});

// --- the credential ----------------------------------------------------------

// A bot token is a bearer credential and it lives in the URL PATH, so any error
// that stringifies an axios config carries it. Every failure path is checked
// because it only takes one to publish the token into a log.
test('no failure path repeats the bot token', async () => {
  const failures = [
    () => nock(BASE).post(/.*/).reply(401, { ok: false, description: 'Unauthorized' }),
    () => nock(BASE).post(/.*/).reply(400, { ok: false, description: 'chat not found' }),
    () => nock(BASE).post(/.*/).reply(500, {}),
    () => nock(BASE).post(/.*/).replyWithError({ code: 'ECONNREFUSED' }),
    () => nock(BASE).post(/.*/).reply(200, { ok: false, description: 'Bad Request' })
  ];

  for (const arrange of failures) {
    nock.cleanAll();
    arrange();
    let message = '';
    try {
      await telegram.sendMessage('hello');
      assert.fail('this arrangement should not have succeeded');
    } catch (err) {
      message = `${err.message}\n${err.stack || ''}`;
    }
    assert.ok(!message.includes(TOKEN), `the token leaked into: ${message}`);
    assert.ok(!message.includes('AAsecret'), `part of the token leaked into: ${message}`);
  }
});

test('a missing credential names what to set rather than failing obscurely', async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;

  await assert.rejects(() => telegram.sendMessage('hello'), /TELEGRAM_BOT_TOKEN/);
  assert.strictEqual(telegram.isConfigured(), false);
});

// --- delivery ----------------------------------------------------------------

test('a message is posted as HTML to the configured chat', async () => {
  let body = null;
  nock(BASE).post(`/bot${TOKEN}/sendMessage`, (b) => { body = b; return true; })
    .reply(200, { ok: true, result: { message_id: 4321 } });

  const result = await telegram.sendMessage('<b>picks</b>');

  assert.strictEqual(result.messageId, 4321);
  assert.strictEqual(body.chat_id, '99887766');
  assert.strictEqual(body.parse_mode, 'HTML');
  assert.strictEqual(body.disable_web_page_preview, true);
});

// Telegram answers 200 with ok:false for application-level problems, so a 200
// is not success.
test('a 200 carrying ok:false is a failure, not a delivery', async () => {
  nock(BASE).post(/.*/).reply(200, { ok: false, error_code: 400, description: 'chat not found' });

  await assert.rejects(() => telegram.sendMessage('hello'), /chat not found/);
});

test('an empty message is refused before a request is made', async () => {
  // No interceptor: nock fails any request, so this passing IS the proof.
  await assert.rejects(() => telegram.sendMessage('   '), /empty message/);
});

// --- the digest --------------------------------------------------------------

function pick(overrides = {}) {
  return {
    fixture: { home: 'Everton', away: 'Crystal Palace', kickoff: '2026-08-22T14:00:00+00:00' },
    market: { family: 'goals', selection: 'over', line: 3.5 },
    marketView: { consensusProbability: 0.293, bestPrice: 3.4, bookmaker: 'Bet365', overround: 0.06 },
    agent: { probability: 0.35, stake: 0.58 },
    edge: 0.0559,
    ...overrides
  };
}

const SUMMARY = {
  n: 26, pending: 0, verdict: 'insufficient',
  agent: { brier: 0.1957 }, baseline: { brier: 0.2196 },
  marketConsensus: { brier: 0.1975 }, pnl: { units: -3.92 }
};

test('a team name with markup characters cannot break the message', () => {
  const text = buildDigest({
    date: '2026-08-21',
    predictions: [pick({
      fixture: { home: 'A & B <FC>', away: 'C', kickoff: '2026-08-22T14:00:00+00:00' }
    })]
  });

  assert.ok(text.includes('A &amp; B &lt;FC&gt;'), 'the name must be escaped');
  assert.ok(!/<FC>/.test(text), 'no raw angle bracket may survive');
});

test('a stale server leads the digest, before any number it produced', () => {
  const text = buildDigest({
    date: '2026-08-21',
    predictions: [pick()],
    server: { stale: true }
  });

  const warning = text.indexOf('DESATUALIZADO');
  assert.ok(warning > -1, 'the warning must be present');
  assert.ok(warning < text.indexOf('Everton'), 'and must come before the picks');
});

test('picks all pointing one way are called out as one bet', () => {
  const text = buildDigest({
    date: '2026-08-21',
    predictions: [pick(), pick(), pick()]
  });

  assert.match(text, /as 3 seleções são todas/);
  assert.match(text, /1\.74u numa só direção/);
});

test('a mixed day carries no concentration warning', () => {
  const text = buildDigest({
    date: '2026-08-21',
    predictions: [pick(), pick({ market: { family: 'goals', selection: 'under', line: 2.5 } })]
  });

  assert.ok(!/numa só direção/.test(text));
});

test('a day with no picks says so rather than sending an empty page', () => {
  const text = buildDigest({ date: '2026-08-21', predictions: [], summary: SUMMARY });

  assert.match(text, /Nenhuma seleção hoje/);
  assert.match(text, /informação, não uma avaria/);
});

test('the baseline beating the agent is never buried', () => {
  const text = buildDigest({
    date: '2026-08-21',
    predictions: [pick()],
    summary: { ...SUMMARY, verdict: 'baseline-better' }
  });

  assert.match(text, /a baseline está a pontuar melhor/);
});

test('the digest stays inside the message limit', () => {
  const many = Array.from({ length: 60 }, () => pick());

  const text = buildDigest({ date: '2026-08-21', predictions: many, summary: SUMMARY });

  assert.ok(text.length <= 4096, `got ${text.length} characters`);
  assert.match(text, /truncado/);
});
