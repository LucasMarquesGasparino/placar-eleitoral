'use strict';

const numberFormat = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const percentFormat = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const clockFormat = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const elements = Object.fromEntries([
  't2-status', 't2-status-pill', 't2-refresh', 't2-updated', 't2-alert', 't2-rehearsal-label',
  't2-phase-message', 't2-L-pct', 't2-L-votes', 't2-F-pct', 't2-F-votes', 't2-bar-L', 't2-bar-F',
  't2-lead', 't2-band', 't2-counted-state', 't2-progress', 't2-progress-bar', 't2-sections',
  't2-now-pct', 't2-forneed', 't2-mode-toggle', 't2-migration', 't2-valid-1t', 't2-valid-2t',
  't2-valid-delta', 't2-ufs', 't2-municipal-panel', 't2-mun-title', 't2-municipal-rows',
  't2-mun-close', 't2-eleicao-status', 't2-election-form', 't2-eleicao-input', 't2-diag-migration',
  't2-diag-units', 't2-diag-updates', 't2-diag-poller', 't2-diag-queue', 't2-diag-official',
  't2-diag-errors', 't2-rehearsal',
].map((id) => [id, document.getElementById(id)]));

const app = {
  baseline: null,
  prior: null,
  state: null,
  queue: null,
  poller: null,
  electionConfig: null,
  electionCode: '6258',
  flowMode: false,
  lastOutput: null,
  rehearsal: false,
  rehearsalTimer: null,
  savedStateBeforeRehearsal: null,
  rehearsalUnits: null,
  userInteracted: false,
  wakeLock: null,
  testOverride: false,
};

function fmtInt(value) {
  return numberFormat.format(Math.round(Number(value) || 0));
}

function fmtPct(value) {
  return `${percentFormat.format((Number(value) || 0) * 100)}%`;
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

function statusText(phase, stale) {
  if (stale) return 'APURAÇÃO · ATRASADO';
  return ({
    pre: 'PRÉVIA', waiting: 'AGUARDANDO TSE', live: 'APURAÇÃO', final: 'FINAL', error: 'ERRO DE DADOS', idle: 'PRÉVIA',
  })[phase] || 'PRÉVIA';
}

function statusClass(phase, stale) {
  if (stale || phase === 'error') return 'is-error';
  if (phase === 'waiting') return 'is-waiting';
  if (phase === 'final') return 'is-final';
  return '';
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

function renderPhaseMessage(status, stale) {
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

function renderUfs(out) {
  const body = elements['t2-ufs'];
  body.replaceChildren();
  Object.entries(out.ufs).forEach(([uf, result]) => {
    const row = document.createElement('tr');
    const nameCell = document.createElement('td');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 't2-uf-button';
    button.textContent = `${uf} · ${result.nome || uf}`;
    button.setAttribute('aria-label', `Ver os municípios de ${result.nome || uf}`);
    button.addEventListener('click', () => renderMunicipalities(uf));
    nameCell.appendChild(button);
    row.appendChild(nameCell);
    makeCell(row, fmtPct(result.progressPct), 'numeric');
    appendResultPair(row, result);
    appendLeader(row, result);
    body.appendChild(row);
  });
}

function renderDiagnostics(out, status) {
  const migration = out.migration;
  const diagnostics = out.diagnostics;
  const countedUnits = `${out.progress.unitsWithData}/${out.progress.unitsTotal}`;
  const weight = migration.dataWeight;
  setText(elements['t2-diag-migration'], `Migração: dados ${fmtPct(weight)} / prior 2022 ${fmtPct(1 - weight)}; ${migration.unitsUsed} unidades na estimativa.`);
  setText(elements['t2-diag-units'], `Unidades com dados: ${countedUnits}. Unidades desconhecidas: ${diagnostics.unknownUnits.length}. Fallback de 2022: ${diagnostics.fallback22Used.length}.`);
  setText(elements['t2-diag-updates'], `Atualizações: ${diagnostics.updates}; regressões: ${diagnostics.regressions}; atualizações inválidas: ${diagnostics.invalidUpdates}.`);
  const abStates = status.abState || {};
  const abSummary = Object.entries(abStates).reduce((counts, [, value]) => {
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
  setText(elements['t2-diag-poller'], `Poller: ${status.phase || 'idle'}; ciclos ${status.cycles || 0}; unidades consultadas ${status.fetched || 0}; EA15/varredura ${JSON.stringify(abSummary)}.`);
  setText(elements['t2-diag-queue'], `Fila: ${status.queue ? JSON.stringify(status.queue) : 'sem fila ativa'}.`);
  if (status.official && Array.isArray(status.official.y)) {
    const zoneSum = [out.br.counted.L, out.br.counted.F, out.br.counted.B, out.br.counted.N, out.br.counted.A];
    const differences = zoneSum.map((value, i) => Math.round(status.official.y[i] - value));
    setText(elements['t2-diag-official'], `Oficial × soma das zonas (L/F/B/N/A): ${differences.map(fmtSignedInt).join(' / ')} votos.`);
  } else {
    setText(elements['t2-diag-official'], 'Oficial × soma das zonas: aguardando o EA20 do Brasil.');
  }
  const errorList = (status.errors || []).slice(0, 5).map((error) => typeof error === 'string' ? error : firstError({ errors: [error] }));
  if (app.electionMessage) errorList.unshift(app.electionMessage);
  setText(elements['t2-diag-errors'], errorList.length ? `Avisos: ${errorList.join(' · ')}` : 'Sem erros ou avisos registrados.');
}

function render(out, status) {
  app.lastOutput = out;
  const phase = status.phase || 'idle';
  const lastTs = out.diagnostics.lastUpdateTs;
  const stale = !app.rehearsal && phase === 'live' && lastTs > 0 && Date.now() - lastTs > 180000;
  const currentStatus = statusText(phase, stale);
  setText(elements['t2-status'], currentStatus);
  setText(elements['t2-status-pill'], app.rehearsal ? 'ENSAIO' : currentStatus);
  elements['t2-status-pill'].className = `prediction-badge t2-status-badge ${statusClass(phase, stale)}`;
  const headerLive = elements['t2-status'].parentElement;
  headerLive.classList.toggle('is-live', phase === 'live' && !stale);
  headerLive.classList.toggle('is-stale', stale);
  renderPhaseMessage(status, stale);

  setText(elements['t2-updated'], lastTs ? `${clockFormat.format(new Date(lastTs))} (Brasília)` : '—');
  setText(elements['t2-L-pct'], fmtPct(out.br.finalShare.L));
  setText(elements['t2-F-pct'], fmtPct(out.br.finalShare.F));
  setText(elements['t2-L-votes'], fmtInt(out.br.final.L));
  setText(elements['t2-F-votes'], fmtInt(out.br.final.F));
  elements['t2-bar-L'].style.width = clampPercent(out.br.finalShare.L);
  elements['t2-bar-F'].style.width = clampPercent(out.br.finalShare.F);

  if (out.br.leaderFinal) {
    const leader = out.br.leaderFinal === 'L' ? 'Lula' : 'Flávio';
    const pp = Math.abs(out.br.finalShare.L - out.br.finalShare.F) * 100;
    setText(elements['t2-lead'], `${leader} à frente por ${fmtPp(pp)} (≈ ${fmtInt(Math.abs(out.br.margin.final))} votos)`);
  } else {
    setText(elements['t2-lead'], 'Empate técnico na projeção.');
  }
  setText(elements['t2-band'], `Faixa entre métodos: Lula ${fmtPct(out.band.lo)}–${fmtPct(out.band.hi)} dos votos válidos (não é margem de erro).`);

  setText(elements['t2-progress'], fmtPct(out.progress.electorateCountedPct));
  elements['t2-progress-bar'].style.width = clampPercent(out.progress.electorateCountedPct);
  const sections = elements['t2-sections'];
  if (out.progress.sectionsTotal > 0) {
    setText(sections, `Seções: ${fmtInt(out.progress.sectionsCounted)} / ${fmtInt(out.progress.sectionsTotal)}`);
    sections.classList.remove('hidden');
  } else {
    sections.classList.add('hidden');
  }
  const current = out.br.countedShare;
  setText(elements['t2-now-pct'], current.valid > 0
    ? `Votos válidos apurados: Lula ${fmtPct(current.L)} · Flávio ${fmtPct(current.F)}`
    : 'Votos válidos apurados: —');
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
  renderMigration(out);
  renderUfs(out);
  renderDiagnostics(out, status);

  if (phase === 'error') {
    elements['t2-alert'].textContent = `Não foi possível interpretar os dados: ${firstError(status) || 'verifique o diagnóstico e tente atualizar.'}`;
    elements['t2-alert'].classList.remove('hidden');
  } else if (app.electionMessage) {
    elements['t2-alert'].textContent = app.electionMessage;
    elements['t2-alert'].classList.remove('hidden');
  } else {
    elements['t2-alert'].classList.add('hidden');
  }
}

function renderElectionCheck() {
  if (app.electionConfig) {
    const found = JSON.stringify(app.electionConfig).includes(String(app.electionCode));
    app.electionMessage = found ? '' : `Código da eleição ${app.electionCode} não encontrado em ele-c.json.`;
    setText(elements['t2-eleicao-status'], found
      ? `ele-c.json disponível; código ${app.electionCode} encontrado.`
      : `${app.electionMessage} Você pode corrigir o código neste diagnóstico.`);
  } else {
    app.electionMessage = `Não foi possível verificar ${electionName(app.electionCode)} em ele-c.json; a prévia continua disponível offline.`;
    setText(elements['t2-eleicao-status'], app.electionMessage);
  }
  if (app.electionMessage) elements['t2-alert'].classList.remove('hidden');
  else elements['t2-alert'].classList.add('hidden');
  elements['t2-eleicao-input'].value = app.electionCode;
}

function startPoller() {
  if (app.poller) app.poller.stop();
  const urls = T2Tse.makeUrls({ eleicao: Number(app.electionCode) });
  const testParam = new URLSearchParams(location.search).get('t2start');
  app.testOverride = testParam === '0' && app.electionCode === '6257';
  const startMs = app.testOverride ? 0 : T2Tse.START_2T_UTC;
  if (testParam === '0' && !app.testOverride) {
    app.electionMessage = 'A opção t2start=0 só libera o ensaio de rede com a eleição 6257.';
    setText(elements['t2-diag-errors'], app.electionMessage);
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
      render(app.state.compute(), app.poller.status());
      try {
        localStorage.setItem('t2.state.v1', JSON.stringify(app.state.exportState()));
        localStorage.setItem('t2.state.election', app.electionCode);
      } catch (error) { /* armazenamento pode estar desativado */ }
    },
  });
  render(app.state.compute(), app.poller.status());
  app.poller.start();
}

async function checkElectionCode() {
  const urls = T2Tse.makeUrls({ eleicao: Number(app.electionCode) });
  const result = await app.queue.get(urls.eleC, { priority: 100 });
  if (result.status === 200 && result.json) app.electionConfig = result.json;
  renderElectionCheck();
}

function stopRehearsal(restoreSavedState) {
  if (app.rehearsalTimer) clearInterval(app.rehearsalTimer);
  app.rehearsalTimer = null;
  app.rehearsal = false;
  app.rehearsalUnits = null;
  elements['t2-rehearsal-label'].classList.add('hidden');
  elements['t2-rehearsal'].textContent = 'Iniciar modo ensaio sintético';
  app.state.reset();
  if (restoreSavedState && app.savedStateBeforeRehearsal) app.state.importState(app.savedStateBeforeRehearsal);
  app.savedStateBeforeRehearsal = null;
}

function startRehearsal() {
  if (app.rehearsal) {
    stopRehearsal(true);
    startPoller();
    return;
  }
  if (app.poller) app.poller.stop();
  app.savedStateBeforeRehearsal = app.state.exportState();
  app.state.reset();
  app.rehearsalUnits = app.baseline.unidades.map((u) => ({
    id: u.id, uf: u.uf, mun: u.mun, zona: u.zona, x: u.x, E: u.E, secoes: u.secoes,
  }));
  const baselineById = new Map(app.baseline.unidades.map((unit) => [unit.id, unit]));
  T2Sim.fakeSecondRound(app.rehearsalUnits, 123);
  app.rehearsal = true;
  elements['t2-rehearsal-label'].classList.remove('hidden');
  elements['t2-rehearsal'].textContent = 'Encerrar ensaio';
  let rehearsalStep = 0;
  const advance = () => {
    rehearsalStep = Math.min(100, rehearsalStep + 1);
    const tau = rehearsalStep / 100;
    T2Sim.stateAt(app.rehearsalUnits, tau).forEach((unit) => {
      if (unit.y) {
        const baseline = baselineById.get(unit.id);
        const totalSections = baseline ? baseline.secoes || 0 : 0;
        app.state.update(unit.id, {
          y: unit.y,
          E: unit.E,
          s: totalSections,
          st: Math.round(totalSections * tau),
          ts: Date.now(),
        });
      }
    });
    const simulatedStatus = app.poller ? app.poller.status() : { phase: 'live', cycles: 0, errors: [], queue: app.queue.stats() };
    simulatedStatus.phase = 'live';
    simulatedStatus.errors = [];
    render(app.state.compute(), simulatedStatus);
    if (rehearsalStep >= 100) clearInterval(app.rehearsalTimer);
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

function bindEvents() {
  elements['t2-refresh'].addEventListener('click', () => {
    if (app.rehearsal) stopRehearsal(false);
    app.state.reset();
    startPoller();
  });
  elements['t2-mode-toggle'].addEventListener('click', () => {
    app.flowMode = !app.flowMode;
    elements['t2-mode-toggle'].setAttribute('aria-pressed', String(app.flowMode));
    elements['t2-mode-toggle'].textContent = app.flowMode ? 'Ver em percentuais' : 'Ver em votos';
    if (app.lastOutput) renderMigration(app.lastOutput);
  });
  elements['t2-mun-close'].addEventListener('click', () => elements['t2-municipal-panel'].classList.add('hidden'));
  elements['t2-election-form'].addEventListener('submit', (event) => {
    event.preventDefault();
    const value = elements['t2-eleicao-input'].value.trim();
    if (!/^\d{1,6}$/.test(value) || Number(value) <= 0) {
      app.electionMessage = 'O código da eleição deve conter de 1 a 6 dígitos.';
      renderElectionCheck();
      return;
    }
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
  elements['t2-rehearsal'].addEventListener('click', startRehearsal);
  document.addEventListener('pointerdown', requestWakeLock, { once: true, passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && app.userInteracted) requestWakeLock();
  });
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
  try {
    app.electionCode = localStorage.getItem('t2.eleicao') || '6258';
  } catch (error) {
    app.electionCode = '6258';
  }
  app.state = T2State.create({ engine: T2Engine, baseline, prior, fallback22: fallback.unidades });
  try {
    const saved = JSON.parse(localStorage.getItem('t2.state.v1') || 'null');
    const savedElection = localStorage.getItem('t2.state.election') || '6258';
    if (saved && savedElection === app.electionCode) app.state.importState(saved);
  } catch (error) { /* estado salvo pode estar vazio ou corrompido */ }
  app.queue = T2FetchQ.createFetchQueue({ maxRps: 15, maxConcurrent: 6 });
  bindEvents();
  await checkElectionCode();
  startPoller();
  setInterval(() => {
    if (app.lastOutput && app.poller) render(app.lastOutput, app.poller.status());
    else if (app.poller) renderPhaseMessage(app.poller.status(), false);
  }, 1000);
}

init().catch((error) => {
  elements['t2-status'].textContent = 'ERRO DE DADOS';
  elements['t2-status-pill'].textContent = 'ERRO DE DADOS';
  elements['t2-status-pill'].classList.add('is-error');
  elements['t2-alert'].textContent = `Não foi possível carregar os dados locais da prévia: ${error.message}`;
  elements['t2-alert'].classList.remove('hidden');
});
