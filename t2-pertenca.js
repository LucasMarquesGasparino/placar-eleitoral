/* t2-pertenca.js — "Pertença": quais seções de cada zona já foram apuradas (índice "cs" do TSE) -> xc exato da zona. Puro (sem DOM, sem rede).
 *
 * Ideia (Plano B, docs/t2-secao.md): com a lista das seções já publicadas e o x de CADA seção no 1º turno de 2026
 * (data/t2/secoes/<uf>.json), o xc de uma zona é a soma dos x das seções publicadas. O motor usa esse xc no lugar da
 * composição da zona inteira (T2State.update(id, {xc})) e corrige o viés de "as primeiras seções são diferentes das últimas".
 *
 * Formato do cs (resultados.tse.jus.br/oficial/ele2026/arquivo-urna/<pleito>/config/<uf>/<uf>-p00<pleito>-cs.json):
 *   { dg, hg, idg, f, cdp, abr:[ { cd:"ac", ds:"ACRE", mu:[ { cd:"01066", nm, zon:[ { cd:"0004", sec:[
 *       { ns:"0077", da:"04/10/2026", ha:"21:08:17" },                 // principal publicada (carimbo)
 *       { ns:"0078" },                                                   // principal ainda não publicada
 *       { ns:"0229", nsa:["0270"], da, ha },                             // principal COM seção agregada (a agregada é a "0270")
 *       { ns:"0270", nsp:"0229" } ] } ] } ] } ] }                        // seção AGREGADA: sem carimbo próprio; não conta em s.ts nem tem linha nos dados abertos
 *
 * Uso:
 *   var cs = T2Pertenca.parseCs(jsonDoCs);                     // { uf, zonas:{ "AC|01066|0004": { total, publicadas:[...], ultimoCarimbo } }, ... }
 *   var r = T2Pertenca.xcPorZona(secoesUf, cs, function (id) { return state.unitInfo(id); }, { now: Date.now(), anteriores: {id:true} });
 *   // r.xc = { id: [K números] | null }, r.stats = { ... }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.T2Pertenca = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }

  /* "04/10/2026" + "21:08:17" (horário de Brasília, UTC-3 sem horário de verão) -> ms desde 1970; 0 se inválido. */
  function parseCarimbo(da, ha) {
    var d = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(da || '').trim());
    var h = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(ha || '').trim());
    if (!d || !h) return 0;
    var t = Date.UTC(+d[3], +d[2] - 1, +d[1], +h[1] + 3, +h[2], +(h[3] || 0));
    return isFinite(t) ? t : 0;
  }

  /* Seção publicada = tem carimbo (da/ha). Tolerante: aceita também um campo de hash, se o TSE passar a usar. */
  function publicada(sec) { return !!(sec && (sec.da || sec.ha || sec.hash || sec.hs)); }

  /* cs -> { uf, ufs:[...], zonas:{ id:{ total, publicadas:[ns], agregadas, ultimoCarimbo } }, total, publicadas, agregadas, ultimoCarimbo, valido }.
   * Nunca lança: entrada fora do formato dá valido:false e zonas vazias. */
  function parseCs(json) {
    var out = { uf: null, ufs: [], zonas: {}, total: 0, publicadas: 0, agregadas: 0, ultimoCarimbo: 0, valido: false };
    var abr = json && json.abr;
    if (!Array.isArray(abr)) return out;
    abr.forEach(function (a) {
      if (!a || typeof a !== 'object' || !Array.isArray(a.mu)) return;
      var uf = String(a.cd || '').toUpperCase();
      if (!uf) return;
      if (out.ufs.indexOf(uf) < 0) out.ufs.push(uf);
      a.mu.forEach(function (mu) {
        if (!mu || !Array.isArray(mu.zon)) return;
        var mun = pad(mu.cd, 5);
        mu.zon.forEach(function (z) {
          if (!z || !Array.isArray(z.sec)) return;
          var id = uf + '|' + mun + '|' + pad(z.cd, 4);
          var zz = { total: 0, publicadas: [], agregadas: 0, ultimoCarimbo: 0 };
          z.sec.forEach(function (s) {
            if (!s || s.ns === undefined) return;
            if (s.nsp !== undefined && s.nsp !== null && s.nsp !== '') { zz.agregadas++; return; }   // agregada: votos vão na principal
            zz.total++;
            if (publicada(s)) {
              zz.publicadas.push(pad(s.ns, 4));
              var t = parseCarimbo(s.da, s.ha);
              if (t > zz.ultimoCarimbo) zz.ultimoCarimbo = t;
            }
          });
          out.zonas[id] = zz;
          out.total += zz.total; out.publicadas += zz.publicadas.length; out.agregadas += zz.agregadas;
          if (zz.ultimoCarimbo > out.ultimoCarimbo) out.ultimoCarimbo = zz.ultimoCarimbo;
        });
      });
    });
    out.uf = out.ufs[0] || null;
    out.valido = out.ufs.length > 0;
    return out;
  }

  var PADRAO = {
    tolPct: 0.10,      // |publicadas no cs - st oficial| <= 10% de st ...
    tolMinAbs: 1,      // ... mas nunca menos que 1 seção (zonas pequenas)
    tolLista: 0.10,    // lista de seções do cs vs. lista do 1T: diferença máxima de 10%
    minCover: 0.9,     // pelo menos 90% das seções publicadas precisam existir no arquivo do 1T (senão o xc ficaria muito incompleto)
    now: 0             // relógio (ms) para a defasagem
  };

  function infoDe(unitInfo, id) {
    try {
      var f = typeof unitInfo === 'function' ? unitInfo : (unitInfo && typeof unitInfo.unitInfo === 'function' ? unitInfo.unitInfo.bind(unitInfo) : null);
      return f ? f(id) : null;
    } catch (e) { return null; }
  }

  /* xc das zonas de UMA UF.
   *   secoesUf: conteúdo de data/t2/secoes/<uf>.json  { rows, zonas:{ id:{ ns:[x...] } } }
   *   cs:       resultado de parseCs (da mesma UF)
   *   unitInfo: id -> { st, s, hasData } | null  (ou um objeto com .unitInfo, como o T2State)
   *   opts:     { tolPct, tolMinAbs, tolLista, minCover, now, anteriores:{ id:true } (zonas que já tinham xc enviado), todas:[ids] }
   * Devolve { xc, stats }. xc[id] = vetor (soma dos x das seções publicadas) para zonas parciais e coerentes;
   * xc[id] = null para zonas em `anteriores` que deixaram de ser coerentes (inclusive as que ficaram completas). */
  function xcPorZona(secoesUf, cs, unitInfo, opts) {
    var o = {}; for (var k in PADRAO) o[k] = PADRAO[k];
    if (opts) for (var k2 in opts) if (opts[k2] !== undefined) o[k2] = opts[k2];
    var ant = o.anteriores || {};
    var xc = {};
    var st = {
      parciais: 0, comXc: 0, semCs: 0, semBase: 0, listaDifere: 0, contagemFora: 0, coberturaBaixa: 0, anulados: 0,
      publicadasCs: 0, stOficial: 0, razao: null, cobertura: 0, defasagemMs: null, ultimoCarimbo: cs && cs.ultimoCarimbo || 0, eleitoradoComXc: 0
    };
    var zonasSecoes = (secoesUf && secoesUf.zonas) || {};
    var czs = (cs && cs.zonas) || {};
    var ids = o.todas || Object.keys(zonasSecoes);
    var K = secoesUf && secoesUf.rows ? secoesUf.rows.length : 0;

    ids.forEach(function (id) {
      var info = infoDe(unitInfo, id);
      var parcial = !!(info && info.st > 0 && info.s > 0 && info.st < info.s);
      var motivo = null, vec = null;
      if (parcial) {
        st.parciais++;
        var cz = czs[id], bz = zonasSecoes[id];
        if (!cz) { motivo = 'semCs'; st.semCs++; }
        else if (!bz) { motivo = 'semBase'; st.semBase++; }
        else {
          var nBase = Object.keys(bz).length, pub = cz.publicadas, n = pub.length;
          st.publicadasCs += n; st.stOficial += info.st;
          var tol = Math.max(o.tolMinAbs, o.tolPct * info.st);
          if (Math.abs(cz.total - nBase) > Math.max(o.tolMinAbs, o.tolLista * nBase)) { motivo = 'listaDifere'; st.listaDifere++; }
          else if (Math.abs(n - info.st) > tol) { motivo = 'contagemFora'; st.contagemFora++; }
          else {
            vec = new Array(K || 0);
            for (var i = 0; i < vec.length; i++) vec[i] = 0;
            var achadas = 0;
            for (var j = 0; j < n; j++) {
              var x = bz[pub[j]];
              if (!x) continue;
              achadas++;
              if (!vec.length) { vec = new Array(x.length); for (var q0 = 0; q0 < x.length; q0++) vec[q0] = 0; }
              for (var q = 0; q < x.length; q++) vec[q] += x[q];
            }
            if (n === 0 || achadas / n < o.minCover) { motivo = 'coberturaBaixa'; st.coberturaBaixa++; vec = null; }
          }
        }
      }
      if (vec) {
        xc[id] = vec; st.comXc++;
        var e = 0; for (var z = 0; z < vec.length; z++) e += vec[z];
        st.eleitoradoComXc += e;
      } else if (ant[id]) { xc[id] = null; st.anulados++; }
    });

    if (st.stOficial > 0) st.razao = st.publicadasCs / st.stOficial;
    st.cobertura = st.parciais > 0 ? st.comXc / st.parciais : 0;
    if (o.now > 0 && st.ultimoCarimbo > 0) st.defasagemMs = Math.max(0, o.now - st.ultimoCarimbo);
    return { xc: xc, stats: st };
  }

  return { parseCs: parseCs, parseCarimbo: parseCarimbo, xcPorZona: xcPorZona, PADRAO: PADRAO };
});
