/* t2-tse.js — Acesso aos dados do TSE (2º turno): URLs, adaptadores de JSON e "poller" (busca periódica).
 *
 * Esquema EA20/EA15 conferido em amostras oficiais do 1º turno de 2026; ver docs/t2-schema.md.
 * Os caminhos de campos ficam centralizados em MAP. Se uma resposta futura mudar, atualize MAP e os fixtures sem espalhar nomes pelo código.
 *
 * 2T-1.1 (robustez): falhas transitórias não derrubam a apuração (o último dado bom continua), backoff exponencial,
 * "atualizar agora", estado de conexão para a tela (connectionState) e aquecimento a partir do estado salvo (prime).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.T2Tse = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BASE = 'https://resultados.tse.jus.br/oficial';
  function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }

  /* 2º turno: domingo 25/10/2026, 17:00 em Brasília (UTC-3, sem horário de verão) = 20:00 UTC. */
  var START_2T_UTC = Date.UTC(2026, 9, 25, 20, 0, 0);

  function makeUrls(cfg) {
    var base = cfg.base || BASE, ano = cfg.ano || '2026', eleicao = cfg.eleicao, cargo = cfg.cargo || '0001';
    var e6 = pad(eleicao, 6), raiz = base + '/ele' + ano + '/' + eleicao;
    function d(uf) { return raiz + '/dados/' + uf.toLowerCase() + '/'; }
    return {
      eleC: base + '/comum/config/ele-c.json',
      cfgMun: raiz + '/config/mun-e' + e6 + '-cm.json',
      acBR: raiz + '/dados/br/br-e' + e6 + '-ab.json',
      acUF: function (uf) { return d(uf) + uf.toLowerCase() + '-e' + e6 + '-ab.json'; },
      resBR: raiz + '/dados/br/br-c' + cargo + '-e' + e6 + '-u.json',
      resUF: function (uf) { return d(uf) + uf.toLowerCase() + '-c' + cargo + '-e' + e6 + '-u.json'; },
      resMun: function (uf, mun) { return d(uf) + uf.toLowerCase() + pad(mun, 5) + '-c' + cargo + '-e' + e6 + '-u.json'; },
      resZona: function (uf, mun, zona) { return d(uf) + uf.toLowerCase() + pad(mun, 5) + '-z' + pad(zona, 4) + '-c' + cargo + '-e' + e6 + '-u.json'; }
    };
  }

  /* >>> ÚNICO lugar com nomes de campos EA20/EA15 observados no TSE. <<< */
  var MAP = {
    secoesTotal: ['s', 'ts'], secoesApuradas: ['s', 'st'],
    eleitorado: ['e', 'te'], eleitoradoInstalado: ['e', 'esi'],
    comparecimento: ['e', 'c'], abstencao: ['e', 'a'], brancos: ['v', 'vb'],
    candidatos: ['carg', 0, 'agr'], candLista: 'cand', candPartidos: 'par', candNumero: 'n', candVotos: 'vap',
    abLista: ['abr'], abCodigo: 'cdabr', abSecoesApuradas: ['s', 'st'], abSecoesTotal: ['s', 'ts']      // acompanhamento da UF (EA15)
  };

  function get(obj, path) {
    var cur = obj;
    for (var i = 0; i < path.length; i++) { if (cur === null || cur === undefined) return undefined; cur = cur[path[i]]; }
    return cur;
  }
  /* "1.234.567" (separador de milhar) -> 1234567; demais textos seguem Number(). */
  function toNum(v) {
    if (v === null || v === undefined || v === '') return null;
    var s = typeof v === 'number' ? v : String(v).trim();
    if (typeof s === 'string' && /^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    var n = typeof s === 'number' ? s : Number(s);
    return isFinite(n) ? n : null;
  }

  /* EA20 agrupa candidaturas em partidos/coligações e pode ter vários grupos em agr[].
   * Se o caminho normal não achar nenhum candidato, faz busca profunda (máx. 8 níveis) em json.carg (ou json) pela chave candLista. */
  function candidates(json, map) {
    map = map || MAP;
    var candKey = map.candLista || 'cand', numKey = map.candNumero, out = [], seen = {};
    function add(list) {
      list.forEach(function (c) {
        if (!c || typeof c !== 'object') return;
        var key = String(c[numKey]);
        if (!seen[key]) { seen[key] = true; out.push(c); }
      });
    }
    function walk(value) {
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (!value || typeof value !== 'object') return;
      var list = value[candKey];
      if (Array.isArray(list)) add(list);
      var parties = value[map.candPartidos || 'par'];
      if (Array.isArray(parties)) walk(parties);
    }
    walk(get(json, map.candidatos));
    if (!out.length) {
      (function deep(node, depth) {
        if (depth > 8 || !node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(function (x) { deep(x, depth + 1); }); return; }
        if (Array.isArray(node[candKey])) add(node[candKey]);
        Object.keys(node).forEach(function (k) { if (k !== candKey) deep(node[k], depth + 1); });
      })(json && json.carg !== undefined ? json.carg : json, 0);
    }
    return out;
  }

  /* Resultado de UMA abrangência (BR, UF, município ou zona) -> { ok, y:[L,F,B,N,A], E, s, st } ou { ok:false, missing:[...] }.
   * Só vale para o 2º turno (2 candidatos): N (nulos) é DERIVADO = comparecimento - L - F - brancos. */
  function parseResultado(json, nums, map) {
    map = map || MAP;
    var miss = [];
    function g(nome, path) { var n = toNum(get(json, path)); if (n === null) miss.push(nome); return n; }
    var c = g('comparecimento', map.comparecimento), a = g('abstencao', map.abstencao), b = g('brancos', map.brancos);
    var L = null, F = null, list = candidates(json, map);
    list.forEach(function (cd) {
      var n = String(cd[map.candNumero]);
      if (n === String(nums.L)) L = toNum(cd[map.candVotos]);
      if (n === String(nums.F)) F = toNum(cd[map.candVotos]);
    });
    if (L === null) miss.push('candidato ' + nums.L);
    if (F === null) miss.push('candidato ' + nums.F);
    if (miss.length) return { ok: false, missing: miss };
    var N = Math.max(0, c - L - F - b);
    var E = toNum(get(json, map.eleitoradoInstalado));
    if (E === null) E = toNum(get(json, map.eleitorado));
    return { ok: true, y: [L, F, b, N, a], E: E, s: toNum(get(json, map.secoesTotal)), st: toNum(get(json, map.secoesApuradas)) };
  }

  /* Horário da totalização do TSE (campos dt/ht = data/hora da apuração; dg/hg = alternativos) -> { dt, ht, dg, hg, label }. */
  function parseTseTime(json) {
    function s(v) { return (v === undefined || v === null || v === '') ? null : String(v); }
    var j = json || {};
    var dt = s(j.dt), ht = s(j.ht), dg = s(j.dg), hg = s(j.hg);
    var label = (dt && ht) ? dt + ' ' + ht : ((dg && hg) ? dg + ' ' + hg : null);
    return { dt: dt, ht: ht, dg: dg, hg: hg, label: label };
  }

  /* Acompanhamento da UF (EA15) -> [{mun, st, s}] ou null se a estrutura não for a esperada (então o poller faz varredura). */
  function parseAcompanhamento(json, map) {
    map = map || MAP;
    var list = get(json, map.abLista);
    if (!Array.isArray(list) || !list.length) return null;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i], cod = it[map.abCodigo], st = toNum(get(it, map.abSecoesApuradas)), s = toNum(get(it, map.abSecoesTotal));
      if (cod === undefined || st === null) return null;
      out.push({ mun: String(cod), st: st, s: s });
    }
    return out;
  }

  function withTimeout(p, ms) {
    return new Promise(function (resolve) {
      var done = false, t = setTimeout(function () { if (!done) { done = true; resolve(null); } }, ms);
      p.then(function (v) { if (!done) { done = true; clearTimeout(t); resolve(v); } },
             function () { if (!done) { done = true; clearTimeout(t); resolve(null); } });
    });
  }

  /* Poller. cfg: { q (T2FetchQ), urls (makeUrls), state (T2State), units:[{id,uf,mun,zona,E}], nums:{L,F}, startMs, mode:'auto'|'sweep', ... }
   * Ciclo: BR (totalização nacional) -> canário (1x) -> acompanhamento EA15 por UF -> unidades que mudaram (ou varredura). */
  function createPoller(cfg) {
    var o = {
      intervalMs: 30000, finalIntervalMs: 300000, deadlineMs: 25000, maxBackoffMs: 120000, budget: 300, startMs: 0,
      now: function () { return Date.now(); }, nums: { L: '13', F: '22' }, mode: 'auto',
      mapRes: MAP, mapAb: MAP, onCycle: null
    };
    for (var k in cfg) if (cfg[k] !== undefined) o[k] = cfg[k];
    var q = o.q, urls = o.urls, state = o.state;
    var byMun = {}, ufs = [], seenUf = {};
    o.units.forEach(function (u) {
      var key = u.uf + '|' + pad(u.mun, 5);
      (byMun[key] = byMun[key] || []).push(u);
      if (!seenUf[u.uf]) { seenUf[u.uf] = true; ufs.push(u.uf); }
    });
    var lastSt = {}, lastFetch = {}, finalU = {}, brokenU = {}, abState = {}, inflight = {};
    var canaryOk = false, timer = null, stopped = true, busy = false, gen = 0;
    var RETRY_404_MS = 300000;   // unidade que deu 404 só volta a ser tentada depois de 5 min
    function isBroken(u) { return !!brokenU[u.id] && brokenU[u.id] > o.now(); }
    var st = {
      phase: 'idle', cycles: 0, official: null, officialTs: 0, fetched: 0, parseFailures: 0, notFound: 0, errors: [],
      lastCycleMs: 0, lastPicks: 0, mode: o.mode,
      lastOkTs: 0, lastContactTs: 0, lastAttemptTs: 0, consecutiveFailures: 0, lastFailure: null,
      busy: false, running: false, nextCycleAt: 0, intervalMs: o.intervalMs, finalIntervalMs: o.finalIntervalMs, startMs: o.startMs
    };

    function unitUrl(u) {
      var key = u.uf + '|' + pad(u.mun, 5);
      return byMun[key].length === 1 ? urls.resMun(u.uf, u.mun) : urls.resZona(u.uf, u.mun, u.zona);
    }
    function logErr(e) { e.at = o.now(); st.errors.unshift(e); if (st.errors.length > 30) st.errors.length = 30; }
    function failure(kind, status) { st.consecutiveFailures++; st.lastFailure = { kind: kind, status: status || 0, at: o.now() }; }
    function kindOf(r) {
      if (r.error === 'blocked') return 'blocked';
      return r.error || (r.status >= 500 ? 'http' : (r.status === 200 && !r.json ? 'json' : 'http'));
    }
    function emit(summary) {
      if (o.onCycle) { try { o.onCycle(summary); } catch (e) { logErr({ id: 'onCycle', erro: String(e && e.message || e) }); } }
      return summary;
    }
    function officialComplete() { return !!(st.official && st.official.s > 0 && st.official.st >= st.official.s); }

    async function fetchUnit(u, okIds, t0) {
      inflight[u.id] = true;
      try {
        var r = await q.get(unitUrl(u), { priority: 10 + Math.min(40, Math.floor((u.E || 0) / 50000)), deadline: t0 + o.deadlineMs });
        if (r.status === 404) { st.notFound++; brokenU[u.id] = o.now() + RETRY_404_MS; logErr({ id: u.id, erro: '404' }); return; }
        if (r.status !== 200 || !r.json) { if (r.error !== 'expired') logErr({ id: u.id, erro: r.error || ('http ' + r.status) }); return; }
        var p = parseResultado(r.json, o.nums, o.mapRes);
        if (!p.ok) { st.parseFailures++; logErr({ id: u.id, erro: 'campos ausentes: ' + p.missing.join(',') }); return; }
        state.update(u.id, { y: p.y, E: p.E, s: p.s, st: p.st, ts: o.now() });
        lastFetch[u.id] = o.now(); st.fetched++; okIds[u.id] = true;
        if (p.s > 0 && p.st >= p.s) finalU[u.id] = true;
      } finally { delete inflight[u.id]; }
    }

    /* Canário: testa os dois tipos de URL (unidade de município de 1 zona e zona de município com várias).
     * fatal = a resposta mostra que o formato mudou (404 ou JSON sem campos); qualquer outra falha é transitória. */
    async function canary(t0) {
      var single = null, multi = null;
      o.units.forEach(function (u) {
        if (byMun[u.uf + '|' + pad(u.mun, 5)].length > 1) { if (!multi || u.E > multi.E) multi = u; }
        else if (!single || u.E > single.E) single = u;
      });
      var tests = [single, multi].filter(Boolean);
      for (var i = 0; i < tests.length; i++) {
        var r = await q.get(unitUrl(tests[i]), { priority: 100, deadline: t0 + o.deadlineMs });
        if (r.status === 404) return { ok: false, fatal: true, motivo: 'canário ' + tests[i].id + ': 404' };
        if (r.status !== 200 || !r.json) return { ok: false, fatal: false, motivo: 'canário ' + tests[i].id + ': ' + (r.error || r.status) };
        var p = parseResultado(r.json, o.nums, o.mapRes);
        if (!p.ok) return { ok: false, fatal: true, motivo: 'canário sem campos: ' + p.missing.join(',') };
      }
      return { ok: true };
    }

    function sweepPick(list, n) {
      var t = o.now();
      return list.filter(function (u) { return !finalU[u.id] && !isBroken(u) && !inflight[u.id]; })
        .map(function (u) { return { u: u, score: (t - (lastFetch[u.id] || 0)) * (1 + (u.E || 0) / 20000) }; })
        .sort(function (a, b) { return b.score - a.score; }).slice(0, n).map(function (x) { return x.u; });
    }

    async function cycleInner() {
      var t0 = o.now();
      if (t0 < o.startMs) { st.phase = 'pre'; return { phase: 'pre' }; }
      st.lastAttemptTs = t0;
      var br = await q.get(urls.resBR, { priority: 100, negTtlMs: 20000 });
      if (br.status === 404) {
        if (st.phase === 'live' || st.phase === 'final') {          // já tínhamos dados: 404 aqui é transitório
          failure('http', 404); logErr({ id: 'BR', erro: '404 transitório' });
          return emit({ phase: st.phase, transient: true });
        }
        st.phase = 'waiting';
        if (!br.cached) st.lastContactTs = o.now();
        st.consecutiveFailures = 0; st.lastFailure = null;
        return emit({ phase: 'waiting' });
      }
      if (br.status !== 200 || !br.json) {                          // falha transitória: mantém o último dado bom
        failure(kindOf(br), br.status);
        logErr({ id: 'BR', erro: br.error || ('http ' + br.status) });
        return emit({ phase: st.phase, transient: true });
      }
      st.lastOkTs = st.lastContactTs = o.now();
      st.consecutiveFailures = 0; st.lastFailure = null;
      var pb = parseResultado(br.json, o.nums, o.mapRes);
      if (pb.ok) { st.official = { y: pb.y, E: pb.E, s: pb.s, st: pb.st, tse: parseTseTime(br.json) }; st.officialTs = o.now(); }
      else logErr({ id: 'BR', erro: 'campos ausentes: ' + pb.missing.join(',') });
      if (!canaryOk) {
        var c = await canary(t0);
        if (!c.ok) {
          logErr({ id: 'canário', erro: c.motivo });
          if (c.fatal) { st.phase = 'error'; return emit({ phase: 'error', motivo: c.motivo }); }
          st.phase = officialComplete() ? 'final' : 'live';           // o BR respondeu: não é falha de conexão
          return emit({ phase: st.phase, transient: true });
        }
        canaryOk = true;
      }
      var picks = [], changed = {}, pending = {};
      if (o.mode !== 'sweep') {
        var rs = await Promise.all(ufs.map(function (uf) { return q.get(urls.acUF(uf), { priority: 60 }); }));
        var broken = [];
        rs.forEach(function (r, i) {
          var uf = ufs[i], list = (r.status === 200 && r.json) ? parseAcompanhamento(r.json, o.mapAb) : null;
          if (!list) { abState[uf] = 'varredura'; broken.push(uf); return; }
          abState[uf] = 'ea15';
          list.forEach(function (it) {
            var key = uf + '|' + pad(it.mun, 5);
            if (byMun[key] && it.st > 0 && it.st !== (lastSt[key] || 0)) { changed[key] = true; pending[key] = it.st; }
          });
        });
        var cand = [];
        Object.keys(changed).forEach(function (key) { byMun[key].forEach(function (u) { if (!finalU[u.id] && !isBroken(u) && !inflight[u.id]) cand.push(u); }); });
        picks = sweepPick(cand, o.budget);                          // mesma prioridade da varredura: zonas nunca lidas primeiro
        if (broken.length) {
          var pool = o.units.filter(function (u) { return broken.indexOf(u.uf) >= 0; });
          sweepPick(pool, Math.max(0, o.budget - picks.length)).forEach(function (u) { picks.push(u); });
        }
      } else {
        picks = sweepPick(o.units, o.budget);
        ufs.forEach(function (uf) { abState[uf] = 'varredura'; });
      }
      var okIds = {};
      await withTimeout(Promise.all(picks.map(function (u) { return fetchUnit(u, okIds, t0); })), o.deadlineMs);
      Object.keys(changed).forEach(function (key) {      // só considera o município "visto" se TODAS as suas zonas pendentes foram lidas
        var all = byMun[key].every(function (u) { return finalU[u.id] || okIds[u.id]; });
        if (all) lastSt[key] = pending[key];
      });
      st.cycles++; st.lastPicks = picks.length; st.lastCycleMs = o.now() - t0;
      st.phase = officialComplete() ? 'final' : 'live';
      return emit({ phase: st.phase, picks: picks.length, fetched: st.fetched });
    }

    /* Uma rodada. Se já há uma em andamento, não faz nada (devolve skipped). */
    async function cycle() {
      if (busy) return { phase: st.phase, skipped: true };
      busy = true; st.busy = true;
      try { return await cycleInner(); }
      finally { busy = false; st.busy = false; }
    }

    /* Espera até a próxima rodada: intervalo normal, 5 min na apuração final, backoff após falhas, respeita pausa do TSE. */
    function delayFor(elapsed) {
      var now = o.now(), wait;
      if (st.phase === 'pre') wait = Math.min(o.intervalMs, Math.max(1000, o.startMs - now));
      else if (st.phase === 'final') wait = o.finalIntervalMs;
      else wait = o.intervalMs;
      if (st.consecutiveFailures > 0) wait = Math.min(o.maxBackoffMs, o.intervalMs * Math.pow(2, Math.min(4, st.consecutiveFailures - 1)));
      var qs = q.stats();
      if (qs.pausedUntil > now) wait = Math.max(wait, qs.pausedUntil - now + 1000);
      return Math.max(1000, wait - (st.phase === 'pre' ? 0 : elapsed));
    }
    async function loop(g) {
      if (g !== gen || stopped) return;
      timer = null;
      var t = o.now();
      try { await cycle(); } catch (e) { logErr({ id: 'ciclo', erro: String(e && e.message || e) }); }
      if (g !== gen || stopped) return;
      var d = delayFor(o.now() - t);
      st.nextCycleAt = o.now() + d;
      timer = setTimeout(function () { kick(g); }, d);
    }
    function kick(g) { loop(g).catch(function (e) { logErr({ id: 'laço', erro: String(e && e.message || e) }); }); }

    function start() { if (!stopped) return; stopped = false; st.running = true; gen++; kick(gen); }
    function stop() { stopped = true; st.running = false; gen++; if (timer) clearTimeout(timer); timer = null; st.nextCycleAt = 0; }
    /* Atualização manual: se parado, inicia; se ocupado, não faz nada (devolve false); senão antecipa a próxima rodada. */
    function refresh() {
      if (stopped) { start(); return true; }
      if (busy) return false;
      if (timer) clearTimeout(timer);
      timer = null; gen++; kick(gen);
      return true;
    }

    /* Aquece o poller com o estado salvo: município já completo no estado não é relido na reabertura do app. */
    function prime(s) {
      var n = 0;
      Object.keys(byMun).forEach(function (key) {
        var us = byMun[key];
        var infos = us.map(function (u) { return (s && s.unitInfo) ? s.unitInfo(u.id) : null; });
        if (!infos.every(function (i) { return i && i.hasData === true; })) return;
        lastSt[key] = infos.reduce(function (acc, i) { return acc + i.st; }, 0);
        infos.forEach(function (info, j) { if (info.s > 0 && info.st >= info.s) finalU[us[j].id] = true; });
        n++;
      });
      if (n > 0) canaryOk = true;                                    // dados vieram de unidades: o formato já foi validado
      return n;
    }

    return {
      cycle: cycle, start: start, stop: stop, refresh: refresh, prime: prime,
      status: function () { return Object.assign({}, st, { abState: abState, queue: q.stats() }); }
    };
  }

  /* Estado da conexão para a tela. Função pura: status (do poller), nowMs, online (navigator.onLine; undefined = true).
   * Devolve { key, label, level: 'ok'|'warn'|'bad'|'info', detail, since, retryAt }. */
  function connectionState(status, nowMs, online) {
    var s = status || {}, now = nowMs, q = s.queue || {}, phase = s.phase || 'idle';
    var fails = s.consecutiveFailures || 0, lf = s.lastFailure || null;
    var lastOk = s.lastOkTs || 0, lastContact = s.lastContactTs || 0, since = lastOk || lastContact || 0;
    function cs(key, label, level, extra) {
      var r = { key: key, label: label, level: level, detail: '', since: 0, retryAt: 0 };
      if (extra) for (var k in extra) r[k] = extra[k];
      return r;
    }
    if (phase === 'pre') return cs('pre', 'PRÉVIA', 'info');
    if (q.pausedUntil > now) return cs('blocked', 'TSE LIMITOU ACESSO', 'bad', { retryAt: q.pausedUntil });
    if (online === false || (fails > 0 && lf && lf.kind === 'network')) return cs('offline', 'SEM CONEXÃO', 'bad', { since: since });
    if (phase === 'error') return cs('error', 'ERRO DE DADOS', 'bad');
    if (phase === 'waiting') {
      if (fails >= 2) return cs('stale', 'ATRASADO', 'warn', { since: since });
      return cs('waiting', 'AGUARDANDO TSE', 'info');
    }
    if (phase === 'idle') return (s.busy || s.running) ? cs('connecting', 'CONECTANDO…', 'info') : cs('paused', 'PAUSADO', 'info');
    if (phase === 'live' || phase === 'final') {
      var iv = phase === 'final' ? (s.finalIntervalMs || 300000) : (s.intervalMs || 30000);
      var staleMs = 2 * iv + 15000, age = now - lastOk;
      if (age > staleMs || fails >= 2) {
        if (s.busy) return cs('connecting', 'ATUALIZANDO…', 'info', { since: lastOk });
        return cs('stale', 'ATRASADO', 'warn', { since: lastOk });
      }
      if (phase === 'final') return cs('final', 'FINAL', 'ok', { since: lastOk });
      return cs('live', 'AO VIVO', 'ok', { since: lastOk });
    }
    return cs('paused', 'PAUSADO', 'info');
  }

  return { BASE: BASE, START_2T_UTC: START_2T_UTC, pad: pad, makeUrls: makeUrls, MAP: MAP, get: get, toNum: toNum, candidates: candidates, parseResultado: parseResultado,
           parseTseTime: parseTseTime, parseAcompanhamento: parseAcompanhamento, createPoller: createPoller, connectionState: connectionState };
});
