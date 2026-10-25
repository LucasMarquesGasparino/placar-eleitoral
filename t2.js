'use strict';

/* t2.js — tela do 2º turno (Placar 2T).
 *
 * PLUGIN OPCIONAL (2T-1.2). Se existir window.T2Plugin (carregado antes deste arquivo, ex.: t2s-plugin.js do app "Placar 2T Seção"):
 *   T2Plugin.init({ state, fetchq, urls, cfg })  depois de criar o estado e o poller (e de novo se o poller for recriado, ex.: troca do
 *                                                código da eleição). state = T2State (update/unitInfo/..., aceita xc), fetchq = fila T2FetchQ
 *                                                do app (use-a para falar com o TSE), urls = T2Tse.makeUrls(...),
 *                                                cfg = { baseline, units, electionCode, startMs }.
 *   await T2Plugin.tick()                        uma vez a cada ciclo CONCLUÍDO do poller. Assíncrono, com try/catch e limite de 8 s; um
 *                                                tick lento não acumula (se o anterior não terminou, o ciclo seguinte não chama de novo) e
 *                                                nunca derruba o app nem bloqueia o render (roda depois do render do ciclo).
 *   T2Plugin.status()                            texto curto mostrado nos diagnósticos.
 * Sem T2Plugin nada muda. O plugin influencia a projeção só via state.update(id, { xc }) (ver t2-state.js).
 */

const numberFormat = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const percentFormat = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const clockFormat = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const elements = Object.fromEntries([
  't2-status', 't2-status-pill', 't2-refresh', 't2-updated', 't2-tse-time', 't2-alert', 't2-rehearsal-label',
  't2-conn', 't2-conn-label', 't2-conn-detail',
  't2-phase-message', 't2-L-pct', 't2-L-votes', 't2-F-pct', 't2-F-votes', 't2-bar-L', 't2-bar-F',
  't2-lead', 't2-band', 't2-counted-state', 't2-progress', 't2-progress-bar', 't2-sections',
  't2-now-pct', 't2-lag-note', 't2-forneed', 't2-rehearsal-2022', 't2-mode-toggle', 't2-migration', 't2-valid-1t', 't2-valid-2t',
  't2-valid-delta', 't2-ufs', 't2-municipal-panel', 't2-mun-title', 't2-municipal-rows',
  't2-mun-close', 't2-mun-back', 't2-ufs-toggle', 't2-mun-toggle', 't2-mun-footer', 't2-eleicao-status', 't2-election-form', 't2-eleicao-input', 't2-diag-migration',
  't2-diag-units', 't2-diag-updates', 't2-diag-poller', 't2-diag-queue', 't2-diag-official', 't2-diag-ext',
  't2-diag-errors', 't2-diagnostics', 't2-rehearsal', 't2-diag-arrival', 't2-diag-plugin',
  't2-off-eyebrow', 't2-off-title', 't2-off-sources', 't2-off-sync', 't2-source-note',
  't2-off-secpct', 't2-off-sections', 't2-off-progress-bar', 't2-off-L-pct', 't2-off-L-votes',
  't2-off-F-pct', 't2-off-F-votes', 't2-off-L-22', 't2-off-F-22', 't2-off-bar-L', 't2-off-bar-F', 't2-off-lead', 't2-off-extra', 't2-off-countries', 't2-off-countries-sum', 't2-off-country-list',
  't2-vs22-state', 't2-vs22-base', 't2-vs22-perdeu', 't2-vs22-perdeu-sub', 't2-vs22-ganhou', 't2-vs22-ganhou-sub', 't2-vs22-resta',
  't2-vs22-resta-pct', 't2-vs22-chance', 't2-vs22-chance-sub', 't2-vs22-usada', 't2-vs22-bar-usada', 't2-vs22-ap', 't2-vs22-bar-ap', 't2-vs22-ritmo',
].map((id) => [id, document.getElementById(id)]));

const app = {
  baseline: null,
  prior: null,
  state: null,
  queue: null,
  poller: null,
  electionConfig: null,
  electionCode: '6258',
  electionMismatch: '',     // código não encontrado em ele-c.json (só quando o arquivo foi lido)
  electionNote: '',         // avisos do diagnóstico da eleição (não vão ao alerta)
  flowMode: false,
  ufVotes: false,           // tabela Estados em votos (botão "Ver em votos")
  munVotes: false,          // detalhe por município em votos
  munUf: '',                // UF aberta no detalhe por município
  lastOutput: null,
  lastVersion: -1,
  lastSavedVersion: -1,
  lastCycleAt: 0,
  rehearsal: false,
  rehearsalTimer: null,
  rehearsalStatus: null,
  realState: null,
  rehearsalUnits: null,
  userInteracted: false,
  wakeLock: null,
  testOverride: false,
  tickTimer: null,
  refreshNote: false,       // "Atualizando…" enquanto o toque em Atualizar aguarda a próxima rodada
  internalError: '',        // erro inesperado de renderização (só some com um toque em Atualizar)
  curve: null,              // data/t2/curva-2026-1t.json (opcional)
  curveNote: '',            // por que a curva não foi carregada
  pluginBusy: false,
  pluginTimeoutMs: 8000,    // limite de um tick do plugin
  pluginError: '',
  exteriorMap: null,        // data/exterior-country-map.json (cidades do exterior: código TSE, cidade, país)
  exteriorMapNote: '',
  ext: null,                // prévia do exterior (T2Ext, t2-ext.js): JR + ascaribe + boletins do TSE, sincronizada a cada 10 s
  extState: null,           // estado (T2State) a que o controlador da prévia está ligado
  extQueue: null,           // fila T2FetchQ própria e lenta dos boletins do TSE (não disputa a fila do placar)
  extStatus: null,          // último status do controlador
  extNote: '',              // por que a prévia do exterior está desligada ('' = ligada)
  extCountriesSig: '',      // a lista de países só é refeita quando muda
  notice: '',               // aviso único da abertura (ex.: código da eleição salvo corrigido)
};

function fmtInt(value) {
  return numberFormat.format(Math.round(Number(value) || 0));
}

function fmtPct(value) {
  return `${percentFormat.format((Number(value) || 0) * 100)}%`;
}

/* Progresso: arredonda PARA BAIXO, para nunca mostrar 100,00% antes do fim. */
function fmtPctFloor(value) {
  return `${percentFormat.format(Math.floor((Number(value) || 0) * 10000) / 100)}%`;
}

function fmtPp(value) {
  return `${percentFormat.format(Number(value) || 0)} p.p.`;
}

function fmtSignedInt(value) {
  const n = Math.round(Number(value) || 0);
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmtInt(Math.abs(n))}`;
}

function clampPercent(value) {
  return `${Math.max(0, Math.min(100, (Number(value) || 0) * 100))}%`;
}

function fmtClock(ts) {
  const n = Number(ts);
  return n > 0 ? `${clockFormat.format(new Date(n))}` : '—';
}

function fmtAge(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (total < 60) return `${total} s`;
  const min = Math.floor(total / 60), sec = total % 60;
  if (min < 60) return `${min} min ${sec} s`;
  const h = Math.floor(min / 60), m = min % 60;
  return `${h} h ${String(m).padStart(2, '0')} min`;
}

/* Só escreve quando o texto muda: o tick de 1 s não reescreve o DOM (nem relê leitores de tela) à toa. */
function setText(element, value) {
  const text = value == null ? '' : String(value);
  if (element && element.textContent !== text) element.textContent = text;
}

function makeCell(row, value, className) {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  cell.textContent = value == null ? '' : String(value);
  row.appendChild(cell);
  return cell;
}

function electionName(code) {
  return code === '6258' ? 'presidencial do 2º turno' : `eleição ${code}`;
}

function firstError(status) {
  const error = status && status.errors && status.errors[0];
  if (!error) return '';
  if (typeof error === 'string') return error;
  const parts = [error.id, error.erro].filter(Boolean);
  return parts.join(': ') || JSON.stringify(error);
}

function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return days > 0 ? `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/* Status simulado do ensaio, ou o status real do poller. */
function currentStatus() {
  if (app.rehearsal) return app.rehearsalStatus || { phase: 'live', lastOkTs: Date.now(), errors: [] };
  return app.poller ? app.poller.status() : { phase: 'idle', errors: [] };
}

/* ---- prévia do exterior (2T-1.6, t2-ext.js) ----
 * JR e ascaribe não liberam CORS: o APK os serve pelo proxy fixo do MainActivity (/jr/v.json, /jr/ext.json, /asc/exterior.json), lido
 * aqui com fetch (assíncrono: nada trava a tela). Os boletins de urna vêm direto do TSE por uma fila própria (1 pedido a cada 1,5 s).
 * Por cidade vale a fonte com mais urnas; o T2State troca cada cidade pelo dado oficial assim que o TSE tiver as mesmas urnas. */
function isApk() {
  return typeof location !== 'undefined' && location.hostname === 'appassets.androidplatform.net';
}

function extDisabledReason() {
  if (typeof T2Ext === 'undefined') return 'módulo da prévia do exterior ausente';
  if (app.electionCode !== '6258') return `a prévia do exterior só vale para o 2º turno (código 6258; o atual é ${app.electionCode})`;
  if (!app.exteriorMap || !Array.isArray(app.exteriorMap.locations)) return app.exteriorMapNote || 'mapa de cidades do exterior ausente';
  if (!isApk()) return 'a prévia do exterior só funciona no aplicativo (no navegador as fontes não liberam acesso)';
  return '';
}

function extFetchJson(url, signal) {
  return fetch(url, { cache: 'no-store', signal }).then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  });
}

function extStatusNow() {
  if (!app.ext) return null;
  try { return app.ext.status(); } catch (error) { return app.extStatus; }
}

function stopExtController(clearGroups) {
  if (app.ext) app.ext.stop();
  app.ext = null;
  app.extState = null;
  app.extStatus = null;
  if (clearGroups && app.state && typeof app.state.clearExternalGroups === 'function') app.state.clearExternalGroups();
}

/* Grupos mudaram: recalcula a projeção. Só fontes/horários mudaram: atualiza só o painel da prévia. */
function onExtChange(status) {
  app.extStatus = status;
  if (app.rehearsal) return;
  if (app.state.version() !== app.lastVersion) refreshView();
  else safe(() => renderOfficial(currentStatus()));
}

function ensureExtController() {
  const reason = extDisabledReason();
  app.extNote = reason;
  if (reason) { stopExtController(true); return; }
  if (app.ext && app.extState === app.state) {
    if (!app.rehearsal && document.visibilityState !== 'hidden') app.ext.start();
    return;
  }
  stopExtController(false);
  if (!app.extQueue) {
    app.extQueue = T2FetchQ.createFetchQueue({ maxRps: 1 / 1.5, maxConcurrent: 1, negTtlMs: 55000, pauseMs: 900000, maxQueue: 200 });
  }
  let storage = null;
  try { storage = window.localStorage; } catch (error) { storage = null; }
  app.ext = T2Ext.createController({
    state: app.state,
    baseline: app.baseline,
    locations: app.exteriorMap.locations,
    fetchJson: extFetchJson,
    tseGet: (url, opt) => app.extQueue.get(url, opt),
    storage,
    onChange: onExtChange,
  });
  app.extState = app.state;
  app.extStatus = extStatusNow();
  if (!app.rehearsal && document.visibilityState !== 'hidden') app.ext.start();
}

function extUrnasText(ext) {
  return ext && ext.totals.urnas > 0 ? `${fmtInt(ext.totals.urnas)} urnas do exterior na prévia` : '';
}

function pillClass(c) {
  if (c.level === 'bad') return 'is-error';
  if (c.key === 'stale' || c.level === 'warn') return 'is-stale';
  if (c.key === 'waiting') return 'is-waiting';
  if (c.key === 'final') return 'is-final';
  return '';
}

/* Detalhe da faixa de conexão (texto em pt-BR, montado a partir do estado). */
function connDetail(c, status, now) {
  const since = c.since || 0;
  switch (c.key) {
    case 'pre': {
      const start = (status && status.startMs) || T2Tse.START_2T_UTC;
      const remain = start - now;
      const ext = extUrnasText(app.extStatus);
      return remain > 0
        ? `${ext ? `${ext} · ` : ''}a totalização do TSE começa às 17:00 (Brasília) · faltam ${formatCountdown(remain)}`
        : `${ext ? `${ext} · ` : ''}iniciando a consulta ao TSE`;
    }
    case 'waiting': {
      const ext = extUrnasText(app.extStatus);
      return `O TSE ainda não publicou o resultado; nova consulta a cada 30 s.${ext ? ` ${ext}.` : ''}`;
    }
    case 'connecting': return 'Consultando o TSE…';
    case 'paused': return 'Consulta pausada (app em segundo plano).';
    case 'live': return `TSE respondeu há ${fmtAge(now - since)}`;
    case 'partial': return status && status.officialFrozen
      ? `Arquivo nacional do TSE parado desde ${fmtClock(status.officialFrozen.since)}; a projeção segue pelas zonas · TSE respondeu há ${fmtAge(now - since)}`
      : `Arquivo nacional do TSE indisponível (${(status && status.brFailures) || 0} falhas seguidas); a projeção segue pelas zonas · TSE respondeu há ${fmtAge(now - since)}`;
    case 'final': return `Apuração concluída · última consulta há ${fmtAge(now - since)}`;
    case 'stale': return since
      ? `Sem resposta do TSE há ${fmtAge(now - since)} · mostrando os últimos dados (${fmtClock(since)})`
      : 'Sem resposta do TSE.';
    case 'offline': return since
      ? `Sem internet · mostrando os dados de ${fmtClock(since)}`
      : 'Sem internet · mostrando a prévia salva no aparelho.';
    case 'blocked': return `O TSE limitou os acessos · nova tentativa às ${fmtClock(c.retryAt)} (não force)`;
    case 'error': return `Formato inesperado nos arquivos do TSE: ${firstError(status)}`;
    case 'rehearsal': return 'Dados sintéticos — não são resultados';
    default: return '';
  }
}

function renderPhaseMessage(status, c) {
  const phase = status && status.phase;
  if (app.rehearsal) {
    setText(elements['t2-phase-message'], 'Ensaio sintético em andamento. Os valores não vêm do TSE.');
    setText(elements['t2-counted-state'], 'Dados sintéticos');
    return;
  }
  const extN = app.extStatus && app.extStatus.totals.urnas > 0 ? app.extStatus.totals.urnas : 0;
  const extText = extN
    ? ` ${fmtInt(extN)} urnas do exterior, lidas dos boletins de urna antes da totalização, já entram na projeção (prévia, não é a totalização oficial).`
    : '';
  if (phase === 'pre') {
    const remain = T2Tse.START_2T_UTC - Date.now();
    const ext = extText || ' Nenhum voto do 2º turno apurado ainda.';
    setText(elements['t2-phase-message'], remain > 0
      ? `Prévia: projeção a partir do 1º turno e da migração de 2022.${ext} Início da totalização do TSE previsto para 17:00 (Brasília), em ${formatCountdown(remain)}.`
      : `Prévia: projeção a partir do 1º turno e da migração de 2022.${ext}`);
    setText(elements['t2-counted-state'], extN ? 'Prévia · exterior' : 'Prévia');
  } else if (phase === 'waiting') {
    setText(elements['t2-phase-message'], `Aguardando o TSE iniciar a divulgação. O aplicativo consulta apenas o arquivo nacional enquanto aguarda.${extText}`);
    setText(elements['t2-counted-state'], extN ? 'Prévia · exterior' : 'Aguardando o TSE');
  } else if (phase === 'live') {
    const lastTs = app.lastOutput && app.lastOutput.diagnostics.lastUpdateTs;
    const ageSeconds = lastTs ? Math.max(0, Math.floor((Date.now() - lastTs) / 1000)) : null;
    const age = ageSeconds == null ? '' : ` Último dado recebido há ${fmtInt(ageSeconds)} s.`;
    const stale = c.key === 'stale';
    setText(elements['t2-phase-message'], stale
      ? `Sem dado novo há mais de 3 minutos.${age} A projeção usa a última totalização disponível.`
      : `Apuração em andamento. Os votos restantes são projetados a partir das zonas já atualizadas.${age}`);
    setText(elements['t2-counted-state'], stale ? 'Sem atualização recente' : 'Dados parciais');
  } else if (phase === 'final') {
    setText(elements['t2-phase-message'], 'Apuração concluída. Valores iguais aos oficiais.');
    setText(elements['t2-counted-state'], 'Apuração concluída');
  } else if (phase === 'error') {
    setText(elements['t2-phase-message'], `ERRO DE DADOS: ${firstError(status) || 'falha ao consultar ou interpretar os arquivos do TSE.'}`);
    setText(elements['t2-counted-state'], 'Verifique o diagnóstico');
  } else {
    setText(elements['t2-phase-message'], 'Carregando a prévia com dados históricos.');
    setText(elements['t2-counted-state'], 'Carregando');
  }
}

function renderMigration(out) {
  const body = elements['t2-migration'];
  body.replaceChildren();
  const rows = out.migration.rows || [];
  const valid1t = rows.reduce((sum, row) => ['B', 'N', 'A'].includes(row.key) ? sum : sum + row.mass, 0);
  const valid2t = out.br.final.L + out.br.final.F;
  setText(elements['t2-valid-1t'], fmtInt(valid1t));
  setText(elements['t2-valid-2t'], fmtInt(valid2t));
  setText(elements['t2-valid-delta'], fmtSignedInt(valid2t - valid1t));

  rows.forEach((item) => {
    const row = document.createElement('tr');
    makeCell(row, item.label);
    makeCell(row, fmtInt(item.mass), 'numeric');
    const values = app.flowMode ? item.flows : item.to;
    values.forEach((value) => makeCell(row, app.flowMode ? fmtInt(value) : fmtPct(value), 'numeric'));
    const confidence = makeCell(row, '', 't2-confidence');
    const level = item.weight >= 0.8 ? 3 : item.weight >= 0.4 ? 2 : 1;
    confidence.textContent = `${'●'.repeat(level)}${'○'.repeat(3 - level)}`;
    confidence.title = `${fmtPct(item.weight)} dos dados desta linha vêm da apuração; o restante ainda depende do prior de 2022.`;
    if (level === 1) confidence.classList.add('is-low');
    row.appendChild(confidence);
    body.appendChild(row);
  });
}

/* "À frente (proj.)": quem lidera a projeção. A margem saiu das duas tabelas (2T-1.6.3); no lugar, "Vantagem × 2022" (appendD22). */
function appendLeader(row, result) {
  const leader = result.leaderFinal === 'L' ? 'Lula' : result.leaderFinal === 'F' ? 'Flávio' : 'Empate';
  const cell = makeCell(row, leader, result.leaderFinal === 'L' ? 't2-leader-l' : result.leaderFinal === 'F' ? 't2-leader-f' : '');
  if (result.leaderFinal) cell.classList.add(`t2-leader-${result.leaderFinal.toLowerCase()}`);
}

/* Colunas Lula/Flávio (Estados e Municípios; logo depois de Apurado e À frente), na ordem de comparação: projeção, 2º turno de 2022 (Lula/Bolsonaro), apurado agora e
   1º turno de 2026 — o apurado fica entre as duas referências históricas. Em % dos válidos ou, com votes, em votos. No detalhe por
   município não há a coluna da projeção (withProj = false). */
function appendShares(row, result, withProj = true, votes = false) {
  const t1 = result.t1, v22 = result.vs22;
  const pair = (l, f) => (votes ? `${fmtInt(l)} / ${fmtInt(f)}` : `${fmtPct(l)} / ${fmtPct(f)}`);
  if (withProj) makeCell(row, votes ? pair(result.final.L, result.final.F) : pair(result.finalShare.L, result.finalShare.F), 'numeric t2-pair');
  makeCell(row, v22 ? `${votes ? pair(v22.votosL, v22.votosF) : pair(v22.L, v22.F)}${v22.cobertura < 0.99 ? ' *' : ''}` : '—', 'numeric t2-pair t2-hist');
  makeCell(row, result.countedShare.valid > 0
    ? (votes ? pair(result.counted.L, result.counted.F) : pair(result.countedShare.L, result.countedShare.F)) : '—', 'numeric t2-pair');
  makeCell(row, t1 ? (votes ? pair(t1.votosL, t1.votosF) : pair(t1.L, t1.F)) : '—', 'numeric t2-pair t2-hist');
}

/* País de uma cidade do exterior (mapa de localidades), para o detalhe do ZZ. */
function exteriorCountry(mun) {
  const list = app.exteriorMap && Array.isArray(app.exteriorMap.locations) ? app.exteriorMap.locations : [];
  if (!app.exteriorCountries) app.exteriorCountries = new Map(list.map((l) => [String(l.code), l.country]));
  return app.exteriorCountries.get(String(mun)) || '';
}

/* Coluna "Vantagem × 2022" de Estados e do município (2T-1.6.3): Σ, nas zonas da UF / do município, da margem L − F apurada contra a de 2022 proporcional ao
   apurado de cada zona (a conta do painel "zona a zona"). Sempre em votos; + ganhou, − perdeu. */
function appendD22(row, result) {
  const d = result.d22;
  const cell = makeCell(row, d ? fmtSignedInt(d.votos) : '—', 'numeric t2-d22');
  if (!d) return;
  const n = Math.round(d.votos);
  if (n > 0) cell.classList.add('is-gain'); else if (n < 0) cell.classList.add('is-loss');
  cell.title = `Vantagem de Lula (Lula − Flávio) contra a de 2022 (Lula − Bolsonaro) nas mesmas zonas, proporcional ao apurado de cada zona; ${d.zonas === 1 ? '1 zona' : `${fmtInt(d.zonas)} zonas`}`;
}

/* Detalhe por município: os 15 maiores da UF. No exterior (ZZ) as cidades são pequenas e a apuração começa pelas da Oceania e da
   Ásia, fora das 15 maiores: mostra todas, as que já têm votos (prévia ou TSE) primeiro, com o país. */
function renderMunicipalities(uf, scroll = true) {
  app.munUf = uf;
  markOpenUf();
  const zz = uf === 'ZZ';
  let rows = app.state.municipios(uf, zz ? 100000 : 15);
  if (zz) rows = rows.filter((r) => r.ec > 0).concat(rows.filter((r) => !(r.ec > 0)));
  setText(elements['t2-mun-footer'], zz
    ? `Exterior: todas as ${fmtInt(rows.length)} cidades; as que já têm votos (prévia dos boletins ou TSE) aparecem primeiro, depois as demais por eleitorado. 2º turno 2022: Lula × Jair Bolsonaro nas mesmas zonas; * = parte das zonas sem dado de 2022. 1º turno 2026: Lula e Flávio só entre os dois (somam 100%), para comparar com o 2º turno. Em percentuais, % dos votos válidos; em votos, os votos de cada um. Vantagem × 2022: a vantagem de Lula no apurado contra a de 2022 nas mesmas zonas, proporcional ao apurado de cada zona (a conta do painel "zona a zona"); + ganhou, − perdeu.`
    : 'Exibimos os 15 municípios com maior eleitorado nesta UF. 2º turno 2022: Lula × Jair Bolsonaro nas mesmas zonas; * = parte das zonas sem dado de 2022. 1º turno 2026: Lula e Flávio só entre os dois (somam 100%), para comparar com o 2º turno. Em percentuais, % dos votos válidos; em votos, os votos de cada um. Vantagem × 2022: a vantagem de Lula no apurado contra a de 2022 nas mesmas zonas, proporcional ao apurado de cada zona (a conta do painel "zona a zona"); + ganhou, − perdeu.');
  const body = elements['t2-municipal-rows'];
  body.replaceChildren();
  setText(elements['t2-mun-title'], `${app.baseline.ufs[uf] || uf} (${uf})`);
  elements['t2-municipal-panel'].classList.remove('hidden');
  rows.forEach((result) => {
    const row = document.createElement('tr');
    const country = zz ? exteriorCountry(result.mun) : '';
    makeCell(row, `${result.nome || result.mun}${country ? ` · ${country}` : ''}`);
    makeCell(row, fmtPct(result.progressPct), 'numeric');
    appendLeader(row, result);
    appendShares(row, result, false, app.munVotes);
    appendD22(row, result);
    body.appendChild(row);
  });
  if (scroll) {
    elements['t2-municipal-panel'].scrollIntoView({ behavior: 'smooth', block: 'start' });
    focusQuiet(elements['t2-mun-title']);
  }
}

function focusQuiet(el) {
  if (el && typeof el.focus === 'function') el.focus({ preventScroll: true });
}

/* Marca na tabela Estados a linha da UF aberta no detalhe (is-open + aria-expanded); devolve o botão dela. */
function markOpenUf() {
  const body = elements['t2-ufs'];
  let open = null;
  Array.from((body && body.children) || []).forEach((row) => {
    const cell = row.children && row.children[0];
    const button = cell && cell.children ? cell.children[0] : null;
    if (!button || !button.dataset || !button.dataset.uf) return;
    const isOpen = !!app.munUf && button.dataset.uf === app.munUf;
    row.classList.toggle('is-open', isOpen);
    button.setAttribute('aria-expanded', String(isOpen));
    if (isOpen) open = button;
  });
  return open;
}

/* Fechar o detalhe (botão do topo ou "Voltar aos estados" do rodapé): volta à linha da UF na tabela Estados, com o foco nela. */
function closeMunicipalities() {
  const button = markOpenUf();
  app.munUf = '';
  markOpenUf();
  elements['t2-municipal-panel'].classList.add('hidden');
  if (button) {
    button.scrollIntoView({ behavior: 'smooth', block: 'center' });
    focusQuiet(button);
  }
}

/* Botões de UF: o clique é tratado por delegação em #t2-ufs (um único listener, ver bindEvents). */
function renderUfs(out) {
  const body = elements['t2-ufs'];
  body.replaceChildren();
  Object.entries(out.ufs).forEach(([uf, result]) => {
    const row = document.createElement('tr');
    const nameCell = document.createElement('td');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 't2-uf-button';
    button.dataset.uf = uf;
    button.textContent = `${uf} · ${result.nome || uf}`;
    button.setAttribute('aria-label', `Ver os municípios de ${result.nome || uf}`);
    button.setAttribute('aria-expanded', String(app.munUf === uf));
    if (app.munUf === uf) row.classList.add('is-open');
    nameCell.appendChild(button);
    row.appendChild(nameCell);
    makeCell(row, fmtPct(result.progressPct), 'numeric');
    appendLeader(row, result);
    appendShares(row, result, true, app.ufVotes);
    appendD22(row, result);
    body.appendChild(row);
  });
}

/* Painel "Apuração oficial · TSE": seções e votos como o TSE publicou (nada é projetado aqui). Antes do primeiro arquivo nacional do TSE
 * com seções, mostra a PRÉVIA DO EXTERIOR (2T-1.6): só as urnas recebidas no exterior, por cidade a fonte com mais urnas. */
function rehearsalOfficial() {
  const out = app.lastOutput;
  if (!out) return null;
  const c = out.br.counted;
  return { y: [c.L, c.F, c.B, c.N, c.A], E: out.br.E, s: out.progress.sectionsTotal, st: out.progress.sectionsCounted };
}

/* Linha menor nos cartões da apuração (2T-1.6.3): o 2º turno de 2022 nas mesmas zonas já apuradas (na prévia, as cidades do exterior
   com urnas), ponderado pelos válidos apurados hoje em cada zona: out.vs2022.apurado.lula22. * = parte dos votos apurados sem 2022. */
function renderOff22(active) {
  const a = active && app.lastOutput && app.lastOutput.vs2022 ? app.lastOutput.vs2022.apurado : null;
  const elL = elements['t2-off-L-22'], elF = elements['t2-off-F-22'];
  const star = a && a.cobertura < 0.99 ? ' *' : '';
  setText(elL, a ? `2022, mesmas zonas: ${fmtPct(a.lula22)}${star}` : '');
  setText(elF, a ? `Bolsonaro 2022, mesmas zonas: ${fmtPct(1 - a.lula22)}${star}` : '');
  const title = a ? `2º turno de 2022 (Lula × Bolsonaro) nas mesmas zonas já apuradas, pesado pelos votos válidos apurados hoje em cada zona${star ? `; ${fmtPct(a.cobertura)} dos votos apurados vêm de zonas com 2022` : ''}.` : '';
  [elL, elF].forEach((el) => {
    if (!el) return;
    el.classList.toggle('hidden', !a);
    if (el.title !== title) el.title = title;
  });
}

function renderOfficial(status) {
  const phase = status && status.phase;
  const ext = app.rehearsal ? null : app.extStatus;
  const tse = app.rehearsal ? rehearsalOfficial() : (status && status.official) || null;
  // o painel nacional do TSE vale a partir do primeiro arquivo nacional com seções; antes disso, a prévia do exterior (se houver urnas)
  const official = app.rehearsal ? tse : (tse && tse.st > 0 ? tse : null);
  const preview = !official && !!ext && ext.totals.urnas > 0;
  renderExtSync(ext);
  renderExtCountries(preview ? ext.countries : null);
  elements['t2-off-sources'].classList.toggle('hidden', !preview);
  if (app.rehearsal) {
    setText(elements['t2-off-eyebrow'], 'ENSAIO · DADOS SINTÉTICOS');
    setText(elements['t2-off-title'], 'Seções simuladas:');
  } else if (preview) {
    setText(elements['t2-off-eyebrow'], 'PRÉVIA DO EXTERIOR · BOLETINS DE URNA');
    setText(elements['t2-off-title'], 'Urnas do exterior recebidas:');
  } else {
    setText(elements['t2-off-eyebrow'], 'APURAÇÃO OFICIAL · TSE');
    setText(elements['t2-off-title'], 'Seções apuradas:');
  }
  const o = preview
    ? { y: [ext.totals.L, ext.totals.F, ext.totals.B, ext.totals.N, ext.totals.A], s: ext.totals.total, st: ext.totals.urnas }
    : (official || (tse && !app.rehearsal ? tse : null));
  if (!o) {
    setText(elements['t2-off-secpct'], '—');
    setText(elements['t2-off-sections'], '—');
    setText(elements['t2-off-L-pct'], '—');
    setText(elements['t2-off-F-pct'], '—');
    setText(elements['t2-off-L-votes'], '—');
    setText(elements['t2-off-F-votes'], '—');
    elements['t2-off-progress-bar'].style.width = '0%';
    elements['t2-off-bar-L'].style.width = '50%';
    elements['t2-off-bar-F'].style.width = '50%';
    renderOff22(false);
    setText(elements['t2-off-lead'], (phase === 'pre' || phase === 'waiting' || !phase)
      ? 'A apuração oficial começa às 17:00 (horário de Brasília) de 25/10.'
      : (status && status.officialStale ? 'Arquivo nacional do TSE indisponível; a projeção segue pelas zonas.' : 'Aguardando o arquivo nacional do TSE.'));
    setText(elements['t2-off-extra'], app.rehearsal || app.extNote ? ''
      : ext ? 'Prévia do exterior: nenhuma urna do exterior recebida ainda. O painel mostra os boletins assim que chegarem.' : '');
    return;
  }
  const secPct = o.s > 0 ? o.st / o.s : 0;
  setText(elements['t2-off-secpct'], fmtPctFloor(secPct));
  setText(elements['t2-off-sections'], preview
    ? `${fmtInt(o.st)} de ${fmtInt(o.s)} urnas · ${fmtInt(ext.totals.cities)} ${ext.totals.cities === 1 ? 'cidade' : 'cidades'}`
    : `${fmtInt(o.st)} de ${fmtInt(o.s)} seções`);
  elements['t2-off-progress-bar'].style.width = clampPercent(secPct);
  const L = Number(o.y[0]) || 0, F = Number(o.y[1]) || 0, B = Number(o.y[2]) || 0, N = Number(o.y[3]) || 0, A = Number(o.y[4]) || 0;
  const valid = L + F;                                  // válidos no 2º turno = Lula + Flávio
  if (valid > 0) {
    setText(elements['t2-off-L-pct'], fmtPct(L / valid));
    setText(elements['t2-off-F-pct'], fmtPct(F / valid));
    setText(elements['t2-off-L-votes'], `${fmtInt(L)} votos`);
    setText(elements['t2-off-F-votes'], `${fmtInt(F)} votos`);
    renderOff22(true);
    elements['t2-off-bar-L'].style.width = clampPercent(L / valid);
    elements['t2-off-bar-F'].style.width = clampPercent(F / valid);
    setText(elements['t2-off-lead'], L === F
      ? 'Empate nos votos apurados.'
      : `${L > F ? 'Lula' : 'Flávio'} à frente por ${fmtInt(Math.abs(L - F))} votos (${fmtPp(Math.abs(L - F) / valid * 100)})`);
  } else {
    setText(elements['t2-off-L-pct'], '—');
    setText(elements['t2-off-F-pct'], '—');
    setText(elements['t2-off-L-votes'], '—');
    setText(elements['t2-off-F-votes'], '—');
    elements['t2-off-bar-L'].style.width = '50%';
    elements['t2-off-bar-F'].style.width = '50%';
    renderOff22(false);
    setText(elements['t2-off-lead'], 'Nenhum voto apurado ainda.');
  }
  let extra = `Brancos ${fmtInt(B)} · Nulos ${fmtInt(N)} · Abstenção ${fmtInt(A)}`;
  if (L + F + B + N + A > 0) extra += ` · Comparecimento ${fmtPct((L + F + B + N) / (L + F + B + N + A))} dos apurados`;
  if (preview) {
    extra = `Brancos ${fmtInt(B)} · Nulos ${fmtInt(N)} · Abstenção ${fmtInt(A)} nas urnas recebidas` +
      (L + F + B + N + A > 0 ? ` · Comparecimento ${fmtPct((L + F + B + N) / (L + F + B + N + A))}` : '') +
      ` · ${extSourcesText(ext.bySource)}` +
      (ext.totals.est ? ' · abstenção, brancos e nulos estimados em parte das cidades' : '') +
      '. Prévia: são os boletins das urnas do exterior, ainda não totalizados pelo TSE.';
  } else if (!app.rehearsal) {
    if (status && status.officialFrozen) extra += ` · Arquivo nacional do TSE parado desde ${fmtClock(status.officialFrozen.since)}`;
    else if (status && status.officialStale) extra += ` · Arquivo nacional indisponível agora; mostrando a leitura de ${fmtClock(status.officialTs)}`;
    const ext2 = app.lastOutput && app.lastOutput.diagnostics && app.lastOutput.diagnostics.external;
    if (ext2 && ext2.ahead > 0) extra += ` · + ${fmtInt(ext2.ahead)} ${ext2.ahead === 1 ? 'urna' : 'urnas'} do exterior ainda fora do TSE (entram na projeção pela prévia)`;
  }
  setText(elements['t2-off-extra'], extra);
}

function extSourcesText(bySource) {
  const parts = [['bu', 'boletins lidos do TSE'], ['jr', 'Jornal Razão'], ['asc', 'ascaribe']]
    .filter(([k]) => bySource && bySource[k] > 0)
    .map(([k, name]) => `${name} ${fmtInt(bySource[k])}`);
  return parts.length ? `urnas por fonte: ${parts.join(', ')}` : 'sem urnas';
}

function buStateText(bu) {
  switch (bu.state) {
    case 'off': return 'desligado';
    case 'stopped': return 'leitura encerrada às 16:45';
    case 'paused': return `o TSE pediu pausa; volta às ${fmtClock(bu.blockedUntil)}`;
    case 'nocs': return 'sem a lista de seções do TSE';
    case 'loading': return 'carregando a lista de seções';
    case 'busy': return 'procurando boletins';
    default: return 'em dia';
  }
}

/* Linha de sincronização da prévia: horário da última rodada, contagem para a próxima e situação de cada fonte. */
function renderExtSync(ext) {
  const el = elements['t2-off-sync'];
  if (!el) return;
  let text = '';
  if (!app.rehearsal && app.extNote) text = `Prévia do exterior desligada: ${app.extNote}.`;
  else if (!app.rehearsal && ext) {
    const now = Date.now(), s = ext.sources;
    const when = ext.inFlight ? 'Exterior: sincronizando…'
      : ext.lastSyncAt ? `Exterior sincronizado às ${fmtClock(ext.lastSyncAt)}` : 'Exterior: primeira sincronização…';
    const next = !ext.running ? ' · pausado' : (!ext.inFlight && ext.nextSyncAt > now ? ` · próxima em ${Math.ceil((ext.nextSyncAt - now) / 1000)} s` : '');
    const src = [
      `boletins do TSE ${fmtInt(s.bu.urnas)}${s.bu.state === 'paused' ? ' (pausado)' : ''}`,
      `Jornal Razão ${s.jr.lastError ? 'com erro' : fmtInt(s.jr.urnas)}`,
      `ascaribe ${s.asc.lastError ? 'com erro' : fmtInt(s.asc.urnas)}`,
    ].join(' · ');
    text = `${when}${next} · urnas: ${src}`;
  }
  if (el.textContent !== text) setText(el, text);
  el.classList.toggle('hidden', !text);
}

/* Lista por país da prévia: refeita só quando muda (o painel é redesenhado a cada segundo). */
function renderExtCountries(countries) {
  const box = elements['t2-off-countries'];
  if (!box) return;
  const list = Array.isArray(countries) ? countries : [];
  const sig = JSON.stringify(list.map((c) => [c.name, c.urnas, c.total, c.L, c.F, c.sources, c.est]));
  if (sig === app.extCountriesSig) return;
  app.extCountriesSig = sig;
  const ul = elements['t2-off-country-list'];
  ul.replaceChildren();
  if (!list.length) { box.classList.add('hidden'); return; }
  setText(elements['t2-off-countries-sum'], `Por país: ${fmtInt(list.length)} ${list.length === 1 ? 'país' : 'países'} com urnas recebidas`);
  list.forEach((c) => {
    const li = document.createElement('li');
    li.className = 't2-off-country-row';
    const valid = c.L + c.F;
    li.textContent = `${c.name} · ${c.complete ? 'completo' : 'parcial'} · ${fmtInt(c.urnas)} de ${fmtInt(c.total)} urnas · ` +
      `Lula ${fmtInt(c.L)} × Flávio ${fmtInt(c.F)}${valid > 0 ? ` (${fmtPct(c.L / valid)} Lula)` : ''} · ` +
      `${c.sources.map((k) => T2Ext.SOURCE_NAMES[k] || k).join(' + ')}${c.est ? ' · abstenção estimada' : ''}`;
    ul.appendChild(li);
  });
  box.classList.remove('hidden');
}

/* Diagnóstico da prévia do exterior: uma parte por fonte e o que entrou na projeção. */
function extDiagText(extern) {
  if (app.rehearsal) return 'Prévia do exterior: pausada durante o ensaio sintético.';
  if (app.extNote) return `Prévia do exterior desligada: ${app.extNote}.`;
  const e = app.extStatus;
  if (!e) return 'Prévia do exterior: iniciando.';
  const s = e.sources;
  const list = (items) => items.map((p) => `${p.name} (${p.reason})`).join('; ');
  const parts = [
    `Prévia do exterior: ${fmtInt(e.totals.urnas)} urnas em ${fmtInt(e.totals.cities)} cidades (${extSourcesText(e.bySource)}); ${fmtInt(e.cycles)} sincronizações, a última às ${fmtClock(e.lastSyncAt)}`,
    `boletins do TSE: ${fmtInt(s.bu.urnas)} urnas lidas em ${fmtInt(s.bu.cities)} cidades, ${buStateText(s.bu)}, ${fmtInt(s.bu.requests)} pedidos, ${fmtInt(s.bu.misses)} seções ainda não recebidas, ${fmtInt(s.bu.errors)} erros${s.bu.lastError ? ` (último: ${s.bu.lastError})` : ''}`,
    `Jornal Razão: ${fmtInt(s.jr.urnas)} urnas, versão ${s.jr.version == null ? '—' : s.jr.version}, último boletim ${fmtClock(s.jr.lastBuAt)}${s.jr.paused ? ', feed em pausa' : ''}${s.jr.lastError ? `, erro: ${s.jr.lastError}` : ''}${s.jr.problems.length ? `, ignorados: ${list(s.jr.problems)}` : ''}`,
    `ascaribe: ${fmtInt(s.asc.urnas)} urnas, atualizado às ${fmtClock(s.asc.at)}${s.asc.lastError ? `, erro: ${s.asc.lastError}` : ''}${s.asc.problems.length ? `, ignorados: ${list(s.asc.problems)}` : ''}`,
  ];
  if (extern) {
    parts.push(`na projeção: ${fmtInt(extern.groups)} cidades da prévia, ${fmtInt(extern.superseded)} já trocadas pelo TSE` +
      `${extern.rejected && extern.rejected.length ? `, recusadas: ${list(extern.rejected)}` : ''}`);
  }
  if (e.skipped && e.skipped.length) parts.push(`fora da prévia: ${list(e.skipped)}`);
  if (e.lastError) parts.push(`erro: ${e.lastError}`);
  return `${parts.join(' · ')}.`;
}

function renderDiagnostics(out, status) {
  const migration = out.migration;
  const diagnostics = out.diagnostics;
  const countedUnits = `${out.progress.unitsWithData}/${out.progress.unitsTotal}`;
  const weight = migration.dataWeight;
  setText(elements['t2-diag-migration'], `Migração: dados ${fmtPct(weight)} / prior 2022 ${fmtPct(1 - weight)}; ${migration.unitsUsed} unidades na estimativa.`);
  setText(elements['t2-diag-units'], `Unidades com dados: ${countedUnits}. Unidades desconhecidas: ${diagnostics.unknownUnits.length}. Fallback de 2022: ${diagnostics.fallback22Used.length}.`);
  setText(elements['t2-diag-updates'], `Atualizações: ${diagnostics.updates}; regressões: ${diagnostics.regressions}; atualizações inválidas: ${diagnostics.invalidUpdates}.`);
  renderPollerDiag(status);
  const band = `Faixa entre métodos (cenário principal, sem ajuste local, só prior): Lula ${fmtPct(out.band.lo)}–${fmtPct(out.band.hi)} dos votos válidos (não é margem de erro).`;
  const curveText = diagnostics.curveLoaded
    ? `Curva de chegada: carregada (${fmtInt(diagnostics.curveUnits)} zonas), α=${diagnostics.arrivalAlpha}${diagnostics.arrivalRamp > 0 ? ` (rampa até ${Math.round(diagnostics.arrivalRamp * 100)}% da zona)` : ''}, aplicada em ${fmtInt(diagnostics.arrivalApplied)} zonas`
    : `Curva de chegada: não carregada${diagnostics.curveNote || app.curveNote ? ` (${diagnostics.curveNote || app.curveNote})` : ''}`;
  const unc = out.uncertainty;
  const calib = unc && unc.pp > 0 && unc.classe
    ? ` Faixa calibrada: ±${fmtPp(unc.pp)} na classe ${Math.round(unc.classe.de * 100)}–${Math.round(unc.classe.ate * 100)}% apurado (2× o maior erro nos ensaios com a ordem real de 2018 e 2022, 100 classes de 1%${diagnostics.membershipApplied > 0 ? '; com pertença exata, a faixa própria da versão por seção' : ''}). Nos dois ensaios a projeção começou superestimando o candidato do PT.`
    : '';
  setText(elements['t2-diag-arrival'], `${curveText}; pertença exata em ${fmtInt(diagnostics.membershipApplied)} zonas. ${band}${calib}`);
  setText(elements['t2-diag-plugin'], pluginStatusText());
  setText(elements['t2-diag-queue'], `Fila: ${status.queue ? JSON.stringify(status.queue) : 'sem fila ativa'}.`);
  setText(elements['t2-diag-ext'], extDiagText(diagnostics.external));
  if (status.official && Array.isArray(status.official.y)) {
    // soma das zonas como o TSE as publicou: sem os grupos da prévia do exterior e com as zonas que eles escondem
    const ex = diagnostics.external || {}, gv = ex.votes || [0, 0, 0, 0, 0], mv = ex.maskedVotes || [0, 0, 0, 0, 0];
    const zoneSum = [out.br.counted.L, out.br.counted.F, out.br.counted.B, out.br.counted.N, out.br.counted.A].map((v, i) => v - gv[i] + mv[i]);
    const differences = zoneSum.map((value, i) => Math.round(status.official.y[i] - value));
    setText(elements['t2-diag-official'], `Oficial × soma das zonas (L/F/B/N/A): ${differences.map(fmtSignedInt).join(' / ')} votos.`);
  } else {
    setText(elements['t2-diag-official'], 'Oficial × soma das zonas: aguardando o EA20 do Brasil.');
  }
  const notes = [app.electionMismatch, app.electionNote, app.curveNote, app.pluginError].filter(Boolean);
  const errorList = (status.errors || []).slice(0, 5).map((error) => {
    if (typeof error === 'string') return error;
    const when = error.at ? `${fmtClock(error.at)} ` : '';
    return `${when}${firstError({ errors: [error] })}`;
  });
  const all = notes.concat(errorList);
  setText(elements['t2-diag-errors'], all.length ? `Avisos: ${all.join(' · ')}` : 'Sem erros ou avisos registrados.');
}

function renderPollerDiag(status) {
  const s = status || {};
  const abSummary = Object.values(s.abState || {}).reduce((counts, value) => {
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
  const lf = s.lastFailure;
  setText(elements['t2-diag-poller'],
    `Poller: ${s.phase || 'idle'}; ciclos ${s.cycles || 0}; unidades consultadas ${s.fetched || 0}; EA15/varredura ${JSON.stringify(abSummary)}; ` +
    `falhas seguidas ${s.consecutiveFailures || 0}; falhas do arquivo nacional ${s.brFailures || 0}${s.officialFrozen ? ' (parado)' : ''}; última falha ${lf ? `${lf.kind} às ${fmtClock(lf.at)}` : '—'}; ` +
    `próximo ciclo ${s.nextCycleAt ? fmtClock(s.nextCycleAt) : '—'}.`);
}

/* Render PESADO: tudo que depende da projeção. Só roda quando há um "out" novo (após recompute). */
function renderData(out, status) {
  app.lastOutput = out;
  const br = out.br;
  setText(elements['t2-L-pct'], fmtPct(br.finalShare.L));
  setText(elements['t2-F-pct'], fmtPct(br.finalShare.F));
  setText(elements['t2-L-votes'], fmtInt(br.final.L));
  setText(elements['t2-F-votes'], fmtInt(br.final.F));
  elements['t2-bar-L'].style.width = clampPercent(br.finalShare.L);
  elements['t2-bar-F'].style.width = clampPercent(br.finalShare.F);

  const unc = out.uncertainty || { pp: 0, lo: br.finalShare.L, hi: br.finalShare.L };
  const indefinido = unc.pp > 0 && unc.lo <= 0.5 && 0.5 <= unc.hi;
  let lead;
  if (indefinido) {
    lead = `Indefinido: diferença menor que o erro típico (Lula ${fmtPct(br.finalShare.L)} × Flávio ${fmtPct(br.finalShare.F)})`;
  } else if (br.leaderFinal) {
    const leader = br.leaderFinal === 'L' ? 'Lula' : 'Flávio';
    const pp = Math.abs(br.finalShare.L - br.finalShare.F) * 100;
    lead = `${leader} à frente por ${fmtPp(pp)} (≈ ${fmtInt(Math.abs(br.margin.final))} votos)`;
  } else {
    lead = 'Empate técnico na projeção.';
  }
  if (out.progress.unitsWithData === 0 && (status.phase || 'idle') !== 'pre') lead += ' — prévia: nenhuma zona lida ainda';
  setText(elements['t2-lead'], lead);
  setText(elements['t2-band'], (unc.pp > 0
    ? `Lula ${fmtPct(br.finalShare.L)} ± ${fmtPp(unc.pp)} (faixa: 2× o maior erro nos ensaios com a ordem real de 2018 e 2022; nos dois, o começo da noite superestimou o candidato do PT)`
    : `Lula ${fmtPct(br.finalShare.L)} (apuração concluída: sem margem de projeção)`) + chanceText(out.chance, unc));

  setText(elements['t2-progress'], fmtPctFloor(out.progress.electorateCountedPct));
  elements['t2-progress-bar'].style.width = clampPercent(out.progress.electorateCountedPct);
  const sections = elements['t2-sections'];
  const exterior = out.diagnostics && out.diagnostics.external;
  const extN = exterior && Number(exterior.sectionsCounted) > 0 ? Number(exterior.sectionsCounted) : 0;
  const extNote = extN
    ? ` · inclui ${fmtInt(extN)} ${extN === 1 ? 'urna' : 'urnas'} do exterior pela prévia (${fmtInt(exterior.groups)} ${exterior.groups === 1 ? 'cidade' : 'cidades'})`
    : '';
  if (out.progress.sectionsTotal > 0) {
    setText(sections, `Seções/Zonas apuradas: ${fmtInt(out.progress.sectionsCounted)} / ${fmtInt(out.progress.sectionsTotal)}${extNote}`);
    sections.classList.remove('hidden');
  } else {
    sections.classList.add('hidden');
  }
  const current = br.countedShare;
  setText(elements['t2-now-pct'], current.valid > 0
    ? `Votos válidos apurados: Lula ${fmtPct(current.L)} · Flávio ${fmtPct(current.F)}`
    : 'Votos válidos apurados: —');
  setText(elements['t2-source-note'], app.rehearsal
    ? 'Ensaio com dados sintéticos; não usa a apuração.'
    : extN
      ? 'Fontes: TSE nas zonas já totalizadas; no exterior ainda não totalizado, prévia pelos boletins de urna (lidos do TSE, do Jornal Razão e do ascaribe), cidade a cidade até o TSE alcançar.'
      : 'Fonte dos dados: TSE.');

  // Aviso quando o TSE já tem bem mais seções do que as zonas que o app leu.
  const lag = elements['t2-lag-note'];
  const off = status.official;
  if (!app.rehearsal && off && off.s > 0 && !status.officialFrozen && !status.officialStale) {
    const secPct = off.st / off.s, zonePct = out.progress.electorateCountedPct;
    if (secPct - zonePct > 0.02) {
      setText(lag, `O TSE já tem ${fmtPctFloor(secPct)} das seções; a projeção ainda usa ${fmtPctFloor(zonePct)} do eleitorado (zonas sendo lidas).`);
      lag.classList.remove('hidden');
    } else {
      lag.classList.add('hidden');
    }
  } else {
    lag.classList.add('hidden');
  }

  const need = out.forNeed;
  if (need) {
    const trailer = need.trailer === 'L' ? 'Lula' : 'Flávio';
    const text = need.trailerNeedShare > 1
      ? `Matematicamente impossível: ${trailer} precisaria de mais de 100% dos votos válidos restantes.`
      : `Para virar, ${trailer} precisa de ${fmtPct(need.trailerNeedShare)} dos válidos restantes (o modelo projeta ${fmtPct(need.trailerProjectedShare)}).`;
    setText(elements['t2-forneed'], text);
    elements['t2-forneed'].classList.remove('hidden');
  } else {
    elements['t2-forneed'].classList.add('hidden');
  }
  // tabelas e cartelas só são refeitas quando a projeção muda (recompute devolve o mesmo objeto sem dado novo): o ciclo do poller
  // não recria as linhas nem derruba toque ou foco nelas. O detalhe por município aberto acompanha (antes ficava congelado).
  if (app.renderedOut !== out) {
    app.renderedOut = out;
    renderVs2022(out);
    renderMigration(out);
    renderUfs(out);
    if (app.munUf) renderMunicipalities(app.munUf, false);
  }
  renderDiagnostics(out, status);
  renderOfficial(status);
}

/* Chance a partir da projeção e da faixa calibrada (t de 4 g.l., escala = metade da faixa). Até 95% apurado vem limitada a [5%, 95%]
 * (teto): os extremos aparecem como "> 95%" / "< 5%"; depois, "> 99%" / "< 1%". */
function fmtChance(p, teto) {
  if (teto && p >= teto - 1e-9) return `> ${Math.round(teto * 100)}%`;
  if (teto && p <= 1 - teto + 1e-9) return `< ${Math.round((1 - teto) * 100)}%`;
  if (p >= 0.995) return '> 99%';
  if (p <= 0.005) return '< 1%';
  return `${Math.round(p * 100)}%`;
}
function chanceText(c, unc) {
  if (!c || !(unc && unc.pp > 0)) return '';
  return ` · chance de vitória: Lula ${fmtChance(c.L, c.teto)}, Flávio ${fmtChance(c.F, c.teto)}`;
}
/* Votos com sinal, em mil / mi. */
function fmtVotos(v, signed) {
  const n = Number(v) || 0, a = Math.abs(n), sg = signed ? (n > 0 ? '+' : n < 0 ? '−' : '') : (n < 0 ? '−' : '');
  if (a >= 995000) return `${sg}${percentFormat.format(a / 1e6)} mi`;
  if (a >= 1000) return `${sg}${fmtInt(Math.round(a / 1000))} mil`;
  return `${sg}${fmtInt(Math.round(a))}`;
}

/* Painel "contra 2022" (2T-1.4.2): a vantagem de Lula no 2º turno de 2022 (fixa), quanto dela ele perdeu e ganhou zona a zona no já
 * apurado (valores absolutos), o que resta, e a referência do % apurado. Números de out.vs2022.zonas (t2-state.js); só apresentação. */
const pct1Format = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
function fmtPct1(p) { return `${pct1Format.format((Number(p) || 0) * 100)}%`; }
function zonasTxt(n) { return n === 1 ? 'em 1 zona' : `em ${fmtInt(n)} zonas`; }

function renderVs2022(out) {
  const v = out && out.vs2022, z = v && v.zonas;
  const ok = !!(z && v.cobertura > 0.5);
  const ap = out ? out.progress.electorateCountedPct : 0, comDados = !!(out && out.progress.unitsWithData > 0);
  setText(elements['t2-vs22-state'], !ok ? 'Indisponível' : !comDados ? 'Aguardando a apuração' : app.rehearsal ? 'Ensaio' : 'Ao vivo');
  const sinal = (el, x) => { el.classList.toggle('is-pos', x > 0); el.classList.toggle('is-neg', x < 0); };
  if (!ok) {
    ['t2-vs22-base', 't2-vs22-perdeu', 't2-vs22-ganhou', 't2-vs22-resta'].forEach((id) => setText(elements[id], '—'));
    setText(elements['t2-vs22-perdeu-sub'], '');
    setText(elements['t2-vs22-ganhou-sub'], '');
    setText(elements['t2-vs22-resta-pct'], v ? `só ${fmtPct(v.cobertura)} do eleitorado tem 2022 na mesma zona` : 'sem o 2º turno de 2022 por zona');
    setText(elements['t2-vs22-ritmo'], '');
    setText(elements['t2-vs22-chance'], '—');
    setText(elements['t2-vs22-chance-sub'], '');
    return;
  }
  setText(elements['t2-vs22-base'], fmtSignedInt(z.margem22));
  setText(elements['t2-vs22-perdeu'], z.perdeu > 0 ? `−${fmtInt(z.perdeu)}` : '0');
  setText(elements['t2-vs22-ganhou'], z.ganhou > 0 ? `+${fmtInt(z.ganhou)}` : '0');
  setText(elements['t2-vs22-perdeu-sub'], comDados ? zonasTxt(z.nPerdeu) : 'nenhuma zona lida ainda');
  setText(elements['t2-vs22-ganhou-sub'], comDados ? zonasTxt(z.nGanhou) : 'nenhuma zona lida ainda');
  setText(elements['t2-vs22-resta'], fmtSignedInt(z.resta));
  sinal(elements['t2-vs22-resta'], z.resta);
  const base = z.margem22 > 0;
  setText(elements['t2-vs22-resta-pct'], base ? `${fmtPct1(z.resta / z.margem22)} da vantagem de 2022` : 'em 2022 Lula não tinha vantagem nessas zonas');
  // chance de a vantagem chegar a zero = chance de Lula perder (a mesma da faixa: projeção ± faixa calibrada, t de 4 g.l., teto 5–95%)
  const c = out.chance, unc = out.uncertainty;
  setText(elements['t2-vs22-chance'], c ? fmtChance(c.F, c.teto) : '—');
  setText(elements['t2-vs22-chance-sub'], !c ? 'aparece com o primeiro dado'
    : unc && unc.pp > 0 ? 'isto é, de Lula perder: projeção ± o erro possível' : 'apuração concluída');
  // referência: vantagem consumida (líquida) contra o % apurado; se a perda fosse uniforme, Lula fecha na frente enquanto consumida < apurado
  const usada = base ? (z.perdeu - z.ganhou) / z.margem22 : 0;
  setText(elements['t2-vs22-usada'], usada < 0 ? `+${fmtPct1(-usada)}` : fmtPct1(usada));
  elements['t2-vs22-bar-usada'].style.width = clampPercent(usada);
  setText(elements['t2-vs22-ap'], fmtPct1(Math.floor(ap * 1000) / 1000));
  elements['t2-vs22-bar-ap'].style.width = clampPercent(ap);
  const rit = elements['t2-vs22-ritmo'];
  let txt = 'Se a perda fosse uniforme, Lula termina na frente enquanto a vantagem consumida for menor que o apurado.', cls = '';
  if (base && comDados && ap > 0) {
    if (usada <= 0) { txt = 'Lula está acima de 2022 no que já foi apurado: nada da vantagem consumido.'; cls = 'is-good'; }
    else if (usada < ap) { txt = `No ritmo de agora, se fosse uniforme, sobra vantagem ao fim: consumiu ${fmtPct1(usada)} com ${fmtPct1(ap)} apurado.`; cls = 'is-good'; }
    else { txt = `No ritmo de agora, se fosse uniforme, a vantagem acaba antes do fim: consumiu ${fmtPct1(usada)} com ${fmtPct1(ap)} apurado.`; cls = 'is-bad'; }
  }
  setText(rit, txt);
  rit.classList.toggle('is-good', cls === 'is-good');
  rit.classList.toggle('is-bad', cls === 'is-bad');
}

/* Render LEVE (1 vez por segundo): faixa de conexão, cabeçalho, horários, contagem regressiva, alertas. */
function renderLive(status) {
  const now = Date.now();
  const c = app.rehearsal
    ? { key: 'rehearsal', label: 'ENSAIO', level: 'info', since: 0, retryAt: 0 }
    : T2Tse.connectionState(status, now, navigator.onLine);
  elements['t2-conn'].className = `t2-conn is-${c.level}`;
  setText(elements['t2-conn-label'], c.label);
  setText(elements['t2-conn-detail'], app.refreshNote ? 'Atualizando…' : connDetail(c, status, now));
  setText(elements['t2-status'], c.label);
  setText(elements['t2-status-pill'], c.label);
  elements['t2-status-pill'].className = `prediction-badge t2-status-badge ${pillClass(c)}`;
  const header = elements['t2-status'].parentElement;
  header.classList.toggle('is-live', c.key === 'live');
  header.classList.toggle('is-stale', c.level === 'warn' || c.level === 'bad');
  renderPhaseMessage(status, c);

  const out = app.lastOutput;
  const lastOk = status && status.lastOkTs;
  const lastUp = out && out.diagnostics.lastUpdateTs;
  setText(elements['t2-updated'], lastOk
    ? `${fmtClock(lastOk)} (Brasília)`
    : (lastUp ? `dados salvos de ${fmtClock(lastUp)}` : '—'));
  const tse = status && status.official && status.official.tse;
  setText(elements['t2-tse-time'], tse && tse.label ? `Totalização TSE: ${tse.label}` : '');
  if (elements['t2-diagnostics'].open) renderPollerDiag(status);   // texto do diagnóstico: só com o painel aberto
  renderAlert(status, c);
  renderOfficial(status);
}

function renderAlert(status, c) {
  const box = elements['t2-alert'];
  let msg = '';
  if (app.internalError) msg = `Erro interno na tela: ${app.internalError}. Os últimos dados continuam visíveis; toque em Atualizar.`;
  else if (c.key === 'error') msg = `Não foi possível interpretar os dados: ${firstError(status) || 'verifique o diagnóstico e tente atualizar.'}`;
  else if (app.electionMismatch) msg = app.electionMismatch;
  else if (app.notice) msg = app.notice;
  if (box.textContent !== msg) setText(box, msg);
  box.classList.toggle('hidden', !msg);
}

/* Projeção recalculada só quando os dados mudam (versão do estado). */
function recompute() {
  const v = app.state.version();
  if (app.lastOutput && v === app.lastVersion) return app.lastOutput;
  try {
    const out = app.state.compute();
    app.lastOutput = out;
    app.lastVersion = v;
    return out;
  } catch (e) {
    showInternalError(e);
    return app.lastOutput;
  }
}

function safe(fn) {
  try { fn(); } catch (e) { showInternalError(e); }
}

function showInternalError(e) {
  app.internalError = (e && e.message) ? String(e.message) : String(e);
  try {
    const box = elements['t2-alert'];
    if (box) {
      setText(box, `Erro interno na tela: ${app.internalError}. Os últimos dados continuam visíveis; toque em Atualizar.`);
      box.classList.remove('hidden');
    }
  } catch (ignored) { /* a própria tela pode estar em estado ruim */ }
}

function refreshView() {
  const out = recompute();
  const st = currentStatus();
  if (out) safe(() => renderData(out, st));
  safe(() => renderLive(st));
}

function renderElectionCheck() {
  if (app.electionConfig) {
    const found = JSON.stringify(app.electionConfig).includes(String(app.electionCode));
    app.electionMismatch = found ? '' : `Código da eleição ${app.electionCode} não encontrado em ele-c.json.`;
    setText(elements['t2-eleicao-status'], found
      ? `ele-c.json disponível; código ${app.electionCode} encontrado.`
      : `${app.electionMismatch} Você pode corrigir o código neste diagnóstico.`);
  } else {
    // ele-c.json não foi lido: só o diagnóstico mostra; o alerta fica para o que afeta os dados.
    app.electionMismatch = '';
    setText(elements['t2-eleicao-status'], `Não foi possível verificar ${electionName(app.electionCode)} em ele-c.json; a prévia continua disponível offline.`);
  }
  elements['t2-eleicao-input'].value = app.electionCode;
}

/* Salva o estado só quando ele mudou (e nunca durante o ensaio). */
function saveState() {
  if (app.rehearsal || !app.state) return;
  const v = app.state.version();
  if (v === app.lastSavedVersion) return;
  try {
    localStorage.setItem('t2.state.v1', JSON.stringify(app.state.exportState()));
    localStorage.setItem('t2.state.election', app.electionCode);
    app.lastSavedVersion = v;
  } catch (error) { /* armazenamento pode estar desativado */ }
}

/* ---- plugin opcional (window.T2Plugin): ver o contrato no topo do arquivo ---- */
function getPlugin() {
  const p = typeof window !== 'undefined' ? window.T2Plugin : null;
  return p && typeof p.tick === 'function' ? p : null;
}

function pluginStatusText() {
  const p = getPlugin();
  if (!p) return 'Plugin: nenhum.';
  try {
    return typeof p.status === 'function' ? `Plugin: ${String(p.status())}` : 'Plugin: ativo.';
  } catch (e) { return 'Plugin: erro ao ler o status.'; }
}

function initPlugin(urls, startMs, units) {
  const p = getPlugin();
  if (!p) return;
  app.pluginError = '';
  try {
    if (typeof p.init === 'function') {
      p.init({ state: app.state, fetchq: app.queue, urls, cfg: { baseline: app.baseline, units, electionCode: app.electionCode, startMs } });
    }
  } catch (e) { app.pluginError = `Plugin: falha ao iniciar (${(e && e.message) || e})`; }
}

/* Roda depois do render do ciclo; não acumula; limite de 8 s; qualquer erro é só registrado. */
function tickPlugin() {
  const p = getPlugin();
  if (!p || app.pluginBusy || app.rehearsal) return;
  app.pluginBusy = true;
  const v0 = app.state.version();
  let timer = null;
  const limit = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), app.pluginTimeoutMs); });
  Promise.race([Promise.resolve().then(() => p.tick()), limit])
    .then((r) => { app.pluginError = r === 'timeout' ? 'Plugin: tick passou de 8 s' : ''; })
    .catch((e) => { app.pluginError = `Plugin: erro no tick (${(e && e.message) || e})`; })
    .then(() => {
      clearTimeout(timer);
      app.pluginBusy = false;
      if (app.state.version() !== v0) { refreshView(); saveState(); }   // o plugin mexeu no estado (xc): recalcula
    });
}

function startPoller() {
  if (app.poller) app.poller.stop();
  const urls = T2Tse.makeUrls({ eleicao: Number(app.electionCode) });
  const testParam = new URLSearchParams(location.search).get('t2start');
  app.testOverride = testParam === '0' && app.electionCode === '6257';
  const startMs = app.testOverride ? 0 : T2Tse.START_2T_UTC;
  if (testParam === '0' && !app.testOverride) {
    app.electionNote = 'A opção t2start=0 só libera o ensaio de rede com a eleição 6257.';
  }
  const units = app.baseline.unidades.map((u) => ({ id: u.id, uf: u.uf, mun: u.mun, zona: u.zona, E: u.E }));
  app.poller = T2Tse.createPoller({
    q: app.queue,
    urls,
    state: app.state,
    units,
    startMs,
    onCycle: () => {
      if (app.testOverride && app.poller.status().cycles >= 3) app.poller.stop();
      app.lastCycleAt = Date.now();
      app.refreshNote = false;
      refreshView();
      saveState();
      tickPlugin();
    },
  });
  ensureExtController();
  initPlugin(urls, startMs, units);
  try { app.poller.prime(app.state); } catch (error) { /* aquecer é opcional */ }
  refreshView();
  app.poller.start();
}

async function checkElectionCode() {
  const urls = T2Tse.makeUrls({ eleicao: Number(app.electionCode) });
  const result = await app.queue.get(urls.eleC, { priority: 100 });
  if (result.status === 200 && result.json) app.electionConfig = result.json;
  renderElectionCheck();
}

function stopRehearsal() {
  if (app.rehearsalTimer) clearInterval(app.rehearsalTimer);
  app.rehearsalTimer = null;
  app.rehearsal = false;
  app.rehearsalUnits = null;
  app.rehearsalStatus = null;
  elements['t2-rehearsal-label'].classList.add('hidden');
  elements['t2-rehearsal-label'].textContent = REHEARSAL_LABEL;
  elements['t2-rehearsal'].textContent = REHEARSAL_TEXT.atual;
  elements['t2-rehearsal-2022'].textContent = REHEARSAL_TEXT.entre;
  elements['t2-rehearsal'].classList.remove('hidden');
  elements['t2-rehearsal-2022'].classList.remove('hidden');
  if (app.realState) app.state = app.realState;
  app.realState = null;
  // troca de estado: o cache de recompute() compara só a versão, que pode coincidir entre o estado real e o do ensaio
  app.lastOutput = null;
  app.lastVersion = -1;
}

const REHEARSAL_TEXT = { atual: 'Ensaio sintético: 1º turno de 2026', entre: 'Ensaio sintético: entre 2022 e 2026' };
const REHEARSAL_LABEL = 'ENSAIO — dados sintéticos; não são resultados eleitorais. Sem curva de chegada (os dados sintéticos não têm viés de chegada; faixa sem curva).';

/* mode: 'atual' (verdade a partir do 1º turno de 2026) ou 'entre' (a mesma verdade puxada até a metade para o 2º turno de 2022 da zona). */
function startRehearsal(mode) {
  if (app.rehearsal) {
    stopRehearsal();
    startPoller();
    return;
  }
  if (app.poller) app.poller.stop();
  if (app.ext) app.ext.stop();
  // estado próprio do ensaio, SEM curva de chegada: os dados sintéticos são proporcionais dentro da zona (não há viés de chegada), e a
  // curva de 2026 aplicada a eles criaria um erro que não existe (2T-1.4). O estado real fica intacto e volta no fim.
  app.realState = app.state;
  app.state = T2State.create(Object.assign({ curve: null }, app.stateCfg));
  // troca de estado: o cache de recompute() compara só a versão, que pode coincidir entre o estado real e o do ensaio
  app.lastOutput = null;
  app.lastVersion = -1;
  app.rehearsalUnits = app.baseline.unidades.map((u) => ({
    id: u.id, uf: u.uf, mun: u.mun, zona: u.zona, x: u.x, E: u.E, secoes: u.secoes,
  }));
  const baselineById = new Map(app.baseline.unidades.map((unit) => [unit.id, unit]));
  const entre = mode === 'entre' && app.fallback22;
  T2Sim.fakeSecondRound(app.rehearsalUnits, 123, entre ? { pull: { ref: app.fallback22, lambda: 0.5 } } : undefined);
  app.rehearsal = true;
  const truthL = T2Engine.validShares(T2Sim.truth(app.rehearsalUnits)).L;
  elements['t2-rehearsal-label'].textContent = REHEARSAL_LABEL + (entre ? ' Modo: entre 2022 e 2026.' : ' Modo: 1º turno de 2026.');
  elements['t2-rehearsal-label'].classList.remove('hidden');
  const ativo = entre ? 't2-rehearsal-2022' : 't2-rehearsal', outro = entre ? 't2-rehearsal' : 't2-rehearsal-2022';
  elements[ativo].textContent = 'Encerrar ensaio';
  elements[outro].classList.add('hidden');
  let rehearsalStep = 0;
  const advance = () => {
    rehearsalStep = Math.min(100, rehearsalStep + 1);
    const tau = rehearsalStep / 100;
    T2Sim.stateAt(app.rehearsalUnits, tau).forEach((unit, k) => {
      if (unit.y) {
        const baseline = baselineById.get(unit.id);
        const totalSections = baseline ? baseline.secoes || 0 : 0;
        const full = app.rehearsalUnits[k].yFull.reduce((a, b) => a + b, 0);
        const fz = full > 0 ? unit.y.reduce((a, b) => a + b, 0) / full : tau;   // fração apurada DESTA zona
        app.state.update(unit.id, {
          y: unit.y,
          E: unit.E,
          s: totalSections,
          st: Math.round(totalSections * fz),
          ts: Date.now(),
        });
      }
    });
    app.rehearsalStatus = {
      phase: 'live', lastOkTs: Date.now(), errors: [], cycles: rehearsalStep, abState: {},
      queue: app.queue.stats(), consecutiveFailures: 0, lastFailure: null, nextCycleAt: 0,
      intervalMs: 30000, finalIntervalMs: 300000, startMs: 0, official: null,
    };
    refreshView();
    if (rehearsalStep >= 100) {
      clearInterval(app.rehearsalTimer);
      elements['t2-rehearsal-label'].textContent = REHEARSAL_LABEL + ` Ensaio concluído: verdade sintética Lula ${fmtPct(truthL)} dos válidos.`;
    }
  };
  advance();
  app.rehearsalTimer = setInterval(advance, 1500);
}

async function requestWakeLock() {
  app.userInteracted = true;
  if (!navigator.wakeLock || app.wakeLock || document.visibilityState !== 'visible') return;
  try {
    app.wakeLock = await navigator.wakeLock.request('screen');
    app.wakeLock.addEventListener('release', () => { app.wakeLock = null; });
  } catch (error) {
    app.wakeLock = null;
  }
}

function startTick() {
  if (!app.tickTimer) app.tickTimer = setInterval(() => safe(() => renderLive(currentStatus())), 1000);
}

function stopTick() {
  if (app.tickTimer) clearInterval(app.tickTimer);
  app.tickTimer = null;
}

/* Atualizar: NUNCA apaga os dados nem a fila (respeita pausas do TSE). Desabilita o botão por 10 s. */
function onRefreshClick() {
  const btn = elements['t2-refresh'];
  if (btn.disabled) return;
  btn.disabled = true;
  app.refreshNote = true;
  app.internalError = '';
  if (app.rehearsal) {
    stopRehearsal();
    startPoller();
  } else if (app.poller) {
    app.poller.refresh();
    if (app.ext) app.ext.syncNow();
  } else {
    startPoller();
  }
  safe(() => renderLive(currentStatus()));
  setTimeout(() => {
    btn.disabled = false;
    app.refreshNote = false;
    safe(() => renderLive(currentStatus()));
  }, 10000);
}

function onVisibility() {
  if (document.visibilityState === 'hidden') {
    if (!app.rehearsal && app.poller) app.poller.stop();
    if (app.ext) app.ext.stop();
    stopTick();
    return;
  }
  if (!app.rehearsal && app.poller) {
    app.poller.start();
    if (app.ext) app.ext.start();                 // sincroniza na hora se a última rodada tem mais de 10 s
  }
  startTick();
  safe(() => renderLive(currentStatus()));
  if (app.userInteracted) requestWakeLock();
}

function bindEvents() {
  elements['t2-refresh'].addEventListener('click', onRefreshClick);
  elements['t2-mode-toggle'].addEventListener('click', () => {
    app.flowMode = !app.flowMode;
    elements['t2-mode-toggle'].setAttribute('aria-pressed', String(app.flowMode));
    elements['t2-mode-toggle'].textContent = app.flowMode ? 'Ver em percentuais' : 'Ver em votos';
    if (app.lastOutput) renderMigration(app.lastOutput);
  });
  const votesToggle = (id, key, rerender) => elements[id].addEventListener('click', () => {
    app[key] = !app[key];
    elements[id].setAttribute('aria-pressed', String(app[key]));
    elements[id].textContent = app[key] ? 'Ver em percentuais' : 'Ver em votos';
    rerender();
  });
  votesToggle('t2-ufs-toggle', 'ufVotes', () => { if (app.lastOutput) renderUfs(app.lastOutput); });
  votesToggle('t2-mun-toggle', 'munVotes', () => { if (app.munUf) renderMunicipalities(app.munUf, false); });
  elements['t2-mun-close'].addEventListener('click', closeMunicipalities);
  elements['t2-mun-back'].addEventListener('click', closeMunicipalities);
  elements['t2-diagnostics'].addEventListener('toggle', () => { if (elements['t2-diagnostics'].open) renderPollerDiag(currentStatus()); });
  elements['t2-ufs'].addEventListener('click', (event) => {
    const target = event.target;
    const button = target && target.closest ? target.closest('button[data-uf]') : null;
    if (button) renderMunicipalities(button.dataset.uf);
  });
  elements['t2-election-form'].addEventListener('submit', (event) => {
    event.preventDefault();
    const value = elements['t2-eleicao-input'].value.trim();
    if (!/^\d{1,6}$/.test(value) || Number(value) <= 0) {
      app.electionNote = 'O código da eleição deve conter de 1 a 6 dígitos.';
      renderElectionCheck();
      return;
    }
    app.electionNote = '';
    const changedElection = value !== app.electionCode;
    app.electionCode = value;
    if (changedElection) app.state.reset();
    try {
      localStorage.setItem('t2.eleicao', value);
      if (changedElection) {
        localStorage.removeItem('t2.state.v1');
        localStorage.setItem('t2.state.election', value);
      }
    } catch (error) { /* armazenamento pode estar desativado */ }
    renderElectionCheck();
    startPoller();
  });
  elements['t2-rehearsal'].addEventListener('click', () => startRehearsal('atual'));
  elements['t2-rehearsal-2022'].addEventListener('click', () => startRehearsal('entre'));
  document.addEventListener('pointerdown', requestWakeLock, { once: true, passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', () => {
    if (!app.rehearsal && app.poller) app.poller.refresh();
    safe(() => renderLive(currentStatus()));
  });
  window.addEventListener('offline', () => safe(() => renderLive(currentStatus())));
  window.addEventListener('error', (event) => showInternalError(event.error || event.message));
  window.addEventListener('unhandledrejection', (event) => showInternalError(event.reason));
}

async function init() {
  const readLocalJson = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Falha ao carregar ${url}: HTTP ${response.status}`);
    return response.json();
  };
  const [baseline, prior, fallback] = await Promise.all([
    readLocalJson('data/t2/base-2026-1t.json'),
    readLocalJson('data/t2/prior-2022.json'),
    readLocalJson('data/t2/fallback-2022.json'),
  ]);
  app.baseline = baseline;
  app.prior = prior;
  app.fallback22 = fallback && fallback.unidades ? fallback.unidades : null;
  try {
    app.exteriorMap = await readLocalJson('data/exterior-country-map.json');
  } catch (error) {
    app.exteriorMapNote = `mapa de localidades do exterior indisponível (${error.message})`;
  }
  // curva de chegada (2T-1.2): opcional; sem ela ou se for inválida, a projeção segue como no 2T-1.1
  try {
    const curve = await readLocalJson('data/t2/curva-2026-1t.json');
    if (curve && curve.v === 1 && curve.unidades) app.curve = curve;
    else app.curveNote = 'curva de chegada inválida';
  } catch (error) {
    app.curveNote = 'curva de chegada ausente';
  }
  // Código da eleição (2T-1.6): este app é do 2º turno (6258). Um código diferente gravado pelo Diagnóstico desligava a prévia do exterior
  // sem aviso (foi o que travou a versão Base) e, às 17h, faria o app ler outra eleição: volta para 6258 e avisa uma vez. Só o ensaio de
  // rede (?t2start=0) mantém o código gravado.
  const networkTest = new URLSearchParams(location.search).get('t2start') === '0';
  let savedCode = null;
  try { savedCode = localStorage.getItem('t2.eleicao'); } catch (error) { savedCode = null; }
  app.electionCode = '6258';
  if (savedCode && savedCode !== '6258') {
    if (networkTest) app.electionCode = savedCode;
    else {
      app.notice = `O aplicativo estava com o código de eleição ${savedCode} gravado no Diagnóstico; voltou para o 2º turno (6258).`;
      try { localStorage.removeItem('t2.eleicao'); } catch (error) { /* armazenamento pode estar desativado */ }
    }
  }
  app.stateCfg = { engine: T2Engine, baseline, prior, fallback22: fallback.unidades };
  app.state = T2State.create(Object.assign({ curve: app.curve }, app.stateCfg));
  try {
    const saved = JSON.parse(localStorage.getItem('t2.state.v1') || 'null');
    const savedElection = localStorage.getItem('t2.state.election') || '6258';
    if (saved && Date.now() < T2Tse.START_2T_UTC && !networkTest) {
      // antes das 17h de 25/10 o TSE não publicou nada do 2º turno: um estado salvo agora é resto de teste, e é descartado
      localStorage.removeItem('t2.state.v1');
      localStorage.removeItem('t2.state.election');
    } else if (saved && savedElection === app.electionCode) app.state.importState(saved);
  } catch (error) { /* estado salvo pode estar vazio ou corrompido */ }
  app.queue = T2FetchQ.createFetchQueue({ maxRps: 15, maxConcurrent: 6 });
  bindEvents();
  startPoller();                              // primeiro render antes de qualquer rede
  checkElectionCode().catch(() => {});        // o código da eleição não bloqueia a apuração
  startTick();
}

globalThis.T2App = { app, renderData, renderLive, renderOfficial, refreshView, recompute, fmtPctFloor, fmtAge, tickPlugin, pluginStatusText, startRehearsal,
  ensureExtController, stopExtController, onExtChange, extDiagText, renderMunicipalities };

init().catch((error) => {
  elements['t2-status'].textContent = 'ERRO DE DADOS';
  elements['t2-conn-label'].textContent = 'ERRO DE DADOS';
  elements['t2-status-pill'].textContent = 'ERRO DE DADOS';
  elements['t2-status-pill'].classList.add('is-error');
  elements['t2-alert'].textContent = `Não foi possível carregar os dados locais da prévia: ${error.message}`;
  elements['t2-alert'].classList.remove('hidden');
});
