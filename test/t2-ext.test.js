'use strict';
// Prévia do exterior (2T-1.6): decodificador de boletim de urna, leitores do Jornal Razão e do ascaribe, junção por cidade e o
// controlador (10 s sem sobreposição, fontes isoladas, leitura dos boletins com orçamento, pausa no 429 e parada às 16:45).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const X = require('../t2-ext.js');

const FIX = path.join(__dirname, 'fixtures', 'bu');
const fx = (name) => fs.readFileSync(path.join(FIX, name));
const fxJson = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));

// ---------- índice sintético: 3 cidades na base, outras só no mapa (nomes e códigos do mapa real) ----------
const LOCATIONS = [
  { code: '29491', city: 'CAMBERRA', country: 'Austrália' },
  { code: '30562', city: 'SYDNEY', country: 'Austrália' },
  { code: '30805', city: 'WELLINGTON', country: 'Nova Zelândia' },
  { code: '29262', city: 'ABU DHABI', country: 'Emirados Árabes Unidos' },
  { code: '30350', city: 'PRAGA', country: 'República Tcheca' },
  { code: '30570', city: 'TAIPÉ', country: 'China (Taiwan)' },
  { code: '30520', city: 'SÃO SALVADOR', country: 'El Salvador' },
];
const BASELINE = {
  rows: ['r0', 'r1', 'r2'],
  unidades: [
    { id: 'ZZ|29491|0001', uf: 'ZZ', mun: '29491', zona: '0001', x: [100, 50, 10], E: 10000, secoes: 10 },
    { id: 'ZZ|30562|0001', uf: 'ZZ', mun: '30562', zona: '0001', x: [300, 200, 20], E: 20000, secoes: 19 },
    { id: 'ZZ|30805|0001', uf: 'ZZ', mun: '30805', zona: '0001', x: [60, 40, 5], E: 3119, secoes: 5 },
    { id: 'SP|71072|0001', uf: 'SP', mun: '71072', zona: '0001', x: [1, 1, 1], E: 999, secoes: 3 },
  ],
};
const ix = () => X.buildIndex({ baseline: BASELINE, locations: LOCATIONS });

function snapshot(paises, t) {
  return { t: t || '2026-10-25T04:30:44-03:00', tot: { ult: '2026-10-25T04:30:10-03:00' }, paises };
}
const AU = { iso: 'AU', nm: 'Austrália', urnas: 26, total: 29, aptos: 18405, c: 8679, f: 2978, l: 5435, vb: 102, vn: 164, ult: '2026-10-25T04:30:10-03:00',
  cid: [{ nm: 'Sydney', urnas: 19, total: 19, f: 2468, l: 4161, c: 6830 }, { nm: 'Camberra', urnas: 7, total: 10, f: 510, l: 1274, c: 1849 }] };
const NZ = { iso: 'NZ', nm: 'Nova Zelândia', urnas: 5, total: 5, aptos: 3119, c: 526, f: 101, l: 418, vb: 4, vn: 3, ult: '2026-10-25T01:51:38-03:00',
  cid: [{ nm: 'Wellington', urnas: 5, total: 5, f: 101, l: 418, c: 526 }] };

// ---------- boletim de urna ----------
test('decodeBu: boletins reais de Wellington (1088) e Camberra (0732) do arquivo-urna 3221', () => {
  const w = X.decodeBu(fx('zz-30805-0001-1088-bu.dat'), { mun: '30805', zona: '0001', secao: '1088' });
  assert.deepEqual(w, { ok: true, mun: 30805, zona: 1, secao: 1088, aptos: 697, c: 73, L: 60, F: 13, B: 0, N: 0 });
  const c = X.decodeBu(new Uint8Array(fx('zz-29491-0001-0732-bu.dat')), { mun: 29491, zona: 1, secao: 732 });
  assert.deepEqual(c, { ok: true, mun: 29491, zona: 1, secao: 732, aptos: 756, c: 123, L: 85, F: 33, B: 1, N: 4 });
  assert.equal(c.L + c.F + c.B + c.N, c.c);
  // sem expect lê a identificação do próprio boletim
  assert.equal(X.decodeBu(fx('zz-30805-0001-1088-bu.dat')).secao, 1088);
});

test('decodeBu: recusa boletim de outra seção, vazio, grande demais, truncado ou corrompido, sem lançar', () => {
  const buf = fx('zz-30805-0001-1088-bu.dat');
  assert.deepEqual(X.decodeBu(buf, { mun: '30805', zona: '0001', secao: '1089' }), { ok: false, error: 'boletim de outra seção' });
  assert.deepEqual(X.decodeBu(buf, { mun: '29491', zona: '0001', secao: '1088' }), { ok: false, error: 'boletim de outra seção' });
  assert.equal(X.decodeBu(new Uint8Array(0)).ok, false);
  assert.equal(X.decodeBu(null).ok, false);
  assert.equal(X.decodeBu(new Uint8Array(70000)).ok, false);
  const cut = X.decodeBu(buf.subarray(0, buf.length - 7), { mun: '30805', zona: '0001', secao: '1088' });
  assert.equal(cut.ok, false);
  assert.match(cut.error, /TLV|envelope|boletim/);
  // corrupção aleatória (semente fixa): nunca lança; se ainda decodificar, os votos continuam somando o comparecimento
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let k = 0; k < 400; k++) {
    const b = Uint8Array.from(buf);
    const n = 1 + Math.floor(rnd() * 3);
    for (let j = 0; j < n; j++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
    const r = X.decodeBu(rnd() < 0.3 ? b.subarray(0, Math.floor(rnd() * b.length)) : b, { mun: 30805, zona: 1, secao: 1088 });
    assert.equal(typeof r.ok, 'boolean');
    if (r.ok) { assert.equal(r.L + r.F + r.B + r.N, r.c); assert.ok(r.c <= r.aptos); }
    else assert.equal(typeof r.error, 'string');
  }
});

test('pickHash: hash recebido mais recente com bu; status e caracteres conferidos; horário de Brasília', () => {
  const w = X.pickHash(fxJson('zz-30805-0001-1088-aux.json'));
  assert.equal(w.name, 'o03221zz3080500011088-bu.dat');
  assert.equal(w.hash.length, 88);
  assert.equal(w.at, Date.UTC(2026, 9, 25, 4, 51, 38));     // 01:51:38 de Brasília
  assert.equal(X.pickHash(fxJson('zz-29491-0001-0732-aux.json')).at, Date.UTC(2026, 9, 25, 6, 36, 51));
  const h = (hash, st, arq, hr) => ({ hash, dr: '25/10/2026', hr: hr || '02:00:00', st, arq });
  const good = 'ab'.repeat(44), other = 'cd'.repeat(44);
  const aux = { hashes: [h(good, 'Recebido', [{ nm: 'x-bu.dat', tp: 'bu' }]), h(other, 'Excluído', [{ nm: 'y-bu.dat', tp: 'bu' }])] };
  assert.equal(X.pickHash(aux).hash, good, 'hash excluído é ignorado');
  aux.hashes.push(h(other, 'Totalizado', [{ nm: 'z-bu.dat', tp: 'bu' }], '03:00:00'));
  assert.equal(X.pickHash(aux).name, 'z-bu.dat', 'o mais recente vale');
  assert.equal(X.pickHash({ hashes: [h('../../x', 'Recebido', [{ nm: 'a-bu.dat', tp: 'bu' }])] }), null, 'hash inseguro');
  assert.equal(X.pickHash({ hashes: [h(good, 'Recebido', [{ nm: '../a', tp: 'bu' }])] }), null, 'nome inseguro');
  assert.equal(X.pickHash({ hashes: [h(good, 'Recebido', [{ nm: 'a.log', tp: 'log' }])] }), null, 'sem bu');
  assert.equal(X.pickHash(null), null);
  assert.match(X.auxUrl('30805', '0001', '1088'), /arquivo-urna\/3221\/dados\/zz\/30805\/0001\/1088\/p003221-zz-m30805-z0001-s1088-aux\.json$/);
});

// ---------- Jornal Razão ----------
test('parseIndex / parseSnapshot: versão, pausa e país incoerente sai sozinho (com motivo)', () => {
  assert.deepEqual(X.parseIndex({ f: { ext: 42 }, t: '2026-10-25T04:30:44-03:00', pausa: 1 }),
    { ok: true, version: 42, at: Date.UTC(2026, 9, 25, 7, 30, 44), paused: true });
  assert.equal(X.parseIndex({ f: {} }).ok, false);
  assert.equal(X.parseSnapshot({}).ok, false);
  const badSum = Object.assign({}, NZ, { nm: 'Japão', cid: [{ nm: 'Tóquio', urnas: 4, total: 5, f: 101, l: 418, c: 526 }] });
  const badTot = Object.assign({}, NZ, { nm: 'Chile', vb: 99 });
  const p = X.parseSnapshot(snapshot([AU, NZ, badSum, badTot]));
  assert.equal(p.ok, true);
  assert.deepEqual(p.countries.map((c) => c.name), ['Austrália', 'Nova Zelândia']);
  assert.deepEqual(p.problems, [{ name: 'Japão', reason: 'soma das cidades difere do país' }, { name: 'Chile', reason: 'totais do país incoerentes' }]);
  assert.equal(p.urnas, 31);
  assert.equal(p.lastBuAt, Date.UTC(2026, 9, 25, 7, 30, 10));
});

test('jrClaims: cidade única é exata; país com várias cidades rateia abstenção e brancos/nulos (estimado); B+N da cidade = c − L − F', () => {
  const { claims, problems } = X.jrClaims(X.parseSnapshot(snapshot([AU, NZ])), ix(), {});
  assert.deepEqual(problems, []);
  const w = claims['30805'];
  assert.deepEqual([w.urnas, w.L, w.F, w.B, w.N, w.c, w.aptos, w.est], [5, 418, 101, 4, 3, 526, 3119, false]);
  const s = claims['30562'], c = claims['29491'];
  assert.equal(s.B + s.N, 6830 - 4161 - 2468);
  assert.equal(c.B + c.N, 1849 - 1274 - 510);
  assert.equal((s.aptos - s.c) + (c.aptos - c.c), 18405 - 8679, 'abstenção do país inteira, sem perder voto no rateio');
  assert.equal(s.est && c.est, true);
  // rateio pelo eleitorado esperado das urnas recebidas: Sydney 19/19 de 20000, Camberra 7/10 de 10000
  const wS = 20000, wC = 10000 * 0.7;
  assert.ok(Math.abs((s.aptos - s.c) - 9726 * wS / (wS + wC)) <= 1);
});

test('jrClaims: cidade com boletins já lidos (mesmas urnas e votos) fica exata e o resto do país vai para as outras', () => {
  const exact = { '30562': { code: '30562', src: 'bu', urnas: 19, L: 4161, F: 2468, B: 80, N: 121, c: 6830, aptos: 13000 } };
  const { claims } = X.jrClaims(X.parseSnapshot(snapshot([AU])), ix(), exact);
  const s = claims['30562'], c = claims['29491'];
  assert.deepEqual([s.B, s.N, s.aptos, s.est], [80, 121, 13000, false]);
  assert.deepEqual([c.B, c.N, c.aptos - c.c, c.est], [102 - 80, 164 - 121, (18405 - 8679) - (13000 - 6830), false], 'sobrou uma cidade: exata');
  // boletim divergente (urnas diferentes) não é usado como exato
  const stale = { '30562': Object.assign({}, exact['30562'], { urnas: 18 }) };
  assert.equal(X.jrClaims(X.parseSnapshot(snapshot([AU])), ix(), stale).claims['30562'].est, true);
});

test('jrClaims: aliases de país/cidade casam; cidade sem correspondência sai sozinha (o país não cai inteiro)', () => {
  const one = (nm, city, extra) => Object.assign({ iso: 'XX', nm, urnas: 1, total: 1, aptos: 100, c: 10, f: 4, l: 5, vb: 1, vn: 0,
    cid: [{ nm: city, urnas: 1, total: 1, f: 4, l: 5, c: 10 }] }, extra || {});
  const two = { iso: 'SV', nm: 'El Salvador', urnas: 2, total: 2, aptos: 200, c: 20, f: 8, l: 10, vb: 1, vn: 1,
    cid: [{ nm: 'San Salvador', urnas: 1, total: 1, f: 4, l: 5, c: 10 }, { nm: 'Atlântida', urnas: 1, total: 1, f: 4, l: 5, c: 10 }] };
  const snap = X.parseSnapshot(snapshot([one('Emirados Árabes', 'Abu Dhabi'), one('Tchéquia', 'Praga'), one('Taiwan', 'Taipé'), two]));
  const { claims, problems } = X.jrClaims(snap, ix(), {});
  assert.deepEqual(Object.keys(claims).sort(), ['29262', '30350', '30520', '30570']);
  assert.deepEqual(problems, [{ name: 'Atlântida (El Salvador)', reason: 'cidade sem correspondência no mapa do TSE' }]);
  assert.equal(X.resolveCode(ix(), 'Abu Dhabi', 'Emirados Árabes'), '29262');
  assert.equal(X.resolveCode(ix(), 'Sydney', 'País errado'), '30562', 'nome de cidade único no mapa basta');
});

// ---------- ascaribe ----------
test('ascaribe: casa pelo código TSE (ignora país errado), estima brancos/nulos/abstenção e marca como estimado', () => {
  const json = { updated_at: '2026-10-25T05:01:03.461785-03:00', exterior: [
    { pais: 'Austrália', codigo_tse: '29491', urnas_totais: 10, urnas_apuradas: 7, votos_validos: 1784, lula: 1274, flavio: 510, codigo_iso3: 'AUS' },
    { pais: 'Japão', codigo_tse: '30805', urnas_totais: 5, urnas_apuradas: 5, votos_validos: 519, lula: 418, flavio: 101, codigo_iso3: 'JPN' },
    { pais: 'X', codigo_tse: '30562', urnas_totais: 19, urnas_apuradas: 0, votos_validos: 0, lula: 0, flavio: 0 },
    { pais: 'Y', codigo_tse: '99999', urnas_totais: 3, urnas_apuradas: 1, votos_validos: 10, lula: 5, flavio: 5 },
    { pais: 'Z', codigo_tse: '29262', urnas_totais: 3, urnas_apuradas: 1, votos_validos: 11, lula: 5, flavio: 5 },
  ] };
  const p = X.parseAsc(json);
  assert.equal(p.ok, true);
  assert.deepEqual(p.problems, [{ name: '29262', reason: 'linha incoerente' }]);
  assert.equal(p.urnas, 13);
  const { claims, problems } = X.ascClaims(p, ix(), { B: 0.01, N: 0.02, abst: 0.8 });
  assert.deepEqual(problems, [{ name: '99999', reason: 'código sem cidade no mapa do TSE' }]);
  assert.deepEqual(Object.keys(claims).sort(), ['29491', '30805']);
  const w = claims['30805'];
  assert.deepEqual([w.L, w.F, w.B, w.N, w.c, w.est, w.src], [418, 101, 5, 10, 534, true, 'asc']);
  assert.equal(w.aptos, 3119, 'cidade completa: aptos = eleitorado da base');
  assert.equal(claims['29491'].aptos, 7000, '7 de 10 urnas de 10.000 eleitores');
  assert.equal(X.parseAsc({ exterior: 'x' }).ok, false);
});

// ---------- junção ----------
test('mergeClaims: por cidade vale a fonte com mais urnas; empate bu > jr > asc', () => {
  const c = (src, urnas) => ({ src, urnas, L: urnas, F: 0, B: 0, N: 0, c: urnas, aptos: urnas });
  const best = X.mergeClaims({
    bu: { a: c('bu', 3), b: c('bu', 5), d: c('bu', 0) },
    jr: { a: c('jr', 4), b: c('jr', 5), e: c('jr', 2) },
    asc: { a: c('asc', 4), b: c('asc', 5), e: c('asc', 3) },
  });
  assert.deepEqual(Object.keys(best).sort(), ['a', 'b', 'e']);
  assert.equal(best.a.src, 'jr');
  assert.equal(best.b.src, 'bu');
  assert.equal(best.e.src, 'asc');
});

test('buildGroups: cidade na base substitui a zona; fora da base vira grupo sem zona com a composição média do exterior', () => {
  const best = {
    '30805': { code: '30805', src: 'bu', urnas: 2, total: 5, L: 100, F: 30, B: 1, N: 2, c: 133, aptos: 1400, ts: 7, est: false },
    '30350': { code: '30350', src: 'asc', urnas: 1, total: 4, L: 50, F: 20, B: 1, N: 1, c: 72, aptos: 300, ts: 8, est: true },
  };
  const { groups, skipped } = X.buildGroups(best, ix());
  assert.deepEqual(skipped, []);
  const [praga, wel] = groups;
  assert.deepEqual([wel.id, wel.mun, wel.memberIds, wel.E, wel.s, wel.st, wel.source, wel.name, wel.country],
    ['30805', '30805', ['ZZ|30805|0001'], 3119, 5, 2, 'bu', 'WELLINGTON', 'Nova Zelândia']);
  assert.deepEqual(wel.y, [100, 30, 1, 2, 1400 - 133]);
  assert.deepEqual(praga.memberIds, []);
  assert.equal(praga.E, 300 * 4, 'eleitorado estimado pelas urnas recebidas: 1 de 4');
  assert.equal(praga.s, 4);
  const zzE = 10000 + 20000 + 3119, zzX0 = 100 + 300 + 60;
  assert.ok(Math.abs(praga.xBase[0] - zzX0 * 1200 / zzE) < 1e-9);
  assert.equal(praga.est, true);
});

// ---------- controlador ----------
const T0 = Date.UTC(2026, 9, 25, 8, 0, 0);          // 05:00 de Brasília, bem antes da parada das 16:45
function clock(start) {
  let now = start, seq = 0;
  const timers = new Map();
  const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
  return {
    now: () => now,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, ms), fn, seq: id }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    flush,
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        timers.forEach((t, id) => { if (t.at <= target && (!next || t.at < next.t.at || (t.at === next.t.at && t.seq < next.t.seq))) next = { id, t }; });
        if (!next) break;
        timers.delete(next.id);
        now = next.t.at;
        next.t.fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}
function fakeState() {
  return { calls: 0, last: [], setExternalGroups(list) { this.calls++; this.last = list; return { accepted: list.length, rejected: [] }; } };
}
function sources(opts) {
  const o = Object.assign({ jrVersion: 1, jr: () => snapshot([AU, NZ]), asc: () => ({ updated_at: '2026-10-25T05:00:00-03:00', exterior: [] }) }, opts || {});
  const calls = { v: 0, ext: 0, asc: 0, signals: [] };
  const fetchJson = (url, signal) => {
    calls.signals.push(signal);
    if (url.startsWith('/jr/v.json?_=')) { calls.v++; return o.v ? o.v() : Promise.resolve({ f: { ext: o.jrVersion }, t: '2026-10-25T04:30:44-03:00' }); }
    if (url === '/jr/ext.json?v=' + o.jrVersion) { calls.ext++; return Promise.resolve(o.jr()); }
    if (url.startsWith('/asc/exterior.json?_=')) { calls.asc++; return Promise.resolve().then(o.asc); }
    return Promise.reject(new Error('URL inesperada: ' + url));
  };
  return { o, calls, fetchJson };
}
const CS = { abr: [{ cd: 'ZZ', mu: [
  { cd: '30805', nm: 'WELLINGTON', zon: [{ cd: '0001', sec: ['1088', '1089', '1090', '1091', '1092'].map((ns) => ({ ns })) }] },
  { cd: '29491', nm: 'CAMBERRA', zon: [{ cd: '0001', sec: ['0732', '0733', '0734', '0735', '0736', '0737', '0738', '0739', '0740', '0741', '0742'].map((ns) => (ns === '0742' ? { ns, nsp: '0741' } : { ns })) }] },
] }] };

test('controlador: sincroniza ao ligar, depois a cada 10 s; fonte com erro não segura a outra; grupos só mudam quando os dados mudam', async () => {
  const c = clock(T0), st = fakeState();
  const src = sources({ asc: () => { throw new Error('HTTP 502'); } });
  const seen = [];
  const ctl = X.createController({ state: st, baseline: BASELINE, locations: LOCATIONS, fetchJson: src.fetchJson, tseGet: null,
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, onChange: (s) => seen.push(s) });
  ctl.start();
  await c.advance(0);
  let s = ctl.status();
  assert.equal(s.cycles, 1);
  assert.equal(s.lastSyncAt, T0);
  assert.equal(s.nextSyncAt, T0 + 10000);
  assert.equal(s.sources.jr.urnas, 31);
  assert.equal(s.sources.asc.lastError, 'HTTP 502');
  assert.equal(s.sources.jr.lastError, '');
  assert.equal(s.sources.bu.state, 'off');
  assert.deepEqual(st.last.map((g) => g.id), ['29491', '30562', '30805']);
  assert.equal(s.totals.urnas, 31);
  assert.equal(s.totals.L, 5853);
  assert.equal(s.totals.aptos, 18405 + 3119);
  assert.deepEqual(s.countries.map((r) => [r.name, r.urnas, r.complete]), [['Austrália', 26, false], ['Nova Zelândia', 5, true]]);
  assert.ok(seen.length >= 2, 'a tela é avisada a cada fonte que chega');
  const callsAfterFirst = st.calls;
  await c.advance(9000);
  assert.equal(src.calls.v, 1, 'nada antes de 10 s');
  await c.advance(1000);
  assert.equal(src.calls.v, 2);
  assert.equal(src.calls.ext, 1, 'mesma versão do JR: não baixa o ext.json de novo');
  assert.equal(st.calls, callsAfterFirst, 'mesmos grupos: o estado não é recalculado');
  assert.equal(ctl.status().cycles, 2);
  ctl.stop();
  await c.advance(120000);
  assert.equal(src.calls.v, 2, 'parado não sincroniza');
  assert.equal(ctl.status().nextSyncAt, 0);
});

test('controlador: correção para baixo no feed do JR é aplicada (não congela)', async () => {
  const c = clock(T0), st = fakeState();
  const src = sources();
  const ctl = X.createController({ state: st, baseline: BASELINE, locations: LOCATIONS, fetchJson: src.fetchJson, tseGet: null,
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  ctl.start();
  await c.advance(0);
  assert.equal(ctl.status().totals.urnas, 31);
  src.o.jrVersion = 2;
  src.o.jr = () => snapshot([NZ]);
  await c.advance(60000);
  assert.equal(ctl.status().totals.urnas, 5);
  assert.deepEqual(st.last.map((g) => g.id), ['30805']);
  ctl.stop();
});

test('controlador: ciclos nunca se sobrepõem; fonte lenta estoura em 15 s (pedido cancelado) e "Atualizar" no meio só agenda o próximo', async () => {
  const c = clock(T0), st = fakeState();
  let hang = true;
  const src = sources({ v: () => (hang ? new Promise(() => {}) : Promise.resolve({ f: { ext: 1 } })) });
  const ctl = X.createController({ state: st, baseline: BASELINE, locations: LOCATIONS, fetchJson: src.fetchJson, tseGet: null,
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  ctl.start();
  await c.advance(0);
  assert.equal(ctl.status().inFlight, true);
  assert.equal(src.calls.asc, 1);
  assert.equal(ctl.syncNow(), true);
  await c.advance(10000);
  assert.equal(src.calls.v, 1, 'sem segundo ciclo enquanto o primeiro não acaba');
  await c.advance(5000);
  let s = ctl.status();
  assert.equal(s.inFlight, false);
  assert.match(s.sources.jr.lastError, /Jornal Razão: sem resposta em 15 s/);
  assert.equal(src.calls.signals[0].aborted, true, 'o fetch pendurado foi cancelado');
  assert.equal(s.nextSyncAt, T0 + 15000 + 1000, '"Atualizar" durante o ciclo: o próximo vem logo depois');
  hang = false;
  await c.advance(1000);
  s = ctl.status();
  assert.equal(s.cycles, 2);
  assert.equal(s.sources.jr.lastError, '');
  assert.equal(s.nextSyncAt, T0 + 16000 + 10000);
  ctl.stop();
});

function tseStub(opts) {
  const o = Object.assign({ aux: {}, bu: {}, cs: CS }, opts || {});
  const log = [];
  const get = async (url, opt) => {
    log.push(url);
    if (o.block && o.block(url)) return { status: 429 };
    if (url === X.URLS.cs) return o.cs ? { status: 200, json: o.cs } : { status: 404 };
    const m = /\/dados\/zz\/(\d{5})\/(\d{4})\/(\d{4})\/(.+)$/.exec(url);
    if (!m) return { status: 404 };
    const key = `${m[1]}-${m[2]}-${m[3]}`;
    if (m[4].endsWith('-aux.json')) return o.aux[key] ? { status: 200, json: o.aux[key] } : { status: 404 };
    assert.equal(opt.as, 'buffer');
    return o.bu[key] ? { status: 200, buffer: o.bu[key] } : { status: 404 };
  };
  return { get, log, o };
}
const memStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m }; };

test('controlador: boletins só nas cidades em que JR/ascaribe contam mais urnas; decodifica, vence o empate e fica guardado', async () => {
  const c = clock(T0), st = fakeState(), storage = memStorage();
  // JR: só Wellington, 1 urna (a 1088, com os mesmos votos do boletim)
  const nz1 = { iso: 'NZ', nm: 'Nova Zelândia', urnas: 1, total: 5, aptos: 697, c: 73, f: 13, l: 60, vb: 0, vn: 0,
    cid: [{ nm: 'Wellington', urnas: 1, total: 5, f: 13, l: 60, c: 73 }] };
  const src = sources({ jr: () => snapshot([nz1]) });
  const tse = tseStub({ aux: { '30805-0001-1088': fxJson('zz-30805-0001-1088-aux.json') }, bu: { '30805-0001-1088': fx('zz-30805-0001-1088-bu.dat') } });
  const cfg = { state: st, baseline: BASELINE, locations: LOCATIONS, fetchJson: src.fetchJson, tseGet: tse.get, storage,
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer };
  const ctl = X.createController(cfg);
  ctl.start();
  await c.advance(0);
  const auxes = tse.log.filter((u) => u.endsWith('-aux.json'));
  assert.deepEqual(auxes.map((u) => u.split('/').slice(-2, -1)[0]), ['1088', '1089', '1090'], 'falta 1 urna: procura até 1 + 2 seções');
  assert.ok(auxes.every((u) => u.includes('/30805/')), 'Camberra (sem urnas no JR/ascaribe) não é sondada');
  await c.advance(5000);                               // junção adiada dos boletins (mergeDelayMs)
  let s = ctl.status();
  assert.equal(s.sources.bu.urnas, 1);
  assert.equal(s.sources.bu.misses, 2);
  assert.equal(s.sources.bu.csUrnas, 15, 'seção agregada (nsp) não conta como urna');
  assert.equal(st.last[0].source, 'bu', 'empate de urnas: boletim do TSE vence o JR');
  assert.deepEqual(st.last[0].y, [60, 13, 0, 0, 697 - 73]);
  assert.equal(st.last[0].total, 5);
  const saved = JSON.parse(storage.getItem('t2.zzbu.3221'));
  assert.deepEqual(saved.secs['30805|0001|1088'].slice(0, 6), [60, 13, 0, 0, 697, 73]);
  // próximo ciclo: boletins já cobrem o que o JR conta; nenhuma sondagem nova
  const before = tse.log.length;
  await c.advance(60000);
  assert.equal(tse.log.length, before);
  ctl.stop();
  // reabrir o app: os boletins voltam do armazenamento sem rede
  const again = X.createController(Object.assign({}, cfg, { fetchJson: () => new Promise(() => {}), tseGet: null }));
  assert.equal(again.status().sources.bu.urnas, 1);
  assert.equal(again.status().totals.L, 60);
  // armazenamento adulterado (soma errada) é ignorado
  storage.setItem('t2.zzbu.3221', JSON.stringify({ v: 1, pleito: '3221', secs: { '30805|0001|1088': [60, 13, 0, 0, 697, 99] } }));
  assert.equal(X.createController(Object.assign({}, cfg, { tseGet: null })).status().sources.bu.urnas, 0);
});

test('controlador: orçamento de boletins por ciclo, pausa de 15 min no 429 e parada às 16:45', async () => {
  const c = clock(T0), st = fakeState();
  const src = sources();                                // JR: Sydney 19, Camberra 7, Wellington 5
  let block = false;
  const tse = tseStub({ block: (u) => block && u.endsWith('-aux.json') });
  const ctl = X.createController({ state: st, baseline: BASELINE, locations: LOCATIONS, fetchJson: src.fetchJson, tseGet: tse.get, buPerCycle: 4,
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  ctl.start();
  await c.advance(0);
  let aux = tse.log.filter((u) => u.endsWith('-aux.json'));
  assert.equal(aux.length, 4, 'no máximo buPerCycle pedidos por ciclo');
  assert.ok(aux.some((u) => u.includes('/29491/')) && aux.some((u) => u.includes('/30805/')), 'cidades intercaladas');
  // 404 recente não é sondado de novo antes de 40 s; no ciclo seguinte (10 s) as outras seções
  ctl._planBu();
  assert.ok(ctl._queue().every((q) => !aux.some((u) => u.includes(`/${q.mun}/0001/${q.secao}/`))));
  block = true;
  await c.advance(10000);
  let s = ctl.status();
  assert.equal(s.sources.bu.state, 'paused');
  assert.equal(s.sources.bu.blockedUntil, T0 + 10000 + 900000);
  assert.match(s.sources.bu.lastError, /pediu pausa \(HTTP 429\)/);
  const n = tse.log.length;
  await c.advance(14 * 60000);
  assert.equal(tse.log.length, n, 'nenhum pedido ao TSE durante a pausa');
  block = false;
  await c.advance(2 * 60000);
  assert.ok(tse.log.length > n, 'volta depois de 15 min');
  ctl.stop();

  // 16:45 de Brasília: nem a lista de seções é pedida
  const c2 = clock(X.START_2T_UTC - 15 * 60000), tse2 = tseStub();
  const late = X.createController({ state: fakeState(), baseline: BASELINE, locations: LOCATIONS, fetchJson: sources().fetchJson, tseGet: tse2.get,
    now: c2.now, setTimer: c2.setTimer, clearTimer: c2.clearTimer });
  late.start();
  await c2.advance(0);
  assert.deepEqual(tse2.log, []);
  assert.equal(late.status().sources.bu.state, 'stopped');
  assert.equal(late.status().totals.urnas, 31, 'JR e ascaribe continuam');
  late.stop();
});
