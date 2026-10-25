'use strict';
// Teste de fumaça da tela do 2T: roda t2.js num DOM falso mínimo (sem dependências) e confere os rótulos e percentuais.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function makeEl(id) {
  const classes = new Set();
  const listeners = {};
  return {
    id, textContent: '', className: '', style: {}, dataset: {}, disabled: false, value: '', hidden: false,
    children: [], parentElement: null,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, force) => { const on = force === undefined ? !classes.has(c) : !!force; if (on) classes.add(c); else classes.delete(c); return on; },
      contains: (c) => classes.has(c),
    },
    setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren() { this.children = []; },
    scrollIntoView() {},
    closest() { return null; },
  };
}

function makeContext(pre) {
  const cache = new Map();
  const document = {
    visibilityState: 'visible',
    getElementById(id) {
      if (!cache.has(id)) { const e = makeEl(id); e.parentElement = makeEl(id + '::pai'); cache.set(id, e); }
      return cache.get(id);
    },
    createElement(tag) { return makeEl(tag); },
    addEventListener() {},
  };
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  // Arquivos locais (data/t2/*.json) vêm do disco; qualquer URL do TSE responde 404 (sem rede).
  const fetch = async (url) => {
    if (/^data\/t2\/[\w.-]+\.json$/.test(String(url))) {
      const body = fs.readFileSync(path.join(ROOT, String(url)), 'utf8');
      return { ok: true, status: 200, json: async () => JSON.parse(body) };
    }
    return { ok: false, status: 404, json: async () => null };
  };
  const ctx = {
    document, localStorage, fetch, navigator: { onLine: true }, location: { search: '' },
    Intl, Date, Math, JSON, Promise, URLSearchParams, setTimeout, clearTimeout,
    setInterval: () => 1, clearInterval: () => {}, console, AbortController,
    window: {}, globalThis: null, addEventListener: () => {},
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  if (pre) pre(ctx);
  vm.createContext(ctx);
  return { ctx, document, cache };
}

async function boot(pre) {
  const m = makeContext(pre);
  for (const f of ['t2-engine.js', 't2-state.js', 't2-fetchq.js', 't2-sim.js', 't2-tse.js', 't2.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), m.ctx, { filename: f });
  }
  const deadline = Date.now() + 15000;
  while (!(m.ctx.T2App && m.ctx.T2App.app.lastOutput && m.ctx.T2App.app.poller)) {
    if (Date.now() > deadline) throw new Error('init da tela não terminou');
    await new Promise((r) => setTimeout(r, 20));
  }
  return m;
}

test('tela do 2T: carrega, mostra PRÉVIA/zero oficial e renderiza cada estado de conexão sem lançar', async () => {
  const { ctx, cache } = makeContext();
  for (const f of ['t2-engine.js', 't2-state.js', 't2-fetchq.js', 't2-sim.js', 't2-tse.js', 't2.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  const $ = (id) => ctx.document.getElementById(id);

  // espera o init (carregar JSON locais + primeiro render)
  const deadline = Date.now() + 15000;
  while (!(ctx.T2App && ctx.T2App.app.lastOutput)) {
    if (Date.now() > deadline) throw new Error('init da tela não terminou');
    await new Promise((r) => setTimeout(r, 20));
  }
  // o poller só dá o primeiro ciclo (fase "pre" ou outra) de forma assíncrona; a faixa é redesenhada pelo tick de 1 s
  while (!(ctx.T2App.app.poller && ctx.T2App.app.poller.status().phase !== 'idle')) {
    if (Date.now() > deadline) throw new Error('poller não saiu de idle');
    await new Promise((r) => setTimeout(r, 20));
  }
  ctx.T2App.renderLive(ctx.T2App.app.poller.status());

  assert.ok(/%$/.test($('t2-L-pct').textContent), 'L: ' + $('t2-L-pct').textContent);
  assert.ok(/%$/.test($('t2-F-pct').textContent), 'F: ' + $('t2-F-pct').textContent);
  const label = $('t2-conn-label').textContent;
  assert.ok(label.length > 0, 'faixa de conexão sem rótulo');
  if (Date.now() < Date.UTC(2026, 9, 25, 20, 0, 0)) assert.equal(label, 'PRÉVIA');
  assert.equal($('t2-off-secpct').textContent, '—');

  const T = ctx.T2App;
  const now = Date.now();
  const official = { y: [60e6, 58e6, 2e6, 3e6, 30e6], E: 158745007, s: 499206, st: 250000, tse: { label: '25/10/2026 19:42:10' } };
  const cases = [
    { name: 'live', status: { phase: 'live', lastOkTs: now, errors: [], official, intervalMs: 30000 }, label: 'AO VIVO' },
    { name: 'stale', status: { phase: 'live', lastOkTs: now - 600000, errors: [], intervalMs: 30000 }, label: 'ATRASADO' },
    { name: 'offline', status: { phase: 'live', lastOkTs: now, errors: [], consecutiveFailures: 1, lastFailure: { kind: 'network', at: now } }, label: 'SEM CONEXÃO' },
    { name: 'blocked', status: { phase: 'live', lastOkTs: now, errors: [], queue: { pausedUntil: now + 600000 } }, label: 'TSE LIMITOU ACESSO' },
    { name: 'error', status: { phase: 'error', errors: [{ id: 'BR', erro: 'x', at: now }] }, label: 'ERRO DE DADOS' },
    { name: 'final', status: { phase: 'final', lastOkTs: now, errors: [], finalIntervalMs: 300000 }, label: 'FINAL' },
    { name: 'partial', status: { phase: 'live', lastOkTs: now, errors: [], intervalMs: 30000, brFailures: 3, officialStale: true, officialTs: now - 90000, official }, label: 'AO VIVO (sem arquivo nacional)' },
    { name: 'congelado', status: { phase: 'live', lastOkTs: now, errors: [], intervalMs: 30000, officialFrozen: { since: now - 600000, label: '25/10/2026 19:14:00' }, official }, label: 'AO VIVO (sem arquivo nacional)' },
  ];
  try {
    for (const c of cases) {
      assert.doesNotThrow(() => { T.renderOfficial(c.status); T.renderLive(c.status); }, c.name);
      assert.equal($('t2-conn-label').textContent, c.label, c.name);
      if (c.name === 'live') {
        assert.equal($('t2-off-secpct').textContent, '50,07%');
        assert.equal($('t2-off-L-pct').textContent, '50,85%');
        assert.equal($('t2-tse-time').textContent, 'Totalização TSE: 25/10/2026 19:42:10');
      }
      if (c.name === 'error') assert.ok($('t2-alert').textContent.includes('Não foi possível interpretar'));
      if (c.name === 'partial') {
        assert.ok($('t2-conn-detail').textContent.includes('Arquivo nacional do TSE indisponível'), $('t2-conn-detail').textContent);
        assert.ok($('t2-off-extra').textContent.includes('Arquivo nacional indisponível'));
      }
      if (c.name === 'congelado') {
        assert.ok($('t2-conn-detail').textContent.includes('parado desde'), $('t2-conn-detail').textContent);
        assert.ok($('t2-off-extra').textContent.includes('Arquivo nacional do TSE parado desde'));
      }
    }
  } finally {
    ctx.T2App.app.poller.stop();
  }
  assert.ok(cache.size > 0);
});

test('tela do 2T: faixa calibrada "± p.p.", "Indefinido" quando 50% cabe na faixa, e diagnósticos da curva', async () => {
  const { ctx } = await boot();
  try {
    const T = ctx.T2App, $ = (id) => ctx.document.getElementById(id);
    const out = T.app.lastOutput, status = { phase: 'live', lastOkTs: Date.now(), errors: [], intervalMs: 30000 };
    assert.ok(out.uncertainty && out.uncertainty.pp > 0, 'compute devolve uncertainty');
    assert.equal(out.diagnostics.curveLoaded, true, 'a curva de 2026 carrega na tela');
    assert.ok(out.diagnostics.curveUnits >= 6000);
    const fake = (L, pp) => {
      const F = 1 - L;
      return Object.assign({}, out, {
        br: Object.assign({}, out.br, { finalShare: { L, F, valid: 1 }, leaderFinal: L > F ? 'L' : 'F', margin: { counted: 0, final: (L - F) * 1e6 } }),
        uncertainty: { pp, lo: L - pp / 100, hi: L + pp / 100 },
      });
    };
    T.renderData(fake(0.512, 1.5), status);
    assert.ok($('t2-lead').textContent.startsWith('Indefinido: diferença menor que o erro típico'), $('t2-lead').textContent);
    assert.ok($('t2-band').textContent.includes('Lula 51,20% ± 1,50 p.p.'), $('t2-band').textContent);
    assert.ok($('t2-band').textContent.includes('ordem real de 2018 e 2022') && $('t2-band').textContent.includes('superestimou o candidato do PT'));
    T.renderData(fake(0.53, 0.75), status);
    assert.ok($('t2-lead').textContent.startsWith('Lula à frente por'), $('t2-lead').textContent);
    T.renderData(fake(0.47, 0.2), status);
    assert.ok($('t2-lead').textContent.startsWith('Flávio à frente por'));
    T.renderData(fake(0.5, 0), status);
    assert.ok($('t2-band').textContent.includes('sem margem de projeção'));
    T.renderData(out, status);
    const arr = $('t2-diag-arrival').textContent;
    assert.ok(arr.includes('Curva de chegada: carregada') && arr.includes('α=0.8 (rampa até 30% da zona)') && arr.includes('aplicada em 0 zonas') && arr.includes('Faixa entre métodos'), arr);
    // 2T-1.2.1: a classe de 1% usada na faixa aparece nos diagnósticos (prévia: 0% apurado => classe 0–1%)
    assert.ok(out.uncertainty.classe && out.uncertainty.classe.de === 0 && out.uncertainty.classe.ate === 0.01, JSON.stringify(out.uncertainty));
    assert.ok(arr.includes('Faixa calibrada: ±11,55 p.p. na classe 0–1% apurado (2× o maior erro nos ensaios com a ordem real de 2018 e 2022') && arr.includes('superestimando o candidato do PT'), arr);
    assert.equal($('t2-diag-plugin').textContent, 'Plugin: nenhum.');
  } finally { ctx.T2App.app.poller.stop(); }
});

test('tela do 2T: com T2Plugin chama init, mostra status() e isola erro/lentidão do tick', async () => {
  const calls = { init: 0, tick: 0, arg: null };
  let modo = 'ok';
  const { ctx } = await boot((c) => {
    c.T2Plugin = {
      init(a) { calls.init++; calls.arg = a; },
      async tick() { calls.tick++; if (modo === 'erro') throw new Error('boom'); if (modo === 'trava') await new Promise(() => {}); },
      status() { return 'seções: 3 UFs ao vivo'; },
    };
  });
  try {
    const T = ctx.T2App, $ = (id) => ctx.document.getElementById(id);
    assert.ok(calls.init >= 1);
    assert.ok(calls.arg.state && calls.arg.fetchq && calls.arg.urls && calls.arg.cfg.baseline && typeof calls.arg.urls.resBR === 'string');
    T.refreshView();
    assert.equal($('t2-diag-plugin').textContent, 'Plugin: seções: 3 UFs ao vivo');
    T.tickPlugin();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls.tick, 1); assert.equal(T.app.pluginBusy, false); assert.equal(T.app.pluginError, '');
    modo = 'erro'; T.tickPlugin();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(T.app.pluginBusy, false); assert.ok(T.app.pluginError.includes('boom'));
    modo = 'trava'; T.app.pluginTimeoutMs = 100; T.tickPlugin(); T.tickPlugin();      // o 2º não acumula
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls.tick, 3); assert.equal(T.app.pluginBusy, true);
    await new Promise((r) => setTimeout(r, 200));                                     // passou do limite: libera e registra
    assert.equal(T.app.pluginBusy, false); assert.ok(/8 s|passou/.test(T.app.pluginError));
  } finally { ctx.T2App.app.poller.stop(); }
});

test('tela do 2T (2T-1.4): contador "contra 2022" e os dois ensaios (1º turno de 2026 / entre 2022 e 2026)', async () => {
  const { ctx } = await boot();
  const T = ctx.T2App, $ = (id) => ctx.document.getElementById(id);
  try {
    const v = T.app.lastOutput.vs2022;
    assert.ok(v && v.cobertura > 0.95 && v.apurado === null, JSON.stringify(v && v.cobertura));
    assert.ok(Math.abs(v.restante.precisa - 0.5) < 1e-12 && v.restante.lula22 > 0.5 && v.restante.lula22 < 0.52, String(v.restante.lula22));
    // painel "contra 2022" (2T-1.4.2): antes da apuração, vantagem de 2022 fixa, nada perdido nem ganho, resta 100%
    assert.equal($('t2-vs22-state').textContent, 'Aguardando a apuração');
    assert.ok(v.zonas && v.zonas.margem22 > 1e6 && v.zonas.perdeu === 0 && v.zonas.ganhou === 0, JSON.stringify(v.zonas));
    assert.ok(/^\+\d{1,3}(\.\d{3})+$/.test($('t2-vs22-base').textContent), $('t2-vs22-base').textContent);
    assert.equal($('t2-vs22-resta').textContent, $('t2-vs22-base').textContent);
    assert.equal($('t2-vs22-perdeu').textContent, '0');
    assert.equal($('t2-vs22-perdeu-sub').textContent, 'nenhuma zona lida ainda');
    assert.equal($('t2-vs22-resta-pct').textContent, '100,0% da vantagem de 2022');
    assert.equal($('t2-vs22-usada').textContent, '0,0%');
    assert.equal($('t2-vs22-chance').textContent, '—');
    assert.equal($('t2-vs22-chance-sub').textContent, 'aparece com o primeiro dado');
    assert.ok($('t2-vs22-ritmo').textContent.startsWith('Se a perda fosse uniforme'));
    assert.equal(T.app.lastOutput.chance, null);
    assert.ok(!$('t2-band').textContent.includes('chance'), 'sem apurado não há chance');
    // com apurado: chance na faixa e no contador
    const o2 = Object.assign({}, T.app.lastOutput, { chance: { L: 0.873, F: 0.127, sigmaPP: 0.4 },
      progress: Object.assign({}, T.app.lastOutput.progress, { electorateCountedPct: 0.3, unitsWithData: 100 }),
      vs2022: Object.assign({}, v, { apurado: { lula: 0.49, lula22: 0.5, dif: -0.01 },
        margem: { vantagem2022: 2.1e6, perdaApurado: -312000, perdaProjetada: -1.6e6, sobraProjetada: 0.5e6, erroVotos: 0.4e6 },
        zonas: { margem22: 2139645, perdeu: 1234567, ganhou: 456789, nPerdeu: 1200, nGanhou: 1, resta: 2139645 - 1234567 + 456789 } }) });
    T.renderData(o2, { phase: 'live', lastOkTs: Date.now(), errors: [], intervalMs: 30000 });
    assert.ok($('t2-band').textContent.includes('chance de vitória: Lula 87%, Flávio 13%'), $('t2-band').textContent);
    assert.equal($('t2-vs22-state').textContent, 'Ao vivo');
    assert.equal($('t2-vs22-base').textContent, '+2.139.645');
    assert.equal($('t2-vs22-perdeu').textContent, '−1.234.567');
    assert.equal($('t2-vs22-perdeu-sub').textContent, 'em 1.200 zonas');
    assert.equal($('t2-vs22-ganhou').textContent, '+456.789');
    assert.equal($('t2-vs22-ganhou-sub').textContent, 'em 1 zona');
    assert.equal($('t2-vs22-resta').textContent, '+1.361.867');
    assert.ok($('t2-vs22-resta').classList.contains('is-pos'));
    assert.equal($('t2-vs22-resta-pct').textContent, '63,6% da vantagem de 2022');
    assert.equal($('t2-vs22-usada').textContent, '36,4%');
    assert.equal($('t2-vs22-chance').textContent, '13%');
    assert.ok($('t2-vs22-chance-sub').textContent.startsWith('isto é, de Lula perder'));
    assert.equal($('t2-vs22-ap').textContent, '30,0%');
    assert.equal($('t2-vs22-bar-ap').style.width, '30%');
    assert.ok($('t2-vs22-ritmo').classList.contains('is-bad') && $('t2-vs22-ritmo').textContent.includes('a vantagem acaba antes do fim'), $('t2-vs22-ritmo').textContent);
    T.renderData(Object.assign({}, o2, { vs2022: Object.assign({}, o2.vs2022, { zonas: Object.assign({}, o2.vs2022.zonas, { perdeu: 456789 + 0.2 * 2139645 }) }) }), { phase: 'live', lastOkTs: Date.now(), errors: [], intervalMs: 30000 });
    assert.ok($('t2-vs22-ritmo').classList.contains('is-good') && $('t2-vs22-ritmo').textContent.includes('sobra vantagem ao fim: consumiu 20,0% com 30,0% apurado'), $('t2-vs22-ritmo').textContent);
    T.renderData(Object.assign({}, o2, { chance: { L: 0.9999, F: 0.0001, sigmaPP: 0.1 } }), { phase: 'live', lastOkTs: Date.now(), errors: [], intervalMs: 30000 });
    assert.ok($('t2-band').textContent.includes('Lula > 99%, Flávio < 1%'));
    T.renderData(Object.assign({}, o2, { chance: { L: 0.95, F: 0.05, sigmaPP: 0.1, teto: 0.95 } }), { phase: 'live', lastOkTs: Date.now(), errors: [], intervalMs: 30000 });
    assert.ok($('t2-band').textContent.includes('Lula > 95%, Flávio < 5%'), $('t2-band').textContent);
    assert.equal($('t2-vs22-chance').textContent, '< 5%');
    const real = T.app.state;
    T.startRehearsal('entre');
    assert.equal(T.app.rehearsal, true);
    assert.ok($('t2-rehearsal-label').textContent.includes('Modo: entre 2022 e 2026'), $('t2-rehearsal-label').textContent);
    assert.equal($('t2-rehearsal-2022').textContent, 'Encerrar ensaio');
    assert.ok($('t2-rehearsal').classList.contains('hidden'));
    assert.notEqual(T.app.state, real, 'o ensaio usa um estado próprio');
    assert.equal(T.app.state.compute().diagnostics.curveLoaded, false, 'ensaio sem curva de chegada (dados sintéticos sem viés de chegada)');
    // sem a saída em cache do estado real (no 1º passo ainda não há zona com dados)
    assert.equal(T.app.lastOutput.progress.electorateCountedPct, T.app.state.compute().progress.electorateCountedPct, 'saída do estado do ensaio, não a do real');
    const lEntre = T.app.rehearsalUnits.reduce((a, u) => a + u.yFull[0], 0);
    T.startRehearsal('entre');                                                   // encerra
    assert.equal(T.app.rehearsal, false);
    assert.equal(T.app.state, real, 'o estado real volta intacto');
    assert.equal(T.app.lastOutput.progress.unitsWithData, 0, 'ao sair do ensaio a tela volta à saída do estado real (sem dados), não à do ensaio');
    assert.equal($('t2-vs22-state').textContent, 'Aguardando a apuração');
    assert.equal($('t2-rehearsal-2022').textContent, 'Ensaio sintético: entre 2022 e 2026');
    assert.equal($('t2-rehearsal').textContent, 'Ensaio sintético: 1º turno de 2026');
    assert.ok(!$('t2-rehearsal').classList.contains('hidden'));
    T.startRehearsal('atual');
    assert.ok($('t2-rehearsal-label').textContent.includes('Modo: 1º turno de 2026'));
    const lAtual = T.app.rehearsalUnits.reduce((a, u) => a + u.yFull[0], 0);
    assert.notEqual(lAtual, lEntre, 'as duas verdades sintéticas diferem');
    T.startRehearsal('atual');
    assert.equal(T.app.rehearsal, false);
  } finally { if (T.app.rehearsalTimer) clearInterval(T.app.rehearsalTimer); T.app.poller.stop(); }
});
