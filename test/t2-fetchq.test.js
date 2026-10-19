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

test('timeout: requisição pendurada resolve error:timeout e libera o worker (relógio real)', async () => {
  const fetchImpl = async (url) => {
    if (url === 'lenta') return new Promise(() => {});
    return { status: 200, json: async () => ({ ok: url }) };
  };
  const q = Q.createFetchQueue({ fetchImpl, timeoutMs: 50, maxRps: 1000, maxConcurrent: 1 });
  const t0 = Date.now();
  const r = await q.get('lenta');
  assert.equal(r.status, 0); assert.equal(r.error, 'timeout');
  assert.ok(Date.now() - t0 < 1000, 'demorou demais: ' + (Date.now() - t0) + ' ms');
  const r2 = await q.get('rapida');
  assert.equal(r2.status, 200); assert.deepEqual(r2.json, { ok: 'rapida' });
  assert.equal(q.stats().timeouts, 1);
});

test('timeout na leitura do corpo: res.json que nunca resolve -> error:timeout', async () => {
  const fetchImpl = async () => ({ status: 200, json: () => new Promise(() => {}) });
  const q = Q.createFetchQueue({ fetchImpl, timeoutMs: 50, maxRps: 1000 });
  const r = await q.get('x');
  assert.equal(r.error, 'timeout');
  assert.equal(q.stats().timeouts, 1);
});

test('AbortController: o signal passado ao fetch é abortado no timeout', async () => {
  let sig = null;
  const fetchImpl = async (url, opts) => { sig = opts.signal; return new Promise(() => {}); };
  const q = Q.createFetchQueue({ fetchImpl, timeoutMs: 30, maxRps: 1000 });
  const r = await q.get('x');
  assert.equal(r.error, 'timeout');
  assert.ok(sig, 'signal ausente');
  assert.equal(sig.aborted, true);
});

test('deadline: requisição vencida não vai à rede e resolve error:expired', async () => {
  const { q, calls, c } = mk(() => ({ status: 200, body: {} }), { maxRps: 1000 });
  const r = await q.get('a', { deadline: c.now() - 1 });
  assert.equal(r.status, 0); assert.equal(r.error, 'expired');
  assert.equal(calls.length, 0);
  assert.equal(q.stats().expired, 1);
});

test('overflow: fila cheia resolve na hora com error:overflow (1 em voo + 2 na fila)', async () => {
  const fetchImpl = async () => new Promise(() => {});
  const q = Q.createFetchQueue({ fetchImpl, maxQueue: 2, maxConcurrent: 1, timeoutMs: 30, maxRps: 1000 });
  const p1 = q.get('a'); const p2 = q.get('b'); const p3 = q.get('c');
  const r4 = await q.get('d');
  assert.equal(r4.status, 0); assert.equal(r4.error, 'overflow');
  assert.equal(q.stats().overflow, 1);
  await Promise.all([p1, p2, p3]);
});

test('200 com JSON inválido -> {status:200, error:json}', async () => {
  const fetchImpl = async () => ({ status: 200, json: async () => { throw new SyntaxError('json'); } });
  const q = Q.createFetchQueue({ fetchImpl, maxRps: 1000 });
  const r = await q.get('x');
  assert.equal(r.status, 200); assert.equal(r.error, 'json');
});
