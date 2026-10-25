#!/usr/bin/env node
/* t2-replay.js — Ensaio do 2T com a ORDEM REAL de chegada das seções (2T-1.2; outros anos no 2T-1.4), passando pelo código real (T2State + T2Engine).
 * Reproduz o 2º turno de 2022 (ou outro ano, com --replay/--curva/--rotulo): a cada t minutos depois das 17:00 de Brasília, só as seções já recebidas entram no estado
 * (y, E, s = seções da zona, st = seções apuradas), e a projeção sai de state.compute(). Prior NEUTRO (T2Engine.neutralPrior):
 * 2022 não é usado como prior dentro da própria amostra. Erro = (Lula projetado − Lula final) em p.p. dos votos válidos.
 *
 * Entradas (geradas por scripts/t2_build_base.py --modo replay2022):
 *   data/t2/dev/replay-2022.json   seções: [zona, x(L,F,D,B,N,A) do 1T22, y(L,F,B,N,A) do 2T22, t2 em segundos desde as 17:00]
 *   data/t2/dev/curva-2022-1t.json curva de chegada do 1T22 (mesmo formato de data/t2/curva-2026-1t.json)
 * Variantes: α constante da curva ∈ {0; 0,25; 0,5; 0,75} (arrivalAlpha, arrivalRamp 0; a0.5 = 2T-1.2), "v13" (padrões do 2T-1.3: α 0,8 em
 * rampa até 30% da zona) e "oraculo" (pertença exata: xc/xr verdadeiros, sem curva).
 * Escopos: nacional e dois grupos de UF (por padrão N+NE × resto, e uma segunda partição alfabética alternada, como checagem).
 *
 * Uso:
 *   node scripts/t2-replay.js                                # tudo: grade de 15 min (15..150), grade de 5 min e um ponto a cada 1%
 *                                                            # apurado de cada escopo (só a0, a0.5 e v13): tabela por faixa e envelope
 *   node scripts/t2-replay.js --sensibilidade                # + grade 3x3 de α máximo x rampa (MAE 5–95%, pontos de 1%)
 *     --grade 0.6/0,0.7/0.15                                 # grade própria α/rampa no lugar da 3x3
 *   node scripts/t2-replay.js --sem-fino                     # sem os pontos de 1% (envelope só com a grade de 5 min)
 *   node scripts/t2-replay.js --rapido                       # só a grade de 15 min, sem partição alfabética nem pontos de 1%
 *   node scripts/t2-replay.js --replay A.json --curva B.json --out C.json --alphas 0,0.5 --alvo 0.8 --rampa 0.3 --passo 15 --tmax 150
 *   node scripts/t2-replay.js --alfa-estrela                 # + α*(f): o α que zera o viés da margem L−F por faixa de fração apurada da zona
 *   node scripts/t2-replay.js --replay data/t2/dev/replay-2018.json --curva data/t2/dev/curva-2018-1t.json --rotulo 2018 --tmax 240 \
 *        --mae-janela 30,240                                 # outro ano (2T-1.4); x pode ter mais candidatos do 1º turno (rows do replay)
 *   node scripts/t2-replay.js --combinar A-resultado.json,B-resultado.json   # envelope = máximo, classe a classe, dos anos; imprime as constantes
 * Saída: data/t2/dev/replay-<rótulo>-resultado.json (tabelas, MAE, critérios de adoção do 2T-1.2 e do 2T-1.3, MAE por faixa de apurado,
 * α*(f) e envelope de erro para a faixa calibrada).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../t2-engine.js');
const St = require('../t2-state.js');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes('--' + n);
const ROOT = path.join(__dirname, '..');
const fReplay = arg('replay', path.join(ROOT, 'data/t2/dev/replay-2022.json'));
const fCurva = arg('curva', path.join(ROOT, 'data/t2/dev/curva-2022-1t.json'));
const ROTULO = arg('rotulo', '2022');                       // ano do ensaio (só para textos e nome da saída)
const NOME_L = arg('nome-l', { 2022: 'Lula', 2018: 'Haddad' }[ROTULO] || 'L');
const fOut = arg('out', path.join(ROOT, 'data/t2/dev/replay-' + ROTULO + '-resultado.json'));
const rapido = flag('rapido');
const fino1pct = !rapido && !flag('sem-fino');
const ALPHAS = [...new Set(arg('alphas', '0,0.25,0.5,0.75').split(',').map(Number).concat([0, 0.5]))].sort((a, b) => a - b);
const PASSO = Number(arg('passo', 15)), TMAX = Number(arg('tmax', 150)), PASSO_FINO = Number(arg('passo-fino', 5));
const ALVO = Number(arg('alvo', St.ARRIVAL_ALPHA_DEFAULT));  // α máximo da variante v13 (2T-1.3)
const RAMPA = Number(arg('rampa', St.ARRIVAL_RAMP_DEFAULT)); // rampa da v13: α_ef = α·min(1, (st/s)/rampa)
const REF = 'a0.5';                                         // 2T-1.2 (α 0,5 constante)
const sensib = flag('sensibilidade') && !rapido;
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const fmtEnv = (f) => '[' + f.map((x) => '[' + +x.pMax.toFixed(2) + ', ' + x.pp.toFixed(2).replace(/0$/, '') + ']').join(', ') + ']';

/* --combinar: envelope de vários anos = máximo, classe a classe, dos envelopes já calculados (mesma regra e pisos em cada ano). */
if (arg('combinar')) {
  const arqs = arg('combinar').split(',');
  const envs = arqs.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')).envelope);
  for (const [v, alvoC] of [['a0', 'ENV_SEM_CURVA'], ['v13', 'ENV_CURVA'], ['oraculo', 'ENV_PERTENCA']]) {
    if (!envs.every((e) => e && e[v] && e[v].length === 100)) throw new Error('envelope ' + v + ' ausente em algum arquivo');
    const comb = envs[0][v].map((f, i) => ({ pMin: f.pMin, pMax: f.pMax, pp: Math.max(...envs.map((e) => e[v][i].pp)), de: envs.map((e) => e[v][i].pp) }));
    console.log('\n' + alvoC + ' (' + v + ', máximo de ' + arqs.map((f) => path.basename(f)).join(' e ') + ') de 5 em 5%: ' +
      comb.filter((x, i) => i % 5 === 0).map((x) => Math.round(x.pMin * 100) + '%: ±' + x.pp.toFixed(2) + ' (' + x.de.map((d) => d.toFixed(2)).join('/') + ')').join('  '));
    console.log('  constante para t2-state.js: ' + fmtEnv(comb));
  }
  process.exit(0);
}

const NORTE_NORDESTE = ['AC', 'AM', 'AP', 'PA', 'RO', 'RR', 'TO', 'MA', 'PI', 'CE', 'RN', 'PB', 'PE', 'AL', 'SE', 'BA'];

/* ---------- dados ---------- */
const rp = JSON.parse(fs.readFileSync(fReplay, 'utf8'));
const curva = JSON.parse(fs.readFileSync(fCurva, 'utf8'));
const rows = rp.rows;                                       // L,F,[demais nomeados do 1T],D,B,N,A
if (JSON.stringify(curva.rows) !== JSON.stringify(rows)) throw new Error('rows da curva diferentes das do replay');
if (rows[0] !== 'L' || rows[1] !== 'F') throw new Error('as duas primeiras linhas do replay têm de ser L e F');
const K = rows.length;
const nz = rp.zonas.length;
const zonas = rp.zonas.map((id, idx) => ({ idx, id, uf: id.split('|')[0], mun: id.split('|')[1], zona: id.split('|')[2], x: rows.map(() => 0), E: 0, n: 0, sec: [] }));
for (const s of rp.secoes) {
  const z = zonas[s[0]];
  for (let i = 0; i < K; i++) z.x[i] += s[1 + i];
  let e2 = 0; for (let i = 0; i < 5; i++) e2 += s[1 + K + i];
  z.E += e2; z.n++;
  z.sec.push({ t: s[6 + K], x: s.slice(1, 1 + K), y: s.slice(1 + K, 6 + K) });
}
zonas.forEach((z) => z.sec.sort((a, b) => a.t - b.t));
const truthOf = (zs) => { const y = [0, 0, 0, 0, 0]; zs.forEach((z) => z.sec.forEach((s) => { for (let i = 0; i < 5; i++) y[i] += s.y[i]; })); return y; };
const shareL = (y) => y[0] / (y[0] + y[1]);

/* ---------- escopos ---------- */
const ufsAll = [...new Set(zonas.map((z) => z.uf))].sort();
const escopos = [{ nome: 'nacional', zs: zonas }];
const grupos = { regiao: [['g1', 'N+NE', (z) => NORTE_NORDESTE.includes(z.uf)], ['g2', 'S+SE+CO+exterior', (z) => !NORTE_NORDESTE.includes(z.uf)]] };
if (!rapido) grupos.alfabetica = [['a1', 'UFs pares (ordem alfabética)', (z) => ufsAll.indexOf(z.uf) % 2 === 0], ['a2', 'UFs ímpares', (z) => ufsAll.indexOf(z.uf) % 2 === 1]];
const descGrupos = {};
for (const part of Object.values(grupos)) for (const [nome, desc, f] of part) { escopos.push({ nome, zs: zonas.filter(f) }); descGrupos[nome] = desc; }
escopos.forEach((e) => { e.truth = truthOf(e.zs); e.truthL = shareL(e.truth); e.totalE = e.zs.reduce((s, z) => s + z.E, 0); });
log('zonas', nz, '| seções', rp.secoes.length, '| escopos', escopos.map((e) => e.nome + ':' + e.zs.length).join(' '));

/* ---------- estados (um por variante x escopo) ---------- */
const variantes = ALPHAS.map((a) => ({ nome: 'a' + a, alpha: a, ramp: 0 })).concat([{ nome: 'v13', alpha: ALVO, ramp: RAMPA }, { nome: 'oraculo', alpha: 0, ramp: 0, oraculo: true }]);
const GRADE_SENS = arg('grade', '')   // --grade 0.6/0,0.7/0.15,… substitui a grade 3x3 da --sensibilidade (rampa 0 = α constante)
  ? arg('grade').split(',').map((g) => g.split('/').map(Number))
  : [0.7, 0.8, 0.85].flatMap((hi) => [0.25, 0.3, 0.4].map((r) => [hi, r]));
if (sensib) for (const [hi, r] of GRADE_SENS) variantes.push({ nome: 's' + hi + '/' + r, alpha: hi, ramp: r, sens: true });
const vGrade = variantes.filter((v) => !v.sens);            // variantes com pontos na grade de tempo (tabelas por horário)
const prior = { rows, M: E.neutralPrior(rows) };
for (const e of escopos) {
  const baseline = { rows, unidades: e.zs.map((z) => ({ id: z.id, uf: z.uf, mun: z.mun, zona: z.zona, x: z.x, E: z.E, secoes: z.n })) };
  const opts0 = { lambda0: E.DEFAULTS.lambda0 * e.totalE / 158.7e6 };
  e.estados = {};
  for (const v of variantes) {
    e.estados[v.nome] = St.create({ engine: E, baseline, prior, curve: v.oraculo ? null : curva, opts: Object.assign({}, opts0, { arrivalAlpha: v.alpha, arrivalRamp: v.ramp }) });
  }
}

/* ---------- varredura no tempo ---------- */
const hora = (min) => { const m = 17 * 60 + min; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
function tempos() {
  const set = new Set();
  for (let t = PASSO; t <= TMAX; t += PASSO) set.add(t);
  if (!rapido) for (let t = PASSO_FINO; t <= TMAX + 30; t += PASSO_FINO) set.add(t);
  return [...set].sort((a, b) => a - b);
}
/* pontos de 1%: instante (s desde as 17:00) em que cada escopo chega a 0,5%, 1%, 2%, ..., 99% do eleitorado apurado ("pontos próprios").
 * Mesma medida de progressPct do T2State (soma de y apurado / eleitorado da zona inteira). Só rodam a0, a0.5 e v13 (vEnv) e, com
 * --sensibilidade, as variantes s*. Nos escopos do envelope (nacional, g1, g2) a0/a0.5/v13 rodam em todos os pontos de 1% dos três
 * (como no 2T-1.2.1); a1/a2 e a sensibilidade, só nos pontos próprios. As tabelas por faixa usam só os pontos próprios. */
const ESC_ENV = ['nacional', 'g1', 'g2'];
const extraSeg = new Set();
const proprio = {};                                         // segundo -> Set(escopos para os quais é ponto próprio de 1%)
if (fino1pct) {
  for (const e of escopos) {
    const ev = [];
    e.zs.forEach((z) => z.sec.forEach((s) => ev.push([s.t, s.y.reduce((a, b) => a + b, 0)])));
    ev.sort((a, b) => a[0] - b[0]);
    const alvos = [0.005]; for (let q = 1; q <= 99; q++) alvos.push(q / 100);
    let acc = 0, j = 0;
    for (const [t, w] of ev) {
      acc += w;
      while (j < alvos.length && acc >= alvos[j] * e.totalE) { extraSeg.add(t); (proprio[t] = proprio[t] || new Set()).add(e.nome); j++; }
      if (j >= alvos.length) break;
    }
  }
}
const TS = [...new Set(tempos().map((t) => t * 60).concat([...extraSeg]))].sort((a, b) => a - b).map((s) => s / 60);
const ehGrade = (T) => Math.abs(T * 60 - Math.round(T) * 60) < 1e-9 && tempos().includes(Math.round(T));
const vEnv = ['a0', REF, 'v13', 'oraculo'];   // oraculo = pertença exata (versão por seção) -> ENV_PERTENCA
const ehProprio = (T, nome) => !!(proprio[Math.round(T * 60)] && proprio[Math.round(T * 60)].has(nome));
const res = {};            // res[escopo][variante] = [{t, apurado, erro, final}]
escopos.forEach((e) => { res[e.nome] = {}; variantes.forEach((v) => { res[e.nome][v.nome] = []; }); });
const ptr = zonas.map(() => 0);
const acc = zonas.map(() => ({ k: 0, y: [0, 0, 0, 0, 0], xc: rows.map(() => 0) }));
/* α*(f) (--alfa-estrela): nos pontos da grade, para cada zona parcial (0 < st < s) com curva, g = margem L−F da composição REAL do 1T das
 * seções já apuradas menos a da zona inteira, e d = margem L−F do desvio da curva interpolado em f = st/s (como no T2State). Por faixa de
 * f, α* = Σ w·g / Σ w·d, w = votos apurados da zona: o α constante que, naquela faixa, zeraria o viés AGREGADO de composição da margem
 * (é o que pesa na projeção). Também sai a regressão Σ w·g·d / Σ w·d², que é atenuada pelo ruído da curva zona a zona (fica abaixo de α*). */
const alfaEst = flag('alfa-estrela');
const AE_BINS = 10;
const ae = Array.from({ length: AE_BINS }, () => ({ g: 0, d: 0, gd: 0, dd: 0, w: 0, n: 0 }));
function curveDeltaLocal(cu, f) {                          // mesma interpolação de curveDelta() em t2-state.js
  const ks = cu.k, ds = cu.d, n = cu.n, k = f * n, esc = curva.esc || 10000;
  if (!(n > 0) || !ks || !ks.length || ds.length !== ks.length) return null;
  if (k <= ks[0]) return ds[0].map((v) => (v || 0) / esc);
  for (let j = 0; j < ks.length; j++) {
    const k0 = ks[j], k1 = j + 1 < ks.length ? ks[j + 1] : n;
    if (k <= k1 || j + 1 === ks.length) {
      const w = k1 > k0 ? Math.min(1, Math.max(0, (k - k0) / (k1 - k0))) : 1;
      return ds[j].map((d0, i) => { const d1 = j + 1 < ks.length ? (ds[j + 1][i] || 0) : 0; return ((d0 || 0) + (d1 - (d0 || 0)) * w) / esc; });
    }
  }
  return null;
}
const t0 = Date.now();
for (const T of TS) {
  const lim = T * 60;
  zonas.forEach((z, i) => {                                 // acumula incrementalmente as seções recebidas até T
    const a = acc[i];
    while (ptr[i] < z.sec.length && z.sec[ptr[i]].t <= lim) {
      const s = z.sec[ptr[i]++]; a.k++;
      for (let j = 0; j < 5; j++) a.y[j] += s.y[j];
      for (let j = 0; j < K; j++) a.xc[j] += s.x[j];
    }
  });
  const cheio = ehGrade(T);
  if (alfaEst && cheio && T >= PASSO && T <= TMAX && T % PASSO === 0) {
    zonas.forEach((z, i) => {
      const a = acc[i];
      if (!a.k || a.k >= z.n) return;
      const cu = curva.unidades[z.id];
      if (!cu) return;
      const f = a.k / z.n, d = curveDeltaLocal(cu, f);
      const sx = z.x.reduce((p, q) => p + q, 0), sc = a.xc.reduce((p, q) => p + q, 0);
      if (!d || !(sx > 0) || !(sc > 0)) return;
      const g = (a.xc[0] - a.xc[1]) / sc - (z.x[0] - z.x[1]) / sx, dm = d[0] - d[1], w = a.y.reduce((p, q) => p + q, 0);
      const b = ae[Math.min(AE_BINS - 1, Math.floor(f * AE_BINS))];
      b.g += w * g; b.d += w * dm; b.gd += w * g * dm; b.dd += w * dm * dm; b.w += w; b.n++;
    });
  }
  for (const e of escopos) {
    const prop = ehProprio(T, e.nome);
    for (const v of variantes) {
      const roda = v.sens ? prop : cheio || (vEnv.includes(v.nome) && (ESC_ENV.includes(e.nome) || prop));
      if (!roda) continue;
      const st = e.estados[v.nome];
      st.reset();
      for (const z of e.zs) {
        const a = acc[z.idx];
        if (!a.k) continue;
        const upd = { y: a.y.slice(), E: z.E, s: z.n, st: a.k };
        if (v.oraculo) upd.xc = a.xc.slice();
        st.update(z.id, upd);
      }
      const out = st.compute();
      res[e.nome][v.nome].push({ t: T, proprio: prop, apurado: out.br.progressPct, erro: (out.br.finalShare.L - e.truthL) * 100, final: out.br.finalShare.L,
                                 arrivalApplied: out.diagnostics.arrivalApplied, membershipApplied: out.diagnostics.membershipApplied });
    }
  }
  if (cheio) log('t=' + T + ' min (' + hora(T) + ') pronto | ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s');
}

/* ---------- métricas ---------- */
const GRADE = TS.filter((t) => t >= PASSO && t <= TMAX && t % PASSO === 0);
const pick = (nome, v, t) => res[nome][v].find((r) => r.t === t);
log('pontos por escopo do envelope: ' + ESC_ENV.map((n) => n + ' ' + res[n].v13.length).join(', '));
const mae = (nome, v, t1, t2) => { const L = GRADE.filter((t) => t >= t1 && t <= t2); return L.reduce((s, t) => s + Math.abs(pick(nome, v, t).erro), 0) / L.length; };
const T_MAE = arg('mae-janela', '30,' + Math.min(150, TMAX)).split(',').map(Number);   // padrão 17:30–19:30
const maeTab = {};
escopos.forEach((e) => { maeTab[e.nome] = {}; vGrade.forEach((v) => { maeTab[e.nome][v.nome] = mae(e.nome, v.nome, T_MAE[0], T_MAE[1]); }); });

/* criterio de adoção do 2T-1.2 (α 0,5 constante): MAE cai >= 50% vs α=0 nos dois grupos principais; nenhum ponto da grade piora > 0,1 p.p. */
const vAlvo = REF;
const criterio = { alvo: 0.5, porGrupo: {}, passaReducao: true, passaPiora: true, piorPonto: 0 };
for (const nome of escopos.map((e) => e.nome)) {
  if (!res[nome][vAlvo] || !res[nome].a0) continue;
  const red = 1 - maeTab[nome][vAlvo] / maeTab[nome].a0;
  let pior = -Infinity;
  GRADE.forEach((t) => { pior = Math.max(pior, Math.abs(pick(nome, vAlvo, t).erro) - Math.abs(pick(nome, 'a0', t).erro)); });
  criterio.porGrupo[nome] = { maeAlfa0: maeTab[nome].a0, maeAlvo: maeTab[nome][vAlvo], reducao: red, piorPontoPP: pior };
  const principal = nome === 'nacional' || nome === 'g1' || nome === 'g2';
  if (principal && !(red >= 0.5)) criterio.passaReducao = false;
  if (principal && pior > 0.1) criterio.passaPiora = false;
  if (principal) criterio.piorPonto = Math.max(criterio.piorPonto, pior);
}
criterio.adotar = criterio.passaReducao && criterio.passaPiora;

/* MAE por faixa de apurado com os pontos PRÓPRIOS de 1% de cada escopo (um ponto por classe). */
const FAIXAS = [[5, 10], [10, 20], [20, 30], [30, 40], [40, 50], [50, 60], [60, 70], [70, 80], [80, 90], [90, 95]];
const propriosDe = (nome, v) => (res[nome][v] || []).filter((r) => r.proprio);
const maeFaixa = (pts, a, b) => { const L = pts.filter((r) => r.apurado * 100 >= a && r.apurado * 100 < b); return L.length ? L.reduce((s, r) => s + Math.abs(r.erro), 0) / L.length : null; };
const maxFaixa = (pts, a, b) => pts.filter((r) => r.apurado * 100 >= a && r.apurado * 100 < b).reduce((m, r) => Math.max(m, Math.abs(r.erro)), 0);
const porFaixa = {};
/* criterio de adoção do 2T-1.3 (v13 x a0.5): MAE 5–95% (pontos próprios) cai >= 30% em nacional, g1 e g2; nenhum ponto da grade de
 * 15 min piora > 0,1 p.p. (nacional, g1, g2); em cada um dos 5 escopos, v13 é melhor (> 0,005 p.p.) em >= 60% das 90 classes de 1% entre
 * 5% e 95% e pior em <= 30%. */
const criterio13 = { alvo: ALVO, rampa: RAMPA, porGrupo: {}, passaReducao: true, passaPiora: true, passaClasses: true };
if (fino1pct) {
  for (const e of escopos) {
    const nome = e.nome, a = propriosDe(nome, REF), b = propriosDe(nome, 'v13');
    porFaixa[nome] = {};
    variantes.filter((v) => vEnv.includes(v.nome) || v.sens).forEach((v) => {
      const p = propriosDe(nome, v.nome);
      porFaixa[nome][v.nome] = { faixas: FAIXAS.map(([x, y]) => maeFaixa(p, x, y)), mae595: maeFaixa(p, 5, 95), max595: maxFaixa(p, 5, 95) };
    });
    let melhores = 0, piores = 0;
    for (let q = 5; q < 95; q++) {
      const ea = maeFaixa(a, q, q + 1), eb = maeFaixa(b, q, q + 1);
      if (ea === null || eb === null) continue;
      if (eb < ea - 0.005) melhores++; else if (eb > ea + 0.005) piores++;
    }
    const c = { mae12: porFaixa[nome][REF].mae595, mae13: porFaixa[nome].v13.mae595, melhores, piores, piorPontoPP: null };
    c.reducao = 1 - c.mae13 / c.mae12;
    if (ESC_ENV.includes(nome)) {
      let pior = -Infinity;
      GRADE.forEach((t) => { pior = Math.max(pior, Math.abs(pick(nome, 'v13', t).erro) - Math.abs(pick(nome, REF, t).erro)); });
      c.piorPontoPP = pior;
      if (!(c.reducao >= 0.3)) criterio13.passaReducao = false;
      if (pior > 0.1) criterio13.passaPiora = false;
    }
    if (!(melhores >= 54 && piores <= 27)) criterio13.passaClasses = false;
    criterio13.porGrupo[nome] = c;
  }
  criterio13.adotar = criterio13.passaReducao && criterio13.passaPiora && criterio13.passaClasses;
}

/* envelope de erro da faixa calibrada (2T-1.2.1): 100 classes de 1% apurado. Classe [i%, i+1%): 2x o maior |erro| entre os pontos
 * (nacional e os dois grupos, grade de 5 min + pontos de 1%) com apurado em [i-3%, i+4%), isto é, a classe e 3 pontos para cada lado.
 * Pisos: 1,5 p.p. até 5% apurado; 0,3 até 60%; 0,2 até 90%; 0,1 depois. SEM monotonia (o erro de 2022 cresceu entre 30% e 60%).
 * Classe sem ponto na janela herda a classe vizinha mais próxima que tenha. Arredondado PARA CIMA a 0,05 p.p. */
const JANELA = 0.03;
function envelope(nomeVar) {
  const piso = (pMax) => (pMax <= 0.05 + 1e-9 ? 1.5 : pMax <= 0.60 + 1e-9 ? 0.3 : pMax <= 0.90 + 1e-9 ? 0.2 : 0.1);
  const pts = [];
  ESC_ENV.filter((n) => res[n]).forEach((n) => res[n][nomeVar].forEach((r) => pts.push(r)));
  const faixas = [];
  for (let i = 0; i < 100; i++) {
    const pMin = i / 100, pMax = (i + 1) / 100;
    let m = 0, n = 0;
    for (const r of pts) if (r.apurado >= pMin - JANELA && r.apurado < pMax + JANELA) { m = Math.max(m, Math.abs(r.erro)); n++; }
    faixas.push({ pMin, pMax, maxAbsErro: n ? m : null, pontos: n });
  }
  faixas.forEach((f, i) => {
    if (f.maxAbsErro === null) {
      for (let d = 1; d < 100; d++) {
        const viz = [faixas[i - d], faixas[i + d]].find((g) => g && g.pontos > 0);
        if (viz) { f.maxAbsErro = viz.maxAbsErro; f.herdada = true; break; }
      }
    }
    const bruto = Math.max(piso(f.pMax), 2 * (f.maxAbsErro || 0));
    f.pp = Math.ceil(bruto * 20 - 1e-9) / 20;
  });
  return faixas;
}
const env = {};
['a0', 'v13', 'oraculo'].forEach((v) => { if (res.nacional[v]) env[v] = envelope(v); });

/* ---------- saída ---------- */
const fmt = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);
console.log('\nErro em p.p. de ' + NOME_L + ' nos votos válidos (projeção − final). Prior neutro; ordem real de chegada do 2T de ' + ROTULO + '; pontos da grade de ' + PASSO + ' min.');
for (const e of escopos) {
  if (!['nacional', 'g1', 'g2'].includes(e.nome)) continue;
  console.log('\n== ' + (e.nome === 'nacional' ? 'NACIONAL' : e.nome + ' (' + descGrupos[e.nome] + ')') + ' | verdade: ' + NOME_L + ' ' + (e.truthL * 100).toFixed(2) + '% dos válidos');
  console.log('hora   apurado  ' + vGrade.map((v) => v.nome.padStart(8)).join(' '));
  for (const t of GRADE) {
    const p = pick(e.nome, 'a0', t).apurado;
    console.log(hora(t) + '  ' + (p * 100).toFixed(1).padStart(5) + '%  ' + vGrade.map((v) => fmt(pick(e.nome, v.nome, t).erro).padStart(8)).join(' '));
  }
  console.log('MAE ' + hora(T_MAE[0]) + '–' + hora(T_MAE[1]) + '  ' + vGrade.map((v) => maeTab[e.nome][v.nome].toFixed(2).padStart(8)).join(' '));
}
console.log('\nCritério de adoção do 2T-1.2 (α=' + criterio.alvo + ' constante x α=0): ' + (criterio.adotar ? 'PASSA' : 'NÃO PASSA') + ' (redução do MAE >=50% nos grupos: ' + criterio.passaReducao + '; nenhum ponto piora >0,1 p.p.: ' + criterio.passaPiora + ')');
Object.entries(criterio.porGrupo).forEach(([n, c]) => console.log('  ' + n.padEnd(9) + 'MAE α0 ' + c.maeAlfa0.toFixed(3) + ' → α' + criterio.alvo + ' ' + c.maeAlvo.toFixed(3) + ' (−' + (c.reducao * 100).toFixed(0) + '%) | pior ponto ' + c.piorPontoPP.toFixed(3)));
if (fino1pct) {
  const f2 = (x) => (x === null ? '  —  ' : x.toFixed(2).padStart(5));
  console.log('\nMAE (p.p.) por faixa de apurado, pontos de 1% de cada escopo. ' + REF + ' = 2T-1.2; v13 = 2T-1.3 (α ' + ALVO + ' em rampa até ' + RAMPA * 100 + '% da zona).');
  for (const e of escopos) {
    console.log('\n== ' + e.nome + (descGrupos[e.nome] ? ' (' + descGrupos[e.nome] + ')' : '') + '\nvariante  ' + FAIXAS.map(([x, y]) => (x + '–' + y).padStart(6)).join('') + ' | MAE 5–95 | máx 5–95');
    ['a0', REF, 'v13'].forEach((v) => { const r = porFaixa[e.nome][v]; console.log(v.padEnd(9) + ' ' + r.faixas.map((x) => ' ' + f2(x)).join('') + ' |    ' + r.mae595.toFixed(3) + ' |   ' + r.max595.toFixed(2)); });
    const c = criterio13.porGrupo[e.nome];
    console.log('v13 x ' + REF + ': MAE −' + (c.reducao * 100).toFixed(0) + '% | classes de 1% melhores ' + c.melhores + ', piores ' + c.piores + (c.piorPontoPP !== null ? ' | pior ponto da grade ' + c.piorPontoPP.toFixed(3) : ''));
  }
  console.log('\nCritério de adoção do 2T-1.3 (v13 x ' + REF + '): ' + (criterio13.adotar ? 'PASSA' : 'NÃO PASSA') + ' (MAE 5–95% cai >=30% em nacional/g1/g2: ' + criterio13.passaReducao + '; nenhum ponto da grade piora >0,1 p.p.: ' + criterio13.passaPiora + '; >=60% das classes melhores e <=30% piores nos 5 escopos: ' + criterio13.passaClasses + ')');
  if (sensib) {
    console.log('\nSensibilidade: MAE 5–95% (pontos de 1%) por α máximo x rampa; referência ' + REF + ' na última coluna.');
    console.log('variante    ' + escopos.map((e) => e.nome.padStart(9)).join(''));
    const linhas = variantes.filter((v) => v.sens).map((v) => v.nome).concat(['v13', REF]);
    linhas.forEach((v) => console.log(v.padEnd(11) + ' ' + escopos.map((e) => porFaixa[e.nome][v].mae595.toFixed(3).padStart(9)).join('')));
  }
}
Object.entries(env).forEach(([v, f]) => {
  console.log('\nEnvelope (' + v + ({ v13: ' -> ENV_CURVA', oraculo: ' -> ENV_PERTENCA' }[v] || ' -> ENV_SEM_CURVA') + ') de 5 em 5%: ' + f.filter((x, i) => i % 5 === 0).map((x) => Math.round(x.pMin * 100) + '%: ±' + x.pp.toFixed(2)).join('  '));
  console.log('  classes com poucos pontos (<3) entre 5% e 95%: ' + (f.filter((x) => x.pMin >= 0.05 && x.pMax <= 0.95 && x.pontos < 3).map((x) => Math.round(x.pMin * 100) + '%').join(' ') || 'nenhuma'));
  console.log('  constante para t2-state.js: ' + fmtEnv(f));
});

const alfaEstrela = alfaEst ? ae.map((b, i) => ({ fDe: i / AE_BINS, fAte: (i + 1) / AE_BINS, alfa: b.d !== 0 ? b.g / b.d : null,
  regressao: b.dd > 0 ? b.gd / b.dd : null, viesMargemPP: b.w > 0 ? 100 * b.g / b.w : null, curvaMargemPP: b.w > 0 ? 100 * b.d / b.w : null, pontos: b.n })) : null;
if (alfaEstrela) {
  console.log('\nα*(f) (margem L−F, pontos da grade de ' + PASSO + ' min, zonas parciais, peso = votos apurados): o α constante que zeraria o viés por faixa de f = st/s.');
  console.log('f      ' + alfaEstrela.map((b) => (Math.round(b.fDe * 100) + '–' + Math.round(b.fAte * 100) + '%').padStart(8)).join(''));
  const c2 = (v) => (v === null ? '—' : v.toFixed(2)).padStart(8);
  console.log('α*     ' + alfaEstrela.map((b) => c2(b.alfa)).join(''));
  console.log('regr.  ' + alfaEstrela.map((b) => c2(b.regressao)).join('') + '   (regressão zona a zona, atenuada)');
  console.log('g p.p. ' + alfaEstrela.map((b) => c2(b.viesMargemPP)).join('') + '   (viés real da margem das seções já apuradas)');
  console.log('d p.p. ' + alfaEstrela.map((b) => c2(b.curvaMargemPP)).join('') + '   (desvio da margem previsto pela curva)');
  console.log('rampa  ' + alfaEstrela.map((b) => (ALVO * Math.min(1, ((b.fDe + b.fAte) / 2) / RAMPA)).toFixed(2).padStart(8)).join('') + '   (α da v13 no meio da faixa)');
  console.log('pontos ' + alfaEstrela.map((b) => String(b.pontos).padStart(8)).join(''));
}

const saida = {
  v: 1, gerado_em: new Date().toISOString(), entrada: { replay: path.basename(fReplay), curva: path.basename(fCurva) },
  descricao: 'Erro (p.p. de ' + NOME_L + ' nos válidos) da projeção do T2State sobre o 2T de ' + ROTULO + ' com a ordem real de chegada; prior neutro.',
  rotulo: ROTULO, rows, ordem1t2t: rp.ordem_1t_2t || null, alfaEstrela,
  alphas: ALPHAS, alvo: ALVO, rampa: RAMPA, tempoMin: TS, grade: GRADE, hora0: '17:00', zonas: nz, secoes: rp.secoes.length,
  escopos: escopos.map((e) => ({ nome: e.nome, zonas: e.zs.length, descricao: descGrupos[e.nome] || null, verdadeL: e.truthL, eleitorado: e.totalE })),
  maeJanela: { de: hora(T_MAE[0]), ate: hora(T_MAE[1]), valores: maeTab },
  criterio: criterio, criterio13: criterio13, porFaixa: porFaixa, faixas: FAIXAS, envelope: env,
  series: res
};
fs.mkdirSync(path.dirname(fOut), { recursive: true });
fs.writeFileSync(fOut, JSON.stringify(saida));
console.log('\ngravado ' + fOut + ' (' + (fs.statSync(fOut).size / 1024).toFixed(0) + ' KB) em ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s');
