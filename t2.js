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
  't2-mun-close', 't2-eleicao-status', 't2-election-form', 't2-eleicao-input', 't2-diag-migration',
  't2-diag-units', 't2-diag-updates', 't2-diag-poller', 't2-diag-queue', 't2-diag-official',
  't2-diag-errors', 't2-rehearsal', 't2-diag-arrival', 't2-diag-plugin',
  't2-off-secpct', 't2-off-sections', 't2-off-progress-bar', 't2-off-L-pct', 't2-off-L-votes',
  't2-off-F-pct', 't2-off-F-votes', 't2-off-bar-L', 't2-off-bar-F', 't2-off-lead', 't2-off-extra',
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

function setText(element, value) {
  if (element) element.textContent = value == null ? '' : String(value);
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
      return remain > 0
        ? `A apuração começa às 17:00 (Brasília) · faltam ${formatCountdown(remain)}`
        : 'Iniciando a consulta ao TSE';
    }
    case 'waiting': return 'O TSE ainda não publicou o resultado; nova consulta a cada 30 s.';
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
  if (phase === 'pre') {
    const remain = T2Tse.START_2T_UTC - Date.now();
    setText(elements['t2-phase-message'], remain > 0
      ? `Prévia: projeção a partir do 1º turno e da migração de 2022. Nenhum voto do 2º turno apurado ainda. Início previsto em 17:00 (Brasília), em ${formatCountdown(remain)}.`
      : 'Prévia: projeção a partir do 1º turno e da migração de 2022. Nenhum voto do 2º turno apurado ainda.');
    setText(elements['t2-counted-state'], 'Prévia');
  } else if (phase === 'waiting') {
    setText(elements['t2-phase-message'], 'Aguardando o TSE iniciar a divulgação. O aplicativo consulta apenas o arquivo nacional enquanto aguarda.');
    setText(elements['t2-counted-state'], 'Aguardando o TSE');
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

function appendResultPair(row, result) {
  if (result.countedShare.valid > 0) {
    makeCell(row, `${fmtPct(result.countedShare.L)} / ${fmtPct(result.countedShare.F)}`, 'numeric t2-pair');
  } else {
    makeCell(row, '—', 'numeric t2-pair');
  }
  makeCell(row, `${fmtPct(result.finalShare.L)} / ${fmtPct(result.finalShare.F)}`, 'numeric t2-pair');
}

function appendLeader(row, result) {
  const leader = result.leaderFinal === 'L' ? 'Lula' : result.leaderFinal === 'F' ? 'Flávio' : 'Empate';
  const cell = makeCell(row, leader, result.leaderFinal === 'L' ? 't2-leader-l' : result.leaderFinal === 'F' ? 't2-leader-f' : '');
  if (result.leaderFinal) cell.classList.add(`t2-leader-${result.leaderFinal.toLowerCase()}`);
  makeCell(row, result.leaderFinal ? fmtPp(Math.abs(result.finalShare.L - result.finalShare.F) * 100) : '—', 'numeric t2-margin');
}

function renderMunicipalities(uf) {
  const rows = app.state.municipios(uf, 15);
  const body = elements['t2-municipal-rows'];
  body.replaceChildren();
  setText(elements['t2-mun-title'], `${app.baseline.ufs[uf] || uf} (${uf})`);
  elements['t2-municipal-panel'].classList.remove('hidden');
  rows.forEach((result) => {
    const row = document.createElement('tr');
    makeCell(row, result.nome || result.mun);
    makeCell(row, fmtPct(result.progressPct), 'numeric');
    appendResultPair(row, result);
    appendLeader(row, result);
    body.appendChild(row);
  });
  elements['t2-municipal-panel'].scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    nameCell.appendChild(button);
    row.appendChild(nameCell);
    makeCell(row, fmtPct(result.progressPct), 'numeric');
    appendResultPair(row, result);
    appendLeader(row, result);
    body.appendChild(row);
  });
}

/* Painel "Apuração oficial · TSE": seções e votos como o TSE publicou (nada é projetado aqui). */
function rehearsalOfficial() {
  const out = app.lastOutput;
  if (!out) return null;
  const c = out.br.counted;
  return { y: [c.L, c.F, c.B, c.N, c.A], E: out.br.E, s: out.progress.sectionsTotal, st: out.progress.sectionsCounted };
}

function renderOfficial(status) {
  const phase = status && status.phase;
  const o = app.rehearsal ? rehearsalOfficial() : ((status && status.official) || null);
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
    setText(elements['t2-off-lead'], (phase === 'pre' || phase === 'waiting' || !phase)
      ? 'A apuração começa às 17:00 (horário de Brasília) de 25/10.'
      : (status && status.officialStale ? 'Arquivo nacional do TSE indisponível; a projeção segue pelas zonas.' : 'Aguardando o arquivo nacional do TSE.'));
    setText(elements['t2-off-extra'], '');
    return;
  }
  const secPct = o.s > 0 ? o.st / o.s : 0;
  setText(elements['t2-off-secpct'], fmtPctFloor(secPct));
  setText(elements['t2-off-sections'], `${fmtInt(o.st)} de ${fmtInt(o.s)} seções`);
  elements['t2-off-progress-bar'].style.width = clampPercent(secPct);
  const L = Number(o.y[0]) || 0, F = Number(o.y[1]) || 0, B = Number(o.y[2]) || 0, N = Number(o.y[3]) || 0, A = Number(o.y[4]) || 0;
  const valid = L + F;                                  // válidos no 2º turno = Lula + Flávio
  if (valid > 0) {
    setText(elements['t2-off-L-pct'], fmtPct(L / valid));
    setText(elements['t2-off-F-pct'], fmtPct(F / valid));
    setText(elements['t2-off-L-votes'], `${fmtInt(L)} votos`);
    setText(elements['t2-off-F-votes'], `${fmtInt(F)} votos`);
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
    setText(elements['t2-off-lead'], 'Nenhum voto apurado ainda.');
  }
  let extra = `Brancos ${fmtInt(B)} · Nulos ${fmtInt(N)} · Abstenção ${fmtInt(A)}`;
  if (o.E > 0) extra += ` · Comparecimento ${fmtPct((L + F + B + N) / (L + F + B + N + A))} dos apurados`;
  if (!app.rehearsal && status && status.officialFrozen) extra += ` · Arquivo nacional do TSE parado desde ${fmtClock(status.officialFrozen.since)}`;
  else if (!app.rehearsal && status && status.officialStale) extra += ` · Arquivo nacional indisponível agora; mostrando a leitura de ${fmtClock(status.officialTs)}`;
  setText(elements['t2-off-extra'], extra);
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
  if (status.official && Array.isArray(status.official.y)) {
    const zoneSum = [out.br.counted.L, out.br.counted.F, out.br.counted.B, out.br.counted.N, out.br.counted.A];
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
  if (out.progress.sectionsTotal > 0) {
    setText(sections, `Seções: ${fmtInt(out.progress.sectionsCounted)} / ${fmtInt(out.progress.sectionsTotal)}`);
    sections.classList.remove('hidden');
  } else {
    sections.classList.add('hidden');
  }
  const current = br.countedShare;
  setText(elements['t2-now-pct'], current.valid > 0
    ? `Votos válidos apurados: Lula ${fmtPct(current.L)} · Flávio ${fmtPct(current.F)}`
    : 'Votos válidos apurados: —');

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
  renderVs2022(out);
  renderMigration(out);
  renderUfs(out);
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
  renderPollerDiag(status);
  renderAlert(status, c);
}

function renderAlert(status, c) {
  const box = elements['t2-alert'];
  let msg = '';
  if (app.internalError) msg = `Erro interno na tela: ${app.internalError}. Os últimos dados continuam visíveis; toque em Atualizar.`;
  else if (c.key === 'error') msg = `Não foi possível interpretar os dados: ${firstError(status) || 'verifique o diagnóstico e tente atualizar.'}`;
  else if (app.electionMismatch) msg = app.electionMismatch;
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
    stopTick();
    return;
  }
  if (!app.rehearsal && app.poller) app.poller.start();
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
  elements['t2-mun-close'].addEventListener('click', () => elements['t2-municipal-panel'].classList.add('hidden'));
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
  // curva de chegada (2T-1.2): opcional; sem ela ou se for inválida, a projeção segue como no 2T-1.1
  try {
    const curve = await readLocalJson('data/t2/curva-2026-1t.json');
    if (curve && curve.v === 1 && curve.unidades) app.curve = curve;
    else app.curveNote = 'curva de chegada inválida';
  } catch (error) {
    app.curveNote = 'curva de chegada ausente';
  }
  try {
    app.electionCode = localStorage.getItem('t2.eleicao') || '6258';
  } catch (error) {
    app.electionCode = '6258';
  }
  app.stateCfg = { engine: T2Engine, baseline, prior, fallback22: fallback.unidades };
  app.state = T2State.create(Object.assign({ curve: app.curve }, app.stateCfg));
  try {
    const saved = JSON.parse(localStorage.getItem('t2.state.v1') || 'null');
    const savedElection = localStorage.getItem('t2.state.election') || '6258';
    if (saved && savedElection === app.electionCode) app.state.importState(saved);
  } catch (error) { /* estado salvo pode estar vazio ou corrompido */ }
  app.queue = T2FetchQ.createFetchQueue({ maxRps: 15, maxConcurrent: 6 });
  bindEvents();
  startPoller();                              // primeiro render antes de qualquer rede
  checkElectionCode().catch(() => {});        // o código da eleição não bloqueia a apuração
  startTick();
}

globalThis.T2App = { app, renderData, renderLive, renderOfficial, refreshView, recompute, fmtPctFloor, fmtAge, tickPlugin, pluginStatusText, startRehearsal };

init().catch((error) => {
  elements['t2-status'].textContent = 'ERRO DE DADOS';
  elements['t2-conn-label'].textContent = 'ERRO DE DADOS';
  elements['t2-status-pill'].textContent = 'ERRO DE DADOS';
  elements['t2-status-pill'].classList.add('is-error');
  elements['t2-alert'].textContent = `Não foi possível carregar os dados locais da prévia: ${error.message}`;
  elements['t2-alert'].classList.remove('hidden');
});
