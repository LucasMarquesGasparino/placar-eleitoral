#!/usr/bin/env node
/* t2-build-prior.js — Estima a matriz de migração de 2022 (1º -> 2º turno) e grava o PRIOR do 2º turno de 2026.
 * Entrada: JSON de 2022 por unidade (município-zona) no formato:
 *   { "rows": ["L","F","D","B","N","A"],
 *     "unidades": [ { "id":"SP|71072|0001","uf":"SP","mun":"71072","zona":"0001",
 *                     "x":[Lula1T, Bolsonaro1T, Demais1T, Brancos1T, Nulos1T, Abstenção1T],   // eleitores, soma = aptos
 *                     "E": aptos, "yFull":[Lula2T, Bolsonaro2T, Brancos2T, Nulos2T, Abstenção2T] } ] }
 * Uso: node scripts/t2-build-prior.js data/t2/dev/backtest-2022.json data/t2/prior-2022.json [data/t2/fallback-2022.json]
 *   3º argumento (opcional): grava também o fallback por unidade = 2º turno de 2022 [L,F,B,N,A] (inteiros), usado quando uma
 *   zona não tem base do 1º turno de 2026.
 */
'use strict';
const fs = require('fs');
const E = require('../t2-engine.js');
const [inFile, outFile, fbFile] = process.argv.slice(2);
if (!inFile || !outFile) { console.error('uso: node scripts/t2-build-prior.js <backtest-2022.json> <prior-2022.json>'); process.exit(2); }
const ROWS26 = ['L', 'F', 'CURY', 'SANTOS', 'CAIADO', 'ZEMA', 'D', 'B', 'N', 'A'];
const d = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const want = ['L', 'F', 'D', 'B', 'N', 'A'];
if (JSON.stringify(d.rows) !== JSON.stringify(want)) { console.error('rows de 2022 devem ser exatamente', want.join(',')); process.exit(2); }
const units = d.unidades.map((u) => ({ id: u.id, uf: u.uf, mun: u.mun, x: u.x, E: u.E, y: u.yFull }));
const bad = units.filter((u) => Math.abs(u.x.reduce((a, b) => a + b, 0) - u.E) > Math.max(2, 0.002 * u.E) || Math.abs(u.y.reduce((a, b) => a + b, 0) - u.E) > Math.max(2, 0.002 * u.E));
if (bad.length > units.length * 0.01) { console.error('MUITAS unidades com soma != aptos (' + bad.length + '). Reveja o build dos dados de 2022.'); process.exit(3); }
const est = E.estimateMigration(units, E.neutralPrior(want), { lambda0: 1e4, iters: 6000 });
const M26 = E.expandPrior(est.M, want, ROWS26);
const fmt = (r) => r.map((v) => v.toFixed(3)).join('  ');
console.log('Unidades usadas:', est.n, '| iterações:', est.iterations, '| peso dos dados:', est.dataWeight.toFixed(4));
console.log('destino      L      F      B      N      A');
want.forEach((r, i) => console.log(r.padEnd(8), fmt(est.M[i]), ' peso-linha', est.rowWeight[i].toFixed(3)));
const warn = [];
if (est.M[0][0] < 0.85) warn.push('Lula 2022 retém < 85% (estranho)');
if (est.M[1][1] < 0.85) warn.push('Bolsonaro 2022 retém < 85% (estranho)');
if (est.M[5][4] < 0.85) warn.push('Abstenção retém < 85% (estranho)');
if (warn.length) console.log('ATENÇÃO:', warn.join('; '));
fs.writeFileSync(outFile, JSON.stringify({
  versao: 1, rows: ROWS26, M: M26,
  origem: '2022 (1T->2T) por regressão ecológica em ' + est.n + ' unidades município-zona; linhas de candidatos nomeados de 2026 copiam a linha "Demais"',
  gerado_em: new Date().toISOString()
}, null, 1));
console.log('gravado', outFile);
if (fbFile) {
  const fb = {};
  d.unidades.forEach((u) => { fb[u.id] = u.yFull.map((v) => Math.round(v)); });
  fs.writeFileSync(fbFile, JSON.stringify({ versao: 1, origem: '2º turno de 2022 por unidade [L,F,B,N,A]', unidades: fb }));
  console.log('gravado', fbFile, '(' + Object.keys(fb).length + ' unidades)');
}
