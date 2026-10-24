'use strict';
// t2s-plugin.js: contrato T2Plugin (init/tick/status) com fila, estado e leitura local FALSOS (sem rede).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlugin } = require('../t2s-plugin.js');

const T0 = Date.UTC(2026, 9, 25, 21, 0, 0);       // 18:00 Brasília
const secId = (n) => String(n).padStart(4, '0');

function secoesDe(uf, zonas) {      // zonas: { id: nSecoes }
  const z = {};
  Object.keys(zonas).forEach((id) => { z[id] = {}; for (let n = 1; n <= zonas[id]; n++) z[id][secId(n)] = [n, 100 - n, 1]; });
  return { v: 1, uf, rows: ['L', 'F', 'A'], zonas: z };
}
function csDe(uf, mapa) {           // mapa: { 'mmmmm|zzzz': { total, pub } }
  const mu = {};
  Object.keys(mapa).forEach((k) => {
    const [m, z] = k.split('|'); const sec = [];
    for (let n = 1; n <= mapa[k].total; n++) sec.push(n <= mapa[k].pub ? { ns: secId(n), da: '25/10/2026', ha: '18:00:' + String(n % 60).padStart(2, '0') } : { ns: secId(n) });
    (mu[m] = mu[m] || { cd: m, zon: [] }).zon.push({ cd: z, sec });
  });
  return { abr: [{ cd: uf.toLowerCase(), mu: Object.values(mu) }] };
}

function mundo(opts) {
  opts = opts || {};
  const clock = { t: T0 };
  // AC: 2 zonas (10 e 20 seções), RR: 1 zona (10)
  const units = [
    { id: 'AC|01066|0004', uf: 'AC', E: 5000 }, { id: 'AC|01007|0009', uf: 'AC', E: 9000 },
    { id: 'RR|00010|0001', uf: 'RR', E: 3000 },
  ];
  const info = { 'AC|01066|0004': { st: 4, s: 10 }, 'AC|01007|0009': { st: 10, s: 20 }, 'RR|00010|0001': { st: 5, s: 10 } };
  const updates = [];
  const state = {
    _units: Object.fromEntries(units.map((u) => [u.id, u])),
    unitInfo: (id) => (info[id] ? { st: info[id].st, s: info[id].s, hasData: true } : null),
    update: (id, upd) => { if (opts.updateThrows) throw new Error('boom'); updates.push({ id, upd }); return true; },
  };
  const files = {
    'data/t2/secoes/ac.json': secoesDe('AC', { 'AC|01066|0004': 10, 'AC|01007|0009': 20 }),
    'data/t2/secoes/rr.json': secoesDe('RR', { 'RR|00010|0001': 10 }),
    'data/t2/secoes/sp.json': secoesDe('SP', { 'SP|71072|0001': 10 }),
  };
  const csJson = {
    AC: csDe('AC', { '01066|0004': { total: 10, pub: 4 }, '01007|0009': { total: 20, pub: 10 } }),
    RR: csDe('RR', { '00010|0001': { total: 10, pub: 5 } }),
  };
  const calls = [], locais = [];
  const fetchq = {
    get: async (url, o) => {
      calls.push({ url, o });
      if (opts.fqThrows) throw new Error('fila quebrou');
      const m = /config\/([a-z]{2})\//.exec(url);
      const uf = m && m[1].toUpperCase();
      if (opts.cs404) return { status: 404 };
      return csJson[uf] ? { status: 200, json: csJson[uf] } : { status: 404 };
    },
  };
  const fetchLocal = async (url) => {
    locais.push(url);
    if (opts.localFalha) return { ok: false, status: 404 };
    return files[url] ? { ok: true, json: async () => files[url] } : { ok: false, status: 404 };
  };
  const p = createPlugin({ fetchLocal, options: Object.assign({ now: () => clock.t }, opts.options) });
  const ok = p.init({ state, fetchq, urls: opts.urls || {}, cfg: opts.cfg || {} });
  return { p, ok, clock, state, info, updates, calls, locais, csJson, files, units };
}

test('init valida o contexto; antes de haver zonas parciais não faz requisição', async () => {
  const w = mundo();
  assert.equal(w.ok, true);
  assert.match(w.p.status(), /seções:/);
  for (const k of Object.keys(w.info)) w.info[k].st = 0;                 // nada apurado ainda
  await w.p.tick();
  assert.equal(w.calls.length, 0); assert.equal(w.locais.length, 0);
  assert.match(w.p.status(), /aguardando apuração/);
  const vazio = createPlugin({});
  assert.equal(vazio.init({}), false);
  assert.match(vazio.status(), /inativo/);
  await assert.doesNotReject(vazio.tick());
});

test('tick lê UM cs (a UF de maior eleitorado parcial), prioridade baixa, e envia xc só das zonas coerentes', async () => {
  const w = mundo();
  await w.p.tick();
  assert.equal(w.calls.length, 1);
  assert.match(w.calls[0].url, /arquivo-urna\/3221\/config\/ac\/ac-p003221-cs\.json$/);
  assert.equal(w.calls[0].o.priority, 1); assert.ok(w.calls[0].o.priority < 10);      // abaixo das zonas (10..50)
  assert.deepEqual(w.locais, ['data/t2/secoes/ac.json']);
  const ids = w.updates.map((u) => u.id).sort();
  assert.deepEqual(ids, ['AC|01007|0009', 'AC|01066|0004']);
  const u1 = w.updates.find((u) => u.id === 'AC|01066|0004').upd;
  assert.deepEqual(u1.xc, [1 + 2 + 3 + 4, 400 - 10, 4]);                              // soma das seções 1..4
  assert.match(w.p.status(), /^seções: 1 UF ao vivo · 2 zonas/);
});

test('rodízio: o tick seguinte lê a outra UF; a mesma UF só volta depois do intervalo mínimo; cache de seções em memória', async () => {
  const w = mundo();
  await w.p.tick(); await w.p.tick();
  assert.match(w.calls[1].url, /\/rr\/rr-p003221-cs\.json$/);
  assert.match(w.p.status(), /2 UFs ao vivo · 3 zonas/);
  await w.p.tick();                                    // AC e RR lidas há 0 s: nada a fazer
  assert.equal(w.calls.length, 2);
  w.clock.t += 91000; await w.p.tick();                // 91 s depois: AC (maior eleitorado) de novo
  assert.equal(w.calls.length, 3); assert.match(w.calls[2].url, /\/ac\//);
  assert.deepEqual(w.locais, ['data/t2/secoes/ac.json', 'data/t2/secoes/rr.json']);   // cada UF carregada UMA vez
});

test('SP lê no máximo a cada 5 min', async () => {
  const w = mundo();
  w.state._units['SP|71072|0001'] = { id: 'SP|71072|0001', uf: 'SP', E: 900000 };
  w.info['SP|71072|0001'] = { st: 5, s: 10 };
  w.csJson.SP = csDe('SP', { '71072|0001': { total: 10, pub: 5 } });
  await w.p.tick();
  assert.match(w.calls[0].url, /\/sp\//);              // maior eleitorado parcial vai primeiro
  const n = () => w.calls.filter((c) => /\/sp\//.test(c.url)).length;
  assert.equal(n(), 1);
  for (let i = 0; i < 4; i++) { w.clock.t += 60000; await w.p.tick(); }   // 4 min depois
  assert.equal(n(), 1);
  w.clock.t += 61000; await w.p.tick();                // 5 min e 1 s
  assert.equal(n(), 2);
});

test('xc não é reenviado se não mudou; muda quando o cs muda', async () => {
  const w = mundo();
  await w.p.tick(); await w.p.tick();
  const antes = w.updates.length;
  w.clock.t += 120000; await w.p.tick(); await w.p.tick();      // relê AC e RR, mesmos dados
  assert.equal(w.updates.length, antes);
  w.csJson.RR = csDe('RR', { '00010|0001': { total: 10, pub: 6 } }); w.info['RR|00010|0001'].st = 6;
  w.clock.t += 120000; await w.p.tick(); await w.p.tick();
  assert.equal(w.updates.length, antes + 1);
  assert.equal(w.updates[w.updates.length - 1].id, 'RR|00010|0001');
});

test('revalida sem rede: zona cujo st oficial se afasta do cs perde o xc (xc:null) e volta à curva', async () => {
  const w = mundo();
  await w.p.tick();
  assert.ok(w.updates.some((u) => u.id === 'AC|01066|0004' && u.upd.xc));
  w.info['AC|01066|0004'].st = 8;                                // o oficial andou; o cs (4 publicadas) ficou para trás
  const chamadas = w.calls.length;
  await w.p.tick();                                              // (a outra UF é lida neste tick; a revalidação não precisa de rede)
  const nulos = w.updates.filter((u) => u.id === 'AC|01066|0004' && u.upd.xc === null);
  assert.equal(nulos.length, 1);
  assert.ok(w.calls.length <= chamadas + 1);
  await w.p.tick();
  assert.equal(w.updates.filter((u) => u.id === 'AC|01066|0004' && u.upd.xc === null).length, 1);   // não repete o null
});

test('cs 404: nada é enviado, status diz que está usando a curva, e não insiste antes de falhaMs', async () => {
  const w = mundo({ cs404: true });
  await w.p.tick(); await w.p.tick();
  assert.equal(w.updates.length, 0);
  assert.equal(w.calls.length, 2);                               // uma tentativa por UF
  assert.match(w.p.status(), /TSE ainda sem lista ao vivo \(usando curva\)/);
  w.clock.t += 200000; await w.p.tick(); await w.p.tick();
  assert.equal(w.calls.length, 2);                               // ainda dentro dos 5 min de espera
  w.clock.t += 120000; await w.p.tick();
  assert.equal(w.calls.length, 3);
});

test('cs sem utilidade (contagem fora do st): espera semUtilidadeMs; status "sem lista ao vivo"', async () => {
  const w = mundo();
  w.csJson.AC = csDe('AC', { '01066|0004': { total: 10, pub: 0 }, '01007|0009': { total: 20, pub: 0 } });   // cs ainda sem carimbos
  await w.p.tick();
  assert.equal(w.updates.length, 0);
  assert.match(w.p.status(), /sem lista ao vivo/);
  w.clock.t += 120000; await w.p.tick();                         // RR (outra UF)
  w.clock.t += 120000; await w.p.tick();                         // AC ainda em espera (5 min)
  assert.ok(w.calls.filter((c) => /\/ac\//.test(c.url)).length === 1);
});

test('xc enviado expira (xcValidoMs) se o cs da UF não for relido', async () => {
  const w = mundo({ options: { xcValidoMs: 600000 } });
  await w.p.tick();
  w.csJson.AC = null;                                            // cs passa a falhar (404)
  w.clock.t += 700000;
  await w.p.tick();
  const nulos = w.updates.filter((u) => u.upd.xc === null).map((u) => u.id).sort();
  assert.deepEqual(nulos, ['AC|01007|0009', 'AC|01066|0004']);
});

test('nunca lança: fila, estado e leitura local com falha', async () => {
  for (const o of [{ fqThrows: true }, { updateThrows: true }, { localFalha: true }]) {
    const w = mundo(o);
    await assert.doesNotReject(w.p.tick());
    await assert.doesNotReject(w.p.tick());
    assert.equal(typeof w.p.status(), 'string');
  }
  // arquivo de seções corrompido
  const w = mundo(); w.files['data/t2/secoes/ac.json'] = { v: 1 };
  await w.p.tick();
  assert.equal(w.updates.length, 0);
  assert.match(w.p.info().lastError, /seções AC/);
});

test('usa urls.csUF do app quando existe, e lê a lista de unidades de cfg.units', async () => {
  const w = mundo({ urls: { csUF: (uf) => 'https://x/cs/' + uf }, cfg: { units: [{ id: 'RR|00010|0001', uf: 'RR', E: 3000 }] } });
  await w.p.tick();
  assert.equal(w.calls[0].url, 'https://x/cs/RR');
  assert.equal(w.calls.length, 1);
});

test('ticks concorrentes não duplicam leitura', async () => {
  const w = mundo();
  await Promise.all([w.p.tick(), w.p.tick(), w.p.tick()]);
  assert.equal(w.calls.length, 1);
});
