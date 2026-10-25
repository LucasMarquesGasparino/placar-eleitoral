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
  const L = y[0], F = y[1], B = y[2], N = y[3], A = y[4], ap = L + F + B + N + A;
  // eleitorado como no TSE durante a contagem (2T, 25/10/2026): est = esi = esa = só o das seções já totalizadas (= c + a);
  // esnt = o das seções ainda não totalizadas
  return { tpabr: 'zona', s: { ts: String(SECOES), st: String(st) },
           e: { te: String(u.E), est: String(ap), esnt: String(Math.max(0, u.E - ap)), esi: String(ap), esni: '0', esa: String(ap), esna: '0',
                c: String(L + F + B + N), a: String(A) }, v: { vb: String(B) },
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
           e: { te: String(add(['e', 'te'])), est: String(add(['e', 'est'])), esnt: String(add(['e', 'esnt'])), esi: String(add(['e', 'esi'])),
                esni: '0', esa: String(add(['e', 'esa'])), esna: '0', c: String(add(['e', 'c'])), a: String(add(['e', 'a'])) },
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
function setup(opts, pollerCfg, extra) {
  const x = mkWorld(), tau = { v: 0 }, srv = mockServer(x.w, tau, opts);
  const fi = extra && extra.wrap ? extra.wrap(srv.fetchImpl) : srv.fetchImpl;
  const q = Q.createFetchQueue({ fetchImpl: fi, maxRps: 100000, maxConcurrent: 8, breaker404: 1000 });
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

test('parseResultado: deriva nulos, eleitorado sem esnt cai no te (nunca no esi), acusa campos ausentes', () => {
  const p = T.parseResultado({ s: { ts: '10', st: '4' }, e: { te: '1000', esi: '990', c: '800', a: '190' }, v: { vb: '10' },
    carg: [{ agr: [{ par: [{ cand: [{ n: '13', vap: '500' }] }] }, { par: [{ cand: [{ n: '22', vap: '270' }] }] }] }] }, { L: '13', F: '22' });
  assert.deepEqual(p, { ok: true, y: [500, 270, 10, 20, 190], E: 1000, s: 10, st: 4 });
  const bad = T.parseResultado({ e: { c: '1' } }, { L: '13', F: '22' });
  assert.equal(bad.ok, false); assert.ok(bad.missing.includes('abstencao') && bad.missing.includes('candidato 13'));
});

// Itapebi/BA (zona 0188), arquivo real do TSE às 17:05 de 25/10/2026: 2 de 26 seções; esi = 572 é só o eleitorado das 2 seções
const ITAPEBI = { tpabr: 'zona', s: { ts: '26', st: '2', si: '2', sni: '0', sa: '2', sna: '0' },
  e: { te: '8386', est: '572', esnt: '7814', esi: '572', esni: '0', esa: '572', esna: '0', c: '410', a: '162' }, v: { vb: '1' },
  carg: [{ cd: '1', agr: [{ par: [{ cand: [{ n: '22', vap: '86' }] }] }, { par: [{ cand: [{ n: '13', vap: '320' }] }] }] }] };

test('eleitorado (2T-1.6.7): apurado + seções não totalizadas; sem esnt, te; sem os dois, null; nunca o esi', () => {
  assert.deepEqual(T.parseResultado(ITAPEBI, { L: '13', F: '22' }), { ok: true, y: [320, 86, 1, 3, 162], E: 8386, s: 26, st: 2 });
  // Brasil às 17:06: 6 eleitores em seções não instaladas ficam de fora (te − esni)
  assert.equal(T.eleitorado({ e: { te: '158745502', est: '682901', esnt: '158062601', esi: '682895', esni: '6', esa: '682895', esna: '0',
    c: '345054', a: '337841' } }), 158745496);
  assert.equal(T.eleitorado({ e: { te: '1000', esi: '40', c: '30', a: '10' } }), 1000);
  assert.equal(T.eleitorado({ e: { esi: '40', c: '30', a: '10' } }), null);
});

test('Itapebi de ponta a ponta: Vantagem × 2022 proporcional ao apurado da zona e o resto do eleitorado continua na projeção', () => {
  const x = mkWorld(), u = x.baseline.unidades[0], y22 = [4137, 1363, 49, 240, 2300];
  const state = St.create({ engine: E, baseline: x.baseline, prior: x.prior, opts: x.opts, fallback22: { [u.id]: y22 } });
  const p = T.parseResultado(ITAPEBI, { L: '13', F: '22' });
  state.update(u.id, { y: p.y, E: p.E, s: p.s, st: p.st });
  const out = state.compute();
  const esperado = (320 - 86) - (572 / 8386) * (4137 - 1363);       // ≈ +44,8 (com E = esi daria 234 − 2774 = −2540)
  assert.ok(Math.abs(out.ufs[u.uf].d22.votos - esperado) < 1e-6, String(out.ufs[u.uf].d22.votos));
  const m = state.municipios(u.uf, 9999).find((v) => v.mun === u.mun);
  assert.ok(m.R > 7000, 'o eleitorado das 24 seções que faltam continua a projetar: ' + m.R);
});

test('poller com o TSE falso realista: zona parcial fica com o eleitorado inteiro (te), não com o das seções já apuradas', async () => {
  const s = setup({});
  s.tau.v = 0.3;
  await s.poller.cycle(); await s.poller.cycle();
  const ups = s.state.exportState().updates, parciais = Object.keys(ups).filter((id) => ups[id].st > 0 && ups[id].st < ups[id].s);
  assert.ok(parciais.length > 5, 'precisa de zonas parciais: ' + parciais.length);
  const byId = new Map(s.baseline.unidades.map((u) => [u.id, u]));
  parciais.forEach((id) => assert.equal(ups[id].E, byId.get(id).E, id));
  const out = s.state.compute();
  // folga: zona completa fica com E = c + a, e o TSE falso arredonda os votos (até ~1 eleitor por zona)
  assert.ok(Math.abs(out.br.E - s.w.totalE) <= Object.keys(ups).length, out.br.E + ' vs ' + s.w.totalE);
});

test('antes das 17h: nenhuma requisição', async () => {
  const s = setup({}, { startMs: Date.now() + 3600000 });
  const r = await s.poller.cycle();
  assert.equal(r.phase, 'pre'); assert.equal(s.srv.log.length, 0);
});

test('aguardando o TSE publicar (BR 404): só o BR e o EA15 de UMA UF (sentinela) por ciclo, fase "waiting"', async () => {
  const s = setup({ brDown: true });
  const r = await s.poller.cycle();
  assert.equal(r.phase, 'waiting'); assert.equal(s.srv.log.length, 2);
  assert.ok(s.srv.log.includes(urls.resBR) && s.srv.log.some((u) => /-ab\.json$/.test(u)));
  assert.equal(s.poller.status().consecutiveFailures, 0);
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

// ---------- 2T-1.1: utilitários, falhas transitórias, backoff, estado de conexão ----------
const unitUrlOf = (w, u) => {
  const n = w.units.filter((x) => x.uf === u.uf && x.mun === u.mun).length;
  return n === 1 ? urls.resMun(u.uf, u.mun) : urls.resZona(u.uf, u.mun, u.zona);
};
const sumSt = (upd) => Object.values(upd).reduce((a, x) => a + x.st, 0);

test('toNum: separador de milhar; número simples; texto com vírgula não é número', () => {
  assert.equal(T.toNum('1.234.567'), 1234567);
  assert.equal(T.toNum('12'), 12);
  assert.equal(T.toNum('47,03'), null);
});

test('candidates: caminho alternativo cai na busca profunda; parseResultado funciona com ele', () => {
  const j = { carg: [{ cand: [{ n: '13', vap: '5' }, { n: '22', vap: '7' }] }] };
  assert.equal(T.candidates(j).length, 2);
  const j2 = { e: { te: '100', esi: '100', c: '80', a: '20' }, v: { vb: '1' }, s: { ts: '10', st: '5' },
    carg: [{ cand: [{ n: '13', vap: '50' }, { n: '22', vap: '20' }] }] };
  assert.deepEqual(T.parseResultado(j2, { L: '13', F: '22' }), { ok: true, y: [50, 20, 1, 9, 20], E: 100, s: 10, st: 5 });
});

test('parseTseTime: label com data e hora; sem campos -> label null', () => {
  assert.equal(T.parseTseTime({ dt: '25/10/2026', ht: '19:42:10' }).label, '25/10/2026 19:42:10');
  assert.equal(T.parseTseTime({}).label, null);
});

test('BR cai depois de live: o ciclo CONTINUA com EA15 e zonas, o estado avança, brFailures sobe e volta a 0 sozinho', async () => {
  const flaky = { on: false };
  const s = setup({}, {}, { wrap: (fi) => async (url, o) => { if (flaky.on && url === urls.resBR) throw new Error('rede caiu'); return fi(url, o); } });
  s.tau.v = 0.3;
  await s.poller.cycle(); await s.poller.cycle();
  assert.equal(s.poller.status().phase, 'live');
  const before = sumSt(s.state.exportState().updates);
  flaky.on = true; s.tau.v = 0.6;
  const r = await s.poller.cycle();
  assert.notEqual(r.transient, true);
  const stt = s.poller.status();
  assert.equal(stt.phase, 'live');
  assert.equal(stt.consecutiveFailures, 0, 'o backoff só conta ciclos em que nada respondeu');
  assert.equal(stt.brFailures, 1); assert.equal(stt.officialStale, true);
  assert.ok(stt.errors.some((e) => e.id === 'BR'));
  assert.ok(sumSt(s.state.exportState().updates) > before, 'as zonas devem continuar avançando sem o arquivo nacional');
  flaky.on = false;
  await s.poller.cycle();
  assert.equal(s.poller.status().brFailures, 0); assert.equal(s.poller.status().officialStale, false);
});

test('BR em 503 a noite toda: zonas continuam atualizando, projeção chega à verdade, estado "partial"', async () => {
  const s = setup({}, {}, { wrap: (fi) => async (url, o) => (url === urls.resBR ? { status: 503, json: async () => null } : fi(url, o)) });
  for (let v = 0.1; v <= 1.0001; v += 0.1) { s.tau.v = v; await s.poller.cycle(); }
  for (let i = 0; i < 3; i++) await s.poller.cycle();
  const stt = s.poller.status();
  assert.ok(stt.brFailures >= 2 && stt.officialStale && stt.official === null);
  assert.equal(stt.consecutiveFailures, 0);
  assert.equal(stt.phase, 'final', 'sem BR, a conclusão vem de todas as zonas completas');
  const out = s.state.compute(), tr = S.truth(s.w);
  assert.ok(Math.abs(out.br.counted.L - tr[0]) <= s.w.units.length);
  const live = Object.assign({}, stt, { phase: 'live', lastOkTs: Date.now() });
  assert.equal(T.connectionState(live, Date.now()).key, 'partial');
  assert.equal(T.connectionState(live, Date.now()).label, 'AO VIVO (sem arquivo nacional)');
});

test('BR 404 mas EA15 já mostra apuração: o ciclo segue (não fica em "aguardando") e o canário roda pelo EA15', async () => {
  const s = setup({}, {}, { wrap: (fi) => async (url, o) => (url === urls.resBR ? { status: 404, json: async () => null } : fi(url, o)) });
  s.tau.v = 0.4;
  await s.poller.cycle(); await s.poller.cycle();
  assert.equal(s.poller.status().phase, 'live');
  assert.ok(s.poller.status().fetched > 0);
  assert.ok(Object.keys(s.state.exportState().updates).length > 0);
});

test('BR 503 antes de qualquer dado e EA15 sem apuração: fase "waiting", falha do BR contada, sem backoff', async () => {
  const s = setup({}, {}, { wrap: (fi) => async (url, o) => (url === urls.resBR ? { status: 503, json: async () => null } : fi(url, o)) });
  const r = await s.poller.cycle();
  assert.equal(r.phase, 'waiting');
  assert.equal(s.poller.status().brFailures, 1);
  assert.equal(s.poller.status().consecutiveFailures, 0);
});

test('backoff só quando NADA responde: rede fora => consecutiveFailures sobe e o estado não é varrido', async () => {
  const down = { on: false };
  const s = setup({}, {}, { wrap: (fi) => async (url, o) => { if (down.on) throw new Error('sem rede'); return fi(url, o); } });
  s.tau.v = 0.3;
  await s.poller.cycle();
  const before = s.srv.log.length;
  down.on = true;
  const r = await s.poller.cycle();
  assert.equal(r.transient, true);
  assert.equal(s.poller.status().consecutiveFailures, 1);
  assert.equal(s.poller.status().lastFailure.kind, 'network');
  assert.ok(s.srv.log.length >= before);                      // (o log do servidor falso não registra o que falhou na rede)
  await s.poller.cycle();
  assert.equal(s.poller.status().consecutiveFailures, 2);
  assert.equal(s.poller.status().phase, 'live');
  down.on = false;
  await s.poller.cycle();
  assert.equal(s.poller.status().consecutiveFailures, 0);
});

test('BR congelado (resposta idêntica) por mais de 5 min enquanto as zonas avançam => officialFrozen; descongela quando muda', async () => {
  const clock = { t: Date.now() };
  let frozenBody = null, freeze = false;
  const s = setup({}, { now: () => clock.t }, { wrap: (fi) => async (url, o) => {
    const r = await fi(url, o);
    if (url === urls.resBR && r.status === 200) {
      const body = await r.json();
      if (!frozenBody) frozenBody = JSON.stringify(body);
      return { status: 200, json: async () => (freeze ? JSON.parse(frozenBody) : body) };
    }
    return r;
  } });
  s.tau.v = 0.2; await s.poller.cycle();
  assert.equal(s.poller.status().officialFrozen, null);
  freeze = true;
  for (let i = 0; i < 4; i++) { clock.t += 90000; s.tau.v += 0.1; await s.poller.cycle(); }
  const fz = s.poller.status().officialFrozen;
  assert.ok(fz && fz.since > 0, 'deveria sinalizar BR parado');
  assert.ok(s.poller.status().brFailures === 0);
  assert.equal(T.connectionState(Object.assign({}, s.poller.status(), { phase: 'live', lastOkTs: clock.t }), clock.t).key, 'partial');
  freeze = false; clock.t += 90000; s.tau.v += 0.05; await s.poller.cycle();
  assert.equal(s.poller.status().officialFrozen, null);
});

test('BR 200 sem candidatos depois de um BR válido: mantém a apuração oficial anterior', async () => {
  let broken = false;
  const s = setup({}, {}, { wrap: (fi) => async (url, o) => {
    if (broken && url === urls.resBR) return { status: 200, json: async () => ({ s: { ts: '10', st: '1' }, e: { te: '1', c: '1', a: '0' }, v: { vb: '0' } }) };
    return fi(url, o);
  } });
  s.tau.v = 0.5;
  await s.poller.cycle();
  const y1 = s.poller.status().official.y;
  assert.ok(y1);
  broken = true;
  await s.poller.cycle();
  assert.deepEqual(s.poller.status().official.y, y1);
  assert.ok(s.poller.status().errors.some((e) => e.id === 'BR'));
});

test('erros: 35 falhas transitórias do BR -> 30 registros, mais novo primeiro', async () => {
  const s = setup({}, {}, { wrap: (fi) => async (url, o) => { if (url === urls.resBR) throw new Error('x'); return fi(url, o); } });
  for (let i = 0; i < 35; i++) await s.poller.cycle();
  const errs = s.poller.status().errors;
  assert.equal(errs.length, 30);
  assert.ok(errs[0].at >= errs[29].at);
});

test('ocupado: rodada concorrente devolve skipped; refresh com poller parado inicia; stop encerra', async () => {
  const s = setup({}, {}, { wrap: (fi) => async (url, o) => { await new Promise((r) => setTimeout(r, 50)); return fi(url, o); } });
  const p = s.poller.cycle();
  const r2 = await s.poller.cycle();
  assert.equal(r2.skipped, true);
  assert.equal(s.poller.status().busy, true);
  await p;
  assert.equal(s.poller.status().busy, false);
  assert.equal(s.poller.refresh(), true);
  assert.equal(s.poller.status().running, true);
  s.poller.stop();
  assert.equal(s.poller.status().running, false);
});

test('justiça: com todo município "mudando" a cada ciclo, toda unidade não final é buscada (sem fome)', async () => {
  let bump = 0;
  const s = setup({}, { budget: 20 }, { wrap: (fi) => async (url, o) => {
    const r = await fi(url, o);
    if (/-ab\.json$/.test(url) && r.status === 200) {
      const body = await r.json();
      body.abr.forEach((it) => { it.s.st = String(1000 + bump); });
      return { status: 200, json: async () => body };
    }
    return r;
  } });
  s.tau.v = 0.5;
  const N = s.w.units.length;
  for (let i = 0; i < Math.ceil(N / 20) + 3; i++) { bump++; await s.poller.cycle(); }
  const requested = new Set(s.srv.log.filter((u) => /-u\.json$/.test(u) && !/br-c0001/.test(u)));
  const nonFinal = s.w.units.filter((u) => Math.min(1, Math.max(0, (0.5 - u.t0) / u.dur)) < 1);
  assert.ok(nonFinal.length > 0);
  const faltam = nonFinal.filter((u) => !requested.has(unitUrlOf(s.w, u)));
  assert.equal(faltam.length, 0, 'unidades nunca buscadas: ' + faltam.length + ' de ' + nonFinal.length);
});

test('em voo: unidade com fetch pendurado não é pedida de novo no ciclo seguinte', async () => {
  let hangUrl = null, release = null, hangCount = 0;
  // deadline de relógio real: só encerra o ciclo com a unidade pendurada; folgado para o ciclo chegar até ela com a CPU ocupada
  const s = setup({}, { deadlineMs: 300 }, { wrap: (fi) => async (url, o) => {
    if (url === hangUrl) { hangCount++; await new Promise((r) => { release = r; }); }
    return fi(url, o);
  } });
  s.tau.v = 0.5;
  const count = {};
  s.w.units.forEach((u) => { const k = u.uf + '|' + u.mun; count[k] = (count[k] || 0) + 1; });
  const target = s.w.units.filter((u) => count[u.uf + '|' + u.mun] === 1 && Math.min(1, Math.max(0, (0.5 - u.t0) / u.dur)) > 0)
    .sort((a, b) => a.E - b.E)[0];
  hangUrl = urls.resMun(target.uf, target.mun);
  await s.poller.cycle();          // o fetch da unidade alvo fica pendurado; o ciclo termina pelo deadline
  await s.poller.cycle();          // ela continua em voo: não pode ser pedida outra vez
  assert.equal(hangCount, 1);
  release();
  await new Promise((r) => setTimeout(r, 20));
  s.poller.stop();
});

test('prime: reabrir o app com estado completo não relê nenhuma unidade (só BR e EA15)', async () => {
  const a = setup({});
  a.tau.v = 1;
  for (let i = 0; i < 10; i++) await a.poller.cycle();
  const saved = JSON.parse(JSON.stringify(a.state.exportState()));
  assert.equal(Object.keys(saved.updates).length, a.w.units.length);
  const state = St.create({ engine: E, baseline: a.baseline, prior: a.prior, opts: a.opts });
  assert.ok(state.importState(saved) > 0);
  const srv = mockServer(a.w, a.tau, {});
  const q = Q.createFetchQueue({ fetchImpl: srv.fetchImpl, maxRps: 100000, maxConcurrent: 8, breaker404: 1000 });
  const units = a.baseline.unidades.map((u) => ({ id: u.id, uf: u.uf, mun: u.mun, zona: u.zona, E: u.E }));
  const poller = T.createPoller({ q, urls, state, units, intervalMs: 1, budget: 400 });
  assert.ok(poller.prime(state) > 0);
  await poller.cycle();
  const unitReqs = srv.log.filter((u) => /-u\.json$/.test(u) && !/br-c0001/.test(u));
  assert.equal(unitReqs.length, 0, 'unidades pedidas: ' + unitReqs.length);
  assert.ok(srv.log.includes(urls.resBR));
});

test('connectionState: um caso para cada chave', () => {
  const now = 1e12;
  const c = (s, online) => T.connectionState(s, now, online);
  assert.equal(c({ phase: 'pre' }).key, 'pre');
  assert.equal(c({ phase: 'live', queue: { pausedUntil: now + 1000 }, lastOkTs: now }).key, 'blocked');
  assert.equal(c({ phase: 'live', lastOkTs: now }, false).key, 'offline');
  assert.equal(c({ phase: 'live', lastOkTs: now, consecutiveFailures: 1, lastFailure: { kind: 'network', at: now } }).key, 'offline');
  assert.equal(c({ phase: 'error' }).key, 'error');
  assert.equal(c({ phase: 'waiting' }).key, 'waiting');
  assert.equal(c({ phase: 'idle', running: true }).key, 'connecting');
  assert.equal(c({ phase: 'idle' }).key, 'paused');
  assert.equal(c({ phase: 'live', intervalMs: 30000, lastOkTs: now - 600000 }).key, 'stale');
  assert.equal(c({ phase: 'final', finalIntervalMs: 300000, lastOkTs: now }).key, 'final');
  assert.equal(c({ phase: 'live', intervalMs: 30000, lastOkTs: now }).key, 'live');
});
