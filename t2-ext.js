/* t2-ext.js — prévia do exterior (ZZ) antes da totalização do TSE (2T-1.6).
 *
 * Três fontes, juntadas por cidade do exterior (código TSE do município):
 *   bu  — boletins de urna que o TSE publica seção a seção em arquivo-urna/3221 (oficiais, ainda não totalizados), decodificados aqui;
 *   jr  — Jornal Razão (/eleicoes/d2/v.json + ext.json): soma por país e cidade dos mesmos boletins;
 *   asc — ascaribe (dados.ascaribe.tech/real/exterior.json): soma por cidade, sem brancos, nulos nem comparecimento.
 * Por cidade vale a fonte com mais urnas (empate: bu > jr > asc). Cada cidade vira um grupo externo do T2State (setExternalGroups):
 * substitui a zona ZZ|mun|0001 em compute() e sai sozinho quando o TSE tem pelo menos as mesmas urnas da cidade. Cidade fora da base
 * do 1º turno vira grupo sem zona, com a composição média do exterior.
 *
 * JR e ascaribe não liberam CORS: no APK passam pelo proxy fixo do MainActivity (/jr/..., /asc/...). Os boletins vêm direto do TSE, por
 * uma fila própria (1 pedido a cada 1,5 s), e só são procurados nas cidades em que JR/ascaribe já contam mais urnas que os boletins lidos:
 * o TSE bloqueia quem gera muitos 404, então não há varredura às cegas. Cada boletim é lido uma vez e guardado no aparelho. A leitura
 * dos boletins para às 16:45 (Brasília), para nunca disputar o TSE com o placar das 17h.
 * A sincronização roda a cada 10 s, sem sobrepor ciclos e sem bloquear a tela: tudo é assíncrono, cada fonte tem 15 s e uma fonte com
 * erro não segura as outras.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.T2Ext = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ELEICAO = 6258;
  var PLEITO = '3221';
  var START_2T_UTC = Date.UTC(2026, 9, 25, 20, 0, 0);       // 17:00 de Brasília (o mesmo de T2Tse.START_2T_UTC)
  var TSE_AU = 'https://resultados.tse.jus.br/oficial/ele2026/arquivo-urna/' + PLEITO;
  var URLS = {
    jrIndex: '/jr/v.json',
    jrData: '/jr/ext.json',
    asc: '/asc/exterior.json',
    cs: TSE_AU + '/config/zz/zz-p00' + PLEITO + '-cs.json',
    jrPage: 'https://jornalrazao.com/eleicoes/exterior',
    ascPage: 'https://apuracao.ascaribe.tech/'
  };
  var SOURCE_NAMES = { bu: 'boletins do TSE', jr: 'Jornal Razão', asc: 'ascaribe' };
  var SOURCE_RANK = { bu: 3, jr: 2, asc: 1 };
  /* Nomes do Jornal Razão que diferem do mapa do TSE (data/exterior-country-map.json). Chaves e valores passam por norm(). */
  var CITY_ALIASES = {
    SANSALVADOR: 'SAO SALVADOR', CIDADEDAGUATEMALA: 'GUATEMALA', KINGSTON: 'KINGSTON JAMAICA', KUWAIT: 'KUAITE',
    CIDADEDOMEXICO: 'MEXICO', CIDADEDOPANAMA: 'PANAMA'
  };
  var COUNTRY_ALIASES = { EMIRADOSARABES: 'EMIRADOS ARABES UNIDOS', TCHEQUIA: 'REPUBLICA TCHECA', TAIWAN: 'CHINA TAIWAN' };
  // proporções usadas só enquanto nenhuma fonte exata tem votos suficientes (ordem de grandeza do exterior)
  var DEFAULT_RATIOS = { B: 0.008, N: 0.011, abst: 0.75 };

  function norm(value) {
    return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
  function int(value) {
    if (typeof value === 'number') return isFinite(value) && Math.floor(value) === value && value >= 0 ? value : null;
    if (value === null || value === undefined || value === '') return null;
    var s = String(value).trim();
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    if (!/^\d{1,9}$/.test(s)) return null;
    return Number(s);
  }
  function stamp(value) {
    if (!value) return 0;
    var n = Date.parse(value);
    return isFinite(n) ? n : 0;
  }
  function fail(message) { return { ok: false, error: message }; }
  function code5(value) {
    var s = String(value === undefined || value === null ? '' : value).trim();
    return /^\d{1,5}$/.test(s) ? s.padStart(5, '0') : '';
  }
  function errText(e) { return String((e && e.message) || e || 'falha'); }
  /* Rateio inteiro proporcional (maior resto): inteiros >= 0 que somam total. */
  function apportion(total, weights) {
    var sw = weights.reduce(function (a, w) { return a + w; }, 0);
    if (!(total > 0) || !(sw > 0)) return weights.map(function () { return 0; });
    var raw = weights.map(function (w) { return total * w / sw; });
    var out = raw.map(Math.floor), rest = total - out.reduce(function (a, b) { return a + b; }, 0);
    raw.map(function (r, i) { return { i: i, f: r - Math.floor(r) }; })
      .sort(function (a, b) { return b.f - a.f || a.i - b.i; })
      .slice(0, rest).forEach(function (e) { out[e.i]++; });
    return out;
  }

  // ---------------------------------------------------------------- índice de localidades (mapa + base + cs)
  /* cfg: { baseline, locations: [{code, city, country}], cs: parseCs(...) opcional }. */
  function buildIndex(cfg) {
    var baseline = cfg && cfg.baseline, locations = (cfg && cfg.locations) || [];
    var ix = { byCode: {}, byCityCountry: {}, byCity: {}, units: {}, E: {}, secoes: {}, cs: {}, zzX: null, zzE: 0 };
    locations.forEach(function (loc) {
      var code = code5(loc && loc.code);
      if (!code || !loc.city || !loc.country) return;
      ix.byCode[code] = { code: code, city: String(loc.city), country: String(loc.country) };
      var kc = norm(loc.city), kk = norm(loc.country);
      (ix.byCityCountry[kc + '|' + kk] = ix.byCityCountry[kc + '|' + kk] || []).push(code);
      (ix.byCity[kc] = ix.byCity[kc] || []).push(code);
    });
    var K = baseline && Array.isArray(baseline.rows) ? baseline.rows.length : 0;
    if (K) ix.zzX = new Array(K).fill(0);
    ((baseline && baseline.unidades) || []).forEach(function (u) {
      if (!u || u.uf !== 'ZZ') return;
      var code = code5(u.mun);
      if (!code) return;
      (ix.units[code] = ix.units[code] || []).push(u.id);
      ix.E[code] = (ix.E[code] || 0) + (Number(u.E) || 0);
      ix.secoes[code] = (ix.secoes[code] || 0) + (Number(u.secoes) || 0);
      if (ix.zzX && Array.isArray(u.x) && u.x.length === K) for (var i = 0; i < K; i++) ix.zzX[i] += Number(u.x[i]) || 0;
      ix.zzE += Number(u.E) || 0;
      if (!ix.byCode[code]) ix.byCode[code] = { code: code, city: String((baseline.muns && baseline.muns['ZZ|' + u.mun]) || code), country: '' };
    });
    if (cfg && cfg.cs && cfg.cs.ok) cfg.cs.cities.forEach(function (c) { ix.cs[c.mun] = c; });
    return ix;
  }
  /* urnas esperadas da cidade: lista de seções do TSE (cs); sem ela, a base do 1º turno */
  function cityTotal(ix, code) { return ix.cs[code] ? ix.cs[code].sections.length : (ix.secoes[code] || 0); }
  function countryKey(name) { var n = norm(name); return norm(COUNTRY_ALIASES[n] || n); }
  function cityKey(name) { var n = norm(name); return norm(CITY_ALIASES[n] || n); }
  /* Cidade do JR -> código TSE: cidade + país; senão, a cidade se o nome for único no mapa. */
  function resolveCode(ix, cityName, countryName) {
    var kc = cityKey(cityName), list = ix.byCityCountry[kc + '|' + countryKey(countryName)];
    if (list && list.length === 1) return list[0];
    var any = ix.byCity[kc];
    return any && any.length === 1 ? any[0] : '';
  }

  // ---------------------------------------------------------------- Jornal Razão
  function parseIndex(json) {
    if (!json || typeof json !== 'object') return fail('índice de versões inválido');
    var v = int(json.f && json.f.ext);
    if (v === null) return fail('versão ext ausente no índice');
    return { ok: true, version: v, at: stamp(json.t), paused: Number(json.pausa) === 1 };
  }

  /* ext.json do JR. Um país incoerente sai sozinho (motivo em problems); só a estrutura toda errada recusa o feed. */
  function parseSnapshot(json) {
    if (!json || typeof json !== 'object' || !Array.isArray(json.paises)) return fail('estrutura ext.json inválida');
    var keys = ['urnas', 'total', 'aptos', 'c', 'f', 'l', 'vb', 'vn'], cityKeys = ['urnas', 'total', 'c', 'f', 'l'];
    var countries = [], problems = [];
    json.paises.forEach(function (p) {
      var name = String((p && p.nm) || '');
      if (!name || !Array.isArray(p.cid)) { problems.push({ name: name || '?', reason: 'país sem nome ou sem cidades' }); return; }
      var row = { iso: String(p.iso || ''), name: name, updatedAt: stamp(p.ult), cities: [] };
      keys.forEach(function (k) { row[k] = int(p[k]); });
      if (keys.some(function (k) { return row[k] === null; }) || row.urnas > row.total || row.aptos < row.c ||
          row.f + row.l + row.vb + row.vn !== row.c) { problems.push({ name: name, reason: 'totais do país incoerentes' }); return; }
      var sums = { urnas: 0, total: 0, c: 0, f: 0, l: 0 }, bad = '';
      p.cid.forEach(function (c) {
        if (bad) return;
        var city = { name: String((c && c.nm) || '') };
        cityKeys.forEach(function (k) { city[k] = int(c && c[k]); });
        if (!city.name || cityKeys.some(function (k) { return city[k] === null; }) || city.urnas > city.total || city.f + city.l > city.c) {
          bad = 'cidade incoerente: ' + (city.name || '?'); return;
        }
        cityKeys.forEach(function (k) { sums[k] += city[k]; });
        row.cities.push(city);
      });
      if (!bad && cityKeys.some(function (k) { return sums[k] !== row[k]; })) bad = 'soma das cidades difere do país';
      if (bad) { problems.push({ name: name, reason: bad }); return; }
      countries.push(row);
    });
    var tot = json.tot && typeof json.tot === 'object' ? json.tot : {};
    return { ok: true, at: stamp(json.t) || stamp(tot.ult), lastBuAt: stamp(tot.ult), countries: countries, problems: problems,
             urnas: countries.reduce(function (a, p) { return a + p.urnas; }, 0) };
  }

  /* Por cidade a partir do snapshot do JR. Brancos + nulos da cidade = c − L − F (exato). O JR só dá aptos, brancos e nulos por país:
   * cidades cujos boletins já foram lidos com as mesmas urnas e votos (exact = reivindicações 'bu') entram com os números exatos, e o
   * resto do país (abstenção, brancos e nulos) é rateado entre as demais cidades com urnas, a abstenção pelo eleitorado esperado das
   * urnas recebidas. Sobrando uma só cidade, ela também fica exata; senão fica marcada como estimada. */
  function jrClaims(snapshot, ix, exact) {
    var claims = {}, problems = [];
    if (!snapshot || !snapshot.ok) return { claims: claims, problems: problems };
    snapshot.countries.forEach(function (p) {
      var active = p.cities.filter(function (c) { return c.urnas > 0; });
      if (!active.length) return;
      var codes = active.map(function (c) { return resolveCode(ix, c.name, p.name); });
      var fixed = active.map(function (c, i) {
        var b = exact && codes[i] ? exact[codes[i]] : null;
        return b && b.urnas === c.urnas && b.c === c.c && b.L === c.l && b.F === c.f ? b : null;
      });
      var restA = p.aptos - p.c, restB = p.vb, restN = p.vn;
      fixed.forEach(function (b) { if (b) { restA -= b.aptos - b.c; restB -= b.B; restN -= b.N; } });
      if (restA < 0 || restB < 0 || restN < 0) { fixed = active.map(function () { return null; }); restA = p.aptos - p.c; restB = p.vb; restN = p.vn; }
      var open = active.filter(function (c, i) { return !fixed[i]; }).length;
      var weights = active.map(function (c, i) {
        if (fixed[i]) return 0;
        var E = codes[i] && ix.E[codes[i]] > 0 ? ix.E[codes[i]] : 0, tot = codes[i] ? cityTotal(ix, codes[i]) || c.total : c.total;
        return E > 0 && tot > 0 ? E * Math.min(1, c.urnas / tot) : Math.max(1, c.c);
      });
      var abst = apportion(restA, weights), bn = restB + restN;
      active.forEach(function (c, i) {
        var code = codes[i], label = c.name + ' (' + p.name + ')';
        if (!code) { problems.push({ name: label, reason: 'cidade sem correspondência no mapa do TSE' }); return; }
        if (claims[code]) { problems.push({ name: label, reason: 'cidade repetida no feed' }); return; }
        var cbn = c.c - c.l - c.f, B, a;
        if (fixed[i]) { B = fixed[i].B; a = fixed[i].aptos - fixed[i].c; }
        else { B = open === 1 && restB <= cbn && restN === cbn - restB ? restB : (bn > 0 ? Math.round(cbn * restB / bn) : 0); a = abst[i]; }
        claims[code] = { code: code, src: 'jr', urnas: c.urnas, total: c.total, L: c.l, F: c.f, B: B, N: cbn - B, c: c.c,
                         aptos: c.c + a, ts: p.updatedAt || snapshot.lastBuAt || snapshot.at, est: !fixed[i] && open > 1 };
      });
    });
    return { claims: claims, problems: problems };
  }

  // ---------------------------------------------------------------- ascaribe
  function parseAsc(json) {
    if (!json || typeof json !== 'object' || !Array.isArray(json.exterior)) return fail('estrutura exterior.json inválida');
    var rows = [], problems = [];
    json.exterior.forEach(function (r) {
      var code = code5(r && r.codigo_tse);
      var row = { code: code, total: int(r && r.urnas_totais), urnas: int(r && r.urnas_apuradas), valid: int(r && r.votos_validos),
                  L: int(r && r.lula), F: int(r && r.flavio) };
      if (!code || ['total', 'urnas', 'valid', 'L', 'F'].some(function (k) { return row[k] === null; }) || row.urnas > row.total ||
          row.L + row.F !== row.valid) { problems.push({ name: code || String((r && r.pais) || '?'), reason: 'linha incoerente' }); return; }
      rows.push(row);
    });
    return { ok: true, at: stamp(json.updated_at), rows: rows, problems: problems,
             urnas: rows.reduce(function (a, r) { return a + r.urnas; }, 0) };
  }
  /* O ascaribe não traz brancos, nulos nem comparecimento: estimados com as proporções das fontes exatas (cidade marcada como estimada).
   * O país sai do mapa pelo código TSE: os campos "pais" e "codigo_iso3" do ascaribe têm erros. */
  function ascClaims(parsed, ix, ratios) {
    var claims = {}, problems = [], r0 = ratios || DEFAULT_RATIOS;
    if (!parsed || !parsed.ok) return { claims: claims, problems: problems };
    parsed.rows.forEach(function (r) {
      if (!(r.urnas > 0)) return;
      if (!ix.byCode[r.code]) { problems.push({ name: r.code, reason: 'código sem cidade no mapa do TSE' }); return; }
      var B = Math.round(r.valid * r0.B), N = Math.round(r.valid * r0.N), c = r.valid + B + N;
      var E = ix.E[r.code] || 0, tot = cityTotal(ix, r.code) || r.total;
      var aptos = E > 0 && tot > 0 ? Math.round(E * Math.min(1, r.urnas / tot)) : Math.round(c / Math.max(0.05, 1 - r0.abst));
      claims[r.code] = { code: r.code, src: 'asc', urnas: r.urnas, total: r.total, L: r.L, F: r.F, B: B, N: N, c: c,
                         aptos: Math.max(c, aptos), ts: parsed.at, est: true };
    });
    return { claims: claims, problems: problems };
  }

  // ---------------------------------------------------------------- boletins de urna do TSE
  /* Seções do exterior (zz-p003221-cs.json). Seção com "nsp" está agregada a outra (a principal) e não é urna própria. */
  function parseCs(json) {
    var abr = json && Array.isArray(json.abr) ? json.abr.filter(function (a) { return a && String(a.cd).toLowerCase() === 'zz'; })[0] : null;
    if (!abr || !Array.isArray(abr.mu)) return fail('lista de seções do exterior inválida');
    var cities = [], urnas = 0;
    abr.mu.forEach(function (m) {
      var mun = code5(m && m.cd);
      if (!mun || !Array.isArray(m.zon)) return;
      var sections = [];
      m.zon.forEach(function (z) {
        var zona = String((z && z.cd) || '');
        if (!/^\d{4}$/.test(zona) || !Array.isArray(z.sec)) return;
        z.sec.forEach(function (s) {
          if (!s || s.nsp) return;
          var ns = String(s.ns || '');
          if (/^\d{4}$/.test(ns)) sections.push({ zona: zona, secao: ns });
        });
      });
      if (!sections.length) return;
      urnas += sections.length;
      cities.push({ mun: mun, name: String(m.nm || ''), sections: sections });
    });
    if (!cities.length) return fail('lista de seções do exterior vazia');
    return { ok: true, cities: cities, urnas: urnas };
  }
  function secKey(mun, zona, secao) { return mun + '|' + zona + '|' + secao; }
  function auxUrl(mun, zona, secao) {
    return TSE_AU + '/dados/zz/' + mun + '/' + zona + '/' + secao + '/p00' + PLEITO + '-zz-m' + mun + '-z' + zona + '-s' + secao + '-aux.json';
  }
  function buUrl(mun, zona, secao, hash, name) { return TSE_AU + '/dados/zz/' + mun + '/' + zona + '/' + secao + '/' + hash + '/' + name; }
  function brTime(d, h) {        // "25/10/2026", "01:51:38" (Brasília, UTC−3) -> ms
    var md = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(d || '')), mh = /^(\d{2}):(\d{2}):(\d{2})$/.exec(String(h || ''));
    if (!md || !mh) return 0;
    return Date.UTC(+md[3], +md[2] - 1, +md[1], +mh[1] + 3, +mh[2], +mh[3]);
  }
  /* aux.json da seção: o hash recebido mais recente que tenha o arquivo do boletim. Hash e nome entram na URL: só caracteres seguros. */
  function pickHash(aux) {
    var list = aux && Array.isArray(aux.hashes) ? aux.hashes : [];
    for (var i = list.length - 1; i >= 0; i--) {
      var h = list[i], st = norm(h && h.st);
      if (!/^(RECEBID|TOTALIZAD)/.test(st) || !/^[0-9a-f]{16,256}$/i.test(String((h && h.hash) || '')) || !Array.isArray(h.arq)) continue;
      var bu = h.arq.filter(function (a) { return a && a.tp === 'bu' && /^[\w.-]{1,96}$/.test(String(a.nm || '')); })[0];
      if (bu) return { hash: String(h.hash), name: String(bu.nm), at: brTime(h.dr, h.hr) };
    }
    return null;
  }

  /* DER mínimo: TLV com limites conferidos e profundidade máxima. */
  function derParse(buf, start, end, depth) {
    if (depth > 24) throw new Error('aninhamento demais');
    var out = [], o = start;
    while (o < end) {
      if (o + 2 > end) throw new Error('TLV truncado');
      var t = buf[o++], cls = t >> 6, cons = (t & 0x20) !== 0, tag = t & 0x1f;
      if (tag === 0x1f) {
        tag = 0; var b, guard = 0;
        do { if (o >= end || ++guard > 4) throw new Error('tag inválida'); b = buf[o++]; tag = tag * 128 + (b & 0x7f); } while (b & 0x80);
      }
      if (o >= end) throw new Error('TLV truncado');
      var len = buf[o++];
      if (len & 0x80) {
        var n = len & 0x7f;
        if (n === 0 || n > 3 || o + n > end) throw new Error('tamanho inválido');
        len = 0; for (var i = 0; i < n; i++) len = len * 256 + buf[o++];
      }
      if (o + len > end) throw new Error('TLV além do fim');
      var node = { cls: cls, cons: cons, tag: tag, start: o, end: o + len, kids: null };
      if (cons) node.kids = derParse(buf, o, o + len, depth + 1);
      out.push(node);
      o += len;
    }
    return out;
  }
  function derInt(buf, n) {
    if (!n || n.cons) return null;
    var len = n.end - n.start;
    if (len < 1 || len > 6 || (buf[n.start] & 0x80)) return null;   // contagens: inteiros não negativos
    var v = 0; for (var i = n.start; i < n.end; i++) v = v * 256 + buf[i];
    return v;
  }
  function isUInt(n) { return !!n && n.cls === 0 && !n.cons && n.tag === 2; }
  function isEnum(n) { return !!n && n.cls === 0 && !n.cons && n.tag === 10; }
  function isSeq(n) { return !!n && n.cls === 0 && n.cons && n.tag === 16; }
  function ctx(n, tag) { return n && n.kids ? n.kids.filter(function (k) { return k.cls === 2 && k.tag === tag; })[0] || null : null; }
  /* IdentificacaoSecaoEleitoral ::= SEQUENCE { municipioZona SEQUENCE { municipio, zona }, local, secao } */
  function secId(buf, n) {
    var k = n && n.kids;
    if (!k || k.length !== 3 || !isSeq(k[0]) || k[0].kids.length !== 2 || !isUInt(k[0].kids[0]) || !isUInt(k[0].kids[1]) ||
        !isUInt(k[1]) || !isUInt(k[2])) return null;
    return { mun: derInt(buf, k[0].kids[0]), zona: derInt(buf, k[0].kids[1]), secao: derInt(buf, k[2]) };
  }

  /* Boletim de urna (bu.dat): envelope DER cujo último OCTET STRING é a EntidadeBoletimUrna. Conferido: seção do boletim = a pedida
   * (expect = { mun, zona, secao }), uma única eleição 6258, um único resultado majoritário com um único cargo (presidente, código 1),
   * só Lula (13), Flávio (22), brancos e nulos, e L + F + brancos + nulos = comparecimento <= aptos. */
  function decodeBu(input, expect) {
    var buf = input instanceof Uint8Array ? input : (input ? new Uint8Array(input) : new Uint8Array(0));
    if (!buf.length || buf.length > 65536) return fail('tamanho do boletim inválido');
    try {
      var top = derParse(buf, 0, buf.length, 0);
      if (top.length !== 1 || !isSeq(top[0])) return fail('envelope inválido');
      var env = top[0].kids, content = null;
      for (var i = env.length - 1; i >= 0; i--) if (env[i].cls === 0 && !env[i].cons && env[i].tag === 4) { content = env[i]; break; }
      if (!content) return fail('envelope sem boletim');
      var inner = derParse(buf, content.start, content.end, 0);
      if (inner.length !== 1 || !isSeq(inner[0])) return fail('boletim inválido');
      var entity = inner[0].kids;
      var ids = entity.map(function (n) { return isSeq(n) ? secId(buf, n) : null; }).filter(Boolean);
      if (ids.length !== 1) return fail('boletim sem identificação única da seção');
      var id = ids[0];
      if (expect && (id.mun !== Number(expect.mun) || id.zona !== Number(expect.zona) || id.secao !== Number(expect.secao))) {
        return fail('boletim de outra seção');
      }
      // ResultadosVotacaoPorEleicao ::= SEQUENCE OF SEQUENCE { idEleicao, qtdEleitoresAptos, ..., resultadosVotacao, ... }
      var blocks = [];
      entity.forEach(function (n) {
        if (!isSeq(n) || !n.kids.length || !n.kids.every(isSeq)) return;
        n.kids.forEach(function (b) { if (b.kids.length >= 3 && isUInt(b.kids[0]) && isUInt(b.kids[1])) blocks.push(b); });
      });
      var mine = blocks.filter(function (b) { return derInt(buf, b.kids[0]) === ELEICAO; });
      if (mine.length !== 1) return fail(mine.length ? 'eleição ' + ELEICAO + ' repetida no boletim' : 'boletim sem a eleição ' + ELEICAO);
      var block = mine[0], aptos = derInt(buf, block.kids[1]);
      var results = block.kids.filter(function (k) { return isSeq(k) && k.kids.length && k.kids.every(isSeq); })[0];
      if (!results || aptos === null) return fail('boletim sem resultados');
      var majoritario = results.kids.filter(function (rv) { return rv.kids.length >= 3 && isEnum(rv.kids[0]) && derInt(buf, rv.kids[0]) === 1; });
      if (majoritario.length !== 1) return fail('boletim sem resultado majoritário único');
      var rv = majoritario[0], comp = isUInt(rv.kids[1]) ? derInt(buf, rv.kids[1]) : null, cargos = rv.kids[2];
      if (comp === null || !isSeq(cargos) || cargos.kids.length !== 1 || !isSeq(cargos.kids[0])) return fail('boletim com cargos inesperados');
      var cargo = cargos.kids[0], cc = cargo.kids[0];
      var codigo = cc && cc.cls === 2 && !cc.cons ? derInt(buf, cc) : null;
      if (codigo !== 1) return fail('boletim sem o cargo de presidente');
      var votos = cargo.kids.filter(function (k) { return isSeq(k) && k.kids.every(isSeq); })[0];
      if (!votos) return fail('boletim sem votos');
      var r = { L: 0, F: 0, B: 0, N: 0 };
      for (var j = 0; j < votos.kids.length; j++) {
        var v = votos.kids[j], tipo = ctx(v, 1), qtd = ctx(v, 2), ident = ctx(v, 3);
        var tv = derInt(buf, tipo), q = derInt(buf, qtd);
        if (tv === null || q === null) return fail('voto ilegível');
        if (tv === 1) {
          var cod = ident && ident.kids && ident.kids.length >= 2 && isUInt(ident.kids[1]) ? derInt(buf, ident.kids[1]) : null;
          if (cod === 13) r.L += q; else if (cod === 22) r.F += q; else return fail('candidato desconhecido no boletim');
        } else if (tv === 2) r.B += q;
        else if (tv === 3) r.N += q;
        else if (q > 0) return fail('tipo de voto inesperado');
      }
      if (r.L + r.F + r.B + r.N !== comp) return fail('votos não somam o comparecimento');
      if (aptos < comp) return fail('comparecimento acima dos aptos');
      return { ok: true, mun: id.mun, zona: id.zona, secao: id.secao, aptos: aptos, c: comp, L: r.L, F: r.F, B: r.B, N: r.N };
    } catch (error) {
      return fail('boletim ilegível: ' + errText(error));
    }
  }

  // ---------------------------------------------------------------- junção por cidade
  /* claimsBySrc = { bu: {code: claim}, jr: {...}, asc: {...} }. Vale a fonte com mais urnas; empate: bu > jr > asc. */
  function mergeClaims(claimsBySrc) {
    var best = {};
    ['bu', 'jr', 'asc'].forEach(function (src) {
      var claims = (claimsBySrc && claimsBySrc[src]) || {};
      Object.keys(claims).forEach(function (code) {
        var c = claims[code];
        if (!c || !(c.urnas > 0)) return;
        var cur = best[code];
        if (!cur || c.urnas > cur.urnas || (c.urnas === cur.urnas && SOURCE_RANK[c.src] > SOURCE_RANK[cur.src])) best[code] = c;
      });
    });
    return best;
  }

  /* Cidade -> grupo externo do T2State. y = [L, F, B, N, aptos − comparecimento] só das urnas recebidas; E = eleitorado da zona na base
   * (ou mais, se os aptos já passarem dele); s = o maior entre as seções da base, as urnas do cs e as recebidas; st = urnas recebidas.
   * Cidade fora da base: grupo sem zona, composição média do exterior no 1º turno e eleitorado estimado pelas urnas recebidas. */
  function buildGroups(best, ix) {
    var groups = [], skipped = [];
    Object.keys(best).sort().forEach(function (code) {
      var c = best[code], members = ix.units[code] || [], loc = ix.byCode[code] || { city: code, country: '' };
      var total = cityTotal(ix, code) || c.total || c.urnas;
      var s = Math.max(ix.secoes[code] || 0, total, c.urnas), st = c.urnas;
      var y = [c.L, c.F, c.B, c.N, Math.max(0, c.aptos - c.c)], g;
      if (members.length) {
        g = { id: code, mun: code, memberIds: members.slice(), E: Math.max(ix.E[code] || 0, c.aptos) };
      } else {
        if (!ix.zzX || !(ix.zzE > 0)) { skipped.push({ name: loc.city, reason: 'sem composição do exterior na base' }); return; }
        var E = Math.max(c.aptos, Math.round(c.aptos * s / Math.max(1, st)));
        g = { id: code, mun: code, memberIds: [], E: E, xBase: ix.zzX.map(function (v) { return v * E / ix.zzE; }) };
      }
      g.name = loc.city; g.country = loc.country; g.y = y; g.s = s; g.st = st;
      g.urnas = st; g.total = total; g.source = c.src; g.ts = c.ts || 0; g.est = !!c.est;
      groups.push(g);
    });
    return { groups: groups, skipped: skipped };
  }

  // ---------------------------------------------------------------- controlador (sincronização a cada 10 s)
  /* cfg:
   *   state            T2State (setExternalGroups)
   *   baseline, locations (data/exterior-country-map.json .locations)
   *   fetchJson(url, signal) -> Promise<json>   JR/ascaribe pelo proxy local; rejeita em erro. signal: AbortSignal (se houver)
   *   tseGet(url, opt) -> Promise<{status, json?, buffer?, error?, retryAt?}>   fila T2FetchQ própria (opt.as = 'buffer'); null desliga
   *   storage          localStorage ou null (os boletins lidos sobrevivem a reaberturas do app)
   *   onChange(status) chamado quando grupos ou estado das fontes mudam
   *   now, setTimer, clearTimer (testes) */
  function createController(cfg) {
    var o = {
      intervalMs: 10000, sourceTimeoutMs: 15000, buPerCycle: 30, buReprobeMs: 40000, buBlockMs: 900000,
      buStopAt: START_2T_UTC - 15 * 60000, storageKey: 't2.zzbu.' + PLEITO, persistDelayMs: 3000, mergeDelayMs: 5000,
      now: function () { return Date.now(); },
      setTimer: function (fn, ms) { return setTimeout(fn, ms); },
      clearTimer: function (h) { clearTimeout(h); },
      onChange: null, storage: null, tseGet: null
    };
    Object.keys(cfg || {}).forEach(function (k) { if (cfg[k] !== undefined) o[k] = cfg[k]; });
    var state = o.state;
    var running = false, inFlight = false, again = false, timer = null, mergeTimer = null, persistTimer = null;
    var lastSyncAt = 0, nextSyncAt = 0, cycles = 0, lastError = '';
    var cs = null, ix = buildIndex({ baseline: o.baseline, locations: o.locations });
    var src = {
      jr: { snapshot: null, version: null, paused: false, claims: {}, problems: [], lastSuccessAt: 0, lastError: '' },
      asc: { parsed: null, claims: {}, problems: [], lastSuccessAt: 0, lastError: '' },
      bu: { secs: {}, claims: {}, requests: 0, misses: 0, errors: 0, blockedUntil: 0, lastError: '', lastAt: 0, csError: '' }
    };
    var buQueue = [], buBusy = false, built = { groups: [], skipped: [], best: {} }, signature = '', stateResult = null, notifyError = '';
    loadSecs();
    safeRebuild();

    function loadSecs() {
      if (!o.storage) return;
      try {
        var saved = JSON.parse(o.storage.getItem(o.storageKey) || 'null');
        if (!saved || saved.v !== 1 || saved.pleito !== PLEITO || !saved.secs || typeof saved.secs !== 'object') return;
        Object.keys(saved.secs).forEach(function (key) {
          var a = saved.secs[key], p = key.split('|');
          if (p.length !== 3 || code5(p[0]) !== p[0] || !/^\d{4}$/.test(p[1]) || !/^\d{4}$/.test(p[2]) || !Array.isArray(a) || a.length < 6) return;
          var v = a.slice(0, 6).map(int);
          if (v.some(function (n) { return n === null; }) || v[0] + v[1] + v[2] + v[3] !== v[5] || v[4] < v[5]) return;
          var sec = { ok: true, v: v, hash: String(a[6] || ''), at: Number(a[7]) || 0, probedAt: 0 };
          src.bu.secs[key] = sec;
          if (sec.at > src.bu.lastAt) src.bu.lastAt = sec.at;
        });
        rebuildBuClaims();
      } catch (e) { /* armazenamento vazio, cheio ou corrompido: começa do zero */ }
    }
    function persistSoon() {
      if (!o.storage || persistTimer) return;
      persistTimer = o.setTimer(function () {
        persistTimer = null;
        var out = {};
        Object.keys(src.bu.secs).forEach(function (k) { var s = src.bu.secs[k]; if (s.ok) out[k] = s.v.concat([s.hash, s.at]); });
        try { o.storage.setItem(o.storageKey, JSON.stringify({ v: 1, pleito: PLEITO, savedAt: o.now(), secs: out })); } catch (e) { /* cheio ou desligado */ }
      }, o.persistDelayMs);
    }
    function rebuildBuClaims() {
      var by = {};
      Object.keys(src.bu.secs).forEach(function (key) {
        var s = src.bu.secs[key];
        if (!s.ok) return;
        var code = key.split('|')[0];
        var c = by[code] || (by[code] = { code: code, src: 'bu', urnas: 0, total: 0, L: 0, F: 0, B: 0, N: 0, c: 0, aptos: 0, ts: 0, est: false });
        c.urnas++; c.L += s.v[0]; c.F += s.v[1]; c.B += s.v[2]; c.N += s.v[3]; c.aptos += s.v[4]; c.c += s.v[5];
        if (s.at > c.ts) c.ts = s.at;
      });
      Object.keys(by).forEach(function (code) { by[code].total = cityTotal(ix, code); });
      src.bu.claims = by;
    }
    /* proporções de brancos, nulos e abstenção nas fontes exatas (boletins e cidades do JR sem rateio), para estimar o ascaribe */
    function ratios() {
      var v = 0, B = 0, N = 0, ap = 0, c = 0;
      [src.bu.claims, src.jr.claims].forEach(function (cl) {
        Object.keys(cl).forEach(function (k) { var x = cl[k]; if (x.est) return; v += x.L + x.F; B += x.B; N += x.N; ap += x.aptos; c += x.c; });
      });
      return v >= 500 && ap > 0 ? { B: B / v, N: N / v, abst: 1 - c / ap } : null;
    }
    function rebuild() {
      if (src.jr.snapshot) {
        var j = jrClaims(src.jr.snapshot, ix, src.bu.claims);
        src.jr.claims = j.claims; src.jr.problems = src.jr.snapshot.problems.concat(j.problems);
      }
      if (src.asc.parsed) {
        var a = ascClaims(src.asc.parsed, ix, ratios());
        src.asc.claims = a.claims; src.asc.problems = src.asc.parsed.problems.concat(a.problems);
      }
      var best = mergeClaims({ bu: src.bu.claims, jr: src.jr.claims, asc: src.asc.claims });
      built = buildGroups(best, ix);
      built.best = best;
      var sig = JSON.stringify(built.groups.map(function (g) { return [g.id, g.y, g.E, g.s, g.st, g.source, g.est]; }));
      if (sig === signature || !state || typeof state.setExternalGroups !== 'function') return false;
      stateResult = state.setExternalGroups(built.groups);
      signature = sig;
      return true;
    }
    function safeRebuild() { try { rebuild(); } catch (e) { lastError = 'junção das fontes: ' + errText(e); } }
    function notify() {
      if (typeof o.onChange !== 'function') return;
      try { o.onChange(status()); notifyError = ''; } catch (e) { notifyError = errText(e); }
    }
    function mergeSoon() {
      if (mergeTimer) return;
      mergeTimer = o.setTimer(function () { mergeTimer = null; safeRebuild(); notify(); }, o.mergeDelayMs);
    }

    /* JSON pelo proxy com prazo próprio; o pedido é cancelado (AbortController) quando o prazo estoura. */
    function getJson(url, label) {
      var ac = typeof AbortController === 'function' ? new AbortController() : null, h = null;
      var limit = new Promise(function (_, rej) {
        h = o.setTimer(function () {
          try { if (ac) ac.abort(); } catch (e) { /* nada */ }
          rej(new Error(label + ': sem resposta em ' + Math.round(o.sourceTimeoutMs / 1000) + ' s'));
        }, o.sourceTimeoutMs);
      });
      return Promise.race([Promise.resolve().then(function () { return o.fetchJson(url, ac ? ac.signal : undefined); }), limit])
        .then(function (v) { o.clearTimer(h); return v; }, function (e) { o.clearTimer(h); throw e; });
    }
    async function syncJr() {
      var s = src.jr;
      try {
        var index = parseIndex(await getJson(URLS.jrIndex + '?_=' + o.now(), 'Jornal Razão'));
        if (!index.ok) throw new Error(index.error);
        s.paused = index.paused;
        if (index.version !== s.version || !s.snapshot) {
          var parsed = parseSnapshot(await getJson(URLS.jrData + '?v=' + index.version, 'Jornal Razão'));
          if (!parsed.ok) throw new Error(parsed.error);
          s.snapshot = parsed; s.version = index.version;
        }
        s.lastSuccessAt = o.now(); s.lastError = '';
      } catch (e) { s.lastError = errText(e); }
      safeRebuild(); notify();
    }
    async function syncAsc() {
      var s = src.asc;
      try {
        var parsed = parseAsc(await getJson(URLS.asc + '?_=' + o.now(), 'ascaribe'));
        if (!parsed.ok) throw new Error(parsed.error);
        s.parsed = parsed; s.lastSuccessAt = o.now(); s.lastError = '';
      } catch (e) { s.lastError = errText(e); }
      safeRebuild(); notify();
    }
    async function ensureCs() {
      if (cs || !o.tseGet || o.now() >= o.buStopAt || o.now() < src.bu.blockedUntil) return;
      var r = await o.tseGet(URLS.cs, { priority: 2 });
      if (blocked(r)) return;
      if (r.status === 200 && r.json) {
        var parsed = parseCs(r.json);
        if (parsed.ok) {
          cs = parsed; ix = buildIndex({ baseline: o.baseline, locations: o.locations, cs: cs });
          rebuildBuClaims(); src.bu.csError = '';
          return;
        }
        src.bu.csError = parsed.error;
      } else {
        src.bu.csError = 'lista de seções do TSE indisponível' + (r.status ? ' (HTTP ' + r.status + ')' : r.error ? ' (' + r.error + ')' : '');
      }
    }

    /* Boletins a procurar neste ciclo: só cidades em que JR/ascaribe contam mais urnas que os boletins lidos; por cidade, até
     * (urnas faltando + 2) seções ainda não lidas, as nunca sondadas ou sondadas há mais tempo primeiro; cidades intercaladas. */
    function planBu() {
      buQueue = [];
      var t = o.now();
      if (!cs || !o.tseGet || t >= o.buStopAt || t < src.bu.blockedUntil) return;
      var per = [];
      cs.cities.forEach(function (city) {
        var have = src.bu.claims[city.mun] ? src.bu.claims[city.mun].urnas : 0;
        var claim = Math.max(src.jr.claims[city.mun] ? src.jr.claims[city.mun].urnas : 0, src.asc.claims[city.mun] ? src.asc.claims[city.mun].urnas : 0);
        if (claim <= have) return;
        var pend = city.sections.filter(function (s) {
          var sec = src.bu.secs[secKey(city.mun, s.zona, s.secao)];
          return !sec || (!sec.ok && !sec.bad && t - sec.probedAt >= o.buReprobeMs);
        }).sort(function (a, b) {
          var pa = src.bu.secs[secKey(city.mun, a.zona, a.secao)], pb = src.bu.secs[secKey(city.mun, b.zona, b.secao)];
          return (pa ? pa.probedAt : 0) - (pb ? pb.probedAt : 0);
        });
        if (pend.length) per.push({ mun: city.mun, need: claim - have, list: pend.slice(0, claim - have + 2) });
      });
      per.sort(function (a, b) { return b.need - a.need || (a.mun < b.mun ? -1 : 1); });
      for (var i = 0; buQueue.length < o.buPerCycle; i++) {
        var added = false;
        per.forEach(function (c) {
          if (i < c.list.length && buQueue.length < o.buPerCycle) { buQueue.push({ mun: c.mun, zona: c.list[i].zona, secao: c.list[i].secao }); added = true; }
        });
        if (!added) break;
      }
    }
    async function buLoop() {
      if (buBusy || !o.tseGet) return;
      buBusy = true;
      try {
        while (running && buQueue.length) {
          var t = o.now();
          if (t >= o.buStopAt || t < src.bu.blockedUntil) { buQueue = []; break; }
          var item = buQueue.shift(), key = secKey(item.mun, item.zona, item.secao);
          var sec = src.bu.secs[key] || (src.bu.secs[key] = { ok: false, probedAt: 0 });
          if (sec.ok || sec.bad) continue;
          sec.probedAt = t;
          src.bu.requests++;
          var r = await o.tseGet(auxUrl(item.mun, item.zona, item.secao), { priority: 1, negTtlMs: o.buReprobeMs });
          if (blocked(r)) break;
          if (r.error === 'breaker') { sec.probedAt = 0; buQueue = []; break; }          // muitos 404 seguidos: só no próximo ciclo
          if (r.status === 404) { src.bu.misses++; continue; }                           // seção ainda não recebida pelo TSE
          if (r.status !== 200 || !r.json) { src.bu.errors++; src.bu.lastError = 'seção ' + key + ': ' + (r.status ? 'HTTP ' + r.status : r.error || 'falha'); continue; }
          var h = pickHash(r.json);
          if (!h) continue;
          src.bu.requests++;
          var b = await o.tseGet(buUrl(item.mun, item.zona, item.secao, h.hash, h.name), { priority: 1, as: 'buffer' });
          if (blocked(b)) break;
          if (b.status !== 200 || !b.buffer) { sec.probedAt = 0; src.bu.errors++; src.bu.lastError = 'boletim ' + key + ': ' + (b.status ? 'HTTP ' + b.status : b.error || 'falha'); continue; }
          var d = decodeBu(b.buffer, item);
          if (!d.ok) { sec.bad = d.error; src.bu.errors++; src.bu.lastError = 'boletim ' + key + ': ' + d.error; continue; }
          sec.ok = true; sec.v = [d.L, d.F, d.B, d.N, d.aptos, d.c]; sec.hash = h.hash; sec.at = h.at;
          if (h.at > src.bu.lastAt) src.bu.lastAt = h.at;
          rebuildBuClaims(); persistSoon(); mergeSoon();
        }
      } catch (e) {
        src.bu.errors++; src.bu.lastError = errText(e);
      } finally { buBusy = false; }
    }
    function blocked(r) {
      if (r && (r.status === 403 || r.status === 429 || r.error === 'paused' || r.error === 'blocked')) {
        src.bu.blockedUntil = Math.max(o.now() + o.buBlockMs, Number(r.retryAt) || 0);
        src.bu.lastError = 'o TSE pediu pausa' + (r.status ? ' (HTTP ' + r.status + ')' : '') + '; boletins suspensos por 15 min';
        buQueue = [];
        return true;
      }
      return false;
    }

    async function cycle() {
      if (!running) return;
      if (inFlight) { again = true; return; }
      inFlight = true; again = false; cycles++;
      var startedAt = o.now();
      try {
        await Promise.all([syncJr(), syncAsc(), ensureCs().catch(function (e) { src.bu.csError = errText(e); })]);
        planBu();
        buLoop().catch(function () { /* erros ficam em src.bu */ });   // não espera: os boletins entram aos poucos (mergeSoon)
        lastError = '';
      } catch (e) {
        lastError = errText(e);
      } finally {
        inFlight = false; lastSyncAt = o.now();
        if (running) schedule(again ? 1000 : Math.max(1000, startedAt + o.intervalMs - o.now()));
        notify();
      }
    }
    function schedule(ms) {
      if (timer) o.clearTimer(timer);
      nextSyncAt = o.now() + ms;
      timer = o.setTimer(function () { timer = null; cycle(); }, ms);
    }
    /* start(): liga a cadeia de 10 s. Ao voltar de uma pausa, sincroniza na hora se o último ciclo tem mais de 10 s. */
    function start() {
      if (running) return;
      running = true;
      schedule(lastSyncAt ? Math.max(0, lastSyncAt + o.intervalMs - o.now()) : 0);
    }
    function stop() {
      running = false;
      if (timer) o.clearTimer(timer);
      timer = null; nextSyncAt = 0; buQueue = [];
    }
    /* "Atualizar": sincroniza agora (se um ciclo está em curso, o próximo começa logo depois dele). */
    function syncNow() {
      if (!running) return false;
      if (inFlight) { again = true; return true; }
      schedule(0);
      return true;
    }

    function status() {
      var t = o.now();
      var totals = { urnas: 0, total: cs ? cs.urnas : 0, L: 0, F: 0, B: 0, N: 0, A: 0, aptos: 0, c: 0, cities: 0, est: false };
      var bySource = { bu: 0, jr: 0, asc: 0 }, countries = {};
      Object.keys(ix.byCode).forEach(function (code) {        // urnas esperadas por país (todas as cidades, com ou sem urnas)
        var loc = ix.byCode[code], name = loc.country || loc.city;
        var row = countries[name] || (countries[name] = { name: name, urnas: 0, total: 0, L: 0, F: 0, B: 0, N: 0, sources: {}, cities: 0, est: false });
        row.total += cityTotal(ix, code);
      });
      built.groups.forEach(function (g) {
        totals.urnas += g.st; totals.L += g.y[0]; totals.F += g.y[1]; totals.B += g.y[2]; totals.N += g.y[3]; totals.A += g.y[4];
        totals.c += g.y[0] + g.y[1] + g.y[2] + g.y[3]; totals.cities++;
        if (g.est) totals.est = true;
        bySource[g.source] += g.st;
        var name = g.country || g.name;
        var row = countries[name] || (countries[name] = { name: name, urnas: 0, total: g.total, L: 0, F: 0, B: 0, N: 0, sources: {}, cities: 0, est: false });
        row.urnas += g.st; row.L += g.y[0]; row.F += g.y[1]; row.B += g.y[2]; row.N += g.y[3]; row.sources[g.source] = true; row.cities++;
        if (g.est) row.est = true;
      });
      totals.aptos = totals.c + totals.A;
      if (!totals.total) totals.total = Object.keys(ix.byCode).reduce(function (a, k) { return a + cityTotal(ix, k); }, 0);
      var list = Object.keys(countries).map(function (k) { return countries[k]; }).filter(function (r) { return r.urnas > 0; }).map(function (r) {
        r.sources = Object.keys(r.sources).sort(function (a, b) { return SOURCE_RANK[b] - SOURCE_RANK[a]; });
        r.complete = r.total > 0 && r.urnas >= r.total;
        return r;
      }).sort(function (a, b) { return b.urnas - a.urnas || (a.name < b.name ? -1 : 1); });
      var buUrnas = Object.keys(src.bu.claims).reduce(function (a, k) { return a + src.bu.claims[k].urnas; }, 0);
      var buState = !o.tseGet ? 'off' : t >= o.buStopAt ? 'stopped' : t < src.bu.blockedUntil ? 'paused'
        : !cs ? (src.bu.csError ? 'nocs' : 'loading') : buBusy || buQueue.length ? 'busy' : 'idle';
      return {
        running: running, inFlight: inFlight, cycles: cycles, intervalMs: o.intervalMs, lastSyncAt: lastSyncAt, nextSyncAt: running ? nextSyncAt : 0,
        lastError: lastError || notifyError, totals: totals, countries: list, groups: built.groups.length, bySource: bySource,
        skipped: built.skipped.slice(), rejected: stateResult && stateResult.rejected ? stateResult.rejected.slice() : [],
        sources: {
          bu: { urnas: buUrnas, cities: Object.keys(src.bu.claims).length, state: buState, requests: src.bu.requests, misses: src.bu.misses,
                errors: src.bu.errors, lastAt: src.bu.lastAt, pending: buQueue.length, blockedUntil: src.bu.blockedUntil,
                stopAt: o.buStopAt, csUrnas: cs ? cs.urnas : 0, lastError: src.bu.lastError || src.bu.csError },
          jr: { urnas: src.jr.snapshot ? src.jr.snapshot.urnas : 0, version: src.jr.version, paused: src.jr.paused,
                at: src.jr.snapshot ? src.jr.snapshot.at : 0, lastBuAt: src.jr.snapshot ? src.jr.snapshot.lastBuAt : 0,
                lastSuccessAt: src.jr.lastSuccessAt, lastError: src.jr.lastError, problems: src.jr.problems.slice() },
          asc: { urnas: src.asc.parsed ? src.asc.parsed.urnas : 0, at: src.asc.parsed ? src.asc.parsed.at : 0,
                 lastSuccessAt: src.asc.lastSuccessAt, lastError: src.asc.lastError, problems: src.asc.problems.slice() }
        }
      };
    }

    return { start: start, stop: stop, syncNow: syncNow, status: status,
             _cycle: cycle, _planBu: planBu, _buLoop: buLoop, _queue: function () { return buQueue.slice(); }, _groups: function () { return built.groups.slice(); } };
  }

  return { ELEICAO: ELEICAO, PLEITO: PLEITO, URLS: URLS, SOURCE_NAMES: SOURCE_NAMES, START_2T_UTC: START_2T_UTC, DEFAULT_RATIOS: DEFAULT_RATIOS,
           norm: norm, apportion: apportion, buildIndex: buildIndex, resolveCode: resolveCode,
           parseIndex: parseIndex, parseSnapshot: parseSnapshot, jrClaims: jrClaims, parseAsc: parseAsc, ascClaims: ascClaims,
           parseCs: parseCs, pickHash: pickHash, decodeBu: decodeBu, auxUrl: auxUrl, buUrl: buUrl,
           mergeClaims: mergeClaims, buildGroups: buildGroups, createController: createController };
});
