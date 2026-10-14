/* t2-tse.js — Acesso aos dados do TSE (2º turno): URLs, adaptadores de JSON e "poller" (busca periódica).
 *
 * Esquema EA20/EA15 conferido em amostras oficiais do 1º turno de 2026; ver docs/t2-schema.md.
 * Os caminhos de campos ficam centralizados em MAP. Se uma resposta futura mudar, atualize MAP e os fixtures sem espalhar nomes pelo código.
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
  function toNum(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = typeof v === 'number' ? v : Number(String(v).trim());
    return isFinite(n) ? n : null;
  }

  /* EA20 agrupa candidaturas em partidos/coligações e pode ter vários grupos em agr[]. */
  function candidates(json, map) {
    map = map || MAP;
    var groups = get(json, map.candidatos), out = [], seen = {};
    function walk(value) {
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (!value || typeof value !== 'object') return;
      var list = value[map.candLista || 'cand'];
      if (Array.isArray(list)) list.forEach(function (candidate) {
        var key = String(candidate[map.candNumero]);
        if (!seen[key]) { seen[key] = true; out.push(candidate); }
      });
      var parties = value[map.candPartidos || 'par'];
      if (Array.isArray(parties)) walk(parties);
    }
    walk(groups);
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

  /* Poller. cfg: { q (T2FetchQ), urls (makeUrls), state (T2State), units:[{id,uf,mun,zona,E}], nums:{L,F}, startMs, mode:'auto'|'sweep', ... } */
  function createPoller(cfg) {
    var o = {
      intervalMs: 30000, finalIntervalMs: 300000, deadlineMs: 25000, budget: 300, startMs: 0,
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
    var lastSt = {}, lastFetch = {}, finalU = {}, brokenU = {}, abState = {}, canaryOk = false, timer = null, stopped = true;
    var RETRY_404_MS = 300000;   // unidade que deu 404 só volta a ser tentada depois de 5 min
    function isBroken(u) { return !!brokenU[u.id] && brokenU[u.id] > o.now(); }
    var st = { phase: 'idle', cycles: 0, official: null, fetched: 0, parseFailures: 0, notFound: 0, errors: [], lastCycleMs: 0, lastPicks: 0, mode: o.mode };

    function unitUrl(u) {
      var key = u.uf + '|' + pad(u.mun, 5);
      return byMun[key].length === 1 ? urls.resMun(u.uf, u.mun) : urls.resZona(u.uf, u.mun, u.zona);
    }
    function logErr(e) { if (st.errors.length < 30) st.errors.push(e); }

    async function fetchUnit(u, okIds) {
      var r = await q.get(unitUrl(u), { priority: 10 + Math.min(40, Math.floor((u.E || 0) / 50000)) });
      if (r.status === 404) { st.notFound++; brokenU[u.id] = o.now() + RETRY_404_MS; logErr({ id: u.id, erro: '404' }); return; }
      if (r.status !== 200 || !r.json) { logErr({ id: u.id, erro: r.error || ('http ' + r.status) }); return; }
      var p = parseResultado(r.json, o.nums, o.mapRes);
      if (!p.ok) { st.parseFailures++; logErr({ id: u.id, erro: 'campos ausentes: ' + p.missing.join(',') }); return; }
      state.update(u.id, { y: p.y, E: p.E, s: p.s, st: p.st, ts: o.now() });
      lastFetch[u.id] = o.now(); st.fetched++; okIds[u.id] = true;
      if (p.s > 0 && p.st >= p.s) finalU[u.id] = true;
    }

    async function canary() {          // testa os dois tipos de URL: unidade de município de 1 zona e zona de município com várias
      var single = null, multi = null;
      o.units.forEach(function (u) {
        if (byMun[u.uf + '|' + pad(u.mun, 5)].length > 1) { if (!multi || u.E > multi.E) multi = u; }
        else if (!single || u.E > single.E) single = u;
      });
      var tests = [single, multi].filter(Boolean);
      for (var i = 0; i < tests.length; i++) {
        var r = await q.get(unitUrl(tests[i]), { priority: 100 });
        if (r.status !== 200 || !r.json) return { ok: false, motivo: 'canário ' + tests[i].id + ': ' + (r.error || r.status) };
        var p = parseResultado(r.json, o.nums, o.mapRes);
        if (!p.ok) return { ok: false, motivo: 'canário sem campos: ' + p.missing.join(',') };
      }
      return { ok: true };
    }

    function sweepPick(list, n) {
      var t = o.now();
      return list.filter(function (u) { return !finalU[u.id] && !isBroken(u); })
        .map(function (u) { return { u: u, score: (t - (lastFetch[u.id] || 0)) * (1 + (u.E || 0) / 20000) }; })
        .sort(function (a, b) { return b.score - a.score; }).slice(0, n).map(function (x) { return x.u; });
    }

    async function cycle() {
      var t0 = o.now();
      if (t0 < o.startMs) { st.phase = 'pre'; return { phase: 'pre' }; }
      var br = await q.get(urls.resBR, { priority: 100, negTtlMs: 20000 });
      if (br.status === 404) { st.phase = 'waiting'; return { phase: 'waiting' }; }
      if (br.status !== 200 || !br.json) { st.phase = 'error'; logErr({ id: 'BR', erro: br.error || ('http ' + br.status) }); return { phase: 'error' }; }
      var pb = parseResultado(br.json, o.nums, o.mapRes);
      st.official = pb.ok ? { y: pb.y, E: pb.E, s: pb.s, st: pb.st } : null;
      if (!pb.ok) logErr({ id: 'BR', erro: 'campos ausentes: ' + pb.missing.join(',') });
      if (!canaryOk) {
        var c = await canary();
        if (!c.ok) { st.phase = 'error'; logErr({ id: 'canário', erro: c.motivo }); return { phase: 'error', motivo: c.motivo }; }
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
        Object.keys(changed).forEach(function (key) { byMun[key].forEach(function (u) { if (!finalU[u.id] && !isBroken(u)) picks.push(u); }); });
        picks.sort(function (a, b) { return b.E - a.E; });
        picks = picks.slice(0, o.budget);
        if (broken.length) {
          var pool = o.units.filter(function (u) { return broken.indexOf(u.uf) >= 0; });
          sweepPick(pool, Math.max(0, o.budget - picks.length)).forEach(function (u) { picks.push(u); });
        }
      } else {
        picks = sweepPick(o.units, o.budget);
        ufs.forEach(function (uf) { abState[uf] = 'varredura'; });
      }
      var okIds = {};
      await withTimeout(Promise.all(picks.map(function (u) { return fetchUnit(u, okIds); })), o.deadlineMs);
      Object.keys(changed).forEach(function (key) {      // só considera o município "visto" se TODAS as suas zonas pendentes foram lidas
        var all = byMun[key].every(function (u) { return finalU[u.id] || okIds[u.id]; });
        if (all) lastSt[key] = pending[key];
      });
      st.cycles++; st.lastPicks = picks.length; st.lastCycleMs = o.now() - t0;
      st.phase = (st.official && st.official.s > 0 && st.official.st >= st.official.s) ? 'final' : 'live';
      var summary = { phase: st.phase, picks: picks.length, fetched: st.fetched };
      if (o.onCycle) o.onCycle(summary);
      return summary;
    }

    function schedule(delay) { if (!stopped) timer = setTimeout(loop, delay); }
    async function loop() {
      var t = o.now(), r;
      try { r = await cycle(); } catch (e) { logErr({ id: 'ciclo', erro: String(e && e.message || e) }); r = { phase: 'error' }; }
      var wait = st.phase === 'final' ? o.finalIntervalMs : o.intervalMs;
      schedule(Math.max(1000, wait - (o.now() - t)));
    }
    return {
      cycle: cycle,
      start: function () { if (!stopped) return; stopped = false; loop(); },
      stop: function () { stopped = true; if (timer) clearTimeout(timer); },
      status: function () { return Object.assign({}, st, { abState: abState, queue: q.stats() }); }
    };
  }

  return { BASE: BASE, START_2T_UTC: START_2T_UTC, pad: pad, makeUrls: makeUrls, MAP: MAP, get: get, toNum: toNum, candidates: candidates, parseResultado: parseResultado,
           parseAcompanhamento: parseAcompanhamento, createPoller: createPoller };
});
