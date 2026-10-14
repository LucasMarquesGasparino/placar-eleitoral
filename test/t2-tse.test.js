'use strict';
// Testa a lógica do poller com a estrutura EA20/EA15 observada nos arquivos reais do TSE.
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../t2-engine.js');
const S = require('../t2-sim.js');
const St = require('../t2-state.js');
const Q = require('../t2-fetchq.js');
const T = require('../t2-tse.js');

const ELEICAO = 6258;
const urls = T.makeUrls({ eleicao: ELEICAO });

function mkWorld() {
  const w = S.makeWorld({ seed: 7, nUf: 4, nMunPerUf: 25 });
  const baseline = { rows: w.rows, unidades: w.units.map((u) => ({ id: u.id, uf: u.uf, mun: u.mun, zona: u.zona, x: u.x, E: u.E, secoes: 10 })) };
  return { w, baseline, prior: { rows: w.rows, M: w.priorM }, opts: { lambda0: 2e6 * w.totalE / 158.7e6 } };
}
const SECOES = 10;
function unitJson(u, f) {
  // seções entram INTEIRAS (como no TSE): votos e "st" sempre coerentes no mesmo arquivo
  const st = Math.min(SECOES, Math.floor(SECOES * f + 1e-9)), fe = st / SECOES;
  const y = u.yFull.map((v) => Math.round(v * fe));
  const L = y[0], F = y[1], B = y[2], N = y[3], A = y[4];
  return { tpabr: 'zona', s: { ts: String(SECOES), st: String(st) },
           e: { te: String(u.E), esi: String(u.E), c: String(L + F + B + N), a: String(A) }, v: { vb: String(B) },
           carg: [{ cd: '1', agr: [
             { par: [{ cand: [{ n: '22', nm: 'FLAVIO', vap: String(F) }] }] },
             { par: [{ cand: [{ n: '13', nm: 'LULA', vap: String(L) }] }] },
           ] }] };
}
// agrega uma lista de unidades (já com seus JSONs) no formato de uma abrangência maior (município/UF/BR)
function aggJson(jsons) {
  const add = (path) => jsons.reduce((t, x) => t + Number(T.get(x, path)), 0);
  const cand = (n) => jsons.reduce((t, x) => t + Number(T.candidates(x).find((c) => c.n === n).vap), 0);
  return { s: { ts: String(add(['s', 'ts'])), st: String(add(['s', 'st'])) },
           e: { te: String(add(['e', 'te'])), esi: String(add(['e', 'esi'])), c: String(add(['e', 'c'])), a: String(add(['e', 'a'])) },
           v: { vb: String(add(['v', 'vb'])) },
           carg: [{ cd: '1', agr: [
             { par: [{ cand: [{ n: '13', vap: String(cand('13')) }] }] },
             { par: [{ cand: [{ n: '22', vap: String(cand('22')) }] }] },
           ] }] };
}
// servidor falso: tauRef.v = andamento global (0..1) usando o cronograma t0/dur de cada unidade
function mockServer(w, tauRef, opts) {
  opts = opts || {};
  const log = [];
  const frac = (u) => Math.min(1, Math.max(0, (tauRef.v - u.t0) / u.dur));
  const fetchImpl = async (url) => {
    log.push(url);
    const reply = (status, body) => ({ status, json: async () => body });
    if (opts.brDown) return reply(404, null);
    if (url === urls.resBR) return reply(200, aggJson(w.units.map((u) => unitJson(u, frac(u)))));
    let m = url.match(/\/dados\/([a-z0-9]{2})\/\1-e006258-ab\.json$/);
    if (m) {
      if (opts.noEA15) return reply(200, {});
      const uf = m[1].toUpperCase(), byMun = {};
      w.units.filter((u) => u.uf === uf).forEach((u) => { (byMun[u.mun] = byMun[u.mun] || []).push(u); });
      return reply(200, { abr: Object.keys(byMun).map((mun) => ({ cdabr: mun,
        s: { ts: String(SECOES * byMun[mun].length), st: String(byMun[mun].reduce((s, u) => s + Number(unitJson(u, frac(u)).s.st), 0)) } })) });
    }
    m = url.match(/\/dados\/([a-z0-9]{2})\/\1(\d{5})(?:-z(\d{4}))?-c0001-e006258-u\.json$/);
    if (m) {
      if (opts.unit404) return reply(404, null);
      const uf = m[1].toUpperCase(), mun = m[2], zona = m[3];
      const list = w.units.filter((u) => u.uf === uf && u.mun === mun && (!zona || u.zona === zona));
      if (!list.length) return reply(404, null);
      const j = list.map((u) => unitJson(u, frac(u)));
      return reply(200, list.length === 1 ? j[0] : aggJson(j));
    }
    return reply(404, null);
  };
  return { fetchImpl, log };
}
function setup(opts, pollerCfg) {
  const x = mkWorld(), tau = { v: 0 }, srv = mockServer(x.w, tau, opts);
  const q = Q.createFetchQueue({ fetchImpl: srv.fetchImpl, maxRps: 100000, maxConcurrent: 8, breaker404: 1000 });
  const state = St.create({ engine: E, baseline: x.baseline, prior: x.prior, opts: x.opts });
  const units = x.baseline.unidades.map((u) => ({ id: u.id, uf: u.uf, mun: u.mun, zona: u.zona, E: u.E }));
  const poller = T.createPoller(Object.assign({ q, urls, state, units, intervalMs: 1, budget: 400 }, pollerCfg));
  return Object.assign(x, { tau, srv, q, state, poller });
}

test('makeUrls: padrões de nome de arquivo (6 dígitos na eleição, 5 no município, 4 na zona)', () => {
  assert.equal(urls.resBR, 'https://resultados.tse.jus.br/oficial/ele2026/6258/dados/br/br-c0001-e006258-u.json');
  assert.equal(urls.acUF('SP'), 'https://resultados.tse.jus.br/oficial/ele2026/6258/dados/sp/sp-e006258-ab.json');
  assert.equal(urls.resMun('SP', '71072'), 'https://resultados.tse.jus.br/oficial/ele2026/6258/dados/sp/sp71072-c0001-e006258-u.json');
  assert.equal(urls.resZona('SP', '71072', '1'), 'https://resultados.tse.jus.br/oficial/ele2026/6258/dados/sp/sp71072-z0001-c0001-e006258-u.json');
  assert.equal(urls.cfgMun, 'https://resultados.tse.jus.br/oficial/ele2026/6258/config/mun-e006258-cm.json');
  assert.equal(urls.eleC, 'https://resultados.tse.jus.br/oficial/comum/config/ele-c.json');
  assert.equal(T.makeUrls({ eleicao: 6257 }).resMun('AC', '1120'), 'https://resultados.tse.jus.br/oficial/ele2026/6257/dados/ac/ac01120-c0001-e006257-u.json');
});

test('parseResultado: deriva nulos, usa eleitorado instalado, acusa campos ausentes', () => {
  const p = T.parseResultado({ s: { ts: '10', st: '4' }, e: { te: '1000', esi: '990', c: '800', a: '190' }, v: { vb: '10' },
    carg: [{ agr: [{ par: [{ cand: [{ n: '13', vap: '500' }] }] }, { par: [{ cand: [{ n: '22', vap: '270' }] }] }] }] }, { L: '13', F: '22' });
  assert.deepEqual(p, { ok: true, y: [500, 270, 10, 20, 190], E: 990, s: 10, st: 4 });
  const bad = T.parseResultado({ e: { c: '1' } }, { L: '13', F: '22' });
  assert.equal(bad.ok, false); assert.ok(bad.missing.includes('abstencao') && bad.missing.includes('candidato 13'));
});

test('antes das 17h: nenhuma requisição', async () => {
  const s = setup({}, { startMs: Date.now() + 3600000 });
  const r = await s.poller.cycle();
  assert.equal(r.phase, 'pre'); assert.equal(s.srv.log.length, 0);
});

test('aguardando o TSE publicar (BR 404): 1 requisição por ciclo, fase "waiting"', async () => {
  const s = setup({ brDown: true });
  const r = await s.poller.cycle();
  assert.equal(r.phase, 'waiting'); assert.equal(s.srv.log.length, 1);
});

test('canário falha (URL de unidade 404): para, não inunda o TSE', async () => {
  const s = setup({ unit404: true });
  s.tau.v = 0.3;
  const r = await s.poller.cycle();
  assert.equal(r.phase, 'error');
  assert.ok(s.srv.log.filter((u) => /-u\.json$/.test(u) && !/br-c0001/.test(u)).length <= 2);
});

test('modo EA15: ao final da apuração o estado bate com a verdade (até arredondamento) e só busca o que mudou', async () => {
  const s = setup({});
  let steps = 0;
  for (let v = 0.05; v <= 1.0001; v += 0.05) { s.tau.v = v; await s.poller.cycle(); steps++; }
  await s.poller.cycle();
  const out = s.state.compute();
  const tr = S.truth(s.w);
  assert.ok(Math.abs(out.br.counted.L - tr[0]) <= s.w.units.length, 'L: ' + out.br.counted.L + ' vs ' + tr[0]);
  assert.ok(Math.abs(out.br.counted.F - tr[1]) <= s.w.units.length);
  assert.equal(s.poller.status().phase, 'final');
  const naive = steps * s.w.units.length;                                  // varrer tudo a cada ciclo
  const unitReqs = s.srv.log.filter((u) => /-u\.json$/.test(u) && !/br-c0001/.test(u)).length;
  assert.ok(unitReqs < naive * 0.6, 'deveria buscar bem menos que a varredura total: ' + unitReqs + ' vs ' + naive);
  assert.ok(Object.values(s.poller.status().abState).every((v) => v === 'ea15'));
});

test('EA15 ilegível => varredura prioritária ainda converge', async () => {
  const s = setup({ noEA15: true }, { budget: 120 });
  for (let v = 0.1; v <= 1.0001; v += 0.1) { s.tau.v = v; await s.poller.cycle(); }
  for (let i = 0; i < 8; i++) await s.poller.cycle();
  const out = s.state.compute(), tr = S.truth(s.w);
  assert.ok(Math.abs(out.br.counted.L - tr[0]) <= s.w.units.length);
  assert.ok(Object.values(s.poller.status().abState).every((v) => v === 'varredura'));
});

test('projeção durante a apuração fica perto da verdade (mundo sintético, via poller)', async () => {
  const s = setup({});
  const trL = E.validShares(S.truth(s.w)).L;
  s.tau.v = 0.5; for (let i = 0; i < 3; i++) await s.poller.cycle();
  const L = s.state.compute().br.finalShare.L;
  assert.ok(Math.abs(L - trL) < 0.01, 'erro de ' + ((L - trL) * 100).toFixed(2) + ' p.p.');
});

test('404 passageiro: a unidade volta a ser buscada depois de 5 min e entra no estado', async () => {
  const x = mkWorld(), tau = { v: 1 }, srv = mockServer(x.w, tau, {});
  const count = {}; x.baseline.unidades.forEach((u) => { const k = u.uf + '|' + u.mun; count[k] = (count[k] || 0) + 1; });
  const singles = x.baseline.unidades.filter((u) => count[u.uf + '|' + u.mun] === 1).sort((a, b) => a.E - b.E);
  const target = singles[0];                                            // a MENOR de município de 1 zona (não é a do canário)
  const targetUrl = urls.resMun(target.uf, target.mun);
  let flaky = true; const clock = { t: Date.now() };
  const fetchImpl = async (url) => (flaky && url === targetUrl ? { status: 404, json: async () => null } : srv.fetchImpl(url));
  const q = Q.createFetchQueue({ fetchImpl, maxRps: 100000, maxConcurrent: 8, breaker404: 1000, negTtlMs: 1000, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } });
  const state = St.create({ engine: E, baseline: x.baseline, prior: x.prior, opts: x.opts });
  const units = x.baseline.unidades.map((u) => ({ id: u.id, uf: u.uf, mun: u.mun, zona: u.zona, E: u.E }));
  const poller = T.createPoller({ q, urls, state, units, intervalMs: 1, budget: 600, now: () => clock.t });
  await poller.cycle();
  assert.equal(state.exportState().updates[target.id], undefined, 'não deve ter dados ainda');
  flaky = false; clock.t += 6 * 60 * 1000;
  await poller.cycle(); await poller.cycle();
  assert.ok(state.exportState().updates[target.id], 'deve ter sido buscada de novo');
});
