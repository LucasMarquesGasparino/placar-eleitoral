#!/usr/bin/env node
/* t2-backtest.js — Ensaio da projeção: reproduz a apuração de um 2º turno JÁ CONHECIDO e mede o erro por % apurado.
 * Dataset (mesmo formato do t2-build-prior.js, mas com as linhas do prior escolhido):
 *   { "rows":[...], "unidades":[{id,uf,mun,zona,x:[K],E,yFull:[5]}] }
 * Uso:
 *   node scripts/t2-backtest.js --synthetic                       # demonstração com dados sintéticos
 *   node scripts/t2-backtest.js data/t2/backtest-2022.json --prior none
 *   node scripts/t2-backtest.js data/t2/backtest-2022.json --prior data/t2/prior-2022-reduzido.json --order random
 *   node scripts/t2-backtest.js <dataset> --grid                   # procura melhores lambda0/kappas
 *   node scripts/t2-backtest.js data/t2/base-2026-1t.json --fake --prior data/t2/prior-2022.json
 *        # ENSAIO "1T como 2T": verdade oculta SINTÉTICA aplicada às unidades reais de 2026 (10 linhas), prior real de 2022
 * AVISO: usar como prior a matriz estimada NO MESMO dataset é vazamento (erro inicial artificialmente baixo).
 */
'use strict';
const fs = require('fs');
const E = require('../t2-engine.js');
const S = require('../t2-sim.js');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes('--' + n);
const seed = +arg('seed', 7);

let ds, scale = 1, priorM;
if (flag('synthetic')) {
  const w = S.makeWorld({ seed });
  ds = { rows: w.rows, unidades: w.units.map((u) => ({ id: u.id, uf: u.uf, mun: u.mun, zona: u.zona, x: u.x, E: u.E, yFull: u.yFull })) };
  scale = w.totalE / 158.7e6; priorM = w.priorM;
} else {
  const f = process.argv[2];
  if (!f || f.startsWith('--')) { console.error('uso: ver cabeçalho do arquivo'); process.exit(2); }
  ds = JSON.parse(fs.readFileSync(f, 'utf8'));
  const tot = ds.unidades.reduce((s, u) => s + u.E, 0); scale = tot / 158.7e6;
  const p = arg('prior', 'none');
  if (p === 'none') priorM = E.neutralPrior(ds.rows);
  else { const pj = JSON.parse(fs.readFileSync(p, 'utf8')); if (JSON.stringify(pj.rows) !== JSON.stringify(ds.rows)) { console.error('rows do prior != rows do dataset'); process.exit(2); } priorM = pj.M; }
}
const units = ds.unidades.map((u) => Object.assign({}, u));
const rnd = S.rng(seed + 1000);
if (flag('fake')) S.fakeSecondRound(units, seed + 7);
else if (arg('order', 'schedule') !== 'random') S.assignSchedule(units, rnd);
if (arg('order', 'schedule') === 'random') units.forEach((u) => { u.t0 = rnd() * 0.7; u.dur = 0.3; });
const truth = S.truth(units), trL = E.validShares(truth).L, trMargin = truth[0] - truth[1];
const base = Object.assign({}, E.DEFAULTS, { lambda0: E.DEFAULTS.lambda0 * scale });

function run(opts, tau) {
  const st = S.stateAt(units, tau);
  const r = E.project(st, { rows: ds.rows, M: priorM }, opts);
  const cnt = st.reduce((s, u) => s + (u.y ? u.y.reduce((a, b) => a + b, 0) : 0), 0) / units.reduce((s, u) => s + u.E, 0);
  const row = { cnt };
  for (const sc of ['full', 'noLocal', 'priorOnly']) {
    const f = r.scenarios[sc].total.final;
    row[sc] = { pp: (E.validShares(f).L - trL) * 100, votes: (f[0] - f[1]) - trMargin };
  }
  return row;
}

if (flag('grid')) {
  const taus = [0.05, 0.1, 0.2, 0.3, 0.5];
  const res = [];
  for (const l of [0.5, 1, 2, 4]) for (const ku of [2e4, 5e4, 2e5]) for (const km of [1e3, 4e3, 1.6e4]) for (const kz of [5e2, 2e3, 8e3]) {
    const o = Object.assign({}, base, { lambda0: base.lambda0 * l, kappaUf: ku, kappaMun: km, kappaZona: kz });
    const mae = taus.reduce((s, t) => s + Math.abs(run(o, t).full.pp), 0) / taus.length;
    res.push({ l, ku, km, kz, mae });
  }
  res.sort((a, b) => a.mae - b.mae);
  console.log('Melhores combinações (erro médio absoluto em p.p. de % de Lula nos válidos, τ=5..50%):');
  res.slice(0, 8).forEach((r) => console.log(' lambda0 x' + r.l, 'kUf', r.ku, 'kMun', r.km, 'kZona', r.kz, '=> MAE', r.mae.toFixed(3)));
  const def = res.find((r) => r.l === 1 && r.ku === 5e4 && r.km === 4e3 && r.kz === 2e3);
  console.log('Padrão atual (x1, 5e4, 4e3, 2e3): MAE', def.mae.toFixed(3));
  process.exit(0);
}

console.log('Verdade: Lula ' + (trL * 100).toFixed(2) + '% dos válidos | margem L-F = ' + Math.round(trMargin) + ' votos | ordem: ' + arg('order', 'schedule'));
console.log('apurado%   erro p.p. (cenário principal / sem ajuste local / só prior)   erro de margem em votos (principal)');
for (const tau of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1]) {
  const r = run(base, tau);
  console.log((r.cnt * 100).toFixed(1).padStart(6) + '%   ' + [r.full.pp, r.noLocal.pp, r.priorOnly.pp].map((v) => (v >= 0 ? '+' : '') + v.toFixed(3)).join(' / ').padEnd(34) + '   ' + Math.round(r.full.votes));
}
