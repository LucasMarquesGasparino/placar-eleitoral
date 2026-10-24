/* t2-state.js — Estado da apuração do 2º turno + resumos prontos para a tela. Puro (sem DOM, sem rede).
 * Uso:
 *   var st = T2State.create({ engine: T2Engine, baseline: <base-2026-1t.json>, prior: <prior-2022.json>, fallback22: <fallback-2022.json>.unidades,
 *                              curve: <curva-2026-1t.json> (opcional), opts: { arrivalAlpha: 0.5 } });
 *   st.update('SP|71072|0001', { y:[L,F,B,N,A], E: 123456, s: 300, st: 120 });   // y = ACUMULADO apurado (não incremento)
 *   var out = st.compute();   // out.br, out.ufs, out.migration, out.band, out.forNeed, out.progress, out.uncertainty, out.diagnostics
 *
 * COMPOSIÇÃO DA PARTE APURADA (2T-1.2). Dentro de cada zona as seções que chegam primeiro não têm a composição da zona inteira.
 * Há duas fontes para corrigir isso, e o motor recebe xc (composição do 1T da parte apurada) e xr (do restante) por unidade:
 *  1) CURVA de chegada (curve = data/t2/curva-2026-1t.json, opts.arrivalAlpha, padrão 0,5; 0 desliga): para zonas parciais (0 < st < s)
 *     interpola o desvio d(k) da composição das k primeiras seções (ordem de chegada no 1T26) em k = (st/s)·n e usa
 *     s_C = s_zona + α·d, cortado em >= 0 e renormalizado; xc = s_C·ec; xr = max(0, x_zona − xc), com x_zona normalizado para somar E.
 *  2) xc EXATO (contrato com plugins, ex.: modo "pertença" por seção): st.update(id, { ..., xc: [K números >= 0] }) com os votos/eleitores do
 *     1T26, nas linhas de rows, das seções já apuradas da zona. Tem PRIORIDADE sobre a curva. Regra: xc é normalizado para somar ec
 *     (eleitorado já apurado, soma de y) e xr = max(0, x_zona − xc) componente a componente. xc: null remove. xc inválido (não é vetor
 *     de K números finitos >= 0) rejeita a atualização inteira, como um y inválido. O xc vale até ser trocado, removido ou até reset():
 *     quem o fornece deve reenviá-lo sempre que o st da zona mudar. Sem y (ec = 0) o xc não tem efeito.
 *     Um update só com xc não conta como atualização de dados (não mexe em diagnostics.updates nem lastUpdateTs); só sobe version().
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
  function isVecN(v, n) { return Array.isArray(v) && v.length === n && v.every(function (z) { return typeof z === 'number' && isFinite(z) && z >= 0; }); }
  function isVec5(v) { return isVecN(v, 5); }

  var ARRIVAL_ALPHA_DEFAULT = 0.5;   // fração da curva de chegada aplicada (0 = desliga; validado no ensaio de 2022, ver docs/t2-backtest.md)

  /* FAIXA CALIBRADA (2T-1.2). Erro "típico" da projeção de Lula, em p.p. dos votos válidos, em função do % do eleitorado apurado.
   * Origem: scripts/t2-replay.js sobre o 2T de 2022 com a ORDEM REAL de chegada (prior neutro, 472 mil seções), nacional e dois grupos
   * de UF, grade de 5 min. Regra: 2 × o maior |erro| observado na faixa de apuração, com pisos de 1,5 p.p. até 5%, 0,3 até 60%,
   * 0,2 até 90% e 0,1 depois; monótono não crescente; arredondado para cima a 0,05. Cada par é [apurado até (fração), ± p.p.].
   * ENV_CURVA vale com a curva de chegada ligada (α > 0); ENV_SEM_CURVA, sem ela (maior viés). Regerar com o replay ao mudar α ou o motor. */
  var ENV_CURVA = [[0.05, 4.05], [0.10, 0.75], [0.20, 0.75], [0.30, 0.75], [0.40, 0.75], [0.60, 0.75], [0.90, 0.70], [1, 0.20]];
  var ENV_SEM_CURVA = [[0.05, 4.05], [0.10, 1.65], [0.20, 1.65], [0.30, 1.65], [0.40, 1.65], [0.60, 1.65], [0.90, 1.40], [1, 0.40]];
  function envelopePP(table, p) {
    for (var i = 0; i < table.length; i++) if (p < table[i][0] || i === table.length - 1) return table[i][1];
    return table[table.length - 1][1];
  }

  function create(cfg) {
    var Eng = cfg.engine, baseline = cfg.baseline, prior = cfg.prior, opts = cfg.opts || {};
    var rows = baseline.rows, K = rows.length;
    if (JSON.stringify(rows) !== JSON.stringify(prior.rows)) throw new Error('rows do baseline e do prior são diferentes');
    if (rows[K - 1] !== 'A') throw new Error('a última linha de rows deve ser "A" (abstenção)');

    var alpha = opts.arrivalAlpha === undefined || opts.arrivalAlpha === null ? ARRIVAL_ALPHA_DEFAULT : Number(opts.arrivalAlpha);
    if (!(alpha >= 0)) alpha = 0;
    var curve = null, curveNote = '';
    if (cfg.curve) {
      var cv = cfg.curve;
      if (!cv || cv.v !== 1 || !cv.unidades || typeof cv.unidades !== 'object') curveNote = 'curva de chegada ignorada: formato inesperado';
      else if (JSON.stringify(cv.rows) !== JSON.stringify(rows)) curveNote = 'curva de chegada ignorada: rows diferentes das da base';
      else curve = cv;
    }
    var curveScale = curve && curve.esc > 0 ? curve.esc : 10000;
    var fb22 = cfg.fallback22 || null;   // opcional: { "UF|mmmmm|zzzz": [L,F,B,N,A] } = 2º turno de 2022 da própria unidade
    var units = {}, order = [];
    var diag = { unknownUnits: [], invalidUpdates: 0, regressions: 0, updates: 0, lastUpdateTs: 0, fallback22Used: [], arrivalApplied: 0, membershipApplied: 0 };
    var last = null;
    var version = 0;                     // sobe a cada mudança de dados (update, reset, importState): a tela recalcula só quando muda

    baseline.unidades.forEach(function (u) {
      var Eb = u.E > 0 ? u.E : sum(u.x);
      units[u.id] = { id: u.id, uf: u.uf, mun: u.mun, zona: u.zona, xBase: u.x, Ebase: Eb, E: Eb, y: null, s: u.secoes || 0, st: 0, xc: null };
      order.push(u.id);
    });

    function update(id, upd) {
      var u = units[id];
      if (!u) {
        var p = String(id).split('|');
        if (p.length !== 3) { diag.invalidUpdates++; return false; }
        u = units[id] = { id: id, uf: p[0], mun: p[1], zona: p[2], xBase: new Array(K).fill(0), Ebase: 0, E: 0, y: null, s: 0, st: 0, xc: null };
        order.push(id); diag.unknownUnits.push(id);
      }
      if (upd.xc !== undefined && upd.xc !== null && !isVecN(upd.xc, K)) { diag.invalidUpdates++; return false; }
      if (upd.y !== undefined && upd.y !== null) {
        if (!isVec5(upd.y)) { diag.invalidUpdates++; return false; }
        if (u.y && sum(upd.y) + 1e-9 < sum(u.y)) diag.regressions++;   // totais do TSE são cumulativos; queda = correção/anulação
        u.y = upd.y.slice();
      }
      if (upd.xc === null) u.xc = null;
      else if (upd.xc !== undefined) u.xc = upd.xc.slice();
      if (upd.E > 0) u.E = upd.E;
      if (upd.s !== undefined && upd.s !== null) u.s = upd.s;
      if (upd.st !== undefined && upd.st !== null) u.st = upd.st;
      // update só com xc (plugin de pertença) não é dado novo do TSE: não mexe em updates nem em lastUpdateTs ("Última atualização")
      var dataUpd = (upd.y !== undefined && upd.y !== null) || upd.E > 0 || (upd.s !== undefined && upd.s !== null) || (upd.st !== undefined && upd.st !== null);
      if (dataUpd || upd.xc === undefined) { diag.updates++; diag.lastUpdateTs = upd.ts || Date.now(); }
      version++;
      return true;
    }
    function updateMany(list) { var n = 0; list.forEach(function (r) { if (update(r.id, r)) n++; }); return n; }
    function reset() { order.forEach(function (id) { units[id].y = null; units[id].E = units[id].Ebase; units[id].st = 0; units[id].xc = null; }); last = null; version++; }
    function versionOf() { return version; }

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

    /* Desvio d(k) da curva de chegada (vetor K em fração, não em 10^-4), interpolado linearmente em k = f·n.
     * Pontos: (0, d1), (k1, d1), ..., (k9, d9), (n, 0): antes do 1º ponto vale d1; depois do último cai a 0 em k = n. */
    function curveDelta(cu, f) {
      var ks = cu.k, ds = cu.d, n = cu.n;
      if (!(n > 0) || !Array.isArray(ks) || !ks.length || !Array.isArray(ds) || ds.length !== ks.length) return null;
      var k = f * n, out = new Array(K), i, j;
      if (k <= ks[0]) { for (i = 0; i < K; i++) out[i] = (ds[0][i] || 0) / curveScale; return out; }
      for (j = 0; j < ks.length; j++) {
        var k0 = ks[j], k1 = j + 1 < ks.length ? ks[j + 1] : n;
        if (k <= k1 || j + 1 === ks.length) {
          var w = k1 > k0 ? Math.min(1, Math.max(0, (k - k0) / (k1 - k0))) : 1;
          for (i = 0; i < K; i++) {
            var d0 = ds[j][i] || 0, d1 = j + 1 < ks.length ? (ds[j + 1][i] || 0) : 0;
            out[i] = (d0 + (d1 - d0) * w) / curveScale;
          }
          return out;
        }
      }
      return null;
    }

    /* xc (apurado) e xr (restante) da unidade, ou null. Ver o comentário do topo do arquivo. x = composição da zona já normalizada para somar E. */
    function arrivalSplit(u, x, E, ec) {
      if (!(ec > 0)) return null;
      var i, sx = sum(x), xc;
      if (!(sx > 0)) return null;
      if (u.xc) {                                                  // pertença exata (plugin): prioridade sobre a curva
        var sxc = sum(u.xc);
        if (!(sxc > 0)) return null;
        xc = u.xc.map(function (v) { return v * ec / sxc; });
        diag.membershipApplied++;
      } else {
        if (!(alpha > 0) || !curve || !(u.s > 0) || !(u.st > 0) || !(u.st < u.s)) return null;
        var cu = curve.unidades[u.id];
        if (!cu) return null;
        var d = curveDelta(cu, u.st / u.s);
        if (!d) return null;
        var sc = new Array(K), tot = 0;
        for (i = 0; i < K; i++) { sc[i] = Math.max(0, x[i] / sx + alpha * d[i]); tot += sc[i]; }
        if (!(tot > 0)) return null;
        xc = sc.map(function (v) { return v / tot * ec; });
        diag.arrivalApplied++;
      }
      var xr = new Array(K);
      for (i = 0; i < K; i++) xr[i] = Math.max(0, x[i] - xc[i]);
      return { xc: xc, xr: xr };
    }

    function compute() {
      diag.fallback22Used = [];
      diag.arrivalApplied = 0; diag.membershipApplied = 0;
      var list = order.map(function (id) {
        var u = units[id], E = u.E > 0 ? u.E : u.Ebase, xb = u.xBase, usedFb = false;
        if (!(sum(xb) > 0)) {
          var f = fromFallback(id, E);
          if (f) { xb = f; diag.fallback22Used.push(id); usedFb = true; }
        }
        var x = Eng.normalizeX(xb, E);
        var item = { id: id, uf: u.uf, mun: u.mun, x: x, E: E, y: u.y };
        if (u.y && (!usedFb || u.xc)) {
          var sp = arrivalSplit(u, x, E, sum(u.y));
          if (sp) { item.xc = sp.xc; item.xr = sp.xr; }
        }
        return item;
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
      // faixa calibrada: ±pp em torno de Lula nos válidos; apuração 100% (nada a projetar; todas as seções) = sem incerteza
      var unc = { pp: 0, lo: br.finalShare.L, hi: br.finalShare.L };
      if (br.R > 1e-6 * br.E && !(secTotal > 0 && secCounted >= secTotal)) {
        var ppU = envelopePP(curve && alpha > 0 ? ENV_CURVA : ENV_SEM_CURVA, br.progressPct);
        unc = { pp: ppU, lo: Math.max(0, br.finalShare.L - ppU / 100), hi: Math.min(1, br.finalShare.L + ppU / 100) };
      }
      last = { list: list, perUnit: full.perUnit };
      return {
        at: Date.now(),
        progress: { electorateCountedPct: br.progressPct, unitsWithData: withData, unitsTotal: order.length, sectionsCounted: secCounted, sectionsTotal: secTotal },
        br: br, ufs: ufs, migration: migration,
        scenarios: { full: br, noLocal: sc(r.scenarios.noLocal), priorOnly: sc(r.scenarios.priorOnly) },
        band: r.band, uncertainty: unc, forNeed: forNeed,
        diagnostics: { unknownUnits: diag.unknownUnits.slice(), fallback22Used: diag.fallback22Used.slice(), invalidUpdates: diag.invalidUpdates, regressions: diag.regressions, updates: diag.updates, lastUpdateTs: diag.lastUpdateTs,
                       arrivalApplied: diag.arrivalApplied, membershipApplied: diag.membershipApplied, arrivalAlpha: curve ? alpha : 0,
                       curveLoaded: !!curve, curveUnits: curve ? Object.keys(curve.unidades).length : 0, curveNote: curveNote }
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

    /* lastUpdateTs = horário dos dados (não do salvamento); savedAt = quando foi gravado. */
    function exportState() {
      var out = { v: 1, updates: {}, lastUpdateTs: diag.lastUpdateTs, savedAt: Date.now() };
      order.forEach(function (id) {
        var u = units[id];
        if (!u.y) return;
        out.updates[id] = { y: u.y, E: u.E, s: u.s, st: u.st };
        if (u.xc) out.updates[id].xc = u.xc;
      });
      return out;
    }
    function importState(obj) {
      if (!obj || obj.v !== 1 || !obj.updates || typeof obj.updates !== 'object') return 0;
      var n = 0; Object.keys(obj.updates).forEach(function (id) { if (update(id, obj.updates[id])) n++; });
      diag.lastUpdateTs = Number(obj.lastUpdateTs) || 0;               // preserva o horário SALVO (nunca Date.now())
      version++;
      return n;
    }

    /* Situação de UMA unidade (usada pelo poller ao reabrir o app): null se não existe. */
    function unitInfo(id) {
      var u = units[id];
      if (!u) return null;
      return { st: u.st || 0, s: u.s || 0, hasData: !!u.y };
    }

    return { update: update, updateMany: updateMany, reset: reset, version: versionOf, compute: compute, municipios: municipios, exportState: exportState, importState: importState, unitInfo: unitInfo, _units: units };
  }

  return { create: create, LABELS: LABELS, DST: DST, ARRIVAL_ALPHA_DEFAULT: ARRIVAL_ALPHA_DEFAULT, ENV_CURVA: ENV_CURVA, ENV_SEM_CURVA: ENV_SEM_CURVA, envelopePP: envelopePP };
});
