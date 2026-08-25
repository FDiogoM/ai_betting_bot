'use strict';

// Pure: no imports, no clock, no filesystem, no network. Given records it
// returns a string.
//
// The digest is composed HERE, from ledger records, rather than written by
// whoever is sending it. Same reason record_prediction stopped accepting a
// transcribed baseline: a number retyped on its way to the owner's phone is a
// number nobody can check, and the phone is where it will actually be read.
//
// Telegram's HTML parse mode is used rather than MarkdownV2, whose escaping
// rules are a minefield — a stray '.' or '-' in a team name is enough to make
// the API reject the whole message.

const LIMIT = 4096;             // Telegram's hard cap on a message body.
const TRUNCATION_NOTE = '\n\n…truncado; ver o boletim completo.';

// Only these five are special in Telegram's HTML mode, and only these five may
// be escaped: escaping more would show the entities as literal text.
function esc(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun',
  'jul', 'ago', 'set', 'out', 'nov', 'dez'];

// Portuguese, to match the bulletin the owner actually reads. The code and its
// comments are English because they are for whoever maintains this; the digest
// is not.
function shortDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function kickoff(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${shortDate(iso)} ${hh}:${mm}`;
}

function pct(n) {
  return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`;
}

function num(n, places = 3) {
  return typeof n === 'number' ? n.toFixed(places) : '—';
}

// All ten, because a phone message that says "over 2.5" without saying goals,
// corners or cards cannot be checked against a bookmaker's slip — and neither
// can "home" without saying whether it is the match result or a clean sheet.
const FAMILY_LABEL = {
  corners: 'Cantos',
  goals: 'Golos',
  cards: 'Cartões',
  matchResult: 'Resultado',
  doubleChance: 'Dupla hipótese',
  bothTeamsScore: 'Ambas marcam',
  oddEven: 'Par/ímpar',
  cleanSheetHome: 'Casa não sofre',
  cleanSheetAway: 'Fora não sofre',
  winToNil: 'Vence a zero'
};

const SIDE_LABEL = {
  over: 'mais de',
  under: 'menos de',
  home: 'casa',
  draw: 'empate',
  away: 'fora',
  homeOrDraw: 'casa ou empate',
  homeOrAway: 'casa ou fora',
  drawOrAway: 'empate ou fora',
  yes: 'sim',
  no: 'não',
  odd: 'ímpar',
  even: 'par'
};

// What a stake of N units is in actual money, or null when nobody has said what
// a unit is worth.
//
// Never guessed. A digest that invents a bankroll prints a figure the reader
// will act on, and being wrong about it is worse than saying units — so with no
// bankroll configured this returns null and the caller falls back.
function money(units, bankroll) {
  if (!bankroll || !Number.isFinite(bankroll.amount) || bankroll.amount <= 0) return null;
  if (!Number.isFinite(bankroll.stakeFraction) || bankroll.stakeFraction <= 0) return null;
  const value = units * bankroll.stakeFraction * bankroll.amount;
  // Rounded down to the cent: a bookmaker will not take a third of one, and
  // rounding up would quietly stake more than the rule said.
  return Math.floor(value * 100) / 100;
}

function amount(value, bankroll) {
  return `${value.toFixed(2)}${bankroll.currency ? ` ${bankroll.currency}` : ''}`;
}

function pickLines(p, bankroll) {
  const family = FAMILY_LABEL[p.market.family] || p.market.family;
  const side = SIDE_LABEL[p.market.selection] || p.market.selection;
  const mine = p.agent.probability;
  const market = p.marketView.consensusProbability;
  const line = p.market.line === undefined || p.market.line === null ? '' : ` ${p.market.line}`;

  const stake = money(p.agent.stake, bankroll);
  // What comes back on a win, stake included — the number a slip shows, not the
  // profit, so it can be checked against the bookmaker's own confirmation.
  const returns = stake === null ? null : Math.floor(stake * p.marketView.bestPrice * 100) / 100;

  return [
    `⚽ <b>${esc(p.fixture.home)} – ${esc(p.fixture.away)}</b>`,
    `${esc(family)} ${esc(side)}${line} · <code>${num(p.marketView.bestPrice, 2)}</code>`
      + ` ${esc(p.marketView.bookmaker)} · ${esc(kickoff(p.fixture.kickoff))}`,
    stake === null
      ? `stake <code>${num(p.agent.stake, 2)}u</code>`
      : `💶 <b>${esc(amount(stake, bankroll))}</b> @ <code>${num(p.marketView.bestPrice, 2)}</code>`
        + ` → <b>${esc(amount(returns, bankroll))}</b>`
        + `  <i>(${num(p.agent.stake, 2)}u)</i>`,
    `minha <code>${num(mine)}</code>`
      + ` · mercado <code>${market === null ? '—' : num(market)}</code>`
      + ` · edge <code>${pct(p.edge)}</code>`
  ].join('\n');
}

// Every pick pointing the same way is one large directional bet wearing several
// hats, and it is the kind of thing that is obvious in a table and invisible on
// a phone. Said out loud, or not at all.
function concentration(predictions) {
  if (predictions.length < 2) return null;
  const sides = new Set(predictions.map((p) => p.market.selection));
  if (sides.size > 1) return null;
  const side = SIDE_LABEL[predictions[0].market.selection] || '';
  const units = predictions.reduce((acc, p) => acc + p.agent.stake, 0);
  return `⚠️ as ${predictions.length} seleções são todas <b>${esc(side)}</b>`
    + ` — ${num(units, 2)}u numa só direção, mais perto de uma aposta do que de ${predictions.length}.`;
}

// One line per family saying who is ahead, then the balance. Per family because
// that is the only comparison that means anything — goals lines sit at
// probabilities corners never reach, so a pooled figure mixes two things.
//
// The comparison is against the MARKET, not the baseline. Beating a venue-split
// Poisson is easy; beating the de-vigged market is the thing that pays, and it
// is the number that should be read first every morning.
function standing(summary) {
  const rows = [];
  for (const [key, label] of [['corners', 'Cantos'], ['goals', 'Golos'], ['cards', 'Cartões']]) {
    const f = summary.byFamily && summary.byFamily[key];
    if (!f || !f.n) continue;
    const mine = f.agent.brier;
    const market = f.marketConsensus ? f.marketConsensus.brier : null;
    if (mine === null || market === null) continue;
    const ahead = mine < market;
    rows.push(`${ahead ? '✅' : '❌'} <b>${label}</b> ${ahead ? 'à frente do' : 'atrás do'} mercado`
      + ` <code>${num(mine)}</code> vs <code>${num(market)}</code> (n=${f.n})`);
  }

  if (!rows.length) {
    rows.push(`<b>Registo</b> · ${summary.n} liquidadas, ainda sem leitura por família`);
  }

  rows.push(`Banca <code>${num(summary.pnl.units, 2)}u</code>`
    + ` · veredicto <i>${esc(summary.verdict)}</i>`);

  // The finding the whole system exists to surface. It leads, always.
  if (summary.verdict === 'baseline-better') {
    rows.unshift('⚠️ <b>a baseline está a pontuar melhor que o agente</b>');
  }
  return rows.join('\n');
}

/**
 * The whole message.
 *
 * `server` is the block from get_api_status. When it reports stale, that goes
 * first and in bold: every number below it came from a process running older
 * code, and the owner needs to know that before reading any of them.
 */
function buildDigest(options) {
  const {
    date, predictions = [], summary = null, server = null, artifactUrl = null,
    bankroll = null
  } = options;

  const parts = [];
  parts.push(`<b>Boletim · ${esc(shortDate(date))}</b>`);

  if (server && server.stale) {
    parts.push('⚠️ <b>SERVIDOR DESATUALIZADO</b> — está a correr código mais antigo que o '
      + 'repositório. Reinicia o servidor MCP; até lá, desconfia de tudo o que se segue.');
  }

  // The standing before the day's picks, deliberately.
  //
  // A digest that opens with "4 seleções" makes a day with none read as a
  // malfunction, when it is a perfectly good answer and the procedure says so.
  // It also puts the least reliable thing first: what the system knows about
  // its own accuracy has months of evidence behind it, and today's four picks
  // have none. Leading with the record is leading with what is actually known.
  if (summary) parts.push(standing(summary));

  if (!predictions.length) {
    parts.push('Nenhuma seleção hoje. Um dia sem valor é informação, não uma avaria.');
  } else {
    const units = predictions.reduce((acc, p) => acc + p.agent.stake, 0);
    const total = money(units, bankroll);
    parts.push(`<b>${predictions.length} ${predictions.length === 1 ? 'seleção' : 'seleções'}`
      + (total === null ? ` · ${num(units, 2)}u em risco</b>` : ` · ${esc(amount(total, bankroll))} em risco</b>`));
    for (const p of predictions) parts.push(pickLines(p, bankroll));

    // Said once, at the point where a reader would otherwise wonder why there
    // are no euros: a bankroll nobody configured is not a bankroll of zero.
    if (total === null) {
      parts.push('<i>stakes em unidades: define `bankroll` e `currency` em config/bulletin.json '
        + 'para veres os montantes.</i>');
    }

    const warning = concentration(predictions);
    if (warning) parts.push(warning);
  }

  // The detail, after the picks. The headline went first; this is for whoever
  // wants the whole reading rather than the verdict.
  if (summary) {
    parts.push(`<b>Registo</b> · ${summary.n} liquidadas · ${summary.pending} pendentes`
      + `\nagente <code>${num(summary.agent.brier)}</code>`
      + ` · baseline <code>${num(summary.baseline.brier)}</code>`
      + ` · mercado <code>${num(summary.marketConsensus && summary.marketConsensus.brier)}</code>`);
  }

  if (artifactUrl) parts.push(`<a href="${esc(artifactUrl)}">boletim completo</a>`);

  const text = parts.join('\n\n');
  if (text.length <= LIMIT) return text;
  return text.slice(0, LIMIT - TRUNCATION_NOTE.length) + TRUNCATION_NOTE;
}

module.exports = { buildDigest, esc, LIMIT, FAMILY_LABEL, SIDE_LABEL };
