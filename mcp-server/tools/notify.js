'use strict';

const { z } = require('zod');
const store = require('../ledger/store');
const scoring = require('../ledger/scoring');
const version = require('../version');
const markets = require('../markets');
const telegram = require('../notify/telegram');
const { buildDigest } = require('../notify/digest');
const { run } = require('../result');

// A day, in the ledger's own terms. Predictions carry an ISO recordedAt, so the
// date prefix is the whole comparison.
function recordedOn(record, day) {
  return typeof record.recordedAt === 'string' && record.recordedAt.slice(0, 10) === day;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function register(server) {
  server.registerTool(
    'send_telegram_digest',
    {
      title: 'Send the day\'s picks to Telegram',
      description: 'Composes a short digest of the predictions RECORDED TODAY and sends it to '
        + 'the configured Telegram chat. The numbers come from the ledger, not from you: a '
        + 'figure retyped on its way to a phone is one nobody can check, and the phone is where '
        + 'it actually gets read. Leads with a staleness warning when this server is running old '
        + 'code, warns when every pick points the same way, and carries the record beside the '
        + 'picks. Use dryRun to see the exact message without sending it — that is also what the '
        + 'bulletin\'s own dry run should call.',
      inputSchema: {
        artifactUrl: z.string().optional()
          .describe('Link to the published bulletin, appended as "boletim completo".'),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
          .describe('Which day\'s recorded predictions to send. Defaults to today (UTC).'),
        dryRun: z.boolean().optional()
          .describe('Compose and return the message without sending it.'),
        silent: z.boolean().optional()
          .describe('Deliver without a notification sound.')
      }
    },
    async ({ artifactUrl, date, dryRun, silent }) =>
      run('send_telegram_digest', async () => {
        const day = date || today();
        const records = store.readAll();
        const predictions = records.filter((r) => r.type === 'prediction' && recordedOn(r, day));

        const allPredictions = records.filter((r) => r.type === 'prediction');
        const settlements = records.filter((r) => r.type === 'settlement');
        const summary = scoring.summarise(allPredictions, settlements);

        // Per family as well as overall, because that is the only comparison
        // that means anything: goals lines sit at probabilities corners never
        // reach, so a pooled Brier mixes two things and says less than either
        // half. The digest leads with these.
        summary.byFamily = {};
        for (const family of markets.FAMILY_NAMES) {
          const f = scoring.summarise(allPredictions, settlements, family);
          if (f.n) summary.byFamily[family] = f;
        }

        const text = buildDigest({
          date: day,
          predictions,
          summary,
          server: version.status(),
          artifactUrl: artifactUrl || null
        });

        // Composed before the configuration is checked, so a dry run works on a
        // machine that has no bot yet — which is every machine, until someone
        // talks to @BotFather.
        if (dryRun) {
          return { sent: false, dryRun: true, configured: telegram.isConfigured(),
            picks: predictions.length, characters: text.length, text };
        }

        const { messageId } = await telegram.sendMessage(text, { silent });
        return { sent: true, messageId, picks: predictions.length, characters: text.length };
      })
  );
}

module.exports = { register };
