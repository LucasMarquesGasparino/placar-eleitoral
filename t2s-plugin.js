/* t2s-plugin.js — Plugin "Seção" do Placar 2T: manda ao motor o xc EXATO das zonas parciais a partir do índice `cs` do TSE.
 *
 * Contrato com o app (t2.js): window.T2Plugin.init({ state, fetchq, urls, cfg }) depois de criar estado e poller;
 * await T2Plugin.tick() a cada ciclo do poller (erro isolado); T2Plugin.status() = texto curto para os diagnósticos.
 *
 * O que faz a cada tick (no máximo UM cs por tick, em rodízio):
 *   1) escolhe a UF com zonas parciais (0 < st < s) de maior eleitorado parcial e leitura mais antiga (SP no máx. a cada 5 min);
 *   2) lê o cs dessa UF pela fila do app com prioridade BAIXA (abaixo das zonas) e carrega data/t2/secoes/<uf>.json sob demanda;
 *   3) T2Pertenca.xcPorZona -> state.update(id, {xc}) só nas zonas em que as seções publicadas no cs batem com o st oficial (±10%).
 *      Zonas incoerentes ficam sem xc (o motor usa a curva de chegada do 2T-1.2) e, se já tinham, recebem xc:null.
 * Nunca lança. Se o cs não vier ao vivo (404, parado, contagem fora), o app se comporta como o 2T-1.2.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./t2-pertenca.js'));
  else root.T2Plugin = factory(root.T2Pertenca).createPlugin();
})(typeof self !== 'undefined' ? self : this, function (Pertenca) {
  'use strict';

  var BASE_TSE = 'https://resultados.tse.jus.br/oficial';
  var DEFAULTS = {
    pleito: '3221',                 // 2º turno de 2026 (1º = 3220)
    base: BASE_TSE,
    secoesDir: 'data/t2/secoes/',   // relativo à página
    prioridade: 1,                  // fila do app: zonas usam 10..50, BR/canário 100; 0 = padrão
    minIntervaloMs: 90000,          // mesma UF: no mínimo 90 s entre leituras do cs
    minIntervaloUf: { SP: 300000 }, // SP (cs de ~6 MB): no máximo a cada 5 min
    semUtilidadeMs: 300000,         // UF cujo cs não casou com nenhuma zona: só tenta de novo depois de 5 min
    falhaMs: 300000,                // cs ou base de seções com falha: espera 5 min
    xcValidoMs: 900000,             // xc enviado vale no máximo 15 min sem uma leitura nova do cs da UF
    prazoMs: 25000,                 // prazo de cada leitura
    vivoMs: 900000,                 // UF "ao vivo" = leitura útil nos últimos 15 min
    tolPct: 0.10, tolMinAbs: 1, tolLista: 0.10, minCover: 0.9,
    now: function () { return Date.now(); }
  };

  function createPlugin(deps) {
    deps = deps || {};
    var P = deps.pertenca || Pertenca;
    var o = {}; for (var k in DEFAULTS) o[k] = DEFAULTS[k];
    var S = null, Fq = null, urls = null, cfg = null, ready = false, busy = false;
    var fetchLocal = deps.fetchLocal || (typeof fetch === 'function' ? function (u) { return fetch(u); } : null);
    var unitsByUf = null;                       // { UF: [ {id, E} ] }
    var secoes = {};                            // UF -> conteúdo de secoes/<uf>.json
    var secoesLoading = {}, secoesFail = {};    // UF -> promessa / instante da falha
    var lastRead = {}, nextAllowed = {};        // UF -> instante da última leitura / do próximo tentável
    var ufInfo = {};                            // UF -> { at, csOk, comXc, parciais, stats, erro }
    var csCache = {};                           // UF -> { cs, sec, at } (última leitura boa: base da revalidação a cada tick)
    var sent = {};                              // UF -> { id: vetor enviado }
    var lastError = '', ticks = 0, reads = 0;

    function now() { return o.now(); }

    function init(ctx) {
      try {
        S = ctx && ctx.state; Fq = ctx && ctx.fetchq; urls = (ctx && ctx.urls) || null; cfg = (ctx && ctx.cfg) || null;
        var extra = cfg && (cfg.secao || cfg.plugin);
        if (extra && typeof extra === 'object') for (var k in extra) if (k !== 'now' || typeof extra[k] === 'function') o[k] = extra[k];
        if (deps.options) for (var k2 in deps.options) o[k2] = deps.options[k2];
        unitsByUf = null; secoes = {}; secoesLoading = {}; secoesFail = {}; lastRead = {}; nextAllowed = {}; ufInfo = {}; sent = {}; csCache = {};
        lastError = ''; ticks = 0; reads = 0;
        ready = !!(S && typeof S.update === 'function' && typeof S.unitInfo === 'function' && Fq && typeof Fq.get === 'function' && P);
        if (!ready) lastError = 'contexto incompleto';
      } catch (e) { ready = false; lastError = String(e && e.message || e); }
      return ready;
    }

    function csUrl(uf) {
      if (urls && typeof urls.csUF === 'function') { try { return urls.csUF(uf); } catch (e) { /* cai no padrão */ } }
      var pl = String(o.pleito), u = uf.toLowerCase();
      return o.base + '/ele2026/arquivo-urna/' + pl + '/config/' + u + '/' + u + '-p00' + pl + '-cs.json';
    }

    /* Zonas por UF: da lista de unidades do app (cfg.units / cfg.baseline.unidades) ou do próprio estado (state._units). */
    function buildUnits() {
      var src = null;
      if (cfg && Array.isArray(cfg.units)) src = cfg.units;
      else if (cfg && cfg.baseline && Array.isArray(cfg.baseline.unidades)) src = cfg.baseline.unidades;
      else if (S && S._units && typeof S._units === 'object') src = Object.keys(S._units).map(function (id) { return S._units[id]; });
      if (!src) return null;
      var out = {};
      src.forEach(function (u) {
        if (!u || !u.id) return;
        var uf = String(u.uf || String(u.id).split('|')[0]).toUpperCase();
        (out[uf] = out[uf] || []).push({ id: u.id, E: u.E > 0 ? u.E : (u.Ebase > 0 ? u.Ebase : 0) });
      });
      return out;
    }

    /* Resumo das zonas parciais de cada UF (para escolher a próxima leitura). */
    function parciaisPorUf() {
      var res = {};
      Object.keys(unitsByUf).forEach(function (uf) {
        var n = 0, e = 0, total = 0, ocupadas = 0;
        unitsByUf[uf].forEach(function (u) {
          var i = S.unitInfo(u.id);
          total++;
          if (i && i.st > 0 && i.s > 0 && i.st < i.s) { n++; e += (u.E > 0 ? u.E : 1); }
          if (i && i.st > 0) ocupadas++;
        });
        if (n > 0) res[uf] = { n: n, e: e, total: total };
      });
      return res;
    }

    function escolherUf(parc) {
      var t = now(), best = null, bestScore = -1;
      Object.keys(parc).forEach(function (uf) {
        if (nextAllowed[uf] && t < nextAllowed[uf]) return;
        var gap = o.minIntervaloUf[uf] || o.minIntervaloMs;
        if (lastRead[uf] && t - lastRead[uf] < gap) return;
        var idade = lastRead[uf] ? (t - lastRead[uf]) : 600000;    // nunca lida = 10 min de "atraso"
        var score = parc[uf].e * idade;
        if (score > bestScore) { bestScore = score; best = uf; }
      });
      return best;
    }

    function carregarSecoes(uf) {
      if (secoes[uf]) return Promise.resolve(secoes[uf]);
      if (secoesFail[uf] && now() - secoesFail[uf] < o.falhaMs) return Promise.resolve(null);
      if (secoesLoading[uf]) return secoesLoading[uf];
      if (!fetchLocal) return Promise.resolve(null);
      secoesLoading[uf] = (async function () {
        try {
          var r = await fetchLocal(o.secoesDir + uf.toLowerCase() + '.json');
          if (!r || r.ok === false) throw new Error('HTTP ' + (r && r.status));
          var j = await r.json();
          if (!j || !j.zonas || typeof j.zonas !== 'object') throw new Error('formato');
          secoes[uf] = j; delete secoesFail[uf];
          return j;
        } catch (e) { secoesFail[uf] = now(); lastError = 'seções ' + uf + ': ' + String(e && e.message || e); return null; }
        finally { delete secoesLoading[uf]; }
      })();
      return secoesLoading[uf];
    }

    function iguais(a, b) {
      if (!a || !b || a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }

    /* Calcula o xc da UF com o cs em cache e a situação ATUAL das zonas; envia só o que mudou. */
    function aplicar(uf, sec, cs) {
      var res = P.xcPorZona(sec, cs, function (id) { return S.unitInfo(id); }, {
        now: now(), anteriores: sent[uf] || {}, todas: Object.keys(sec.zonas), tolPct: o.tolPct, tolMinAbs: o.tolMinAbs, tolLista: o.tolLista, minCover: o.minCover
      });
      var mem = sent[uf] = sent[uf] || {};
      Object.keys(res.xc).forEach(function (id) {
        var v = res.xc[id];
        if (v === null) {
          if (mem[id]) { S.update(id, { xc: null }); delete mem[id]; }
        } else if (!iguais(mem[id], v)) {
          S.update(id, { xc: v }); mem[id] = v;
        }
      });
      return res;
    }

    async function lerUf(uf, parc) {
      var t0 = now();
      lastRead[uf] = t0; reads++;
      var info = ufInfo[uf] = { at: t0, csOk: false, comXc: 0, parciais: parc[uf].n, stats: null, erro: null };
      var rs = await Promise.all([
        Fq.get(csUrl(uf), { priority: o.prioridade, negTtlMs: o.falhaMs, deadline: t0 + o.prazoMs }),
        carregarSecoes(uf)
      ]);
      var r = rs[0], sec = rs[1];
      if (!r || r.status !== 200 || !r.json) {
        info.erro = r && r.status === 404 ? 'cs 404' : ('cs ' + ((r && (r.error || r.status)) || 'falhou'));
        nextAllowed[uf] = now() + o.falhaMs;       // o xc já enviado segue valendo até xcValidoMs (revalidar)
        return;
      }
      var cs = P.parseCs(r.json);
      if (!cs.valido) { info.erro = 'cs formato'; nextAllowed[uf] = now() + o.falhaMs; return; }
      info.csOk = true;
      if (!sec) { info.erro = 'sem base de seções'; nextAllowed[uf] = now() + o.falhaMs; return; }
      csCache[uf] = { cs: cs, sec: sec, at: t0 };
      var res = aplicar(uf, sec, cs);
      info.stats = res.stats; info.comXc = res.stats.comXc;
      if (res.stats.parciais > 0 && res.stats.comXc === 0) nextAllowed[uf] = now() + o.semUtilidadeMs;
    }

    /* A cada tick, sem rede: confere de novo as zonas que têm xc (o st oficial avança a cada ciclo) e expira o que ficou velho. */
    function revalidar() {
      var t = now();
      Object.keys(sent).forEach(function (uf) {
        var mem = sent[uf], c = csCache[uf];
        if (!mem || !Object.keys(mem).length) return;
        if (!c || t - c.at > o.xcValidoMs) { limparEnviados(uf); if (ufInfo[uf]) ufInfo[uf].comXc = 0; return; }
        var res = aplicar(uf, c.sec, c.cs);
        if (ufInfo[uf] && ufInfo[uf].at === c.at) { ufInfo[uf].stats = res.stats; ufInfo[uf].comXc = res.stats.comXc; }
      });
    }

    function limparEnviados(uf) {   // cs deixou de responder: zonas com xc voltam à curva
      var mem = sent[uf]; if (!mem) return;
      Object.keys(mem).forEach(function (id) { try { S.update(id, { xc: null }); } catch (e) { /* ignora */ } });
      sent[uf] = {};
    }

    async function tick() {
      if (!ready || busy) return;
      busy = true; ticks++;
      try {
        if (!unitsByUf) unitsByUf = buildUnits();
        if (!unitsByUf) { lastError = 'sem lista de unidades'; return; }
        revalidar();
        var parc = parciaisPorUf();
        var uf = escolherUf(parc);
        if (uf) await lerUf(uf, parc);
      } catch (e) { lastError = String(e && e.message || e); }
      finally { busy = false; }
    }

    /* Texto curto para os diagnósticos. */
    function status() {
      try {
        if (!ready) return 'seções: inativo (' + (lastError || 'sem contexto') + ')';
        var t = now(), vivas = 0, zonas = 0, lags = [], lidas = 0, comParcial = 0;
        Object.keys(ufInfo).forEach(function (uf) {
          var i = ufInfo[uf]; lidas++;
          if (i.comXc > 0 && t - i.at <= o.vivoMs) {
            vivas++; zonas += i.comXc;
            if (i.stats && i.stats.defasagemMs !== null && i.stats.defasagemMs !== undefined) lags.push(i.stats.defasagemMs);
          }
        });
        if (vivas > 0) {
          var txt = 'seções: ' + vivas + (vivas === 1 ? ' UF ao vivo' : ' UFs ao vivo') + ' · ' + zonas + (zonas === 1 ? ' zona' : ' zonas');
          if (lags.length) {
            lags.sort(function (a, b) { return a - b; });
            var dm = Math.max(0, Math.round(lags[Math.floor(lags.length / 2)] / 60000));
            txt += dm > 60 ? ' · carimbo mais novo com mais de 1 h' : ' · defasagem ~' + dm + ' min';
          }
          return txt;
        }
        if (unitsByUf) { try { comParcial = Object.keys(parciaisPorUf()).length; } catch (e) { comParcial = 0; } }
        if (lidas > 0) return 'seções: TSE ainda sem lista ao vivo (usando curva)';
        if (comParcial > 0) return 'seções: lendo listas do TSE…';
        return 'seções: aguardando apuração';
      } catch (e) { return 'seções: erro'; }
    }

    /* Para depuração/testes. */
    function info() {
      return { ready: ready, ticks: ticks, reads: reads, lastError: lastError, ufs: JSON.parse(JSON.stringify(ufInfo)), carregadas: Object.keys(secoes), enviadas: Object.keys(sent).reduce(function (a, u) { return a + Object.keys(sent[u]).length; }, 0) };
    }

    return { init: init, tick: tick, status: status, info: info, _options: o };
  }

  return { createPlugin: createPlugin, DEFAULTS: DEFAULTS };
});
