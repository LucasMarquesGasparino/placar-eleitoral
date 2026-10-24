/* t2-engine.js — Motor de projeção do 2º turno (Lula x Flávio).
 * Puro: sem DOM, sem rede, sem dependências. Funciona no navegador (window.T2Engine) e no Node (require).
 *
 * VOCABULÁRIO
 *  - "unidade" = par (município, zona). É a menor unidade com resultado ao vivo no TSE (arquivo EA20 de zona).
 *  - LINHAS (origem, 1º turno), K linhas, ex.: ['L','F','CURY','SANTOS','CAIADO','ZEMA','D','B','N','A']
 *  - COLUNAS (destino, 2º turno), SEMPRE 5: ['L','F','B','N','A']  (índices 0..4)
 *  - M = matriz de migração K x 5. Cada LINHA soma 1 (fração do que veio daquela origem para cada destino).
 *  - x  = vetor (K) de eleitores da unidade por origem no 1º turno (soma = eleitorado instalado E).
 *  - y  = vetor (5) apurado no 2º turno até agora (soma = eleitores já apurados ec). null se nada apurado.
 *  - xc, xr (OPCIONAIS, 2T-1.2) = vetores (K) com a composição do 1º turno da parte JÁ APURADA (xc) e do RESTANTE (xr) da unidade.
 *    O motor só usa as proporções (xc/soma(xc), xr/soma(xr)). Sem xc/xr (ou com soma 0) vale x para tudo: comportamento idêntico ao 2T-1.1.
 *    Motivo: dentro da zona as seções que chegam primeiro não têm a composição da zona inteira (ver docs/t2-backtest.md).
 *    estimateMigration e o resíduo do apurado usam xc; a base do restante e o comparecimento do restante usam xr.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.T2Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DST = ['L', 'F', 'B', 'N', 'A'];
  var NDST = 5;

  var DEFAULTS = {
    lambda0: 2000000,  // força do prior da matriz M, em "eleitores equivalentes"
    kappaUf: 50000,    // encolhimento do ajuste local por UF (eleitores equivalentes)
    kappaMun: 4000,    // idem, por município
    kappaZona: 2000,   // idem, por zona (só quando o município tem 2+ unidades)
    iters: 3000,       // máx. de iterações do gradiente projetado
    tol: 1e-12,        // parada antecipada
    turnoutBand: 0.08, // |comparecimento previsto - comparecimento 1T| máximo no restante
    ecMin: 1           // eleitores apurados mínimos para a unidade entrar na regressão
  };

  function merge(base, extra) {
    var o = {}, k;
    for (k in base) o[k] = base[k];
    if (extra) for (k in extra) if (extra[k] !== undefined) o[k] = extra[k];
    return o;
  }
  function sum(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s; }
  function zeros(r, c) { var m = []; for (var i = 0; i < r; i++) m.push(new Array(c).fill(0)); return m; }
  function cloneM(M) { return M.map(function (r) { return r.slice(); }); }

  /* Projeção euclidiana de v no simplex {w >= 0, soma(w) = 1}. */
  function projectSimplex(v) {
    var n = v.length;
    var u = v.slice().sort(function (a, b) { return b - a; });
    var css = 0, theta = 0;
    for (var i = 0; i < n; i++) {
      css += u[i];
      var t = (css - 1) / (i + 1);
      if (u[i] - t > 0) theta = t;
    }
    var out = new Array(n);
    for (var j = 0; j < n; j++) out[j] = Math.max(v[j] - theta, 0);
    return out;
  }

  /* s (K) · M (K x 5) -> vetor (5) */
  function dot(s, M) {
    var out = [0, 0, 0, 0, 0];
    for (var i = 0; i < s.length; i++) {
      var si = s[i];
      if (si) for (var j = 0; j < NDST; j++) out[j] += si * M[i][j];
    }
    return out;
  }

  /* true se v é um vetor com soma positiva (xc/xr úteis). */
  function hasMass(v) { return Array.isArray(v) && sum(v) > 0; }

  /* Estima M por mínimos quadrados ponderados, com linhas no simplex e prior (ridge) em priorM.
   * Cada unidade com y entra com: s = x/soma(x) (partes do 1T), t = y/ec (partes do 2T apurado), peso w = ec.
   * Objetivo: soma_u w*||t - s M||^2 + lambda0 * ||M - priorM||^2 */
  function estimateMigration(units, priorM, opts) {
    var o = merge(DEFAULTS, opts);
    var K = priorM.length;
    var A = zeros(K, K), B = zeros(K, NDST), W = 0, n = 0, i, j, k;
    for (var q = 0; q < units.length; q++) {
      var u = units[q];
      if (!u.y) continue;
      var ec = sum(u.y);
      var xs = hasMass(u.xc) ? u.xc : u.x;      // composição da parte apurada (xc, se houver)
      var sx = sum(xs);
      if (!(ec > o.ecMin) || !(sx > 0)) continue;
      var s = xs.map(function (v) { return v / sx; });
      var t = u.y.map(function (v) { return v / ec; });
      for (i = 0; i < K; i++) {
        if (!s[i]) continue;
        for (j = 0; j < K; j++) A[i][j] += ec * s[i] * s[j];
        for (j = 0; j < NDST; j++) B[i][j] += ec * s[i] * t[j];
      }
      W += ec; n++;
    }
    if (n === 0) return { M: cloneM(priorM), W: 0, n: 0, iterations: 0, dataWeight: 0, rowWeight: priorM.map(function () { return 0; }) };
    var trace = 0;
    for (i = 0; i < K; i++) trace += A[i][i];
    var lam = o.lambda0;
    var step = 1 / (2 * (trace + lam));
    var M = cloneM(opts && opts.warm ? opts.warm : priorM);
    var it;
    for (it = 0; it < o.iters; it++) {
      var Mn = new Array(K), maxd = 0;
      for (i = 0; i < K; i++) {
        var row = new Array(NDST);
        for (j = 0; j < NDST; j++) {
          var g = 0;
          for (k = 0; k < K; k++) g += A[i][k] * M[k][j];
          g = 2 * (g - B[i][j]) + 2 * lam * (M[i][j] - priorM[i][j]);
          row[j] = M[i][j] - step * g;
        }
        row = projectSimplex(row);
        for (j = 0; j < NDST; j++) maxd = Math.max(maxd, Math.abs(row[j] - M[i][j]));
        Mn[i] = row;
      }
      M = Mn;
      if (maxd < o.tol) break;
    }
    // rowWeight[i] ~ quanto os DADOS (e não o prior) mandam na linha i: A_ii / (A_ii + lambda0)
    var rowWeight = [];
    for (i = 0; i < K; i++) rowWeight.push(A[i][i] / (A[i][i] + lam));
    return { M: M, W: W, n: n, iterations: it, dataWeight: W / (W + lam), rowWeight: rowWeight };
  }

  /* Limita o comparecimento previsto do restante a [comp1 - band, comp1 + band]. c = vetor (5) que soma R. */
  function guardTurnout(c, R, comp1, band) {
    if (!(R > 0)) return c;
    var hi = Math.min(1, comp1 + band), lo = Math.max(0, comp1 - band);
    var comp2 = 1 - c[4] / R;
    var target = comp2 > hi ? hi : (comp2 < lo ? lo : comp2);
    if (target === comp2) return c;
    var newA = R * (1 - target);
    var others = c[0] + c[1] + c[2] + c[3];
    var out = c.slice(), j;
    if (others > 0) { var f = (R - newA) / others; for (j = 0; j < 4; j++) out[j] = c[j] * f; }
    else { for (j = 0; j < 4; j++) out[j] = (R - newA) / 4; }
    out[4] = newA;
    return out;
  }

  function addTo(a, b, f) { for (var i = 0; i < a.length; i++) a[i] += b[i] * (f === undefined ? 1 : f); }
  function scaled(a, f) { return a.map(function (v) { return v * f; }); }

  /* Roda um cenário. useLocal=false => sem ajuste local (delta = 0). */
  function runScenario(units, M, useLocal, o) {
    var n = units.length, K = M.length, q, i;
    // 1) preparação por unidade
    var natX = new Array(K).fill(0);
    for (q = 0; q < n; q++) { var sx0 = sum(units[q].x); if (sx0 > 0) for (i = 0; i < K; i++) natX[i] += units[q].x[i]; }
    var natS = sum(natX) > 0 ? scaled(natX, 1 / sum(natX)) : new Array(K).fill(1 / K);
    var P = new Array(n);
    for (q = 0; q < n; q++) {
      var u = units[q];
      var sx = sum(u.x);
      var s = sx > 0 ? scaled(u.x, 1 / sx) : natS.slice();
      var E = (u.E > 0 ? u.E : sx);
      var y = u.y ? u.y.slice() : [0, 0, 0, 0, 0];
      var ec = sum(y);
      if (ec > E) E = ec;
      var R = Math.max(0, E - ec);
      var sC = hasMass(u.xc) ? scaled(u.xc, 1 / sum(u.xc)) : s;   // composição do APURADO (xc) e do RESTANTE (xr); sem eles, a da zona
      var sR = hasMass(u.xr) ? scaled(u.xr, 1 / sum(u.xr)) : s;
      var base = dot(sR, M);                      // distribuição esperada por eleitor no restante
      var baseC = sC === sR ? base : dot(sC, M);  // ... e no apurado (base do resíduo)
      var r = [0, 0, 0, 0, 0];
      if (ec > 0) for (i = 0; i < NDST; i++) r[i] = y[i] - ec * baseC[i];   // resíduo do apurado (soma 0)
      P[q] = { s: sR, E: E, y: y, ec: ec, R: R, base: base, r: r, delta: [0, 0, 0, 0, 0] };
    }
    // 2) ajuste local em cascata UF -> município -> zona
    if (useLocal) {
      var ufs = {}, muns = {};
      for (q = 0; q < n; q++) {
        var ku = units[q].uf, km = units[q].uf + '|' + units[q].mun;
        (ufs[ku] = ufs[ku] || []).push(q);
        (muns[km] = muns[km] || []).push(q);
      }
      var dUf = {}, key;
      for (key in ufs) {
        var rg = [0, 0, 0, 0, 0], ecg = 0;
        ufs[key].forEach(function (idx) { addTo(rg, P[idx].r); ecg += P[idx].ec; });
        dUf[key] = scaled(rg, 1 / (ecg + o.kappaUf));
      }
      for (key in muns) {
        var idxs = muns[key], uf = units[idxs[0]].uf, dg = dUf[uf];
        var ecm = 0, rm = [0, 0, 0, 0, 0];
        idxs.forEach(function (idx) { addTo(rm, P[idx].r); ecm += P[idx].ec; });
        addTo(rm, dg, -ecm);                                   // resíduo após o ajuste da UF
        var dm = dg.slice();
        addTo(dm, rm, 1 / (ecm + o.kappaMun));
        if (idxs.length === 1) { P[idxs[0]].delta = dm; continue; }   // município de 1 zona: a zona É o município
        idxs.forEach(function (idx) {
          var p = P[idx], rz = p.r.slice();
          addTo(rz, dm, -p.ec);
          var dz = dm.slice();
          addTo(dz, rz, 1 / (p.ec + o.kappaZona));
          p.delta = dz;
        });
      }
    }
    // 3) restante projetado, limites e totais
    var perUnit = new Array(n);
    for (q = 0; q < n; q++) {
      var p = P[q], rem;
      if (p.R <= 0) rem = [0, 0, 0, 0, 0];
      else {
        var v = [0, 0, 0, 0, 0];
        for (i = 0; i < NDST; i++) v[i] = p.R * (p.base[i] + p.delta[i]);
        var c = v.map(function (z) { return Math.max(0, z); });
        var sc = sum(c);
        if (!(sc > 0)) { c = scaled(p.base, p.R); sc = sum(c); }
        if (!(sc > 0)) { c = [0, 0, 0, 0, p.R]; sc = p.R; }
        c = scaled(c, p.R / sc);
        var comp1 = 1 - p.s[K - 1];
        rem = guardTurnout(c, p.R, comp1, o.turnoutBand);
      }
      perUnit[q] = { counted: p.y, rem: rem, final: [0, 1, 2, 3, 4].map(function (j) { return p.y[j] + rem[j]; }), E: p.E, ec: p.ec, R: p.R };
    }
    return { perUnit: perUnit, total: aggregate(perUnit, function () { return 'BR'; }).BR };
  }

  /* Agrega perUnit por chave (função keyFn(indice) -> string). */
  function aggregate(perUnit, keyFn) {
    var out = {};
    for (var q = 0; q < perUnit.length; q++) {
      var k = keyFn(q);
      var g = out[k] || (out[k] = { counted: [0, 0, 0, 0, 0], rem: [0, 0, 0, 0, 0], final: [0, 0, 0, 0, 0], E: 0, ec: 0, R: 0 });
      addTo(g.counted, perUnit[q].counted); addTo(g.rem, perUnit[q].rem); addTo(g.final, perUnit[q].final);
      g.E += perUnit[q].E; g.ec += perUnit[q].ec; g.R += perUnit[q].R;
    }
    return out;
  }

  /* Pontos de um vetor (5): % de Lula e Flávio sobre os votos válidos (L+F). */
  function validShares(v) {
    var d = v[0] + v[1];
    return d > 0 ? { L: v[0] / d, F: v[1] / d, valid: d } : { L: 0.5, F: 0.5, valid: 0 };
  }

  /* Função principal. units: [{id, uf, mun, x:[K], E, y:[5]|null}] ; prior: {rows:[K], M:K x 5}. */
  function project(units, prior, opts) {
    var o = merge(DEFAULTS, opts);
    var est = estimateMigration(units, prior.M, o);
    var full = runScenario(units, est.M, true, o);
    var noLocal = runScenario(units, est.M, false, o);
    var priorOnly = runScenario(units, prior.M, false, o);
    var Ls = [full, noLocal, priorOnly].map(function (r) { return validShares(r.total.final).L; });
    return {
      M: est.M, estimate: est,
      scenarios: { full: full, noLocal: noLocal, priorOnly: priorOnly },
      band: { lo: Math.min.apply(null, Ls), hi: Math.max.apply(null, Ls) }
    };
  }

  /* Prior neutro (usado só para estimar o prior de 2022). rows deve conter L,F,D,B,N,A. */
  function neutralPrior(rows) {
    var T = {
      L: [1, 0, 0, 0, 0], F: [0, 1, 0, 0, 0], D: [0.35, 0.35, 0.05, 0.05, 0.2],
      B: [0.1, 0.1, 0.4, 0.2, 0.2], N: [0.1, 0.1, 0.2, 0.4, 0.2], A: [0.02, 0.02, 0.01, 0.01, 0.94]
    };
    return rows.map(function (r) { return (T[r] || T.D).slice(); });
  }

  /* Expande M estimada com linhas reduzidas (ex.: L,F,D,B,N,A) para as linhas completas (candidatos nomeados copiam D). */
  function expandPrior(M, rowsSmall, rowsFull) {
    return rowsFull.map(function (r) {
      var idx = rowsSmall.indexOf(r);
      if (idx < 0) idx = rowsSmall.indexOf('D');
      return M[idx].slice();
    });
  }

  /* Normaliza x para somar E (eleitorado instalado). */
  function normalizeX(x, E) { var s = sum(x); return s > 0 ? scaled(x, E / s) : x.slice(); }

  return {
    DST: DST, DEFAULTS: DEFAULTS,
    projectSimplex: projectSimplex, dot: dot, estimateMigration: estimateMigration,
    guardTurnout: guardTurnout, runScenario: runScenario, aggregate: aggregate,
    validShares: validShares, project: project, neutralPrior: neutralPrior,
    expandPrior: expandPrior, normalizeX: normalizeX
  };
});
