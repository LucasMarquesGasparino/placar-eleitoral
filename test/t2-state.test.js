'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../t2-engine.js');
const S = require('../t2-sim.js');
const St = require('../t2-state.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' esperado ' + b + ' obtido ' + a);
function mkState(seed) {
  const w = S.makeWorld({ seed: seed || 7 });
  const baseline = { rows: w.rows, ufs: { U0: 'UF zero' }, unidades: w.units.map((u) => ({ id: u.id, uf: u.uf, mun: u.mun, zona: u.zona, x: u.x, E: u.E, secoes: 10 })) };
  const prior = { rows: w.rows, M: w.priorM };
  const opts = { lambda0: 2e6 * w.totalE / 158.7e6 };
  return { w, st: St.create({ engine: E, baseline, prior, opts }), opts, prior };
}

test('state.compute == engine.project direto (mesmos números)', () => {
  const { w, st, opts, prior } = mkState(7);
  const snap = S.stateAt(w, 0.4);
  snap.forEach((u) => { if (u.y) st.update(u.id, { y: u.y, E: u.E, s: 10, st: 5 }); });
  const out = st.compute();
  const direct = E.project(snap, prior, opts);
  out.br.final.L; // existe
  near(out.br.final.L, direct.scenarios.full.total.final[0], 1e-6, 'L final');
  near(out.br.final.F, direct.scenarios.full.total.final[1], 1e-6, 'F final');
  assert.equal(Object.keys(out.ufs).length, 8);
  assert.equal(out.progress.unitsTotal, w.units.length);
  assert.ok(out.migration.rows.length === 10 && out.migration.rows.every((r) => Math.abs(r.to.reduce((a, b) => a + b, 0) - 1) < 1e-9));
  assert.ok(out.band.lo <= out.br.finalShare.L && out.br.finalShare.L <= out.band.hi);
});

test('antes da apuração: sem apurado, forNeed nulo, progresso 0, projeção == prior', () => {
  const { st } = mkState(7);
  const out = st.compute();
  assert.equal(out.forNeed, null);
  assert.equal(out.progress.electorateCountedPct, 0);
  near(out.scenarios.full.finalShare.L, out.scenarios.priorOnly.finalShare.L, 1e-12);
});

test('forNeed: fórmula do "para virar"', () => {
  const { w, st } = mkState(7);
  S.stateAt(w, 0.5).forEach((u) => { if (u.y) st.update(u.id, { y: u.y }); });
  const out = st.compute(), f = out.forNeed;
  assert.ok(f && f.remainingValid > 0);
  const lead = Math.abs(out.br.counted.L - out.br.counted.F);
  near(f.trailerNeedShare, (lead + f.remainingValid) / (2 * f.remainingValid), 1e-12);
  assert.equal(f.leader === 'L', out.br.counted.L > out.br.counted.F);
});

test('export/import de estado reproduz o mesmo resultado; update inválido é descartado', () => {
  const a = mkState(7), b = mkState(7);
  S.stateAt(a.w, 0.3).forEach((u) => { if (u.y) a.st.update(u.id, { y: u.y }); });
  const dump = JSON.parse(JSON.stringify(a.st.exportState()));
  assert.ok(b.st.importState(dump) > 0);
  near(a.st.compute().br.final.L, b.st.compute().br.final.L, 1e-9);
  assert.equal(a.st.update('U0|10000|0001', { y: [1, 2, NaN, 0, 0] }), false);
  assert.equal(a.st.update('lixo', { y: [1, 2, 3, 4, 5] }), false);
  assert.ok(a.st.compute().diagnostics.invalidUpdates >= 2);
});

test('unidade desconhecida entra com base nacional e é reportada; regressão de totais é contada', () => {
  const { st } = mkState(7);
  assert.equal(st.update('ZZ|99999|0001', { y: [10, 20, 1, 1, 8], E: 100 }), true);
  st.update('ZZ|99999|0001', { y: [5, 5, 1, 1, 8] });
  const d = st.compute().diagnostics;
  assert.deepEqual(d.unknownUnits, ['ZZ|99999|0001']);
  assert.equal(d.regressions, 1);
});

test('municipios(): maiores primeiro e soma bate com a UF', () => {
  const { w, st } = mkState(7);
  S.stateAt(w, 0.6).forEach((u) => { if (u.y) st.update(u.id, { y: u.y }); });
  const out = st.compute();
  const ms = st.municipios('U0', 1000);
  for (let i = 1; i < ms.length; i++) assert.ok(ms[i - 1].E >= ms[i].E);
  near(ms.reduce((s, m) => s + m.final.L, 0), out.ufs.U0.final.L, 1e-6, 'soma municípios == UF');
});

test('fallback de 2022: unidade desconhecida usa o 2T de 2022 da própria unidade (e não a composição nacional)', () => {
  const w = S.makeWorld({ seed: 7 });
  const baseline = { rows: w.rows, unidades: w.units.map((u) => ({ id: u.id, uf: u.uf, mun: u.mun, zona: u.zona, x: u.x, E: u.E })) };
  const prior = { rows: w.rows, M: w.priorM }, opts = { lambda0: 2e6 * w.totalE / 158.7e6 };
  const id = 'U0|99999|0001', y22 = [700, 150, 20, 30, 100];     // 2022: Lula forte nesta unidade
  const comFb = St.create({ engine: E, baseline, prior, opts, fallback22: { [id]: y22 } });
  const semFb = St.create({ engine: E, baseline, prior, opts });
  [comFb, semFb].forEach((st) => st.update(id, { E: 2000 }));
  const a = comFb.compute(), b = semFb.compute();
  assert.deepEqual(a.diagnostics.fallback22Used, [id]);
  assert.deepEqual(b.diagnostics.fallback22Used, []);
  const ma = comFb.municipios('U0', 9999).find((m) => m.mun === '99999');
  const mb = semFb.municipios('U0', 9999).find((m) => m.mun === '99999');
  near(ma.E, 2000, 1e-9); near(ma.final.L + ma.final.F + ma.final.B + ma.final.N + ma.final.A, 2000, 1e-6);
  assert.ok(ma.finalShare.L > mb.finalShare.L + 0.1, 'com fallback 2022 o Lula projetado deve ser bem maior: ' + ma.finalShare.L + ' vs ' + mb.finalShare.L);
});

test('export -> import em estado novo preserva o horário SALVO dos dados (diagnostics.lastUpdateTs)', () => {
  const a = mkState(7), b = mkState(7);
  const TS = 1234567890000;
  S.stateAt(a.w, 0.3).forEach((u) => { if (u.y) a.st.update(u.id, { y: u.y, ts: TS }); });
  const dump = JSON.parse(JSON.stringify(a.st.exportState()));
  assert.equal(dump.lastUpdateTs, TS);
  assert.ok(typeof dump.savedAt === 'number' && dump.savedAt > 0);
  assert.ok(b.st.importState(dump) > 0);
  assert.equal(b.st.compute().diagnostics.lastUpdateTs, TS);
});

test('version() sobe com update, reset e importState; não sobe com update inválido', () => {
  const { st } = mkState(7);
  const v0 = st.version();
  assert.equal(st.update('U0|10000|0001', { y: [1, 2, NaN, 0, 0] }), false);
  assert.equal(st.version(), v0);
  st.update('U0|10000|0001', { y: [1, 2, 0, 0, 0] });
  const v1 = st.version();
  assert.ok(v1 > v0);
  st.reset();
  assert.ok(st.version() > v1);
});

test('importState com objeto incompleto retorna 0 sem lançar', () => {
  const { st } = mkState(7);
  assert.equal(st.importState({ v: 1 }), 0);
  assert.equal(st.importState(null), 0);
  assert.equal(st.importState({ v: 2, updates: {} }), 0);
});

test('unitInfo: null para unidade inexistente; situação da unidade', () => {
  const { st } = mkState(7);
  assert.equal(st.unitInfo('nao|existe|0001'), null);
  const info = st.unitInfo('U0|10000|0001');
  assert.ok(info && info.hasData === false && info.st === 0);
  st.update('U0|10000|0001', { y: [1, 2, 0, 0, 0], s: 10, st: 4 });
  assert.deepEqual(st.unitInfo('U0|10000|0001'), { st: 4, s: 10, hasData: true });
});

// ---------- 2T-1.2: curva de chegada, xc explícito e faixa calibrada ----------
function mkCurveState(extra) {
  const w = S.makeWorld({ seed: 7 });
  const baseline = { rows: w.rows, ufs: { U0: 'UF zero' }, unidades: w.units.map((u) => ({ id: u.id, uf: u.uf, mun: u.mun, zona: u.zona, x: u.x, E: u.E, secoes: 10 })) };
  const prior = { rows: w.rows, M: w.priorM };
  const K = w.rows.length;
  // curva sintética: as primeiras seções são "menos Lula" (d negativo em L, positivo em F), n = 10, k = 1..9
  const unidades = {};
  w.units.forEach((u) => {
    const k = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    unidades[u.id] = { n: 10, k, d: k.map((kk) => { const d = new Array(K).fill(0); d[0] = -(10 - kk) * 60; d[1] = (10 - kk) * 60; return d; }) };
  });
  const curve = { v: 1, rows: w.rows, esc: 10000, unidades };
  const opts = Object.assign({ lambda0: 2e6 * w.totalE / 158.7e6 }, (extra && extra.opts) || {});
  return { w, baseline, prior, curve, opts, mk: (o) => St.create(Object.assign({ engine: E, baseline, prior, curve, opts }, o || {})) };
}
function feed(st, w, tau, stFn) {
  S.stateAt(w, tau).forEach((u) => { if (u.y) st.update(u.id, { y: u.y, E: u.E, s: 10, st: stFn ? stFn(u) : 5 }); });
}

test('curva: α=0 ou sem curva == 2T-1.1 (mesmos números); curva ausente não faz nada', () => {
  const c = mkCurveState();
  const ref = c.mk({ curve: null, opts: Object.assign({}, c.opts, { arrivalAlpha: 0.5 }) });
  const zero = c.mk({ opts: Object.assign({}, c.opts, { arrivalAlpha: 0 }) });
  [ref, zero].forEach((st) => feed(st, c.w, 0.4));
  const a = ref.compute(), b = zero.compute();
  assert.equal(a.diagnostics.arrivalApplied, 0); assert.equal(b.diagnostics.arrivalApplied, 0);
  near(a.br.final.L, b.br.final.L, 1e-9); near(a.br.final.F, b.br.final.F, 1e-9);
  const direct = E.project(S.stateAt(c.w, 0.4), c.prior, c.opts);
  // st=5 de s=10 nas unidades parciais: sem curva nenhuma o resultado é o do motor puro (unidades com y==E_u completas incluídas)
  near(a.br.final.L, direct.scenarios.full.total.final[0], 1e-6, 'sem curva == motor puro');
});

test('curva: só unidades parciais (0 < st < s) são alteradas; st=0 e st=s não; α padrão 0,5', () => {
  const c = mkCurveState();
  const st = c.mk();
  feed(st, c.w, 0.4, (u) => 5);
  const out = st.compute();
  const parciais = Object.values(st._units).filter((u) => u.y).length;
  assert.equal(out.diagnostics.arrivalApplied, parciais);
  assert.equal(out.diagnostics.arrivalAlpha, 0.5);
  assert.equal(out.diagnostics.curveLoaded, true);
  const completo = c.mk(); feed(completo, c.w, 0.4, () => 10);
  assert.equal(completo.compute().diagnostics.arrivalApplied, 0, 'st=s: curva sem efeito');
  const nada = c.mk(); feed(nada, c.w, 0.4, () => 0);
  assert.equal(nada.compute().diagnostics.arrivalApplied, 0, 'st=0: curva sem efeito');
  // a curva muda o resultado em direção a MAIS Lula (as primeiras seções são menos lulistas, então o restante é mais lulista)
  const sem = c.mk({ opts: Object.assign({}, c.opts, { arrivalAlpha: 0 }) }); feed(sem, c.w, 0.4, () => 5);
  assert.ok(out.br.final.L > sem.compute().br.final.L, 'curva deve elevar Lula quando as primeiras seções são menos lulistas');
  // conservação: soma de cada unidade == E
  const m = st.municipios('U0', 9999);
  m.forEach((x) => near(x.final.L + x.final.F + x.final.B + x.final.N + x.final.A, x.E, 1e-6 * x.E + 1e-6));
});

test('curva: interpolação linear (d(0)=d1, d(n)=0) confere com cálculo independente do xc/xr', () => {
  const c = mkCurveState();
  const K = c.w.rows.length;
  const st = c.mk({ opts: Object.assign({}, c.opts, { arrivalAlpha: 0.75 }) });
  // alvo: uma unidade com st/s = 0,25 => k = 2,5 entre k=2 e k=3
  const snap = S.stateAt(c.w, 0.4);
  const alvo = snap.find((u) => u.y);
  snap.forEach((u) => { if (u.y) st.update(u.id, { y: u.y, E: u.E, s: 10, st: u === alvo ? 5 : 10 }); });
  st.update(alvo.id, { y: alvo.y, E: alvo.E, s: 8, st: 2 });                    // f = 0,25 -> k = 0,25*10 = 2,5
  const out = st.compute();
  assert.equal(out.diagnostics.arrivalApplied, 1);
  // cálculo independente
  const d = (kk) => (10 - kk) * 60 / 1e4;                                       // d[0] = -d(kk); d[1] = +d(kk)
  const dk = (d(2) + d(3)) / 2;                                                 // k = 2,5
  const sx = alvo.x.reduce((a, b) => a + b, 0);
  const sc = alvo.x.map((v) => v / sx); sc[0] = Math.max(0, sc[0] - 0.75 * dk); sc[1] += 0.75 * dk;
  const tot = sc.reduce((a, b) => a + b, 0), ec = alvo.y.reduce((a, b) => a + b, 0);
  const xc = sc.map((v) => v / tot * ec), xr = alvo.x.map((v, i) => Math.max(0, v - xc[i]));
  const lista = snap.map((u) => Object.assign({}, u, u === alvo ? { xc, xr } : {}));
  const ref = E.project(lista, c.prior, c.opts);
  near(out.br.final.L, ref.scenarios.full.total.final[0], 1e-6, 'L final com xc/xr calculados à mão');
  // antes do 1º ponto (f muito pequeno) vale d1; depois do último ponto cai para 0
  const pouco = c.mk({ opts: Object.assign({}, c.opts, { arrivalAlpha: 1 }) }), quase = c.mk({ opts: Object.assign({}, c.opts, { arrivalAlpha: 1 }) });
  [pouco, quase].forEach((s2) => snap.forEach((u) => { if (u.y) s2.update(u.id, { y: u.y, E: u.E, s: 1000, st: s2 === pouco ? 1 : 999 }); }));
  const lp = pouco.compute().br.finalShare.L, lq = quase.compute().br.finalShare.L;
  const semc = c.mk({ opts: Object.assign({}, c.opts, { arrivalAlpha: 0 }) });
  snap.forEach((u) => { if (u.y) semc.update(u.id, { y: u.y, E: u.E, s: 1000, st: 999 }); });
  assert.ok(Math.abs(lq - semc.compute().br.finalShare.L) < 2e-3, 'perto do fim a curva some: ' + lq);
  assert.ok(lp > lq, 'no começo a correção é maior que no fim');
});

test('curva com rows diferentes ou formato inválido é ignorada com aviso', () => {
  const c = mkCurveState();
  const st = c.mk({ curve: { v: 1, rows: ['X'], unidades: {} } });
  feed(st, c.w, 0.3);
  const d = st.compute().diagnostics;
  assert.equal(d.curveLoaded, false); assert.equal(d.arrivalApplied, 0); assert.ok(/rows/.test(d.curveNote));
  assert.ok(/formato/.test(c.mk({ curve: { v: 2 } }).compute().diagnostics.curveNote));
});

test('xc explícito: prioridade sobre a curva, normalizado para ec, xr = max(0, x − xc); xc:null remove', () => {
  const c = mkCurveState();
  const st = c.mk();
  const snap = S.stateAt(c.w, 0.4), alvo = snap.find((u) => u.y);
  snap.forEach((u) => { if (u.y) st.update(u.id, { y: u.y, E: u.E, s: 10, st: 5 }); });
  const base = st.compute();
  const ec = alvo.y.reduce((a, b) => a + b, 0), K = c.w.rows.length;
  const xc = new Array(K).fill(0); xc[0] = 50; xc[1] = 50; xc[K - 1] = 100;       // escala arbitrária (soma 200): é normalizada para ec
  assert.equal(st.update(alvo.id, { xc }), true);
  const out = st.compute();
  assert.equal(out.diagnostics.membershipApplied, 1);
  assert.equal(out.diagnostics.arrivalApplied, base.diagnostics.arrivalApplied - 1, 'a unidade com xc sai da curva');
  const xcN = xc.map((v) => v * ec / 200), xr = alvo.x.map((v, i) => Math.max(0, v - xcN[i]));
  const sem = S.stateAt(c.w, 0.4);
  const lista = sem.map((u) => Object.assign({}, u));
  // referência: a curva continua valendo para as demais unidades; reproduz via estado com a unidade do alvo trocada
  const ref = c.mk(); snap.forEach((u) => { if (u.y) ref.update(u.id, { y: u.y, E: u.E, s: 10, st: u === alvo ? 10 : 5 }); });
  assert.ok(Number.isFinite(out.br.final.L) && out.br.final.L !== base.br.final.L);
  assert.ok(lista.length && xr.some((v) => v > 0));
  // xc: null remove
  assert.equal(st.update(alvo.id, { xc: null }), true);
  const volta = st.compute();
  assert.equal(volta.diagnostics.membershipApplied, 0);
  near(volta.br.final.L, base.br.final.L, 1e-9, 'sem xc volta ao resultado da curva');
});

test('xc explícito == xc/xr passados direto ao motor (contrato com o modo pertença)', () => {
  const c = mkCurveState();
  const st = c.mk({ curve: null });
  const snap = S.stateAt(c.w, 0.4);
  const lista = snap.map((u) => {
    if (!u.y) return u;
    const ec = u.y.reduce((a, b) => a + b, 0);
    const xc = u.x.map((v) => v * (ec / u.E) * (1 + 0.1 * Math.sin(v))); const sxc = xc.reduce((a, b) => a + b, 0);
    const xcN = xc.map((v) => v * ec / sxc);
    st.update(u.id, { y: u.y, E: u.E, s: 10, st: 5, xc });
    return Object.assign({}, u, { xc: xcN, xr: u.x.map((v, i) => Math.max(0, v - xcN[i])) });
  });
  const ref = E.project(lista, c.prior, c.opts);
  near(st.compute().br.final.L, ref.scenarios.full.total.final[0], 1e-6);
  assert.equal(st.compute().diagnostics.membershipApplied, lista.filter((u) => u.y).length);
});

test('xc inválido rejeita o update inteiro; update só com xc não mexe em lastUpdateTs/updates; reset e export/import tratam xc', () => {
  const c = mkCurveState();
  const st = c.mk();
  const id = c.w.units[0].id, K = c.w.rows.length;
  st.update(id, { y: [10, 20, 1, 1, 8], E: 100, s: 10, st: 5, ts: 1234 });
  const up0 = st.compute().diagnostics;
  assert.equal(st.update(id, { xc: [1, 2, 3] }), false);                          // tamanho errado
  assert.equal(st.update(id, { xc: new Array(K).fill(-1) }), false);
  assert.equal(st.update(id, { y: [1, 1, 1, 1, 1], xc: new Array(K).fill(NaN) }), false);
  assert.equal(st.compute().diagnostics.invalidUpdates, up0.invalidUpdates + 3);
  const v0 = st.version();
  assert.equal(st.update(id, { xc: new Array(K).fill(1), ts: 99999 }), true);
  const d = st.compute().diagnostics;
  assert.equal(d.lastUpdateTs, 1234); assert.equal(d.updates, up0.updates);
  assert.ok(st.version() > v0);
  const dump = JSON.parse(JSON.stringify(st.exportState()));
  assert.deepEqual(dump.updates[id].xc, new Array(K).fill(1));
  const st2 = c.mk(); assert.ok(st2.importState(dump) > 0);
  assert.equal(st2.compute().diagnostics.membershipApplied, 1);
  st2.reset();
  assert.equal(st2.compute().diagnostics.membershipApplied, 0);
});

test('faixa calibrada: uncertainty {pp, lo, hi} segue o envelope e some em 100%', () => {
  const c = mkCurveState();
  const st = c.mk();
  const u0 = st.compute().uncertainty;
  assert.equal(u0.pp, St.ENV_CURVA[0][1]);
  near(u0.lo, st.compute().br.finalShare.L - u0.pp / 100, 1e-12); near(u0.hi, st.compute().br.finalShare.L + u0.pp / 100, 1e-12);
  feed(st, c.w, 0.5);
  const u1 = st.compute().uncertainty, p = st.compute().br.progressPct;
  assert.equal(u1.pp, St.envelopePP(St.ENV_CURVA, p));
  assert.ok(u1.pp < u0.pp && u1.lo <= st.compute().br.finalShare.L && st.compute().br.finalShare.L <= u1.hi);
  // sem curva a faixa é maior (viés maior)
  const sem = c.mk({ opts: Object.assign({}, c.opts, { arrivalAlpha: 0 }) }); feed(sem, c.w, 0.5);
  assert.ok(sem.compute().uncertainty.pp >= u1.pp);
  // 100% apurado
  const fim = c.mk(); feed(fim, c.w, 1, () => 10);
  const uf = fim.compute();
  assert.equal(uf.uncertainty.pp, 0); near(uf.uncertainty.lo, uf.br.finalShare.L, 1e-12);
  // envelopes: monótonos não crescentes e pisos do plano
  [St.ENV_CURVA, St.ENV_SEM_CURVA].forEach((t) => { for (let i = 1; i < t.length; i++) assert.ok(t[i][1] <= t[i - 1][1]); assert.ok(t[0][1] >= 1.5 && t[t.length - 1][1] >= 0.1); });
  assert.equal(St.envelopePP(St.ENV_CURVA, 0.0499) , St.ENV_CURVA[0][1]);
  assert.equal(St.envelopePP(St.ENV_CURVA, 0.05), St.ENV_CURVA[1][1]);
});
