/* t2-sim.js — Gerador sintético DETERMINÍSTICO para testar o motor e ensaiar a apuração.
 * Não usa dados reais. Serve para: (1) testes automáticos, (2) ensaio da tela com "apuração" simulada.
 * Uso: const S = require('./t2-sim.js'); const w = S.makeWorld({seed: 7}); const st = S.stateAt(w, 0.3);
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.T2Sim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ROWS = ['L', 'F', 'CURY', 'SANTOS', 'CAIADO', 'ZEMA', 'D', 'B', 'N', 'A'];
  var M_TRUE = [
    [0.975, 0.004, 0.003, 0.003, 0.015],
    [0.004, 0.975, 0.003, 0.003, 0.015],
    [0.30, 0.35, 0.06, 0.07, 0.22],
    [0.18, 0.30, 0.10, 0.12, 0.30],
    [0.12, 0.62, 0.05, 0.06, 0.15],
    [0.10, 0.65, 0.05, 0.05, 0.15],
    [0.30, 0.30, 0.10, 0.10, 0.20],
    [0.10, 0.10, 0.50, 0.15, 0.15],
    [0.08, 0.08, 0.14, 0.55, 0.15],
    [0.012, 0.012, 0.004, 0.004, 0.968]
  ];

  function rng(seed) {            // mulberry32
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(r) { var u = 0; while (u === 0) u = r(); var v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  function zeroSum5(r, sd) {
    var v = [0, 1, 2, 3, 4].map(function () { return gauss(r) * sd; });
    var m = (v[0] + v[1] + v[2] + v[3] + v[4]) / 5;
    return v.map(function (z) { return z - m; });
  }
  function sum(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s; }

  /* Mundo: { units:[{id,uf,mun,zona,x:[10],E,yFull:[5],t0,dur}], priorM } */
  function makeWorld(opts) {
    opts = opts || {};
    var r = rng(opts.seed || 1);
    var nUf = opts.nUf || 8, nMunPerUf = opts.nMunPerUf || 40;
    var sdUf = opts.sdUf === undefined ? 0.012 : opts.sdUf;
    var sdMun = opts.sdMun === undefined ? 0.010 : opts.sdMun;
    var sdZona = opts.sdZona === undefined ? 0.004 : opts.sdZona;
    var units = [], g, m, z, i;
    for (g = 0; g < nUf; g++) {
      var uf = 'U' + g;
      var baseL = 0.28 + 0.38 * r();                       // % de Lula entre os válidos no UF
      var caiadoBoost = r() < 0.2 ? 0.08 : 0;
      var dUf = zeroSum5(r, sdUf);
      for (m = 0; m < nMunPerUf; m++) {
        var mun = String(10000 + g * 1000 + m);
        var dMun = zeroSum5(r, sdMun);
        var nz = r() < 0.8 ? 1 : 2 + Math.floor(r() * 3);
        for (z = 0; z < nz; z++) {
          var E = Math.round(Math.exp(Math.log(15000) + 0.9 * gauss(r)));
          if (E < 800) E = 800;
          var dZona = zeroSum5(r, sdZona);
          var turnout = Math.min(0.92, Math.max(0.65, 0.79 + 0.04 * gauss(r)));
          var vb = 0.018 + 0.004 * gauss(r), vn = 0.03 + 0.006 * gauss(r);
          if (vb < 0.005) vb = 0.005; if (vn < 0.01) vn = 0.01;
          var others = [0.03 + 0.008 * gauss(r), 0.022 + 0.006 * gauss(r), 0.02 + caiadoBoost + 0.006 * gauss(r), 0.003 + 0.001 * Math.abs(gauss(r)), 0.0015];
          others = others.map(function (v) { return Math.max(0.0005, v); });
          var vL = Math.min(0.9, Math.max(0.1, baseL + 0.05 * gauss(r)));
          var validRest = 1 - sum(others);
          var Lv = vL * validRest, Fv = (1 - vL) * validRest;     // fatias dos votos válidos (soma 1)
          var validFrac = 1 - vb - vn;
          var comp = turnout;
          // x em fração do eleitorado: [L,F,CURY,SANTOS,CAIADO,ZEMA,D,B,N,A]
          var sh = [Lv, Fv, others[0], others[1], others[2], others[3], others[4]].map(function (v) { return v * validFrac * comp; });
          sh.push(vb * comp, vn * comp, 1 - comp);
          var x = sh.map(function (v) { return v * E; });
          // verdade do 2º turno
          var base = [0, 0, 0, 0, 0];
          for (i = 0; i < 10; i++) for (var j = 0; j < 5; j++) base[j] += sh[i] * M_TRUE[i][j];
          var rate = base.map(function (v, j) { return v + dUf[j] + dMun[j] + dZona[j] + gauss(r) * Math.sqrt(Math.max(v * (1 - v), 1e-6) / E); });
          rate = rate.map(function (v) { return Math.max(0, v); });
          var sr = sum(rate); rate = rate.map(function (v) { return v / sr; });
          units.push({ id: uf + '|' + mun + '|' + String(z + 1).padStart(4, '0'), uf: uf, mun: mun, zona: String(z + 1).padStart(4, '0'), x: x, E: E, yFull: rate.map(function (v) { return v * E; }) });
        }
      }
    }
    assignSchedule(units, r);
    var priorM = M_TRUE.map(function (row) {
      var v = row.map(function (z) { return z + 0.04 * gauss(r); });
      return projectSimplexLocal(v);
    });
    return { units: units, priorM: priorM, rows: ROWS, totalE: units.reduce(function (s, u) { return s + u.E; }, 0) };
  }

  function projectSimplexLocal(v) {
    var n = v.length, u = v.slice().sort(function (a, b) { return b - a; }), css = 0, theta = 0, i;
    for (i = 0; i < n; i++) { css += u[i]; var t = (css - 1) / (i + 1); if (u[i] - t > 0) theta = t; }
    return v.map(function (z) { return Math.max(z - theta, 0); });
  }

  /* Cronograma de apuração: unidades pequenas começam e terminam antes. Preenche u.t0 e u.dur (em 0..1).
   * Serve para QUALQUER lista de unidades com campo E (inclusive dados reais de 2022 no ensaio). */
  function assignSchedule(units, r) {
    var order = units.map(function (u, k) { return k; }).sort(function (a, b) { return units[a].E - units[b].E; });
    order.forEach(function (k, rank) {
      var f = rank / Math.max(1, units.length - 1);
      units[k].t0 = 0.02 + 0.5 * (0.7 * Math.pow(f, 0.7) + 0.3 * r());
      units[k].dur = 0.05 + 0.35 * f * (0.5 + r());
    });
    return units;
  }

  /* Estado da apuração no instante tau (0..1): unidades com y parcial (ou null).
   * Aceita o "mundo" (makeWorld) ou diretamente uma lista de unidades com yFull, t0 e dur. */
  function stateAt(worldOrUnits, tau) {
    var list = Array.isArray(worldOrUnits) ? worldOrUnits : worldOrUnits.units;
    return list.map(function (u) {
      var f = tau >= 1 ? 1 : Math.min(1, Math.max(0, (tau - u.t0) / u.dur));
      return { id: u.id, uf: u.uf, mun: u.mun, zona: u.zona, x: u.x, E: u.E, y: f > 0 ? u.yFull.map(function (v) { return v * f; }) : null };
    });
  }

  function truth(worldOrUnits) {
    var list = Array.isArray(worldOrUnits) ? worldOrUnits : worldOrUnits.units;
    var t = [0, 0, 0, 0, 0];
    list.forEach(function (u) { for (var j = 0; j < 5; j++) t[j] += u.yFull[j]; });
    return t;
  }

  /* ENSAIO "1T como 2T": dada uma lista de unidades REAIS {id,uf,mun,x:[10],E}, gera uma verdade oculta do 2º turno
   * (yFull) aplicando M_TRUE + efeitos locais (UF, município, zona) e um cronograma de apuração. Muta e devolve a lista.
   * Serve para ensaiar tela + motor em escala real, sem dados do 2T. Linhas de x devem ser as 10 linhas padrão (ROWS). */
  function fakeSecondRound(units, seed, effects) {
    var r = rng(seed || 1), ef = effects || {}, sdUf = ef.sdUf === undefined ? 0.012 : ef.sdUf,
        sdMun = ef.sdMun === undefined ? 0.010 : ef.sdMun, sdZona = ef.sdZona === undefined ? 0.004 : ef.sdZona;
    var dUf = {}, dMun = {}, i, j;
    units.forEach(function (u) {
      if (!dUf[u.uf]) dUf[u.uf] = zeroSum5(r, sdUf);
      var km = u.uf + '|' + u.mun;
      if (!dMun[km]) dMun[km] = zeroSum5(r, sdMun);
      var dz = zeroSum5(r, sdZona), sx = sum(u.x), base = [0, 0, 0, 0, 0];
      for (i = 0; i < 10; i++) for (j = 0; j < 5; j++) base[j] += (u.x[i] / sx) * M_TRUE[i][j];
      var rate = base.map(function (v, k) { return Math.max(0, v + dUf[u.uf][k] + dMun[km][k] + dz[k] + gauss(r) * Math.sqrt(Math.max(v * (1 - v), 1e-6) / u.E)); });
      var sr = sum(rate);
      u.yFull = rate.map(function (v) { return v / sr * u.E; });
    });
    assignSchedule(units, r);
    return units;
  }

  return { ROWS: ROWS, M_TRUE: M_TRUE, fakeSecondRound: fakeSecondRound, rng: rng, makeWorld: makeWorld, assignSchedule: assignSchedule, stateAt: stateAt, truth: truth };
});
