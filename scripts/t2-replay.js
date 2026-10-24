#!/usr/bin/env node
/* t2-replay.js — Ensaio do 2T com a ORDEM REAL de chegada das seções (2T-1.2), passando pelo código real (T2State + T2Engine).
 * Reproduz o 2º turno de 2022: a cada t minutos depois das 17:00 de Brasília, só as seções já recebidas entram no estado
 * (y, E, s = seções da zona, st = seções apuradas), e a projeção sai de state.compute(). Prior NEUTRO (T2Engine.neutralPrior):
 * 2022 não é usado como prior dentro da própria amostra. Erro = (Lula projetado − Lula final) em p.p. dos votos válidos.
 *
 * Entradas (geradas por scripts/t2_build_base.py --modo replay2022):
 *   data/t2/dev/replay-2022.json   seções: [zona, x(L,F,D,B,N,A) do 1T22, y(L,F,B,N,A) do 2T22, t2 em segundos desde as 17:00]
 *   data/t2/dev/curva-2022-1t.json curva de chegada do 1T22 (mesmo formato de data/t2/curva-2026-1t.json)
 * Variantes: α da curva ∈ {0; 0,25; 0,5; 0,75} (arrivalAlpha) e "oraculo" (pertença exata: xc/xr verdadeiros, sem curva).
 * Escopos: nacional e dois grupos de UF (por padrão N+NE × resto, e uma segunda partição alfabética alternada, como checagem).
 *
 * Uso:
 *   node scripts/t2-replay.js                                # tudo, grade de 15 min (15..150) + grade fina de 5 min para o envelope
 *   node scripts/t2-replay.js --rapido                       # só a grade de 15 min, sem partição alfabética
 *   node scripts/t2-replay.js --replay A.json --curva B.json --out C.json --alphas 0,0.5 --passo 15 --tmax 150
 * Saída: data/t2/dev/replay-2022-resultado.json (tabelas, MAE, criterio de adoção do α=0,5 e envelope de erro para a faixa calibrada).
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
const fOut = arg('out', path.join(ROOT, 'data/t2/dev/replay-2022-resultado.json'));
const rapido = flag('rapido');
const ALPHAS = arg('alphas', '0,0.25,0.5,0.75').split(',').map(Number);
const PASSO = Number(arg('passo', 15)), TMAX = Number(arg('tmax', 150)), PASSO_FINO = Number(arg('passo-fino', 5));
const ALVO = Number(arg('alvo', 0.5));                      // α avaliado no criterio de adoção e no envelope
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const NORTE_NORDESTE = ['AC', 'AM', 'AP', 'PA', 'RO', 'RR', 'TO', 'MA', 'PI', 'CE', 'RN', 'PB', 'PE', 'AL', 'SE', 'BA'];

/* ---------- dados ---------- */
const rp = JSON.parse(fs.readFileSync(fReplay, 'utf8'));
const curva = JSON.parse(fs.readFileSync(fCurva, 'utf8'));
const rows = rp.rows;                                       // L,F,D,B,N,A
if (JSON.stringify(curva.rows) !== JSON.stringify(rows)) throw new Error('rows da curva diferentes das do replay');
const nz = rp.zonas.length;
const zonas = rp.zonas.map((id, idx) => ({ idx, id, uf: id.split('|')[0], mun: id.split('|')[1], zona: id.split('|')[2], x: [0, 0, 0, 0, 0, 0], E: 0, n: 0, sec: [] }));
for (const s of rp.secoes) {
  const z = zonas[s[0]];
  for (let i = 0; i < 6; i++) z.x[i] += s[1 + i];
  let e2 = 0; for (let i = 0; i < 5; i++) e2 += s[7 + i];
  z.E += e2; z.n++;
  z.sec.push({ t: s[12], x: s.slice(1, 7), y: s.slice(7, 12) });
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
const variantes = ALPHAS.map((a) => ({ nome: 'a' + a, alpha: a, oraculo: false })).concat([{ nome: 'oraculo', alpha: 0, oraculo: true }]);
const prior = { rows, M: E.neutralPrior(rows) };
for (const e of escopos) {
  const baseline = { rows, unidades: e.zs.map((z) => ({ id: z.id, uf: z.uf, mun: z.mun, zona: z.zona, x: z.x, E: z.E, secoes: z.n })) };
  const opts0 = { lambda0: E.DEFAULTS.lambda0 * e.totalE / 158.7e6 };
  e.estados = {};
  for (const v of variantes) {
    e.estados[v.nome] = St.create({ engine: E, baseline, prior, curve: v.oraculo ? null : curva, opts: Object.assign({}, opts0, { arrivalAlpha: v.alpha }) });
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
const TS = tempos();
const res = {};            // res[escopo][variante] = [{t, apurado, erro, final}]
escopos.forEach((e) => { res[e.nome] = {}; variantes.forEach((v) => { res[e.nome][v.nome] = []; }); });
const ptr = zonas.map(() => 0);
const acc = zonas.map(() => ({ k: 0, y: [0, 0, 0, 0, 0], xc: [0, 0, 0, 0, 0, 0] }));
const t0 = Date.now();
for (const T of TS) {
  const lim = T * 60;
  zonas.forEach((z, i) => {                                 // acumula incrementalmente as seções recebidas até T
    const a = acc[i];
    while (ptr[i] < z.sec.length && z.sec[ptr[i]].t <= lim) {
      const s = z.sec[ptr[i]++]; a.k++;
      for (let j = 0; j < 5; j++) a.y[j] += s.y[j];
      for (let j = 0; j < 6; j++) a.xc[j] += s.x[j];
    }
  });
  for (const e of escopos) {
    for (const v of variantes) {
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
      res[e.nome][v.nome].push({ t: T, apurado: out.br.progressPct, erro: (out.br.finalShare.L - e.truthL) * 100, final: out.br.finalShare.L,
                                 arrivalApplied: out.diagnostics.arrivalApplied, membershipApplied: out.diagnostics.membershipApplied });
    }
  }
  log('t=' + T + ' min (' + hora(T) + ') pronto | ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s');
}

/* ---------- métricas ---------- */
const GRADE = TS.filter((t) => t >= PASSO && t <= TMAX && t % PASSO === 0);
const pick = (nome, v, t) => res[nome][v].find((r) => r.t === t);
const mae = (nome, v, t1, t2) => { const L = GRADE.filter((t) => t >= t1 && t <= t2); return L.reduce((s, t) => s + Math.abs(pick(nome, v, t).erro), 0) / L.length; };
const T_MAE = [30, 150];                                    // 17:30–19:30
const maeTab = {};
escopos.forEach((e) => { maeTab[e.nome] = {}; variantes.forEach((v) => { maeTab[e.nome][v.nome] = mae(e.nome, v.nome, T_MAE[0], T_MAE[1]); }); });

/* criterio de adoção do α alvo: MAE cai >= 50% vs α=0 nos dois grupos principais; nenhum ponto da grade piora > 0,1 p.p. */
const vAlvo = 'a' + ALVO;
const criterio = { alvo: ALVO, porGrupo: {}, passaReducao: true, passaPiora: true, piorPonto: 0 };
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

/* envelope de erro da faixa calibrada (A3): 2x o maior |erro| observado na faixa de p (nacional e grupos, grade fina),
 * com pisos: 1,5 p.p. até 5% apurado; 0,3 até 60%; 0,2 até 90%; 0,1 depois. Monótono e não crescente (máximo dos trechos seguintes). */
function envelope(nomeVar) {
  const cortes = [0.05, 0.10, 0.20, 0.30, 0.40, 0.60, 0.90, 1.0001];
  const piso = (pMax) => (pMax <= 0.05 ? 1.5 : pMax <= 0.60 ? 0.3 : pMax <= 0.90 ? 0.2 : 0.1);
  const escopoUsados = ['nacional', 'g1', 'g2'].filter((n) => res[n]);
  const faixas = cortes.map((pMax, i) => {
    const pMin = i === 0 ? 0 : cortes[i - 1];
    let m = 0, n = 0;
    for (const nome of escopoUsados) for (const r of res[nome][nomeVar]) if (r.apurado >= pMin && r.apurado < pMax) { m = Math.max(m, Math.abs(r.erro)); n++; }
    return { pMin, pMax: Math.min(1, pMax), maxAbsErro: m, pontos: n, bruto: Math.max(piso(pMax), 2 * m) };
  });
  for (let i = faixas.length - 2; i >= 0; i--) faixas[i].bruto = Math.max(faixas[i].bruto, faixas[i + 1].bruto);
  faixas.forEach((f) => { f.pp = Math.ceil(f.bruto * 20 - 1e-9) / 20; });      // arredonda PARA CIMA a 0,05 p.p.
  return faixas;
}
const env = {};
['a0', vAlvo].forEach((v) => { if (res.nacional[v]) env[v] = envelope(v); });

/* ---------- saída ---------- */
const fmt = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);
console.log('\nErro em p.p. de Lula nos votos válidos (projeção − final). Prior neutro; ordem real de chegada do 2T22; pontos da grade de ' + PASSO + ' min.');
for (const e of escopos) {
  if (!['nacional', 'g1', 'g2'].includes(e.nome)) continue;
  console.log('\n== ' + (e.nome === 'nacional' ? 'NACIONAL' : e.nome + ' (' + descGrupos[e.nome] + ')') + ' | verdade: Lula ' + (e.truthL * 100).toFixed(2) + '% dos válidos');
  console.log('hora   apurado  ' + variantes.map((v) => v.nome.padStart(8)).join(' '));
  for (const t of GRADE) {
    const p = pick(e.nome, 'a0', t).apurado;
    console.log(hora(t) + '  ' + (p * 100).toFixed(1).padStart(5) + '%  ' + variantes.map((v) => fmt(pick(e.nome, v.nome, t).erro).padStart(8)).join(' '));
  }
  console.log('MAE ' + hora(T_MAE[0]) + '–' + hora(T_MAE[1]) + '  ' + variantes.map((v) => maeTab[e.nome][v.nome].toFixed(2).padStart(8)).join(' '));
}
console.log('\nCritério de adoção de α=' + ALVO + ': ' + (criterio.adotar ? 'PASSA' : 'NÃO PASSA') + ' (redução do MAE >=50% nos grupos: ' + criterio.passaReducao + '; nenhum ponto piora >0,1 p.p.: ' + criterio.passaPiora + ')');
Object.entries(criterio.porGrupo).forEach(([n, c]) => console.log('  ' + n.padEnd(9) + 'MAE α0 ' + c.maeAlfa0.toFixed(3) + ' → α' + ALVO + ' ' + c.maeAlvo.toFixed(3) + ' (−' + (c.reducao * 100).toFixed(0) + '%) | pior ponto ' + c.piorPontoPP.toFixed(3)));
Object.entries(env).forEach(([v, f]) => {
  console.log('\nEnvelope (' + v + '): [apurado até, ± p.p.]  ' + JSON.stringify(f.map((x) => [x.pMax, x.pp])));
});

const saida = {
  v: 1, gerado_em: new Date().toISOString(), entrada: { replay: path.basename(fReplay), curva: path.basename(fCurva) },
  descricao: 'Erro (p.p. de Lula nos válidos) da projeção do T2State sobre o 2T de 2022 com a ordem real de chegada; prior neutro.',
  alphas: ALPHAS, alvo: ALVO, tempoMin: TS, grade: GRADE, hora0: '17:00', zonas: nz, secoes: rp.secoes.length,
  escopos: escopos.map((e) => ({ nome: e.nome, zonas: e.zs.length, descricao: descGrupos[e.nome] || null, verdadeL: e.truthL, eleitorado: e.totalE })),
  maeJanela: { de: hora(T_MAE[0]), ate: hora(T_MAE[1]), valores: maeTab },
  criterio: criterio, envelope: env,
  series: res
};
fs.mkdirSync(path.dirname(fOut), { recursive: true });
fs.writeFileSync(fOut, JSON.stringify(saida));
console.log('\ngravado ' + fOut + ' (' + (fs.statSync(fOut).size / 1024).toFixed(0) + ' KB) em ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s');
