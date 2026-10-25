/* t2-state.js — Estado da apuração do 2º turno + resumos prontos para a tela. Puro (sem DOM, sem rede).
 * Uso:
 *   var st = T2State.create({ engine: T2Engine, baseline: <base-2026-1t.json>, prior: <prior-2022.json>, fallback22: <fallback-2022.json>.unidades,
 *                              curve: <curva-2026-1t.json> (opcional), opts: { arrivalAlpha: 0.5 } });
 *   st.update('SP|71072|0001', { y:[L,F,B,N,A], E: 123456, s: 300, st: 120 });   // y = ACUMULADO apurado (não incremento)
 *   // E = eleitorado da zona INTEIRA (apurado + seções ainda não totalizadas; T2Tse.eleitorado), nunca só o das seções já apuradas
 *   var out = st.compute();   // out.br, out.ufs, out.migration, out.band, out.forNeed, out.progress, out.uncertainty, out.diagnostics
 *
 * COMPOSIÇÃO DA PARTE APURADA (2T-1.2; rampa no 2T-1.3). Dentro de cada zona as seções que chegam primeiro não têm a composição da zona inteira.
 * Há duas fontes para corrigir isso, e o motor recebe xc (composição do 1T da parte apurada) e xr (do restante) por unidade:
 *  1) CURVA de chegada (curve = data/t2/curva-2026-1t.json, opts.arrivalAlpha, padrão 0,8; 0 desliga): para zonas parciais (0 < st < s)
 *     interpola o desvio d(k) da composição das k primeiras seções (ordem de chegada no 1T26) em k = (st/s)·n e usa
 *     s_C = s_zona + α_ef·d, cortado em >= 0 e renormalizado; xc = s_C·ec; xr = max(0, x_zona − xc), com x_zona normalizado para somar E.
 *     α_ef = α·min(1, f/rampa), f = st/s, rampa = opts.arrivalRamp (padrão 0,3; 0 = α constante, como no 2T-1.2). No começo da zona a
 *     ordem do 1T prevê mal a do 2T (em 2022 o α que zerava o viés era ≈0,3 com f < 10% e ≈0,8 depois; ver docs/t2-backtest.md).
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

  var ARRIVAL_ALPHA_DEFAULT = 0.8;   // fração da curva de chegada aplicada com a zona já adiantada (0 = desliga; ensaio de 2022, mantido no 2T-1.4 após o de 2018; docs/t2-backtest.md)
  var CHANCE_TETO = 0.95, CHANCE_ATE = 0.95;   // chance limitada a [5%, 95%] até 95% do eleitorado apurado (2T-1.4)
  var ARRIVAL_RAMP_DEFAULT = 0.3;    // até esta fração apurada da zona o α cresce de 0 até ARRIVAL_ALPHA_DEFAULT (2T-1.3; 0 = sem rampa)

  /* FAIXA CALIBRADA (2T-1.2.1; dois anos no 2T-1.4). Erro da projeção de Lula, em p.p. dos votos válidos, em 100 classes de 1% do eleitorado
   * apurado. Origem: scripts/t2-replay.js sobre os 2º turnos de 2022 (472 mil seções) e 2018 com a ORDEM REAL de chegada (prior neutro),
   * nacional e dois grupos de UF, grade de 5 min mais um ponto a cada 1% apurado de cada escopo. Regra da classe [i%, i+1%), em cada ano:
   * 2 × o maior |erro| observado com apurado entre i−3% e i+4%, com pisos de 1,5 p.p. até 5%, 0,3 até 60%, 0,2 até 90% e 0,1 depois;
   * arredondado para cima a 0,05. A constante é o MÁXIMO, classe a classe, dos dois anos (--combinar). Sem monotonia.
   * Cada par é [apurado até (fração), ± p.p.]. ENV_CURVA vale com a curva de chegada ligada (α > 0); ENV_SEM_CURVA, sem ela (maior viés).
   * Com só dois anos a faixa ainda pode ser superada numa terceira eleição (por isso a chance tem teto; ver compute()).
   * Regerar com o replay ao mudar α ou o motor (node scripts/t2-replay.js nos dois anos e --combinar imprime as três linhas prontas). */
  var ENV_CURVA = [[0.01, 11.55], [0.02, 11.55], [0.03, 11.55], [0.04, 11.55], [0.05, 5.95], [0.06, 5.55], [0.07, 2.9], [0.08, 2.25], [0.09, 1.4], [0.1, 1.3], [0.11, 1.1], [0.12, 1.1], [0.13, 0.8], [0.14, 0.8], [0.15, 0.8], [0.16, 0.8], [0.17, 0.8], [0.18, 0.8], [0.19, 0.8], [0.2, 0.7], [0.21, 0.5], [0.22, 0.5], [0.23, 0.5], [0.24, 0.5], [0.25, 0.5], [0.26, 0.4], [0.27, 0.35], [0.28, 0.4], [0.29, 0.4], [0.3, 0.4], [0.31, 0.4], [0.32, 0.4], [0.33, 0.4], [0.34, 0.55], [0.35, 0.55], [0.36, 0.55], [0.37, 0.6], [0.38, 0.6], [0.39, 0.6], [0.4, 0.6], [0.41, 0.65], [0.42, 0.65], [0.43, 0.65], [0.44, 0.65], [0.45, 0.7], [0.46, 0.75], [0.47, 0.75], [0.48, 0.75], [0.49, 0.8], [0.5, 0.8], [0.51, 0.8], [0.52, 0.8], [0.53, 0.8], [0.54, 0.8], [0.55, 0.8], [0.56, 0.8], [0.57, 0.8], [0.58, 0.85], [0.59, 0.85], [0.6, 0.9], [0.61, 0.9], [0.62, 0.9], [0.63, 0.9], [0.64, 0.9], [0.65, 0.9], [0.66, 0.9], [0.67, 0.9], [0.68, 0.9], [0.69, 0.9], [0.7, 0.9], [0.71, 0.9], [0.72, 0.9], [0.73, 0.85], [0.74, 0.85], [0.75, 0.55], [0.76, 0.55], [0.77, 0.55], [0.78, 0.55], [0.79, 0.5], [0.8, 0.5], [0.81, 0.5], [0.82, 0.35], [0.83, 0.35], [0.84, 0.35], [0.85, 0.3], [0.86, 0.3], [0.87, 0.25], [0.88, 0.2], [0.89, 0.2], [0.9, 0.2], [0.91, 0.2], [0.92, 0.15], [0.93, 0.15], [0.94, 0.15], [0.95, 0.15], [0.96, 0.15], [0.97, 0.15], [0.98, 0.15], [0.99, 0.15], [1, 0.1]];
  var ENV_SEM_CURVA = [[0.01, 11.45], [0.02, 11.45], [0.03, 11.45], [0.04, 11.45], [0.05, 6.3], [0.06, 5.95], [0.07, 3.2], [0.08, 2.65], [0.09, 2.05], [0.1, 2.05], [0.11, 2.05], [0.12, 2.05], [0.13, 2.05], [0.14, 2.05], [0.15, 2.05], [0.16, 2.05], [0.17, 1.95], [0.18, 1.95], [0.19, 1.95], [0.2, 1.95], [0.21, 1.95], [0.22, 1.95], [0.23, 1.9], [0.24, 1.9], [0.25, 1.9], [0.26, 2.0], [0.27, 2.0], [0.28, 2.0], [0.29, 2.0], [0.3, 2.0], [0.31, 2.0], [0.32, 2.0], [0.33, 1.8], [0.34, 1.75], [0.35, 1.75], [0.36, 1.75], [0.37, 1.75], [0.38, 1.7], [0.39, 1.65], [0.4, 1.65], [0.41, 1.65], [0.42, 1.65], [0.43, 1.65], [0.44, 1.65], [0.45, 1.65], [0.46, 1.65], [0.47, 1.65], [0.48, 1.65], [0.49, 1.65], [0.5, 1.65], [0.51, 1.65], [0.52, 1.65], [0.53, 1.65], [0.54, 1.65], [0.55, 1.6], [0.56, 1.55], [0.57, 1.55], [0.58, 1.55], [0.59, 1.55], [0.6, 1.55], [0.61, 1.5], [0.62, 1.5], [0.63, 1.45], [0.64, 1.45], [0.65, 1.4], [0.66, 1.4], [0.67, 1.35], [0.68, 1.35], [0.69, 1.35], [0.7, 1.3], [0.71, 1.25], [0.72, 1.2], [0.73, 1.15], [0.74, 1.15], [0.75, 1.1], [0.76, 1.05], [0.77, 1.05], [0.78, 1.0], [0.79, 0.95], [0.8, 0.9], [0.81, 0.85], [0.82, 0.8], [0.83, 0.8], [0.84, 0.75], [0.85, 0.7], [0.86, 0.65], [0.87, 0.65], [0.88, 0.6], [0.89, 0.6], [0.9, 0.55], [0.91, 0.55], [0.92, 0.5], [0.93, 0.45], [0.94, 0.45], [0.95, 0.4], [0.96, 0.35], [0.97, 0.35], [0.98, 0.3], [0.99, 0.25], [1, 0.2]];
  // ENV_PERTENCA: erro da pertença exata ("oráculo" do ensaio = versão por seção com cobertura total), mesma regra; usada como máx com a da curva.
  var ENV_PERTENCA = [[0.01, 11.6], [0.02, 11.6], [0.03, 11.6], [0.04, 11.6], [0.05, 7.25], [0.06, 6.85], [0.07, 3.2], [0.08, 2.75], [0.09, 1.25], [0.1, 1.35], [0.11, 1.35], [0.12, 1.35], [0.13, 1.55], [0.14, 1.55], [0.15, 1.55], [0.16, 1.55], [0.17, 1.55], [0.18, 1.55], [0.19, 1.55], [0.2, 1.55], [0.21, 1.45], [0.22, 1.35], [0.23, 1.35], [0.24, 1.35], [0.25, 1.35], [0.26, 1.3], [0.27, 1.25], [0.28, 1.15], [0.29, 1.1], [0.3, 1.1], [0.31, 1.0], [0.32, 0.95], [0.33, 0.95], [0.34, 0.95], [0.35, 0.95], [0.36, 0.85], [0.37, 0.85], [0.38, 0.85], [0.39, 0.85], [0.4, 0.85], [0.41, 0.9], [0.42, 0.9], [0.43, 0.9], [0.44, 0.9], [0.45, 0.9], [0.46, 0.9], [0.47, 0.9], [0.48, 0.9], [0.49, 0.9], [0.5, 0.9], [0.51, 0.9], [0.52, 0.9], [0.53, 0.9], [0.54, 0.9], [0.55, 0.9], [0.56, 0.9], [0.57, 0.9], [0.58, 0.75], [0.59, 0.75], [0.6, 0.75], [0.61, 0.75], [0.62, 0.7], [0.63, 0.7], [0.64, 0.7], [0.65, 0.7], [0.66, 0.7], [0.67, 0.7], [0.68, 0.65], [0.69, 0.65], [0.7, 0.65], [0.71, 0.65], [0.72, 0.65], [0.73, 0.65], [0.74, 0.65], [0.75, 0.35], [0.76, 0.35], [0.77, 0.3], [0.78, 0.3], [0.79, 0.3], [0.8, 0.3], [0.81, 0.25], [0.82, 0.25], [0.83, 0.25], [0.84, 0.25], [0.85, 0.25], [0.86, 0.2], [0.87, 0.2], [0.88, 0.2], [0.89, 0.2], [0.9, 0.2], [0.91, 0.2], [0.92, 0.2], [0.93, 0.2], [0.94, 0.2], [0.95, 0.2], [0.96, 0.15], [0.97, 0.15], [0.98, 0.15], [0.99, 0.1], [1, 0.1]];
  function envelopeIndex(table, p) {
    for (var i = 0; i < table.length; i++) if (p < table[i][0]) return i;
    return table.length - 1;
  }
  function envelopePP(table, p) { return table[envelopeIndex(table, p)][1]; }

  /* Distribuição t de Student com 4 graus de liberdade (forma fechada): caudas mais grossas que a normal (2T-1.4). Em z = 2 (borda da
   * faixa, que vale ~2σ) dá 0,942, abaixo do teto de 95% da chance; a normal daria 0,977. */
  function tCdf4(z) { var u = z / Math.sqrt(z * z + 4); return 0.5 + 0.75 * u * (1 - u * u / 3); }

  function create(cfg) {
    var Eng = cfg.engine, baseline = cfg.baseline, prior = cfg.prior, opts = cfg.opts || {};
    var rows = baseline.rows, K = rows.length;
    if (JSON.stringify(rows) !== JSON.stringify(prior.rows)) throw new Error('rows do baseline e do prior são diferentes');
    if (rows[K - 1] !== 'A') throw new Error('a última linha de rows deve ser "A" (abstenção)');

    var alpha = opts.arrivalAlpha === undefined || opts.arrivalAlpha === null ? ARRIVAL_ALPHA_DEFAULT : Number(opts.arrivalAlpha);
    if (!(alpha >= 0)) alpha = 0;
    var ramp = opts.arrivalRamp === undefined || opts.arrivalRamp === null ? ARRIVAL_RAMP_DEFAULT : Number(opts.arrivalRamp);
    if (!(ramp >= 0)) ramp = 0;
    var curve = null, curveNote = '';
    if (cfg.curve) {
      var cv = cfg.curve;
      if (!cv || cv.v !== 1 || !cv.unidades || typeof cv.unidades !== 'object') curveNote = 'curva de chegada ignorada: formato inesperado';
      else if (JSON.stringify(cv.rows) !== JSON.stringify(rows)) curveNote = 'curva de chegada ignorada: rows diferentes das da base';
      else curve = cv;
    }
    var curveScale = curve && curve.esc > 0 ? curve.esc : 10000;
    var fb22 = cfg.fallback22 || null;   // opcional: { "UF|mmmmm|zzzz": [L,F,B,N,A] } = 2º turno de 2022 da própria unidade
    var units = {}, order = [], externalGroups = [], externalRejected = [];
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
    function reset() { order.forEach(function (id) { units[id].y = null; units[id].E = units[id].Ebase; units[id].st = 0; units[id].xc = null; }); externalGroups = []; externalRejected = []; last = null; version++; }
    function versionOf() { return version; }

    /* GRUPOS EXTERNOS (2T-1.6): prévia do exterior antes da totalização do TSE, um grupo por cidade (t2-ext.js). Não entram em
     * exportState(). Em compute() cada grupo substitui as unidades de memberIds (todas ZZ) enquanto o TSE tiver menos urnas delas que o
     * grupo; sai sozinho, cidade a cidade, quando a soma do st oficial das zonas com dado chega ao st do grupo ou quando todas as zonas
     * estão completas no TSE. Grupo sem membro (cidade fora da base do 1º turno) traz xBase (K números, soma > 0) e E.
     * g = { id, name, mun?, country?, memberIds: [...], y: [L,F,B,N,A] das urnas recebidas, E, s, st, xBase?, source?, ts?, urnas?, total?, est? }.
     * s pode passar das seções da base (vale o maior). Devolve { accepted, rejected: [{ id, reason }] }. */
    function setExternalGroups(list) {
      var next = [], reserved = {}, rejected = [];
      (Array.isArray(list) ? list : []).forEach(function (g) {
        var gid = g && typeof g.id === 'string' ? g.id : '';
        function no(reason) { rejected.push({ id: gid || '?', name: String((g && g.name) || gid || '?'), reason: reason }); }
        if (!gid) return no('grupo sem id');
        if (!isVec5(g.y)) return no('votos inválidos');
        var ids = Array.isArray(g.memberIds) ? g.memberIds : [];
        var members = [], seen = {}, xBase = new Array(K).fill(0), Ebase = 0, sections = 0, bad = '';
        ids.forEach(function (id) {
          if (bad) return;
          var u = units[id];
          if (!u) bad = 'zona ' + id + ' fora da base';
          else if (u.uf !== 'ZZ') bad = 'zona ' + id + ' não é do exterior';
          else if (seen[id]) bad = 'zona ' + id + ' repetida';
          else if (reserved[id]) bad = 'zona ' + id + ' já está em outro grupo';
          if (bad) return;
          seen[id] = true; members.push(id); Ebase += u.Ebase; sections += u.s || 0;
          for (var i = 0; i < K; i++) xBase[i] += u.xBase[i] || 0;
        });
        if (bad) return no(bad);
        if (!members.length) {
          if (!isVecN(g.xBase, K) || !(sum(g.xBase) > 0)) return no('cidade sem zona na base e sem composição do 1º turno');
          xBase = g.xBase.slice();
        } else if (!(sum(xBase) > 0)) return no('zonas sem votos no 1º turno');
        var E = Number(g.E), st = Number(g.st), s = Math.max(Number(g.s) || 0, sections);
        if (!isFinite(E) || !(E > 0)) E = Ebase;
        if (!(E > 0)) return no('eleitorado inválido');
        if (!isFinite(st) || st < 0 || Math.floor(st) !== st) return no('urnas recebidas inválidas');
        if (!(s > 0) || st > s) return no('mais urnas recebidas que seções');
        if (sum(g.y) > E) E = sum(g.y);
        var y22 = null;
        if (fb22 && members.length) {
          var history = new Array(5).fill(0), complete = true;
          members.forEach(function (id) {
            var pv = fb22[id];
            if (!isVec5(pv) || !(pv[0] + pv[1] > 0)) { complete = false; return; }
            for (var i = 0; i < 5; i++) history[i] += pv[i];
          });
          if (complete) y22 = history;
        }
        members.forEach(function (id) { reserved[id] = true; });
        var mun = String(g.mun || (members.length ? units[members[0]].mun : gid));
        next.push({ id: 'EXT|' + gid, key: gid, uf: 'ZZ', mun: mun, name: String(g.name || gid), country: String(g.country || ''),
                    memberIds: members, xBase: xBase, Ebase: Ebase, E: E, y: g.y.slice(), s: s, st: st, y22: y22,
                    source: String(g.source || ''), ts: Number(g.ts) || 0, urnas: Number(g.urnas) || st, total: Number(g.total) || s, est: !!g.est });
      });
      externalGroups = next;
      externalRejected = rejected;
      version++;
      return { accepted: next.length, rejected: rejected.slice() };
    }
    /* Situação de um grupo diante do TSE: urnas oficiais das zonas da cidade (só as zonas com dado) e se ele já saiu. */
    function groupHandoff(g) {
      var off = 0, withData = 0, complete = 0;
      g.memberIds.forEach(function (id) {
        var u = units[id];
        if (!u || !u.y) return;
        withData++; off += u.st || 0;
        if (u.s > 0 && u.st >= u.s) complete++;
      });
      var out = withData > 0 && (off >= g.st || complete === g.memberIds.length);
      return { off: off, out: out };
    }
    function clearExternalGroups() {
      if (!externalGroups.length) return false;
      externalGroups = []; version++; last = null; return true;
    }

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
        var f = u.st / u.s, aEff = ramp > 0 ? alpha * Math.min(1, f / ramp) : alpha;
        var d = curveDelta(cu, f);
        if (!d) return null;
        var sc = new Array(K), tot = 0;
        for (i = 0; i < K; i++) { sc[i] = Math.max(0, x[i] / sx + aEff * d[i]); tot += sc[i]; }
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
      var masked = {}, active = [], superseded = [], ahead = 0;
      externalGroups.forEach(function (g) {
        var h = groupHandoff(g);
        if (h.out) { superseded.push(g); return; }
        active.push(g); ahead += Math.max(0, g.st - h.off);
        g.memberIds.forEach(function (id) { masked[id] = true; });
      });
      var list = order.filter(function (id) { return !masked[id]; }).map(function (id) {
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
      active.forEach(function (g) {
        var E = g.E > 0 ? g.E : g.Ebase;
        list.push({ id: g.id, uf: g.uf, mun: g.mun, name: g.name, x: Eng.normalizeX(g.xBase, E), E: E,
                    y: g.y, y22: g.y22, s: g.s, st: g.st });
      });
      var r = Eng.project(list, prior, opts);
      var full = r.scenarios.full;
      var byUf = Eng.aggregate(full.perUnit, function (q) { return list[q].uf; });
      var ufs = {}, hist = {};
      list.forEach(function (u) { histAdd(hist[u.uf] || (hist[u.uf] = histAcc()), u); });
      Object.keys(byUf).sort().forEach(function (k) {
        ufs[k] = view(byUf[k]);
        ufs[k].nome = (baseline.ufs && baseline.ufs[k]) || k;
        var h = histView(hist[k] || histAcc()); ufs[k].t1 = h.t1; ufs[k].vs22 = h.vs22;
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
      order.forEach(function (id) { var u = units[id]; if (masked[id]) return; secCounted += u.st || 0; secTotal += u.s || 0; if (u.y) withData++; });
      active.forEach(function (g) { secCounted += g.st; secTotal += g.s; if (sum(g.y) > 0) withData++; });
      // faixa calibrada: ±pp em torno de Lula nos válidos; apuração 100% (nada a projetar; todas as seções) = sem incerteza
      var unc = { pp: 0, lo: br.finalShare.L, hi: br.finalShare.L };
      if (br.R > 1e-6 * br.E && !(secTotal > 0 && secCounted >= secTotal)) {
        var envT = curve && alpha > 0 ? ENV_CURVA : ENV_SEM_CURVA, envI = envelopeIndex(envT, br.progressPct), ppU = envT[envI][1];
        // pertença exata (versão por seção) em alguma zona: faixa própria (erro do "oráculo" nos ensaios), nunca menor que a da curva
        if (diag.membershipApplied > 0) ppU = Math.max(ppU, ENV_PERTENCA[envelopeIndex(ENV_PERTENCA, br.progressPct)][1]);
        unc = { pp: ppU, lo: Math.max(0, br.finalShare.L - ppU / 100), hi: Math.min(1, br.finalShare.L + ppU / 100),
                classe: { de: envI > 0 ? envT[envI - 1][0] : 0, ate: envT[envI][0] } };
      }
      // contador "contra 2022" (2T-1.4): Lula no que falta apurar, comparado ao 2º turno de 2022 das MESMAS zonas (fallback22).
      // Só informativo: no ensaio 2018 -> 2022 o 2º turno anterior por zona não melhorou a projeção (docs/t2-backtest.md).
      var vs2022 = null, dzArr = new Array(list.length).fill(null);
      if (fb22) {
        var cV = 0, cL = 0, c22 = 0, rV = 0, r22 = 0, eCob = 0, eTot = 0, colchao = 0, perdaC = 0, perdaF = 0, vFim = 0;
        var m22 = 0, zPerdeu = 0, zGanhou = 0, nPerdeu = 0, nGanhou = 0;
        list.forEach(function (u, q) {
          var pu = full.perUnit[q], y22 = u.y22 || fb22[u.id];
          eTot += pu.E;
          if (!y22 || !(y22[0] + y22[1] > 0)) return;
          // painel "contra 2022" (2T-1.4.2), em votos brutos: a margem L − F de 2022 da zona (fixa) contra a margem apurada hoje,
          // com a de 2022 proporcional à fração do eleitorado da zona já apurada (zona completa: a margem de 2022 inteira)
          var uu = units[u.id], ecz = sum(pu.counted);
          var completeUnit = uu ? uu.s > 0 && uu.st >= uu.s : u.s > 0 && u.st >= u.s;
          var fz = completeUnit ? 1 : (pu.E > 0 ? Math.min(1, ecz / pu.E) : 0);
          m22 += y22[0] - y22[1];
          if (((uu && uu.y) || u.y) && ecz > 0) {
            var dz = (pu.counted[0] - pu.counted[1]) - fz * (y22[0] - y22[1]);
            dzArr[q] = dz;
            if (dz < 0) { zPerdeu -= dz; nPerdeu++; } else if (dz > 0) { zGanhou += dz; nGanhou++; }
          }
          var p22 = y22[0] / (y22[0] + y22[1]), vc = pu.counted[0] + pu.counted[1], vr = pu.rem[0] + pu.rem[1], vf = pu.final[0] + pu.final[1];
          eCob += pu.E; cV += vc; cL += pu.counted[0]; c22 += vc * p22; rV += vr; r22 += vr * p22;
          // margem (L − F) em votos: a de 2022 da zona aplicada aos votos válidos de hoje, e quanto o apurado / o projetado se afastam dela
          colchao += vf * (2 * p22 - 1); perdaC += (pu.counted[0] - pu.counted[1]) - vc * (2 * p22 - 1);
          perdaF += (pu.final[0] - pu.final[1]) - vf * (2 * p22 - 1); vFim += vf;
        });
        var vRem = br.rem.L + br.rem.F, vCnt = br.counted.L + br.counted.F;
        vs2022 = {
          cobertura: eTot > 0 ? eCob / eTot : 0,
          // zonas (2T-1.4.2): margem22 = Σ (Lula − Bolsonaro) do 2º turno de 2022 nas zonas com 2022; perdeu / ganhou = soma, em valor
          // absoluto, do quanto a margem apurada de cada zona ficou abaixo / acima da de 2022 (proporcional ao apurado da zona);
          // resta = margem22 − perdeu + ganhou (com tudo apurado: a margem de 2026 nessas zonas)
          zonas: { margem22: m22, perdeu: zPerdeu, ganhou: zGanhou, nPerdeu: nPerdeu, nGanhou: nGanhou, resta: m22 - zPerdeu + zGanhou },
          // "vantagem de 2022": margem de Lula se cada zona repetisse a fatia de 2022 com os votos válidos projetados de hoje;
          // perdaApurado: votos de margem abaixo (−) ou acima (+) de 2022 no já apurado (viesado para baixo no começo: as primeiras
          // seções da zona são menos lulistas); perdaProjetada: idem no fim, pela projeção do motor, com erroVotos = margem da faixa calibrada.
          margem: { vantagem2022: colchao, perdaApurado: cV > 0 ? perdaC : null, perdaProjetada: perdaF, sobraProjetada: colchao + perdaF,
                    erroVotos: 2 * (unc.pp / 100) * vFim },
          // cobertura = fração dos válidos apurados que vêm de zonas com 2022 (lula22 só pesa essas zonas)
          apurado: cV > 0 ? { lula: cL / cV, lula22: c22 / cV, dif: cL / cV - c22 / cV, cobertura: vCnt > 0 ? cV / vCnt : 1 } : null,
          restante: rV > 0 && vRem > 0 ? (function () {
            var precisa = (0.5 * (vCnt + vRem) - br.counted.L) / vRem, l22 = r22 / rV;
            return { lula22: l22, precisa: precisa, folga: l22 - precisa };
          })() : null
        };
      }
      // d22 por UF (2T-1.6.3): Σ dz das zonas da UF (a mesma conta do painel "zona a zona" e de municipios()[].d22); null sem zona apurada
      Object.keys(ufs).forEach(function (k) { ufs[k].d22 = null; });
      dzArr.forEach(function (dz, q) {
        var k = list[q].uf;
        if (dz == null || !ufs[k]) return;
        var d = ufs[k].d22 || (ufs[k].d22 = { votos: 0, zonas: 0 });
        d.votos += dz; d.zonas++;
      });
      // chance de vitória (2T-1.4): t de Student (4 g.l.) em torno da projeção com escala σ = metade da faixa calibrada (a faixa vale ~2σ).
      // Com só dois ensaios (2018, 2022) a faixa pode ser superada numa 3ª eleição: até 95% apurado a chance fica entre 5% e 95% (teto).
      // Sem apurado: null.
      var chance = null;
      if (br.ec > 0) {
        var pL = unc.pp > 0 ? tCdf4((br.finalShare.L - 0.5) / (unc.pp / 200)) : (br.finalShare.L > 0.5 ? 1 : br.finalShare.L < 0.5 ? 0 : 0.5);
        var teto = unc.pp > 0 && br.progressPct < CHANCE_ATE ? CHANCE_TETO : null;
        if (teto) pL = Math.min(teto, Math.max(1 - teto, pL));
        chance = { L: pL, F: 1 - pL, sigmaPP: unc.pp / 2, teto: teto };
      }
      last = { list: list, perUnit: full.perUnit, dz: dzArr };
      return {
        at: Date.now(),
        progress: { electorateCountedPct: br.progressPct, unitsWithData: withData, unitsTotal: order.length - Object.keys(masked).length + active.length, sectionsCounted: secCounted, sectionsTotal: secTotal },
        br: br, ufs: ufs, migration: migration,
        scenarios: { full: br, noLocal: sc(r.scenarios.noLocal), priorOnly: sc(r.scenarios.priorOnly) },
        band: r.band, uncertainty: unc, forNeed: forNeed, vs2022: vs2022, chance: chance,
        diagnostics: { unknownUnits: diag.unknownUnits.slice(), fallback22Used: diag.fallback22Used.slice(), invalidUpdates: diag.invalidUpdates, regressions: diag.regressions, updates: diag.updates, lastUpdateTs: diag.lastUpdateTs,
                       arrivalApplied: diag.arrivalApplied, membershipApplied: diag.membershipApplied, arrivalAlpha: curve ? alpha : 0, arrivalRamp: curve && alpha > 0 ? ramp : 0,
                       curveLoaded: !!curve, curveUnits: curve ? Object.keys(curve.unidades).length : 0, curveNote: curveNote,
                       external: externalSummary(active, superseded, masked, ahead) }
      };
    }

    /* Resumo dos grupos externos para a tela: ativos (entram na projeção), substituídos pelo TSE e recusados (com o motivo). */
    function externalSummary(active, superseded, masked, ahead) {
      var votes = [0, 0, 0, 0, 0], bySource = {}, st = 0, s = 0;
      active.forEach(function (g) {
        for (var i = 0; i < 5; i++) votes[i] += g.y[i];
        st += g.st; s += g.s; bySource[g.source || '?'] = (bySource[g.source || '?'] || 0) + g.st;
      });
      /* Votos oficiais que já existiam nas zonas mascaradas (ficam de fora da soma das zonas). */
      var maskedVotes = [0, 0, 0, 0, 0];
      Object.keys(masked).forEach(function (id) {
        var y = units[id] && units[id].y;
        if (y) for (var i = 0; i < 5; i++) maskedVotes[i] += y[i] || 0;
      });
      return { groups: active.length, superseded: superseded.length, rejected: externalRejected.slice(), unitsMasked: Object.keys(masked).length,
               sectionsCounted: st, sectionsTotal: s, urnas: st, ahead: ahead, votes: votes, maskedVotes: maskedVotes, bySource: bySource,
               names: active.map(function (g) { return g.name; }), supersededNames: superseded.map(function (g) { return g.name; }) };
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
        var item = last.list.find(function (u) { return u.uf === uf && u.mun === m && u.name; });
        v.nome = (baseline.muns && baseline.muns[uf + '|' + m]) || (item && item.name) || m;
        var acc = histAcc();
        last.list.forEach(function (u) { if (u.uf === uf && u.mun === m) histAdd(acc, u); });
        var h = histView(acc); v.t1 = h.t1; v.vs22 = h.vs22;
        // d22 (2T-1.6.3): Σ dz das zonas do município (a mesma conta do painel "zona a zona"): a margem L − F apurada contra a de 2022
        // proporcional ao apurado de cada zona; somando todos os municípios dá ganhou − perdeu. null sem zona apurada com 2022.
        var d = 0, nz = 0;
        idx.forEach(function (q) { var u = last.list[q]; if (u.mun === m && last.dz && last.dz[q] != null) { d += last.dz[q]; nz++; } });
        v.d22 = nz > 0 ? { votos: d, zonas: nz } : null;
        return v;
      }).sort(function (a, b) { return b.E - a.E; }).slice(0, limit || 20);
    }

    /* Referências históricas de um conjunto de unidades (estado ou município), para as tabelas:
       t1 = Lula e Flávio no 1º turno de 2026, normalizados entre os dois (L + F = 100%, como no 2º turno), da base de cada zona;
       vs22 = Lula e Bolsonaro no 2º turno de 2022 (% dos válidos) somando o fallback22 das zonas (y22 do grupo, no exterior), com
       cobertura = fração do eleitorado com dado de 2022. votosL/votosF = os mesmos em votos. Cada um é null quando não há dado. */
    var iL = rows.indexOf('L'), iF = rows.indexOf('F');
    function histAcc() { return { L1: 0, F1: 0, L22: 0, F22: 0, Eall: 0, Ecov: 0 }; }
    function histAdd(acc, u) {
      var x = u.x, E = u.E > 0 ? u.E : 0;
      if (x && iL >= 0 && iF >= 0) {
        acc.L1 += x[iL] || 0; acc.F1 += x[iF] || 0;
      }
      acc.Eall += E;
      var y22 = u.y22 || (fb22 ? fb22[u.id] : null);
      if (isVec5(y22) && y22[0] + y22[1] > 0) { acc.L22 += y22[0]; acc.F22 += y22[1]; acc.Ecov += E; }
    }
    function histView(acc) {
      var v22 = acc.L22 + acc.F22;
      var v1 = acc.L1 + acc.F1;
      return { t1: v1 > 0 ? { L: acc.L1 / v1, F: acc.F1 / v1, votosL: acc.L1, votosF: acc.F1 } : null,
               vs22: v22 > 0 ? { L: acc.L22 / v22, F: acc.F22 / v22, votosL: acc.L22, votosF: acc.F22,
                                 cobertura: acc.Eall > 0 ? acc.Ecov / acc.Eall : 1 } : null };
    }

    /* lastUpdateTs = horário dos dados (não do salvamento); savedAt = quando foi gravado.
     * v: 2 desde o 2T-1.6.7. No v: 1 o E salvo de zona ainda parcial era o eleitorado só das seções já totalizadas (e.esi; ver
     * T2Tse.eleitorado): na importação ele é descartado e a zona fica com o eleitorado da base até ser relida. Zona completa mantém o E. */
    function exportState() {
      var out = { v: 2, updates: {}, lastUpdateTs: diag.lastUpdateTs, savedAt: Date.now() };
      order.forEach(function (id) {
        var u = units[id];
        if (!u.y) return;
        out.updates[id] = { y: u.y, E: u.E, s: u.s, st: u.st };
        if (u.xc) out.updates[id].xc = u.xc;
      });
      return out;
    }
    function importState(obj) {
      if (!obj || (obj.v !== 1 && obj.v !== 2) || !obj.updates || typeof obj.updates !== 'object') return 0;
      var n = 0;
      Object.keys(obj.updates).forEach(function (id) {
        var upd = obj.updates[id];
        if (obj.v === 1 && upd && typeof upd === 'object' && !(upd.s > 0 && upd.st >= upd.s)) { upd = Object.assign({}, upd); delete upd.E; }
        if (update(id, upd)) n++;
      });
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

    return { update: update, updateMany: updateMany, reset: reset, version: versionOf, compute: compute, municipios: municipios, exportState: exportState, importState: importState, unitInfo: unitInfo,
             setExternalGroups: setExternalGroups, clearExternalGroups: clearExternalGroups, _units: units };
  }

  return { create: create, LABELS: LABELS, DST: DST, ARRIVAL_ALPHA_DEFAULT: ARRIVAL_ALPHA_DEFAULT, ARRIVAL_RAMP_DEFAULT: ARRIVAL_RAMP_DEFAULT, ENV_CURVA: ENV_CURVA, ENV_SEM_CURVA: ENV_SEM_CURVA, ENV_PERTENCA: ENV_PERTENCA, CHANCE_TETO: CHANCE_TETO, tCdf4: tCdf4, envelopePP: envelopePP, envelopeIndex: envelopeIndex };
});
