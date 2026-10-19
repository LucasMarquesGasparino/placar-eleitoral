/* t2-state.js — Estado da apuração do 2º turno + resumos prontos para a tela. Puro (sem DOM, sem rede).
 * Uso:
 *   var st = T2State.create({ engine: T2Engine, baseline: <base-2026-1t.json>, prior: <prior-2022.json>, fallback22: <fallback-2022.json>.unidades, opts: {} });
 *   st.update('SP|71072|0001', { y:[L,F,B,N,A], E: 123456, s: 300, st: 120 });   // y = ACUMULADO apurado (não incremento)
 *   var out = st.compute();   // out.br, out.ufs, out.migration, out.band, out.forNeed, out.progress, out.diagnostics
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.T2State = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LABELS = { L: 'Lula', F: 'Flávio Bolsonaro', B: 'Brancos', N: 'Nulos', A: 'Abstenções' };
  var DST = ['L', 'F', 'B', 'N', 'A'];

  function sum(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s; }
  function vec2obj(v) { return { L: v[0], F: v[1], B: v[2], N: v[3], A: v[4] }; }
  function isVec5(v) { return Array.isArray(v) && v.length === 5 && v.every(function (z) { return typeof z === 'number' && isFinite(z) && z >= 0; }); }

  function create(cfg) {
    var Eng = cfg.engine, baseline = cfg.baseline, prior = cfg.prior, opts = cfg.opts || {};
    var rows = baseline.rows, K = rows.length;
    if (JSON.stringify(rows) !== JSON.stringify(prior.rows)) throw new Error('rows do baseline e do prior são diferentes');
    if (rows[K - 1] !== 'A') throw new Error('a última linha de rows deve ser "A" (abstenção)');

    var fb22 = cfg.fallback22 || null;   // opcional: { "UF|mmmmm|zzzz": [L,F,B,N,A] } = 2º turno de 2022 da própria unidade
    var units = {}, order = [];
    var diag = { unknownUnits: [], invalidUpdates: 0, regressions: 0, updates: 0, lastUpdateTs: 0, fallback22Used: [] };
    var last = null;

    baseline.unidades.forEach(function (u) {
      var Eb = u.E > 0 ? u.E : sum(u.x);
      units[u.id] = { id: u.id, uf: u.uf, mun: u.mun, zona: u.zona, xBase: u.x, Ebase: Eb, E: Eb, y: null, s: u.secoes || 0, st: 0 };
      order.push(u.id);
    });

    function update(id, upd) {
      var u = units[id];
      if (!u) {
        var p = String(id).split('|');
        if (p.length !== 3) { diag.invalidUpdates++; return false; }
        u = units[id] = { id: id, uf: p[0], mun: p[1], zona: p[2], xBase: new Array(K).fill(0), Ebase: 0, E: 0, y: null, s: 0, st: 0 };
        order.push(id); diag.unknownUnits.push(id);
      }
      if (upd.y !== undefined && upd.y !== null) {
        if (!isVec5(upd.y)) { diag.invalidUpdates++; return false; }
        if (u.y && sum(upd.y) + 1e-9 < sum(u.y)) diag.regressions++;   // totais do TSE são cumulativos; queda = correção/anulação
        u.y = upd.y.slice();
      }
      if (upd.E > 0) u.E = upd.E;
      if (upd.s !== undefined && upd.s !== null) u.s = upd.s;
      if (upd.st !== undefined && upd.st !== null) u.st = upd.st;
      diag.updates++; diag.lastUpdateTs = upd.ts || Date.now();
      return true;
    }
    function updateMany(list) { var n = 0; list.forEach(function (r) { if (update(r.id, r)) n++; }); return n; }
    function reset() { order.forEach(function (id) { units[id].y = null; units[id].E = units[id].Ebase; units[id].st = 0; }); last = null; }

    function view(g) {
      var sc = Eng.validShares(g.counted), sf = Eng.validShares(g.final);
      return {
        E: g.E, ec: g.ec, R: g.R, progressPct: g.E > 0 ? g.ec / g.E : 0,
        counted: vec2obj(g.counted), rem: vec2obj(g.rem), final: vec2obj(g.final),
        countedShare: { L: sc.L, F: sc.F, valid: sc.valid }, finalShare: { L: sf.L, F: sf.F, valid: sf.valid },
        margin: { counted: g.counted[0] - g.counted[1], final: g.final[0] - g.final[1] },
        leaderFinal: g.final[0] === g.final[1] ? null : (g.final[0] > g.final[1] ? 'L' : 'F'),
        turnoutFinal: g.E > 0 ? 1 - g.final[4] / g.E : 0
      };
    }

    /* Unidade SEM base do 1º turno de 2026 (zona nova/desconhecida): usa o 2º turno de 2022 da própria unidade
     * (Lula->L, Bolsonaro->F, brancos, nulos, abstenção) escalado ao eleitorado atual. Sem 2022 também: o motor usa a composição nacional. */
    function fromFallback(id, E) {
      if (!fb22 || !fb22[id] || !(E > 0)) return null;
      var y = fb22[id], t = sum(y);
      if (!(t > 0)) return null;
      var m = { L: y[0], F: y[1], B: y[2], N: y[3], A: y[4] };
      return rows.map(function (r) { return (m[r] || 0) * E / t; });
    }

    function compute() {
      diag.fallback22Used = [];
      var list = order.map(function (id) {
        var u = units[id], E = u.E > 0 ? u.E : u.Ebase, xb = u.xBase;
        if (!(sum(xb) > 0)) {
          var f = fromFallback(id, E);
          if (f) { xb = f; diag.fallback22Used.push(id); }
        }
        return { id: id, uf: u.uf, mun: u.mun, x: Eng.normalizeX(xb, E), E: E, y: u.y };
      });
      var r = Eng.project(list, prior, opts);
      var full = r.scenarios.full;
      var byUf = Eng.aggregate(full.perUnit, function (q) { return list[q].uf; });
      var ufs = {};
      Object.keys(byUf).sort().forEach(function (k) {
        ufs[k] = view(byUf[k]);
        ufs[k].nome = (baseline.ufs && baseline.ufs[k]) || k;
      });
      var br = view(full.total);
      // matriz de migração nacional
      var mass = new Array(K).fill(0);
      list.forEach(function (u) { for (var i = 0; i < K; i++) mass[i] += u.x[i]; });
      var migration = {
        dst: DST, dataWeight: r.estimate.dataWeight, unitsUsed: r.estimate.n, iterations: r.estimate.iterations,
        rows: rows.map(function (key, i) {
          var lab = (baseline.candidatos && baseline.candidatos[key] && baseline.candidatos[key].nome) ||
                    ({ D: 'Demais candidatos', B: 'Brancos', N: 'Nulos', A: 'Abstenções' })[key] || key;
          return { key: key, label: lab, mass: mass[i], to: r.M[i].slice(), weight: r.estimate.rowWeight[i], flows: r.M[i].map(function (m) { return m * mass[i]; }) };
        })
      };
      var sc = function (s) { return view(s.total); };
      // "para virar": quanto dos votos válidos RESTANTES o candidato que está atrás precisa levar
      var forNeed = null;
      if (br.ec > 0) {
        var Lc = br.counted.L, Fc = br.counted.F, Vr = br.rem.L + br.rem.F;
        if (Vr > 0 && Lc !== Fc) {
          var leader = Lc > Fc ? 'L' : 'F', trailer = leader === 'L' ? 'F' : 'L', lead = Math.abs(Lc - Fc);
          forNeed = { leader: leader, trailer: trailer, lead: lead, remainingValid: Vr,
                      trailerNeedShare: (lead + Vr) / (2 * Vr), trailerProjectedShare: br.rem[trailer] / Vr };
        }
      }
      var secCounted = 0, secTotal = 0, withData = 0;
      order.forEach(function (id) { var u = units[id]; secCounted += u.st || 0; secTotal += u.s || 0; if (u.y) withData++; });
      last = { list: list, perUnit: full.perUnit };
      return {
        at: Date.now(),
        progress: { electorateCountedPct: br.progressPct, unitsWithData: withData, unitsTotal: order.length, sectionsCounted: secCounted, sectionsTotal: secTotal },
        br: br, ufs: ufs, migration: migration,
        scenarios: { full: br, noLocal: sc(r.scenarios.noLocal), priorOnly: sc(r.scenarios.priorOnly) },
        band: r.band, forNeed: forNeed,
        diagnostics: { unknownUnits: diag.unknownUnits.slice(), fallback22Used: diag.fallback22Used.slice(), invalidUpdates: diag.invalidUpdates, regressions: diag.regressions, updates: diag.updates, lastUpdateTs: diag.lastUpdateTs }
      };
    }

    /* Municípios de uma UF (do último compute), maiores primeiro. */
    function municipios(uf, limit) {
      if (!last) return [];
      var idx = [];
      last.list.forEach(function (u, q) { if (u.uf === uf) idx.push(q); });
      var per = idx.map(function (q) { return last.perUnit[q]; });
      var agg = Eng.aggregate(per, function (j) { return last.list[idx[j]].mun; });
      return Object.keys(agg).map(function (m) {
        var v = view(agg[m]); v.mun = m;
        v.nome = (baseline.muns && baseline.muns[uf + '|' + m]) || m;
        return v;
      }).sort(function (a, b) { return b.E - a.E; }).slice(0, limit || 20);
    }

    function exportState() {
      var out = { v: 1, updates: {} };
      order.forEach(function (id) { var u = units[id]; if (u.y) out.updates[id] = { y: u.y, E: u.E, s: u.s, st: u.st }; });
      return out;
    }
    function importState(obj) {
      if (!obj || obj.v !== 1) return 0;
      var n = 0; Object.keys(obj.updates).forEach(function (id) { if (update(id, obj.updates[id])) n++; });
      return n;
    }

    /* Situação de UMA unidade (usada pelo poller ao reabrir o app): null se não existe. */
    function unitInfo(id) {
      var u = units[id];
      if (!u) return null;
      return { st: u.st || 0, s: u.s || 0, hasData: !!u.y };
    }

    return { update: update, updateMany: updateMany, reset: reset, compute: compute, municipios: municipios, exportState: exportState, importState: importState, unitInfo: unitInfo, _units: units };
  }

  return { create: create, LABELS: LABELS, DST: DST };
});
