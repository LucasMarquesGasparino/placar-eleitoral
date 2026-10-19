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

function makeContext() {
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
  vm.createContext(ctx);
  return { ctx, document, cache };
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
    }
  } finally {
    ctx.T2App.app.poller.stop();
  }
  assert.ok(cache.size > 0);
});
