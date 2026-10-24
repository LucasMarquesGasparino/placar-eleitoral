'use strict';
// t2-pertenca.js: parse do índice cs e xc por zona, com fixtures pequenas no formato real observado (1T de 2026, AC).
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../t2-pertenca.js');

const carimbo = (ha) => ({ da: '25/10/2026', ha });
// zona AC|01066|0004: seções 0077..0086 (10 principais), 0090 agregada à 0077 (nsp)
function csFix(pubs, extra) {
  const sec = [];
  for (let n = 77; n <= 86; n++) {
    const ns = String(n).padStart(4, '0');
    const s = { ns };
    if (pubs.includes(ns)) Object.assign(s, carimbo('18:' + String(n % 60).padStart(2, '0') + ':00'));
    if (ns === '0077') s.nsa = ['0090'];
    sec.push(s);
  }
  sec.push({ ns: '0090', nsp: '0077' });
  return Object.assign({
    dg: '25/10/2026', hg: '18:30:00', idg: '1', f: 'o', cdp: '3221',
    abr: [{ cd: 'ac', ds: 'ACRE', mu: [
      { cd: '01066', nm: 'PORTO WALTER', zon: [{ cd: '0004', sec }] },
      { cd: '01007', nm: 'ASSIS BRASIL', zon: [{ cd: '0009', sec: [{ ns: '0001', ...carimbo('18:01:00') }, { ns: '0002', ...carimbo('18:02:00') }] }] },
    ] }],
  }, extra || {});
}
// base por seção: cada seção 0077..0086 tem x = [n, 100-n, 0]; (rows de 3 linhas basta para o teste)
function secoesFix() {
  const z1 = {};
  for (let n = 77; n <= 86; n++) z1[String(n).padStart(4, '0')] = [n, 1000 - n, 5];
  return { v: 1, uf: 'AC', rows: ['L', 'F', 'A'], zonas: {
    'AC|01066|0004': z1,
    'AC|01007|0009': { '0001': [10, 20, 1], '0002': [30, 40, 2] },
  } };
}
const info = (map) => (id) => map[id] || null;

test('parseCs: conta principais publicadas; agregadas não contam; carimbo em Brasília', () => {
  const cs = P.parseCs(csFix(['0077', '0078', '0090']));       // 0090 (agregada) não é publicada por si
  assert.equal(cs.valido, true); assert.equal(cs.uf, 'AC');
  const z = cs.zonas['AC|01066|0004'];
  assert.equal(z.total, 10); assert.deepEqual(z.publicadas, ['0077', '0078']); assert.equal(z.agregadas, 1);
  assert.equal(cs.zonas['AC|01007|0009'].total, 2); assert.equal(cs.zonas['AC|01007|0009'].publicadas.length, 2);
  assert.equal(cs.total, 12); assert.equal(cs.publicadas, 4); assert.equal(cs.agregadas, 1);
  // seção 0078 carimbada 18:18:00 Brasília = 21:18:00 UTC (é o maior carimbo da zona e do arquivo)
  assert.equal(new Date(z.ultimoCarimbo).toISOString(), '2026-10-25T21:18:00.000Z');
  assert.equal(new Date(cs.ultimoCarimbo).toISOString(), '2026-10-25T21:18:00.000Z');
});

test('parseCs: tolerante a campos extras, zero-pad dos códigos e entradas ruins', () => {
  const j = csFix([]);
  j.abr[0].mu[0].cd = '1066'; j.abr[0].mu[0].zon[0].cd = '4'; j.abr[0].extra = { x: 1 };
  j.abr[0].mu[0].zon[0].sec[0].novoCampo = 'x';
  const cs = P.parseCs(j);
  assert.ok(cs.zonas['AC|01066|0004']);
  assert.equal(cs.zonas['AC|01066|0004'].publicadas.length, 0);
  for (const ruim of [null, undefined, {}, { abr: 'x' }, { abr: [null, 3, { cd: 'ac' }] }, 'texto', []]) {
    const r = P.parseCs(ruim);
    assert.equal(r.valido, false); assert.deepEqual(r.zonas, {});
  }
});

test('parseCarimbo: formatos válidos e inválidos', () => {
  assert.equal(new Date(P.parseCarimbo('04/10/2026', '21:08:17')).toISOString(), '2026-10-05T00:08:17.000Z');
  assert.equal(P.parseCarimbo('', ''), 0); assert.equal(P.parseCarimbo('2026-10-04', '21:08'), 0);
  assert.equal(new Date(P.parseCarimbo('4/10/2026', '9:05')).toISOString(), '2026-10-04T12:05:00.000Z');
});

test('xcPorZona: zona parcial coerente recebe a soma das seções publicadas', () => {
  const cs = P.parseCs(csFix(['0077', '0078', '0079', '0080']));
  const r = P.xcPorZona(secoesFix(), cs, info({ 'AC|01066|0004': { st: 4, s: 10, hasData: true } }), { now: Date.UTC(2026, 9, 25, 21, 30) });
  assert.deepEqual(r.xc['AC|01066|0004'], [77 + 78 + 79 + 80, 4000 - 314, 20]);
  assert.equal(r.xc['AC|01007|0009'], undefined);          // zona sem unitInfo: não é parcial
  assert.equal(r.stats.parciais, 1); assert.equal(r.stats.comXc, 1); assert.equal(r.stats.cobertura, 1);
  assert.equal(r.stats.razao, 1);
  assert.equal(r.stats.defasagemMs, 10 * 60000);           // último carimbo 18:20 Brasília (0080), agora 18:30
});

test('xcPorZona: tolerância de ±10% (e mínimo de 1 seção) em torno do st oficial', () => {
  const cs = P.parseCs(csFix(['0077', '0078', '0079', '0080', '0081']));   // 5 publicadas
  const ok = (st) => P.xcPorZona(secoesFix(), cs, info({ 'AC|01066|0004': { st, s: 10 } })).xc['AC|01066|0004'] !== undefined;
  assert.equal(ok(5), true);
  assert.equal(ok(4), true);        // |5-4| = 1 <= max(1, 0,4)
  assert.equal(ok(6), true);
  assert.equal(ok(3), false);       // |5-3| = 2 > max(1, 0,3)
  assert.equal(ok(8), false);
  // 100 seções: 10% = 10
  const grande = { v: 1, rows: ['L'], zonas: { 'AC|00001|0001': {} } };
  const secs = [], j = { abr: [{ cd: 'ac', mu: [{ cd: '00001', zon: [{ cd: '0001', sec: secs }] }] }] };
  for (let n = 1; n <= 100; n++) { const ns = String(n).padStart(4, '0'); grande.zonas['AC|00001|0001'][ns] = [1]; secs.push(n <= 60 ? { ns, ...carimbo('18:00:00') } : { ns }); }
  const cg = P.parseCs(j);
  const f = (st) => P.xcPorZona(grande, cg, info({ 'AC|00001|0001': { st, s: 100 } }), {}).xc['AC|00001|0001'] !== undefined;
  assert.equal(f(66), true); assert.equal(f(55), true); assert.equal(f(54), false); assert.equal(f(67), false); assert.equal(f(53), false);
  // tolerância configurável
  assert.equal(P.xcPorZona(grande, cg, info({ 'AC|00001|0001': { st: 70, s: 100 } }), { tolPct: 0.2 }).xc['AC|00001|0001'] !== undefined, true);
});

test('xcPorZona: zonas completas ou sem apuração não recebem xc; cs atrasado exclui a zona', () => {
  const cs = P.parseCs(csFix(['0077']));                                    // cs com 1 publicada
  const r = P.xcPorZona(secoesFix(), cs, info({
    'AC|01066|0004': { st: 8, s: 10 },                                      // cs muito atrás: incoerente
    'AC|01007|0009': { st: 2, s: 2 },                                       // completa
  }));
  assert.deepEqual(r.xc, {});
  assert.equal(r.stats.contagemFora, 1); assert.equal(r.stats.parciais, 1);
  const r2 = P.xcPorZona(secoesFix(), cs, info({ 'AC|01066|0004': { st: 0, s: 10 } }));
  assert.deepEqual(r2.xc, {}); assert.equal(r2.stats.parciais, 0);
});

test('xcPorZona: emite null para zona que tinha xc e deixou de ser coerente (inclui zona que ficou completa)', () => {
  const cs = P.parseCs(csFix(['0077', '0078', '0079', '0080']));
  const anteriores = { 'AC|01066|0004': true, 'AC|01007|0009': true };
  const r = P.xcPorZona(secoesFix(), cs, info({ 'AC|01066|0004': { st: 9, s: 10 }, 'AC|01007|0009': { st: 2, s: 2 } }), { anteriores });
  assert.equal(r.xc['AC|01066|0004'], null);
  assert.equal(r.xc['AC|01007|0009'], null);
  assert.equal(r.stats.anulados, 2);
  // sem `anteriores`, nada é emitido
  assert.deepEqual(P.xcPorZona(secoesFix(), cs, info({ 'AC|01066|0004': { st: 9, s: 10 } })).xc, {});
});

test('xcPorZona: lista de seções muito diferente do 1T, cobertura baixa e zona ausente no cs', () => {
  // cs lista 14 seções na zona contra 10 no 1T
  const j = csFix(['0077', '0078', '0079', '0080']);
  for (let n = 200; n < 204; n++) j.abr[0].mu[0].zon[0].sec.push({ ns: String(n).padStart(4, '0') });
  const r = P.xcPorZona(secoesFix(), P.parseCs(j), info({ 'AC|01066|0004': { st: 4, s: 14 } }));
  assert.deepEqual(r.xc, {}); assert.equal(r.stats.listaDifere, 1);
  // 4 publicadas, só 2 existem na base (seções renumeradas): cobertura 50% < 90%
  const base = secoesFix(); delete base.zonas['AC|01066|0004']['0079']; delete base.zonas['AC|01066|0004']['0080'];
  const j2 = csFix(['0077', '0078', '0079', '0080']);
  j2.abr[0].mu[0].zon[0].sec = j2.abr[0].mu[0].zon[0].sec.filter((s) => s.ns !== '0081' && s.ns !== '0082');   // mantém total 8 (= base) para isolar a cobertura
  const r2 = P.xcPorZona(base, P.parseCs(j2), info({ 'AC|01066|0004': { st: 4, s: 8 } }));
  assert.deepEqual(r2.xc, {}); assert.equal(r2.stats.coberturaBaixa, 1);
  // zona parcial que o cs não lista
  const r3 = P.xcPorZona(secoesFix(), P.parseCs({ abr: [{ cd: 'ac', mu: [] }] }), info({ 'AC|01066|0004': { st: 4, s: 10 } }), { anteriores: { 'AC|01066|0004': true } });
  assert.equal(r3.stats.semCs, 1); assert.equal(r3.xc['AC|01066|0004'], null);
});

test('xcPorZona: aceita unitInfo como objeto com método e nunca lança com entradas ruins', () => {
  const cs = P.parseCs(csFix(['0077', '0078', '0079', '0080']));
  const estado = { unitInfo: (id) => (id === 'AC|01066|0004' ? { st: 4, s: 10 } : null) };
  assert.ok(P.xcPorZona(secoesFix(), cs, estado).xc['AC|01066|0004']);
  assert.doesNotThrow(() => P.xcPorZona(null, null, null));
  assert.doesNotThrow(() => P.xcPorZona({}, {}, () => { throw new Error('x'); }, null));
  assert.deepEqual(P.xcPorZona(null, null, null).xc, {});
});
