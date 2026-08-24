'use strict';

const XLSX = require('xlsx');

// The spreadsheet is an EXPORT, never the store. The engine reads and replays
// from the ledger thousands of times for a bootstrap, which wants local files
// and determinism; a workbook is where a person looks at the answer. It is also
// editable by accident, which is fine for exploration and would be fatal for a
// record — the reason the real ledger is append-only JSONL under git.
//
// Written whole on every export, so the file is always a complete snapshot of
// one run rather than an accumulation nobody can date.

function sheetFrom(rows, header) {
  const sheet = XLSX.utils.json_to_sheet(rows, { header });
  // Column widths from the widest cell, so nothing arrives as ####.
  sheet['!cols'] = header.map((key) => ({
    wch: Math.min(46, Math.max(
      key.length + 2,
      ...rows.map((r) => String(r[key] === null || r[key] === undefined ? '' : r[key]).length + 2)
    ))
  }));
  return sheet;
}

function strategyRows(comparison) {
  return comparison.results.map((r) => ({
    'Estratégia': r.strategy,
    'Apostas': r.bets,
    'Ganhas': r.wins,
    'Anuladas': r.voids,
    'Taxa de acerto': r.hitRate,
    'Apostado (u)': r.staked,
    'Lucro (u)': r.profitUnits,
    'ROI': r.roi,
    'Banca final': r.finalBankroll,
    'Queda máxima (u)': r.maxDrawdown,
    'Nota': r.note
  }));
}

function bootstrapRows(bootstrap) {
  return bootstrap.results.map((r) => ({
    'Estratégia': r.strategy,
    'Apostas': r.n,
    'Lucro observado (u)': r.observedProfit === undefined ? null : r.observedProfit,
    'Média simulada': r.mean === undefined ? null : r.mean,
    'P5': r.p05 === undefined ? null : r.p05,
    'Mediana': r.median === undefined ? null : r.median,
    'P95': r.p95 === undefined ? null : r.p95,
    'P(perder)': r.probabilityOfLoss === undefined ? null : r.probabilityOfLoss,
    'Zero dentro do intervalo': r.straddlesZero === undefined ? null : (r.straddlesZero ? 'SIM' : 'não'),
    'Leitura': r.note
  }));
}

function curveRows(comparison) {
  const rows = [];
  for (const r of comparison.results) {
    for (const point of r.curve) {
      rows.push({
        'Estratégia': r.strategy,
        'Registado em': point.at,
        'Id': point.id,
        'Família': point.family,
        'Stake (u)': point.stake,
        'Preço': point.price,
        'Resultado': point.outcome,
        'Retorno (u)': point.result,
        'Banca': point.bankroll
      });
    }
  }
  return rows;
}

// The plain-language front page. A workbook of numbers with no statement of
// what they do and do not establish is how a small sample gets read as a
// finding.
function readingRows(comparison, bootstrap, generatedAt) {
  const established = bootstrap.results.filter((r) => r.straddlesZero === false);
  return [
    { Campo: 'Gerado em', Valor: generatedAt },
    { Campo: 'Previsões liquidadas', Valor: comparison.settled },
    { Campo: 'Previsões pendentes', Valor: comparison.pending },
    { Campo: 'Banca inicial', Valor: comparison.startingBankroll },
    { Campo: 'Reamostragens', Valor: bootstrap.iterations },
    { Campo: 'Semente', Valor: bootstrap.seed },
    { Campo: '', Valor: '' },
    {
      Campo: 'AVISO',
      Valor: 'Estas estratégias foram escolhidas depois de se verem os resultados. Com esta '
        + 'amostra, é garantido que alguma pareça excelente por sorte. Os intervalos da folha '
        + 'Bootstrap são a razão para desconfiar, não para agir.'
    },
    {
      Campo: 'O que está estabelecido',
      Valor: established.length
        ? established.map((r) => `${r.strategy}: intervalo de 90% exclui o zero`).join(' | ')
        : 'Nada. Todos os intervalos de 90% incluem o zero, ou seja, nem o SINAL do '
          + 'resultado está determinado.'
    },
    {
      Campo: 'O que isto não pode dizer',
      Valor: 'Só repete apostas que foram registadas. Uma regra que teria apostado em '
        + 'seleções que nunca foram escritas não é testável aqui.'
    }
  ];
}

/**
 * Writes the whole run to one workbook.
 *
 * Returns what was written rather than nothing, so a caller can report the
 * shape of the file without opening it.
 */
function writeWorkbook(filePath, comparison, bootstrap, options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const book = XLSX.utils.book_new();

  const reading = readingRows(comparison, bootstrap, generatedAt);
  XLSX.utils.book_append_sheet(book, sheetFrom(reading, ['Campo', 'Valor']), 'Leitura');

  const strategies = strategyRows(comparison);
  XLSX.utils.book_append_sheet(book, sheetFrom(strategies, [
    'Estratégia', 'Apostas', 'Ganhas', 'Anuladas', 'Taxa de acerto', 'Apostado (u)',
    'Lucro (u)', 'ROI', 'Banca final', 'Queda máxima (u)', 'Nota'
  ]), 'Estratégias');

  const boot = bootstrapRows(bootstrap);
  XLSX.utils.book_append_sheet(book, sheetFrom(boot, [
    'Estratégia', 'Apostas', 'Lucro observado (u)', 'Média simulada', 'P5', 'Mediana', 'P95',
    'P(perder)', 'Zero dentro do intervalo', 'Leitura'
  ]), 'Bootstrap');

  const curve = curveRows(comparison);
  XLSX.utils.book_append_sheet(book, sheetFrom(curve, [
    'Estratégia', 'Registado em', 'Id', 'Família', 'Stake (u)', 'Preço', 'Resultado',
    'Retorno (u)', 'Banca'
  ]), 'Curva');

  XLSX.writeFile(book, filePath);

  return {
    file: filePath,
    generatedAt,
    sheets: [
      { name: 'Leitura', rows: reading.length },
      { name: 'Estratégias', rows: strategies.length },
      { name: 'Bootstrap', rows: boot.length },
      { name: 'Curva', rows: curve.length }
    ]
  };
}

module.exports = { writeWorkbook, strategyRows, bootstrapRows, curveRows, readingRows };
