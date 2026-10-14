'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../t2-engine.js');
const S = require('../t2-sim.js');
const St = require('../t2-state.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' esperado ' + b + ' obtido ' + a);
function mkState(seed) {
  const w = S.makeWorld({ seed: seed || 7 });
  const baseline = { rows: w.rows, ufs: { U0: 'UF zero' }, unidades: w.units.map((u) => ({ id: u.id, uf: u.uf, mun: u.mun, zona: u.zona, x: u.x, E: u.E, secoes: 10 })) };
  const prior = { rows: w.rows, M: w.priorM };
  const opts = { lambda0: 2e6 * w.totalE / 158.7e6 };
  return { w, st: St.create({ engine: E, baseline, prior, opts }), opts, prior };
}

test('state.compute == engine.project direto (mesmos números)', () => {
  const { w, st, opts, prior } = mkState(7);
  const snap = S.stateAt(w, 0.4);
  snap.forEach((u) => { if (u.y) st.update(u.id, { y: u.y, E: u.E, s: 10, st: 5 }); });
  const out = st.compute();
  const direct = E.project(snap, prior, opts);
  out.br.final.L; // existe
  near(out.br.final.L, direct.scenarios.full.total.final[0], 1e-6, 'L final');
  near(out.br.final.F, direct.scenarios.full.total.final[1], 1e-6, 'F final');
  assert.equal(Object.keys(out.ufs).length, 8);
  assert.equal(out.progress.unitsTotal, w.units.length);
  assert.ok(out.migration.rows.length === 10 && out.migration.rows.every((r) => Math.abs(r.to.reduce((a, b) => a + b, 0) - 1) < 1e-9));
  assert.ok(out.band.lo <= out.br.finalShare.L && out.br.finalShare.L <= out.band.hi);
});

test('antes da apuração: sem apurado, forNeed nulo, progresso 0, projeção == prior', () => {
  const { st } = mkState(7);
  const out = st.compute();
  assert.equal(out.forNeed, null);
  assert.equal(out.progress.electorateCountedPct, 0);
  near(out.scenarios.full.finalShare.L, out.scenarios.priorOnly.finalShare.L, 1e-12);
});

test('forNeed: fórmula do "para virar"', () => {
  const { w, st } = mkState(7);
  S.stateAt(w, 0.5).forEach((u) => { if (u.y) st.update(u.id, { y: u.y }); });
  const out = st.compute(), f = out.forNeed;
  assert.ok(f && f.remainingValid > 0);
  const lead = Math.abs(out.br.counted.L - out.br.counted.F);
  near(f.trailerNeedShare, (lead + f.remainingValid) / (2 * f.remainingValid), 1e-12);
  assert.equal(f.leader === 'L', out.br.counted.L > out.br.counted.F);
});

test('export/import de estado reproduz o mesmo resultado; update inválido é descartado', () => {
  const a = mkState(7), b = mkState(7);
  S.stateAt(a.w, 0.3).forEach((u) => { if (u.y) a.st.update(u.id, { y: u.y }); });
  const dump = JSON.parse(JSON.stringify(a.st.exportState()));
  assert.ok(b.st.importState(dump) > 0);
  near(a.st.compute().br.final.L, b.st.compute().br.final.L, 1e-9);
  assert.equal(a.st.update('U0|10000|0001', { y: [1, 2, NaN, 0, 0] }), false);
  assert.equal(a.st.update('lixo', { y: [1, 2, 3, 4, 5] }), false);
  assert.ok(a.st.compute().diagnostics.invalidUpdates >= 2);
});

test('unidade desconhecida entra com base nacional e é reportada; regressão de totais é contada', () => {
  const { st } = mkState(7);
  assert.equal(st.update('ZZ|99999|0001', { y: [10, 20, 1, 1, 8], E: 100 }), true);
  st.update('ZZ|99999|0001', { y: [5, 5, 1, 1, 8] });
  const d = st.compute().diagnostics;
  assert.deepEqual(d.unknownUnits, ['ZZ|99999|0001']);
  assert.equal(d.regressions, 1);
});

test('municipios(): maiores primeiro e soma bate com a UF', () => {
  const { w, st } = mkState(7);
  S.stateAt(w, 0.6).forEach((u) => { if (u.y) st.update(u.id, { y: u.y }); });
  const out = st.compute();
  const ms = st.municipios('U0', 1000);
  for (let i = 1; i < ms.length; i++) assert.ok(ms[i - 1].E >= ms[i].E);
  near(ms.reduce((s, m) => s + m.final.L, 0), out.ufs.U0.final.L, 1e-6, 'soma municípios == UF');
});

test('fallback de 2022: unidade desconhecida usa o 2T de 2022 da própria unidade (e não a composição nacional)', () => {
  const w = S.makeWorld({ seed: 7 });
  const baseline = { rows: w.rows, unidades: w.units.map((u) => ({ id: u.id, uf: u.uf, mun: u.mun, zona: u.zona, x: u.x, E: u.E })) };
  const prior = { rows: w.rows, M: w.priorM }, opts = { lambda0: 2e6 * w.totalE / 158.7e6 };
  const id = 'U0|99999|0001', y22 = [700, 150, 20, 30, 100];     // 2022: Lula forte nesta unidade
  const comFb = St.create({ engine: E, baseline, prior, opts, fallback22: { [id]: y22 } });
  const semFb = St.create({ engine: E, baseline, prior, opts });
  [comFb, semFb].forEach((st) => st.update(id, { E: 2000 }));
  const a = comFb.compute(), b = semFb.compute();
  assert.deepEqual(a.diagnostics.fallback22Used, [id]);
  assert.deepEqual(b.diagnostics.fallback22Used, []);
  const ma = comFb.municipios('U0', 9999).find((m) => m.mun === '99999');
  const mb = semFb.municipios('U0', 9999).find((m) => m.mun === '99999');
  near(ma.E, 2000, 1e-9); near(ma.final.L + ma.final.F + ma.final.B + ma.final.N + ma.final.A, 2000, 1e-6);
  assert.ok(ma.finalShare.L > mb.finalShare.L + 0.1, 'com fallback 2022 o Lula projetado deve ser bem maior: ' + ma.finalShare.L + ' vs ' + mb.finalShare.L);
});
