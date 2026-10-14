'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../t2-fetchq.js');

function clock() { let t = 1000000; return { now: () => t, sleep: async (ms) => { t += ms; } }; }
function mk(handler, extra) {
  const c = clock(); const calls = [];
  const fetchImpl = async (url) => { calls.push({ url, at: c.now() }); const r = handler(url, calls.length); return { status: r.status, json: async () => r.body }; };
  const q = Q.createFetchQueue(Object.assign({ fetchImpl, now: c.now, sleep: c.sleep }, extra));
  return { q, calls, c };
}

test('200: devolve json', async () => {
  const { q } = mk(() => ({ status: 200, body: { a: 1 } }));
  const r = await q.get('u1');
  assert.equal(r.status, 200); assert.deepEqual(r.json, { a: 1 });
});

test('limite de taxa: início das requisições espaçado por 1000/maxRps (relógio real)', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(Date.now()); return { status: 200, json: async () => ({}) }; };
  const q = Q.createFetchQueue({ fetchImpl, maxRps: 40, maxConcurrent: 4 });   // 25 ms entre inícios
  await Promise.all(Array.from({ length: 16 }, (_, i) => q.get('u' + i)));
  // taxa média respeitada (tolerância a jitter de timers): 15 intervalos de 25 ms
  assert.ok(calls[calls.length - 1] - calls[0] >= 15 * 25 * 0.8, 'rápido demais: ' + (calls[calls.length - 1] - calls[0]) + ' ms');
  // nunca mais de 6 inícios dentro de qualquer janela de 100 ms (nominal: 4 a 5)
  for (let i = 0; i + 6 < calls.length; i++) assert.ok(calls[i + 6] - calls[i] > 100, 'rajada em ' + i);
});

test('404 cria cache negativo (não repete a mesma URL) e disjuntor abre após 5 404s', async () => {
  const { q, calls } = mk(() => ({ status: 404, body: null }), { maxRps: 1000 });
  const a = await q.get('x'); const b = await q.get('x');
  assert.equal(a.status, 404); assert.equal(b.cached, true); assert.equal(calls.length, 1);
  for (let i = 0; i < 5; i++) await q.get('y' + i);
  const blocked = await q.get('z');
  assert.equal(blocked.error, 'breaker');
  assert.ok(!calls.some((c) => c.url === 'z'), 'z não deve ir à rede');
});

test('403/429 pausam tudo por pauseMs; resetBlocks libera', async () => {
  let n = 0;
  const { q, calls } = mk(() => (++n === 1 ? { status: 429, body: null } : { status: 200, body: {} }), { maxRps: 1000 });
  const a = await q.get('a');
  assert.equal(a.error, 'blocked');
  const b = await q.get('b');
  assert.equal(b.error, 'paused'); assert.equal(calls.length, 1);
  q.resetBlocks();
  assert.equal((await q.get('c')).status, 200);
});

test('prioridade: maior primeiro', async () => {
  const { q, calls } = mk(() => ({ status: 200, body: {} }), { maxConcurrent: 1, maxRps: 1000 });
  const ps = [q.get('baixa', { priority: 0 }), q.get('alta', { priority: 5 }), q.get('media', { priority: 2 })];
  await Promise.all(ps);
  // a primeira já foi despachada antes das outras entrarem; as duas seguintes obedecem à prioridade
  assert.equal(calls[1].url, 'alta'); assert.equal(calls[2].url, 'media');
});

test('negTtlMs por requisição: 404 pode ser repetido depois de um TTL curto', async () => {
  const { q, calls, c } = mk(() => ({ status: 404, body: null }), { maxRps: 1000, breaker404: 100 });
  await q.get('esperando', { negTtlMs: 10000 });
  const b = await q.get('esperando', { negTtlMs: 10000 });
  assert.equal(b.cached, true);
  await c.sleep(10001);
  const d = await q.get('esperando', { negTtlMs: 10000 });
  assert.equal(d.cached, undefined);
  assert.equal(calls.length, 2);
});
