'use strict';

// Manually run, never part of `npm test`: it needs a real key and spends live
// requests. `node smoke.js <fixtureId>`
//
// Its job is to report which corner markets a bookmaker actually quotes, so the
// market-name patterns in aggregate/cornerOdds.js are read off a real response
// rather than guessed.
require('./env').load(); // same .env the server reads, so the probe needs no shell setup

const provider = require('./provider/apiFootball');
const cache = require('./cache');

async function main() {
  const fixtureId = Number(process.argv[2]);
  if (!Number.isFinite(fixtureId)) {
    console.error('usage: node smoke.js <fixtureId>');
    process.exit(1);
  }
  if (!process.env.API_FOOTBALL_KEY) {
    console.error('API_FOOTBALL_KEY is not set');
    process.exit(1);
  }

  const odds = await provider.fetch(provider.ENDPOINTS.ODDS, { fixture: fixtureId }, cache.TTL.ODDS);
  if (!odds.length) {
    console.log('no odds returned for this fixture');
    return;
  }

  // Print every market name each bookmaker quotes, so the corner market's real
  // name can be read off rather than guessed.
  for (const entry of odds) {
    for (const book of entry.bookmakers || []) {
      const names = (book.bets || []).map((b) => b.name);
      console.log(`${book.name}: ${names.join(' | ')}`);
      for (const bet of book.bets || []) {
        if (/corner/i.test(bet.name)) {
          console.log(`  >> ${bet.name}:`,
            (bet.values || []).map((v) => `${v.value}@${v.odd}`).join(', '));
        }
      }
    }
  }
}

main().catch((err) => {
  // Never log a raw error object: an AxiosError serializes err.config.headers,
  // which carries x-apisports-key.
  console.error('probe failed:', err && err.message ? err.message : String(err));
  process.exit(1);
});
