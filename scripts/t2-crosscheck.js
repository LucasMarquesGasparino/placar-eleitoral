#!/usr/bin/env node
/* t2-crosscheck.js — CONFERE o arquivo-base (vindo do CSV) contra os JSON EA20 do TSE (os mesmos que o app lê ao vivo).
 * Objetivo: garantir que as DEFINIÇÕES (brancos, nulos, abstenção, eleitorado) são as mesmas nos dois mundos.
 * Uso:
 *   node scripts/t2-crosscheck.js --base data/t2/base-2026-1t.json --eleicao 6257 --n 20 --dry     # só lista as URLs
 *   node scripts/t2-crosscheck.js --base data/t2/base-2026-1t.json --eleicao 6257 --n 20           # busca (5 req/s) e compara
 * Só vale para o 1º turno encerrado (várias candidaturas). Sai com código 3 se algum número não bater.
 * Faz poucas requisições (n), educadas (5/s). Se der 404 na primeira, PARE e investigue (veja Passo 0 do plano).
 */
'use strict';
const fs = require('fs');
const Q = require('../t2-fetchq.js'), T = require('../t2-tse.js'), S = require('../t2-sim.js');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes('--' + n);
if (!arg('base')) { console.error('uso: ver cabeçalho do arquivo'); process.exit(2); }
const b = JSON.parse(fs.readFileSync(arg('base'), 'utf8'));
const urls = T.makeUrls({ eleicao: +arg('eleicao', 6257), base: arg('base-url', T.BASE) });
const n = +arg('n', 20), rnd = S.rng(+arg('seed', 1));
const munCount = {};
b.unidades.forEach((u) => { const k = u.uf + '|' + u.mun; munCount[k] = (munCount[k] || 0) + 1; });
const shuffle = (a) => a.map((v) => [rnd(), v]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
const single = shuffle(b.unidades.filter((u) => munCount[u.uf + '|' + u.mun] === 1));
const multi = shuffle(b.unidades.filter((u) => munCount[u.uf + '|' + u.mun] > 1));
let pick = single.slice(0, Math.ceil(n / 2)).concat(multi.slice(0, Math.floor(n / 2)));
if (pick.length < n) pick = pick.concat(shuffle(single.slice(Math.ceil(n / 2)).concat(multi.slice(Math.floor(n / 2)))).slice(0, n - pick.length));
const urlOf = (u) => (munCount[u.uf + '|' + u.mun] === 1 ? urls.resMun(u.uf, u.mun) : urls.resZona(u.uf, u.mun, u.zona));
if (flag('dry')) { pick.forEach((u) => console.log(u.id, urlOf(u))); process.exit(0); }

const numOf = {}; b.rows.forEach((r) => { if (b.candidatos[r]) numOf[r] = String(b.candidatos[r].numero); });
(async () => {
  const q = Q.createFetchQueue({ maxRps: 5, maxConcurrent: 2, breaker404: 3 });
  let bad = 0, ok = 0;
  for (const u of pick) {
    const r = await q.get(urlOf(u));
    if (r.status !== 200 || !r.json) { console.log('FALHA', u.id, 'http', r.status, r.error || ''); bad++; if (r.status === 404 || r.error) { console.log('Parando: não insista com 404/bloqueio.'); break; } continue; }
    const j = r.json, M = T.MAP, g = (p) => T.toNum(T.get(j, p));
    const c = g(M.comparecimento), a = g(M.abstencao), bl = g(M.brancos), list = T.candidates(j);
    if (c === null || a === null || bl === null || !Array.isArray(list)) { console.log('FALHA', u.id, 'campos ausentes (ajuste MAP em t2-tse.js após o probe)'); bad++; continue; }
    const votes = {}; let sumC = 0;
    list.forEach((cd) => { const v = T.toNum(cd[M.candVotos]) || 0; votes[String(cd[M.candNumero])] = v; sumC += v; });
    const got = {}; let usados = 0;
    Object.keys(numOf).forEach((row) => { got[row] = votes[numOf[row]] || 0; usados += got[row]; });
    got.D = sumC - usados; got.B = bl; got.N = Math.max(0, c - sumC - bl); got.A = a;
    const E = T.eleitorado(j, M);                          // a mesma regra do app (apurado + seções não totalizadas)
    const diffs = [];
    b.rows.forEach((row, i) => { if (Math.abs(got[row] - u.x[i]) > 0) diffs.push(row + ': csv ' + u.x[i] + ' vs tse ' + got[row]); });
    if (E !== null && Math.abs(E - u.E) > 0) diffs.push('E: csv ' + u.E + ' vs tse ' + E);
    if (diffs.length) { bad++; console.log('DIVERGE', u.id, '|', diffs.join(' | ')); } else { ok++; console.log('ok', u.id); }
  }
  console.log('\nResumo: ' + ok + ' ok, ' + bad + ' com problema, de ' + pick.length + ' unidades.');
  process.exit(bad ? 3 : 0);
})();
