#!/usr/bin/env node
/* t2-observador.js — Medidor da defasagem do índice "cs" do TSE na noite do 2º turno (Plano B1).
 *
 * Pergunta que responde: o `cs` (lista de seções com carimbo de publicação) acompanha a apuração AO VIVO ou chega horas depois
 * (como no 1º turno de 2026: AC ~21h, SP ~23h, MG/RS/DF no dia seguinte)? Só se acompanhar vale o "modo pertença" do app Placar 2T Seção.
 *
 * A cada rodada (padrão 5 min), para cada UF observada (padrão AC, RR, AP, SE, DF):
 *   1) lê o cs e conta as seções PRINCIPAIS com carimbo (seções agregadas, com "nsp", não contam: elas não entram em s.ts);
 *   2) lê o resUF (EA20) e pega s.st (seções apuradas, oficial);
 *   3) lê o `aux` de até 10 seções (no total da rodada) RECÉM-publicadas no cs, para saber a hora de RECEBIMENTO do BU (hashes[].dr/hr).
 *      Nunca pede `aux` de seção que o cs não marca como publicada (404 em excesso = bloqueio de 10 min do TSE).
 * Grava uma linha JSON por UF por rodada em data/t2/dev/observador-2t.jsonl e imprime um resumo.
 * Defasagem medida de três jeitos: (a) agora - carimbo mais recente do cs; (b) carimbo do cs - recebimento do BU nas seções amostradas;
 * (c) tempo desde que o st OFICIAL alcançou a contagem atual do cs ("o cs mostra o que o oficial já mostrava há X min").
 *
 * Uso:   node scripts/t2-observador.js [--agora] [--uma-vez] [--pleito 3221] [--uf ac,rr,ap,se,df] [--intervalo 300]
 *        node scripts/t2-observador.js --help
 * Domingo (2T): termux-wake-lock; node scripts/t2-observador.js   (espera até 17:00 e roda até 21:00, horário de Brasília)
 * Teste com o 1T:  node scripts/t2-observador.js --pleito 3220 --uf ac --agora --uma-vez
 * Carga: ~20 requisições por rodada com 5 UFs (fila T2FetchQ a 2 req/s) — desprezível.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Q = require('../t2-fetchq.js');
const T = require('../t2-tse.js');
const P = require('../t2-pertenca.js');

const BASE = 'https://resultados.tse.jus.br/oficial';
const ELEICAO_DO_PLEITO = { '3220': '6257', '3221': '6258' };
const NUMS = { L: '13', F: '22' };
const PADRAO = {
  pleito: '3221', eleicao: null, ufs: ['AC', 'RR', 'AP', 'SE', 'DF'], intervalo: 300, janela: '17:00-21:00', data: '2026-10-25',
  agora: false, umaVez: false, maxAux: 10, rodadas: 0, maxRps: 2, out: path.join(__dirname, '..', 'data', 't2', 'dev', 'observador-2t.jsonl'), semAux: false
};

function pad(n, w) { return T.pad(n, w); }

/* ---------- URLs (ficam aqui de propósito: o observador é independente do app) ---------- */
function makeUrlsObs(cfg) {
  const pl = String(cfg.pleito), el = String(cfg.eleicao || ELEICAO_DO_PLEITO[pl] || '6258'), base = cfg.base || BASE;
  const tse = T.makeUrls({ base, ano: '2026', eleicao: el });
  const arq = base + '/ele2026/arquivo-urna/' + pl;
  return {
    csUF: (uf) => arq + '/config/' + uf.toLowerCase() + '/' + uf.toLowerCase() + '-p00' + pl + '-cs.json',
    auxSecao: (uf, mun, zona, secao) => {
      const u = uf.toLowerCase(), m = pad(mun, 5), z = pad(zona, 4), s = pad(secao, 4);
      return arq + '/dados/' + u + '/' + m + '/' + z + '/' + s + '/p00' + pl + '-' + u + '-m' + m + '-z' + z + '-s' + s + '-aux.json';
    },
    resUF: (uf) => tse.resUF(uf)
  };
}

/* ---------- horário de Brasília (UTC-3 fixo) ---------- */
function hhmmss(ms) { const d = new Date(ms - 3 * 3600000); return pad(d.getUTCHours(), 2) + ':' + pad(d.getUTCMinutes(), 2) + ':' + pad(d.getUTCSeconds(), 2); }
function hhmm(ms) { return hhmmss(ms).slice(0, 5); }
function janelaMs(data, janela) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data), j = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(janela);
  if (!d || !j) throw new Error('--data AAAA-MM-DD e --janela HH:MM-HH:MM');
  const at = (h, m) => Date.UTC(+d[1], +d[2] - 1, +d[3], +h + 3, +m, 0);
  return { ini: at(j[1], j[2]), fim: at(j[3], j[4]) };
}

/* "04/10/2026" + "18:34:08" (Brasília) -> ms */
function carimboMs(da, ha) { return P.parseCarimbo(da, ha); }

function parseArgs(argv) {
  const o = Object.assign({}, PADRAO, { ufs: PADRAO.ufs.slice() });
  const val = (i, nome) => { if (i + 1 >= argv.length || String(argv[i + 1]).startsWith('--')) throw new Error('falta valor em ' + nome); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.ajuda = true;
    else if (a === '--agora') o.agora = true;
    else if (a === '--uma-vez') o.umaVez = true;
    else if (a === '--sem-aux') o.semAux = true;
    else if (a === '--pleito') o.pleito = val(i++, a);
    else if (a === '--eleicao') o.eleicao = val(i++, a);
    else if (a === '--uf') o.ufs = val(i++, a).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--intervalo') o.intervalo = Number(val(i++, a));
    else if (a === '--janela') o.janela = val(i++, a);
    else if (a === '--data') o.data = val(i++, a);
    else if (a === '--aux') o.maxAux = Number(val(i++, a));
    else if (a === '--rodadas') o.rodadas = Number(val(i++, a));
    else if (a === '--rps') o.maxRps = Number(val(i++, a));
    else if (a === '--out') o.out = val(i++, a);
    else throw new Error('opção desconhecida: ' + a);
  }
  if (!/^\d{4}$/.test(o.pleito)) throw new Error('--pleito deve ter 4 dígitos (3220 = 1T, 3221 = 2T)');
  if (!o.ufs.length || o.ufs.some((u) => !/^[A-Z]{2}$/.test(u))) throw new Error('--uf: siglas separadas por vírgula');
  if (!(o.intervalo >= 10)) throw new Error('--intervalo em segundos (mínimo 10)');
  if (!(o.maxAux >= 0) || !(o.maxRps > 0) || !(o.maxRps <= 5)) throw new Error('--aux >= 0 e --rps entre 0 e 5');
  return o;
}

const AJUDA = `t2-observador.js — mede a defasagem do índice "cs" do TSE (Plano B1)

Opções (padrões entre parênteses):
  --pleito N        3221 = 2º turno (padrão), 3220 = 1º turno (para testar)
  --eleicao N       código da eleição do resUF (padrão: 6258 no 2T, 6257 no 1T)
  --uf AC,RR,...    UFs observadas (AC,RR,AP,SE,DF)
  --intervalo S     segundos entre rodadas (300)
  --janela H-H      janela em Brasília (17:00-21:00); fora dela espera/encerra
  --data AAAA-MM-DD dia da janela (2026-10-25)
  --agora           ignora a janela e roda já (até Ctrl-C ou --rodadas N)
  --uma-vez         uma rodada só
  --rodadas N       encerra depois de N rodadas
  --aux N           máx. de aux por rodada, no total (10); --sem-aux desliga
  --rps N           requisições por segundo (2, máx. 5)
  --out ARQ         JSONL de saída (data/t2/dev/observador-2t.jsonl)
Nunca pede aux de seção que o cs não marca como publicada.`;

/* ---------- uma rodada ---------- */
function novoContexto(opts, deps) {
  return {
    opts, urls: makeUrlsObs(opts), q: deps.q, now: deps.now, log: deps.log, append: deps.append,
    ronda: 0, vistas: {}, auxFeitos: {}, hist: {}, aux404: 0
  };
}

async function observarUF(ctx, uf, quotaAux, t) {
  const rec = { t: new Date(t).toISOString(), hora: hhmmss(t), ronda: ctx.ronda, uf, pleito: ctx.opts.pleito };
  const opt = { priority: 5, negTtlMs: ctx.opts.intervalo * 1000 };
  // 1) cs
  const rc = await ctx.q.get(ctx.urls.csUF(uf), opt);
  let cs = null;
  rec.cs = { status: rc.status };
  if (rc.error) rec.cs.erro = rc.error;
  if (rc.status === 200 && rc.json) {
    cs = P.parseCs(rc.json);
    if (!cs.valido) { rec.cs.erro = 'formato'; cs = null; }
    else {
      Object.assign(rec.cs, { total: cs.total, publicadas: cs.publicadas, agregadas: cs.agregadas, gerado: ((rc.json.dg || '') + ' ' + (rc.json.hg || '')).trim() || null });
      rec.cs.ultimoCarimbo = cs.ultimoCarimbo ? new Date(cs.ultimoCarimbo).toISOString() : null;
      rec.cs.ultimoCarimboHora = cs.ultimoCarimbo ? hhmmss(cs.ultimoCarimbo) : null;
      rec.cs.defasagemMin = cs.ultimoCarimbo ? +((t - cs.ultimoCarimbo) / 60000).toFixed(1) : null;
    }
  }
  // 2) resUF (EA20): s.st oficial
  const rr = await ctx.q.get(ctx.urls.resUF(uf), { priority: 6, negTtlMs: ctx.opts.intervalo * 1000 });
  rec.oficial = { status: rr.status };
  if (rr.error) rec.oficial.erro = rr.error;
  if (rr.status === 200 && rr.json) {
    const p = T.parseResultado(rr.json, NUMS);
    if (p.ok) {
      Object.assign(rec.oficial, { st: p.st, s: p.s, tse: T.parseTseTime(rr.json).label });
      rec.oficial.pctSecoes = p.s > 0 ? +(100 * p.st / p.s).toFixed(2) : null;
    } else rec.oficial.erro = 'campos ausentes: ' + p.missing.join(',');
  }
  // razão cs / oficial e defasagem pela contagem
  const h = ctx.hist[uf] = ctx.hist[uf] || [];
  if (cs && rec.oficial.st !== undefined) {
    rec.razao = rec.oficial.st > 0 ? +(cs.publicadas / rec.oficial.st).toFixed(3) : null;
    h.push({ t, st: rec.oficial.st });
    const primeira = h.find((x) => x.st >= cs.publicadas);
    rec.defasagemContagemMin = (cs.publicadas > 0 && primeira) ? +((t - primeira.t) / 60000).toFixed(1) : null;
  }
  // 3) aux de seções recém-publicadas (só as que o cs marca como publicadas)
  rec.aux = [];
  rec.novas = 0;
  if (cs) {
    const vistas = ctx.vistas[uf] = ctx.vistas[uf] || {};
    const primeiraVez = Object.keys(vistas).length === 0;
    const novas = [];
    const tsPorSecao = {};
    (rc.json.abr || []).forEach((a) => (a.mu || []).forEach((mu) => (mu.zon || []).forEach((z) => (z.sec || []).forEach((s) => {
      if (!s || s.nsp !== undefined || !(s.da || s.ha || s.hash || s.hs)) return;
      const key = pad(mu.cd, 5) + '|' + pad(z.cd, 4) + '|' + pad(s.ns, 4);
      if (!vistas[key]) { vistas[key] = true; novas.push({ key, mun: pad(mu.cd, 5), zona: pad(z.cd, 4), secao: pad(s.ns, 4), da: s.da, ha: s.ha, ts: carimboMs(s.da, s.ha) }); }
      tsPorSecao[key] = 1;
    }))));
    rec.novas = novas.length;
    rec.primeiraLeitura = primeiraVez;
    novas.sort((a, b) => b.ts - a.ts);
    if (!ctx.opts.semAux && quotaAux > 0) {
      for (const n of novas) {
        if (rec.aux.length >= quotaAux) break;
        if (ctx.auxFeitos[uf + '|' + n.key]) continue;
        if (ctx.aux404 >= 3) { rec.auxSuspenso = 'três 404 de aux: aux suspenso por segurança'; break; }
        ctx.auxFeitos[uf + '|' + n.key] = true;
        const ra = await ctx.q.get(ctx.urls.auxSecao(uf, n.mun, n.zona, n.secao), { priority: 4, negTtlMs: 3600000 });
        const item = { mun: n.mun, zona: n.zona, secao: n.secao, status: ra.status, carimboCs: ((n.da || '') + ' ' + (n.ha || '')).trim() };
        if (ra.status === 404) ctx.aux404++;
        if (ra.status === 200 && ra.json) {
          const hs = Array.isArray(ra.json.hashes) ? ra.json.hashes : [];
          const recebs = hs.map((x) => ({ ms: carimboMs(x && x.dr, x && x.hr), dr: x && x.dr, hr: x && x.hr })).filter((x) => x.ms > 0).sort((a, b) => a.ms - b.ms);
          item.publicadoAux = ((ra.json.dg || '') + ' ' + (ra.json.hg || '')).trim() || null;
          item.situacao = ra.json.st || null;
          if (recebs.length) {
            item.recebido = (recebs[0].dr + ' ' + recebs[0].hr).trim();
            if (n.ts > 0) item.defasagemMin = +((n.ts - recebs[0].ms) / 60000).toFixed(1);   // carimbo do cs - recebimento do BU
            item.idadeMin = +((t - recebs[0].ms) / 60000).toFixed(1);                          // agora - recebimento
          }
        } else if (ra.error) item.erro = ra.error;
        rec.aux.push(item);
      }
    }
  }
  const qs = ctx.q.stats ? ctx.q.stats() : {};
  rec.fila = { ok: qs.ok, notFound: qs.notFound, errors: qs.errors, blocked: qs.blocked };
  return rec;
}

function resumo(rec) {
  const c = rec.cs || {}, o = rec.oficial || {};
  const csTxt = c.publicadas !== undefined ? 'cs ' + c.publicadas + '/' + c.total : 'cs ' + (c.erro || c.status);
  const ofTxt = o.st !== undefined ? 'oficial ' + o.st + '/' + o.s : 'oficial ' + (o.erro || o.status);
  const razao = rec.razao !== undefined && rec.razao !== null ? 'razão ' + String(rec.razao).replace('.', ',') : 'razão —';
  const dc = c.defasagemMin !== null && c.defasagemMin !== undefined ? 'último carimbo ' + c.ultimoCarimboHora + ' (há ' + c.defasagemMin + ' min)' : 'sem carimbo';
  const dn = rec.defasagemContagemMin !== null && rec.defasagemContagemMin !== undefined ? 'cs = oficial de ' + rec.defasagemContagemMin + ' min atrás' : '';
  const ds = (rec.aux || []).filter((a) => a.defasagemMin !== undefined).map((a) => a.defasagemMin);
  const da = ds.length ? 'publicação-recebimento ' + (ds.reduce((x, y) => x + y, 0) / ds.length).toFixed(1) + ' min (n=' + ds.length + ')' : '';
  return [rec.hora, rec.uf, csTxt, ofTxt, razao, dc, dn, da, rec.novas ? '+' + rec.novas + ' novas' : ''].filter(Boolean).join(' | ');
}

/* Uma rodada em todas as UFs. Devolve os registros. Erros de uma UF não derrubam as outras. */
async function rodada(ctx) {
  ctx.ronda++;
  const t = ctx.now();
  const qs = ctx.q.stats ? ctx.q.stats() : {};
  if (qs.pausedUntil > t) {
    const rec = { t: new Date(t).toISOString(), hora: hhmmss(t), ronda: ctx.ronda, pausado: true, ateMs: qs.pausedUntil };
    ctx.append(JSON.stringify(rec)); ctx.log('[' + rec.hora + '] fila pausada pelo TSE até ' + hhmmss(qs.pausedUntil) + ' — rodada pulada');
    return [rec];
  }
  const quota = Math.max(1, Math.floor(ctx.opts.maxAux / ctx.opts.ufs.length));
  let restante = ctx.opts.maxAux;
  const recs = [];
  for (const uf of ctx.opts.ufs) {
    let rec;
    try { rec = await observarUF(ctx, uf, Math.min(quota, restante), ctx.now()); }
    catch (e) { rec = { t: new Date(ctx.now()).toISOString(), hora: hhmmss(ctx.now()), ronda: ctx.ronda, uf, erro: String(e && e.message || e) }; }
    restante -= (rec.aux || []).length;
    recs.push(rec);
    ctx.append(JSON.stringify(rec));
    ctx.log(rec.erro ? '[' + rec.hora + '] ' + uf + ' erro: ' + rec.erro : resumo(rec));
  }
  return recs;
}

/* Laço completo: espera a janela, roda a cada `intervalo`, encerra no fim da janela (ou com --uma-vez/--rodadas). */
async function executar(opts, deps) {
  const ctx = novoContexto(opts, deps);
  const w = janelaMs(opts.data, opts.janela);
  const stop = deps.stopped || (() => false);
  if (!opts.agora) {
    while (!stop() && deps.now() < w.ini) {
      deps.log('aguardando a janela (' + opts.janela + ' de ' + opts.data + ', Brasília): faltam ' + Math.ceil((w.ini - deps.now()) / 60000) + ' min');
      await deps.sleep(Math.min(60000, w.ini - deps.now()));
    }
  }
  const limite = opts.umaVez ? 1 : (opts.rodadas || Infinity);
  while (!stop()) {
    const t0 = deps.now();
    if (!opts.agora && t0 > w.fim) { deps.log('fim da janela (' + hhmm(w.fim) + ').'); break; }
    await rodada(ctx);
    if (ctx.ronda >= limite) break;
    const espera = Math.max(1000, t0 + opts.intervalo * 1000 - deps.now());
    await deps.sleep(espera);
  }
  return ctx;
}

async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error('erro: ' + e.message + '\n(use --help)'); return 2; }
  if (opts.ajuda) { console.log(AJUDA); return 0; }
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  const q = Q.createFetchQueue({ maxRps: opts.maxRps, maxConcurrent: 2, timeoutMs: 30000, negTtlMs: 120000 });
  let parar = false, acordar = null;
  const pararJa = () => { parar = true; console.log('\nencerrando após a rodada atual…'); if (acordar) acordar(); };
  process.on('SIGINT', pararJa);
  process.on('SIGTERM', pararJa);
  const deps = {
    q, now: () => Date.now(), sleep: (ms) => new Promise((r) => { const h = setTimeout(r, ms); acordar = () => { clearTimeout(h); r(); }; }), stopped: () => parar,
    log: (s) => console.log(s), append: (line) => fs.appendFileSync(opts.out, line + '\n')
  };
  console.log('Observador cs/aux · pleito ' + opts.pleito + ' · UFs ' + opts.ufs.join(',') + ' · a cada ' + opts.intervalo + ' s · saída ' + opts.out);
  await executar(opts, deps);
  console.log('encerrado. Registro em ' + opts.out);
  return 0;
}

module.exports = { makeUrlsObs, parseArgs, janelaMs, hhmmss, rodada, executar, novoContexto, observarUF, resumo, PADRAO, AJUDA, main };

if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error('erro fatal: ' + (e && e.message || e)); process.exit(1); });
