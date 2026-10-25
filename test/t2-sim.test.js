'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../t2-engine.js');
const S = require('../t2-sim.js');

test('makeWorld é determinístico (mesma semente, mesmos números)', () => {
  const a = S.makeWorld({ seed: 9 }), b = S.makeWorld({ seed: 9 }), c = S.makeWorld({ seed: 10 });
  assert.deepEqual(a.units[5].yFull, b.units[5].yFull);
  assert.notDeepEqual(a.units[5].yFull, c.units[5].yFull);
});

test('fakeSecondRound: verdade soma E por unidade e o motor converge no fim (ensaio 1T-como-2T)', () => {
  const w = S.makeWorld({ seed: 4 });
  const real = w.units.map((u) => ({ id: u.id, uf: u.uf, mun: u.mun, x: u.x, E: u.E }));   // finge que são unidades reais
  S.fakeSecondRound(real, 77);
  real.forEach((u) => assert.ok(Math.abs(u.yFull.reduce((a, b) => a + b, 0) - u.E) < 1e-6 * u.E + 1e-6));
  const finalState = S.stateAt(real, 1);
  assert.ok(finalState.every((u, i) => u.y && u.y.every((v, j) => v === real[i].yFull[j])));
  const r = E.project(finalState, { rows: S.ROWS, M: w.priorM }, { lambda0: 2e6 * w.totalE / 158.7e6 });
  const trL = E.validShares(S.truth(real)).L;
  assert.ok(Math.abs(E.validShares(r.scenarios.full.total.final).L - trL) < 1e-6);
});

test('fakeSecondRound com pull (2T-1.4): verdade entre M_TRUE·x e o 2022 da zona, sem ser igual a nenhuma', () => {
  const w = S.makeWorld({ seed: 4 });
  const mk = () => w.units.map((u) => ({ id: u.id, uf: u.uf, mun: u.mun, x: u.x, E: u.E }));
  const ref = {};
  w.units.forEach((u) => { ref[u.id] = [0.6 * u.E, 0.15 * u.E, 0.02 * u.E, 0.03 * u.E, 0.2 * u.E]; });   // "2022" bem mais lulista
  const sem = S.fakeSecondRound(mk(), 77), meio = S.fakeSecondRound(mk(), 77, { pull: { ref, lambda: 0.5 } }), todo = S.fakeSecondRound(mk(), 77, { pull: { ref, lambda: 1 } });
  const L = (us) => E.validShares(S.truth(us)).L;
  assert.ok(L(sem) < L(meio) && L(meio) < L(todo), [L(sem), L(meio), L(todo)].join(' '));
  meio.forEach((u) => assert.ok(Math.abs(u.yFull.reduce((a, b) => a + b, 0) - u.E) < 1e-6 * u.E + 1e-6));
  assert.ok(Math.abs(L(todo) - 0.8) > 1e-4);                                   // efeitos locais e ruído continuam por cima
  const sem0 = S.fakeSecondRound(mk(), 77, { pull: { ref, lambda: 0 } });
  assert.deepEqual(sem0.map((u) => u.yFull), sem.map((u) => u.yFull));          // λ = 0: igual ao ensaio atual
});
