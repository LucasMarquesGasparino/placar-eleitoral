'use strict';
// scripts/t2-observador.js com fila FALSA (sem rede): URLs, parse, aux só de seção publicada, JSONL, janela e pausas.
const test = require('node:test');
const assert = require('node:assert/strict');
const Obs = require('../scripts/t2-observador.js');

const SEG = 1000;
const secId = (n) => String(n).padStart(4, '0');
const T_INI = Date.UTC(2026, 9, 25, 20, 0, 0);     // 17:00 Brasília

function csJson(uf, zonas) {      // zonas: { 'mmmmm|zzzz': { total, pub, agreg } }
  const mu = {};
  Object.keys(zonas).forEach((k) => {
    const [m, z] = k.split('|'); const sec = [];
    for (let n = 1; n <= zonas[k].total; n++) sec.push(n <= zonas[k].pub ? { ns: secId(n), da: '25/10/2026', ha: '17:' + String(10 + (n % 40)).padStart(2, '0') + ':00' } : { ns: secId(n) });
    for (let a = 0; a < (zonas[k].agreg || 0); a++) sec.push({ ns: secId(900 + a), nsp: secId(1) });
    (mu[m] = mu[m] || { cd: m, zon: [] }).zon.push({ cd: z, sec });
  });
  return { dg: '25/10/2026', hg: '17:30:00', abr: [{ cd: uf.toLowerCase(), ds: uf, mu: Object.values(mu) }] };
}
function resJson(st, s) {
  return { dt: '25/10/2026', ht: '17:29:00', s: { ts: String(s), st: String(st) }, e: { te: '1000', esi: '1000', c: '800', a: '200' }, v: { vb: '10' },
           carg: [{ agr: [{ par: [{ cand: [{ n: '13', vap: '400' }, { n: '22', vap: '350' }] }] }] }] };
}
function auxJson() { return { dg: '25/10/2026', hg: '17:31:00', st: 'Totalizada', hashes: [{ dr: '25/10/2026', hr: '17:05:00', st: 'Totalizado', arq: [] }] }; }

function mundo(over) {
  over = over || {};
  const clock = { t: T_INI };
  const reqs = [], linhas = [], logs = [];
  const mundoCs = over.cs || { AC: { '01066|0004': { total: 20, pub: 8, agreg: 2 } }, RR: { '00010|0001': { total: 10, pub: 0 } } };
  const q = {
    pausedUntil: 0,
    get: async (url) => {
      reqs.push(url);
      let m;
      if ((m = /config\/([a-z]{2})\/.*-cs\.json$/.exec(url))) {
        const uf = m[1].toUpperCase();
        if (over.cs404 && over.cs404.includes(uf)) return { status: 404 };
        return mundoCs[uf] ? { status: 200, json: csJson(uf, mundoCs[uf]) } : { status: 404 };
      }
      if ((m = /\/dados\/([a-z]{2})\/[a-z]{2}-c0001-e006258-u\.json$/.exec(url)) || (m = /\/dados\/([a-z]{2})\/[a-z]{2}-c0001-e006257-u\.json$/.exec(url))) {
        const uf = m[1].toUpperCase(); const z = mundoCs[uf] && Object.values(mundoCs[uf])[0];
        return z ? { status: 200, json: resJson(over.stOficial !== undefined ? over.stOficial : z.pub, z.total) } : { status: 404 };
      }
      if (/-aux\.json$/.test(url)) return over.aux404 ? { status: 404 } : { status: 200, json: auxJson() };
      return { status: 404 };
    },
    stats: () => ({ pausedUntil: q.pausedUntil, ok: reqs.length, notFound: 0, errors: 0, blocked: 0 }),
  };
  const deps = { q, now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, log: (s) => logs.push(s), append: (l) => linhas.push(JSON.parse(l)) };
  return { clock, reqs, linhas, logs, deps, q };
}
const opts = (extra) => Object.assign(Obs.parseArgs([]), { ufs: ['AC', 'RR'], agora: true }, extra);

test('URLs: cs e aux por pleito; resUF igual ao app (EA20)', () => {
  const u = Obs.makeUrlsObs({ pleito: '3221' });
  assert.equal(u.csUF('AC'), 'https://resultados.tse.jus.br/oficial/ele2026/arquivo-urna/3221/config/ac/ac-p003221-cs.json');
  assert.equal(u.auxSecao('AC', '1066', '4', '77'),
    'https://resultados.tse.jus.br/oficial/ele2026/arquivo-urna/3221/dados/ac/01066/0004/0077/p003221-ac-m01066-z0004-s0077-aux.json');
  assert.equal(u.resUF('AC'), 'https://resultados.tse.jus.br/oficial/ele2026/6258/dados/ac/ac-c0001-e006258-u.json');
  const u1 = Obs.makeUrlsObs({ pleito: '3220' });
  assert.match(u1.csUF('SP'), /arquivo-urna\/3220\/config\/sp\/sp-p003220-cs\.json$/);
  assert.match(u1.resUF('SP'), /\/ele2026\/6257\/dados\/sp\/sp-c0001-e006257-u\.json$/);
});

test('parseArgs: padrões, opções e erros', () => {
  const d = Obs.parseArgs([]);
  assert.equal(d.pleito, '3221'); assert.deepEqual(d.ufs, ['AC', 'RR', 'AP', 'SE', 'DF']); assert.equal(d.intervalo, 300); assert.equal(d.janela, '17:00-21:00'); assert.equal(d.maxAux, 10); assert.equal(d.maxRps, 2);
  assert.match(d.out, /data[\\/]t2[\\/]dev[\\/]observador-2t\.jsonl$/);
  const o = Obs.parseArgs(['--pleito', '3220', '--uf', 'ac, rr', '--agora', '--uma-vez', '--intervalo', '60', '--aux', '4']);
  assert.equal(o.pleito, '3220'); assert.deepEqual(o.ufs, ['AC', 'RR']); assert.equal(o.agora && o.umaVez, true); assert.equal(o.intervalo, 60); assert.equal(o.maxAux, 4);
  assert.equal(Obs.parseArgs(['--help']).ajuda, true);
  for (const ruim of [['--xyz'], ['--pleito'], ['--pleito', '32'], ['--uf', 'abc'], ['--intervalo', '2'], ['--rps', '50']]) assert.throws(() => Obs.parseArgs(ruim), ruim.join(' '));
});

test('janela de 17:00 a 21:00 em Brasília', () => {
  const w = Obs.janelaMs('2026-10-25', '17:00-21:00');
  assert.equal(new Date(w.ini).toISOString(), '2026-10-25T20:00:00.000Z');
  assert.equal(new Date(w.fim).toISOString(), '2026-10-26T00:00:00.000Z');
  assert.equal(Obs.hhmmss(Date.UTC(2026, 9, 25, 21, 8, 17)), '18:08:17');
});

test('uma rodada: cs, resUF, razão, aux só de seção publicada, registro JSONL por UF', async () => {
  const w = mundo({ stOficial: 10 });
  const ctx = Obs.novoContexto(opts({ ufs: ['AC'], maxAux: 3 }), w.deps);
  const [r] = await Obs.rodada(ctx);
  assert.equal(r.uf, 'AC');
  assert.equal(r.cs.status, 200); assert.equal(r.cs.total, 20); assert.equal(r.cs.publicadas, 8); assert.equal(r.cs.agregadas, 2);
  assert.equal(r.oficial.st, 10); assert.equal(r.oficial.s, 20); assert.equal(r.oficial.tse, '25/10/2026 17:29:00');
  assert.equal(r.razao, 0.8);
  assert.equal(r.novas, 8);
  assert.equal(r.aux.length, 3);
  assert.equal(r.aux[0].defasagemMin > 0, true);                                       // carimbo do cs (17:1x) menos recebimento (17:05)
  // nunca pediu aux de seção não publicada (secoes 9..20) nem agregada (900+)
  const auxReqs = w.reqs.filter((u) => /-aux\.json$/.test(u));
  assert.equal(auxReqs.length, 3);
  auxReqs.forEach((u) => { const n = Number(/-s(\d{4})-aux/.exec(u)[1]); assert.ok(n >= 1 && n <= 8, u); });
  assert.equal(w.linhas.length, 1);
  assert.equal(w.linhas[0].pleito, '3221');
  assert.ok(w.logs.some((l) => /AC \| cs 8\/20 \| oficial 10\/20 \| razão 0,8/.test(l)), w.logs.join('\n'));
});

test('aux: total por rodada limitado a --aux e dividido entre UFs; não repete seções nas rodadas seguintes', async () => {
  const w = mundo({ cs: { AC: { '01066|0004': { total: 30, pub: 20 } }, RR: { '00010|0001': { total: 30, pub: 20 } } } });
  const ctx = Obs.novoContexto(opts({ maxAux: 4 }), w.deps);
  await Obs.rodada(ctx);
  let aux = w.reqs.filter((u) => /-aux\.json$/.test(u));
  assert.equal(aux.length, 4);
  assert.equal(aux.filter((u) => /\/dados\/ac\//.test(u)).length, 2);
  await Obs.rodada(ctx);
  aux = w.reqs.filter((u) => /-aux\.json$/.test(u));
  assert.equal(new Set(aux).size, aux.length);                                         // nenhuma URL repetida
  assert.equal(aux.length, 4);                                                         // 2ª rodada: nenhuma seção nova, nenhum aux novo
});

test('seções recém-publicadas entre rodadas são as amostradas', async () => {
  const w = mundo({ cs: { AC: { '01066|0004': { total: 30, pub: 5 } } } });
  const ctx = Obs.novoContexto(opts({ ufs: ['AC'], maxAux: 10 }), w.deps);
  await Obs.rodada(ctx);                                                               // 5 seções amostradas
  const antes = w.reqs.length;
  // mais 3 seções publicadas
  const mundoCs = { AC: { '01066|0004': { total: 30, pub: 8 } } };
  const get = w.q.get;
  w.q.get = async (url) => (/-cs\.json$/.test(url) ? { status: 200, json: csJson('AC', mundoCs.AC) } : get(url));
  const [r] = await Obs.rodada(ctx);
  assert.equal(r.novas, 3);
  const novosAux = w.reqs.slice(antes).filter((u) => /-aux\.json$/.test(u)).map((u) => Number(/-s(\d{4})-aux/.exec(u)[1])).sort((a, b) => a - b);
  assert.deepEqual(novosAux, [6, 7, 8]);
});

test('defasagem pela contagem: cs mostra o que o oficial já mostrava há X min', async () => {
  const w = mundo({ cs: { AC: { '01066|0004': { total: 40, pub: 10 } } }, stOficial: 4 });
  const ctx = Obs.novoContexto(opts({ ufs: ['AC'], semAux: true }), w.deps);
  const lista = [];
  // rodada 1 (t0): oficial 4. rodada 2 (+5 min): oficial 10 -> cs (10) = oficial; rodada 3: cs ainda 10, oficial 14
  lista.push(...await Obs.rodada(ctx));
  w.clock.t += 300 * SEG;
  const getOrig = w.q.get;
  w.q.get = async (url) => { const r = await getOrig(url); if (/-c0001-/.test(url)) r.json = resJson(10, 40); return r; };
  lista.push(...await Obs.rodada(ctx));
  w.clock.t += 300 * SEG;
  w.q.get = async (url) => { const r = await getOrig(url); if (/-c0001-/.test(url)) r.json = resJson(14, 40); return r; };
  lista.push(...await Obs.rodada(ctx));
  assert.equal(lista[0].defasagemContagemMin, null);                                   // oficial ainda abaixo do cs (cs adiantado)
  assert.equal(lista[1].defasagemContagemMin, 0);
  assert.equal(lista[2].defasagemContagemMin, 5);                                      // o oficial chegou a 10 há 5 min
  assert.equal(w.reqs.filter((u) => /-aux\.json$/.test(u)).length, 0);
});

test('cs 404 e aux 404: registra, não derruba as outras UFs e suspende aux após três 404', async () => {
  const w = mundo({ cs404: ['AC'] });
  const ctx = Obs.novoContexto(opts({ maxAux: 2 }), w.deps);
  const rs = await Obs.rodada(ctx);
  assert.equal(rs[0].cs.status, 404); assert.equal(rs[0].aux.length, 0);
  assert.equal(rs[1].uf, 'RR'); assert.equal(rs[1].cs.status, 200);
  assert.ok(w.logs.some((l) => /AC \| cs 404/.test(l)));
  const w2 = mundo({ aux404: true, cs: { AC: { '01066|0004': { total: 30, pub: 20 } } } });
  const ctx2 = Obs.novoContexto(opts({ ufs: ['AC'], maxAux: 10 }), w2.deps);
  const [r2] = await Obs.rodada(ctx2);
  assert.equal(w2.reqs.filter((u) => /-aux\.json$/.test(u)).length, 3);
  assert.match(r2.auxSuspenso, /aux suspenso/);
});

test('fila pausada pelo TSE (403/429): a rodada é pulada, sem requisições', async () => {
  const w = mundo();
  w.q.pausedUntil = T_INI + 600000;
  const ctx = Obs.novoContexto(opts(), w.deps);
  const rs = await Obs.rodada(ctx);
  assert.equal(w.reqs.length, 0); assert.equal(rs[0].pausado, true);
});

test('erro inesperado em uma UF não derruba a rodada', async () => {
  const w = mundo();
  const get = w.q.get;
  w.q.get = async (url) => { if (/\/ac\//.test(url)) throw new Error('quebrou'); return get(url); };
  const rs = await Obs.rodada(Obs.novoContexto(opts(), w.deps));
  assert.match(rs[0].erro, /quebrou/); assert.equal(rs[1].cs.status, 200);
});

test('executar: espera a janela, roda a cada intervalo e para ao fim da janela', async () => {
  const w = mundo();
  w.clock.t = Date.UTC(2026, 9, 25, 19, 0, 0);                                         // 16:00 Brasília
  const o = opts({ agora: false, ufs: ['AC'], intervalo: 1800, semAux: true });       // a cada 30 min: 17:00, 17:30, ..., 21:00
  const ctx = await Obs.executar(o, w.deps);
  assert.ok(w.logs.some((l) => /aguardando a janela/.test(l)));
  assert.equal(ctx.ronda, 9);                                                          // 17:00 ... 21:00 (inclusive)
  assert.equal(w.linhas[0].hora, '17:00:00');
  assert.ok(w.logs.some((l) => /fim da janela/.test(l)));
});

test('executar --uma-vez e --rodadas; com --agora ignora a janela', async () => {
  const w = mundo();
  w.clock.t = Date.UTC(2026, 9, 25, 12, 0, 0);
  const c1 = await Obs.executar(opts({ umaVez: true, ufs: ['AC'] }), w.deps);
  assert.equal(c1.ronda, 1);
  const c2 = await Obs.executar(opts({ rodadas: 3, ufs: ['AC'], intervalo: 60 }), w.deps);
  assert.equal(c2.ronda, 3);
});

test('--help imprime a ajuda sem fazer requisição', async () => {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, [require.resolve('../scripts/t2-observador.js'), '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0); assert.match(r.stdout, /mede a defasagem do índice "cs"/);
});
