'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../t2-engine.js');
const S = require('../t2-sim.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' esperado ' + b + ' obtido ' + a);
const sum = (a) => a.reduce((s, v) => s + v, 0);

// ---- cenário minúsculo (K=6: L,F,D,B,N,A) usado em vários testes ----
const ROWS6 = ['L', 'F', 'D', 'B', 'N', 'A'];
const M0_6 = [
  [0.97, 0.01, 0.005, 0.005, 0.01],
  [0.01, 0.97, 0.005, 0.005, 0.01],
  [0.30, 0.30, 0.10, 0.10, 0.20],
  [0.10, 0.10, 0.50, 0.15, 0.15],
  [0.10, 0.10, 0.15, 0.50, 0.15],
  [0.01, 0.01, 0.005, 0.005, 0.97]
];
const X = [400, 300, 100, 20, 30, 150];
function tiny() {
  return [
    { id: 'AA|m1|z1', uf: 'AA', mun: 'm1', x: X, E: 1000, y: [520, 270, 30, 20, 160] },
    { id: 'AA|m1|z2', uf: 'AA', mun: 'm1', x: X, E: 1000, y: null },
    { id: 'AA|m2|z1', uf: 'AA', mun: 'm2', x: X, E: 1000, y: null },
    { id: 'BB|m3|z1', uf: 'BB', mun: 'm3', x: X, E: 1000, y: null },
    { id: 'BB|m3|z2', uf: 'BB', mun: 'm3', x: X, E: 1000, y: null }
  ];
}
const BIG = { lambda0: 1e12 };   // prior "congelado": isola o efeito do ajuste local

test('projectSimplex: soma 1, não negativo, idempotente', () => {
  for (const v of [[0.5, 0.5, 0.5], [2, 0, 0], [0.2, 0.1, -1], [5, 4, 3, 2, 1], [0.2, 0.3, 0.5]]) {
    const p = E.projectSimplex(v);
    near(sum(p), 1, 1e-12, 'soma');
    assert.ok(p.every((z) => z >= 0));
    const q = E.projectSimplex(p);
    p.forEach((z, i) => near(z, q[i], 1e-12, 'idempotente'));
  }
  assert.deepEqual(E.projectSimplex([2, 0, 0]), [1, 0, 0]);
});

test('guardTurnout: só age fora da faixa e preserva a soma', () => {
  const R = 1000;
  const inside = [400, 300, 20, 30, 250];
  assert.deepEqual(E.guardTurnout(inside, R, 0.75, 0.08), inside);
  const out = E.guardTurnout([500, 400, 30, 40, 30], R, 0.75, 0.08);  // comparecimento previsto 97% > 83%
  near(sum(out), R, 1e-9, 'soma');
  near(1 - out[4] / R, 0.83, 1e-9, 'comparecimento limitado');
  assert.ok(out.every((z) => z >= 0));
});

test('sem apuração: todos os cenários == x·M0 (prior puro)', () => {
  const units = tiny().map((u) => Object.assign({}, u, { y: null }));
  const r = E.project(units, { rows: ROWS6, M: M0_6 });
  const expect = E.dot(X.map((v) => v / 1000), M0_6).map((v) => v * 1000);
  for (const sc of ['full', 'noLocal', 'priorOnly']) {
    r.scenarios[sc].perUnit.forEach((p) => p.final.forEach((v, j) => near(v, expect[j], 1e-6, sc)));
  }
});

test('apuração 100%: final == apurado e restante == 0', () => {
  const units = tiny().map((u) => Object.assign({}, u, { y: [500, 300, 30, 20, 150] }));
  const r = E.project(units, { rows: ROWS6, M: M0_6 });
  r.scenarios.full.perUnit.forEach((p) => {
    p.rem.forEach((v) => near(v, 0, 1e-9, 'rem'));
    p.final.forEach((v, j) => near(v, [500, 300, 30, 20, 150][j], 1e-9, 'final'));
  });
});

test('conservação e não-negatividade em qualquer ponto da apuração (mundo sintético)', () => {
  const w = S.makeWorld({ seed: 3 });
  for (const tau of [0, 0.1, 0.25, 0.5, 0.8, 1]) {
    const st = S.stateAt(w, tau);
    const r = E.project(st, { rows: w.rows, M: w.priorM }, { lambda0: 2e6 * w.totalE / 158.7e6 });
    for (const sc of ['full', 'noLocal', 'priorOnly']) {
      r.scenarios[sc].perUnit.forEach((p, i) => {
        near(sum(p.final), p.E, 1e-6 * p.E + 1e-6, 'soma==E');
        assert.ok(p.final.every((v) => v >= -1e-9), 'negativo');
        assert.ok(p.rem.every((v) => v >= -1e-9), 'rem negativo');
      });
    }
    r.M.forEach((row) => { near(sum(row), 1, 1e-9, 'linha de M soma 1'); assert.ok(row.every((v) => v >= 0)); });
  }
});

test('cascata: zona sem dado herda o município; município sem dado herda a UF; UF sem dado não é afetada', () => {
  const r = E.project(tiny(), { rows: ROWS6, M: M0_6 }, BIG);
  const full = r.scenarios.full.perUnit, nol = r.scenarios.noLocal.perUnit;
  const idx = (id) => tiny().findIndex((u) => u.id === id);
  const upM1 = full[idx('AA|m1|z2')].final[0] - nol[idx('AA|m1|z2')].final[0];   // zona irmã da apurada
  const upM2 = full[idx('AA|m2|z1')].final[0] - nol[idx('AA|m2|z1')].final[0];   // município sem dado, mesma UF
  assert.ok(upM1 > 15, 'ajuste do município deve elevar Lula: ' + upM1);
  assert.ok(upM2 > 0 && upM2 < upM1, 'ajuste da UF menor que o do município: ' + upM2 + ' vs ' + upM1);
  ['BB|m3|z1', 'BB|m3|z2'].forEach((id) => {
    full[idx(id)].final.forEach((v, j) => near(v, nol[idx(id)].final[j], 1e-9, 'BB intacta'));
  });
});

test('estimateMigration recupera M conhecida (linhas com massa) em mundo de pouco ruído', () => {
  const w = S.makeWorld({ seed: 11, nUf: 10, nMunPerUf: 60, sdUf: 0.004, sdMun: 0.003, sdZona: 0.001 });
  const st = S.stateAt(w, 1);
  const small = ['L', 'F', 'D', 'B', 'N', 'A'];
  const prior = E.expandPrior(E.neutralPrior(small), small, w.rows);
  const r = E.estimateMigration(st, prior, { lambda0: 1000 });
  ['L', 'F', 'A'].forEach((name) => {
    const i = w.rows.indexOf(name);
    r.M[i].forEach((v, j) => near(v, S.M_TRUE[i][j], 0.03, 'linha ' + name));
  });
  assert.ok(r.rowWeight[w.rows.indexOf('L')] > 0.99);
  assert.ok(r.rowWeight[w.rows.indexOf('ZEMA')] < 0.2, 'linha de candidato minúsculo deve ter peso de dados baixo');
});

test('erro da projeção cai com o avanço da apuração e zera no fim (mundo sintético)', () => {
  const w = S.makeWorld({ seed: 7 });
  const trL = E.validShares(S.truth(w)).L;
  const opts = { lambda0: 2e6 * w.totalE / 158.7e6 };
  const err = {};
  for (const tau of [0, 0.3, 0.5, 1]) {
    const r = E.project(S.stateAt(w, tau), { rows: w.rows, M: w.priorM }, opts);
    err[tau] = {
      full: Math.abs(E.validShares(r.scenarios.full.total.final).L - trL),
      prior: Math.abs(E.validShares(r.scenarios.priorOnly.total.final).L - trL)
    };
  }
  assert.ok(err[0].full > 0.005, 'prior imperfeito deve errar no início');
  assert.ok(err[0.3].full < err[0].full / 3, 'erro cai com 30% do tempo');
  assert.ok(err[0.5].full < 0.002, 'menos de 0,2 p.p. na metade');
  assert.ok(err[1].full < 1e-6, 'zero no fim');
  assert.ok(err[0.3].full < err[0.3].prior, 'aprender dos dados vence o prior puro');
});

test('faixa de cenários (band) contém o cenário principal', () => {
  const w = S.makeWorld({ seed: 5 });
  const r = E.project(S.stateAt(w, 0.2), { rows: w.rows, M: w.priorM }, { lambda0: 2e6 * w.totalE / 158.7e6 });
  const L = E.validShares(r.scenarios.full.total.final).L;
  assert.ok(r.band.lo <= L + 1e-12 && L <= r.band.hi + 1e-12);
});

test('VETOR DE OURO (cenário minúsculo, prior congelado)', () => {
  const r = E.project(tiny(), { rows: ROWS6, M: M0_6 }, BIG);
  const f = r.scenarios.full.perUnit.map((p) => p.final.map((v) => Math.round(v * 1000) / 1000));
  const GOLD = require('./golden.json');
  f.forEach((row, i) => row.forEach((v, j) => near(v, GOLD.full[i][j], 2e-3, 'ouro full[' + i + '][' + j + ']')));
  const t = r.scenarios.full.total.final.map((v) => Math.round(v * 1000) / 1000);
  t.forEach((v, j) => near(v, GOLD.totalFull[j], 2e-3, 'ouro total'));
});
