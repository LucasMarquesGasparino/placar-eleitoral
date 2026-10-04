const TSE = {
  root: 'https://resultados.tse.jus.br',
  cycle: 'ele2026',
  federalElection: '6257',
  stateElection: '6259',
  autoSyncMs: 5 * 60 * 1000,
};

const STATES = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará',
  DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso',
  MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná',
  PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul',
  RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
};

const OFFICE_NAMES = {
  '0001': 'Presidente da República',
  '0003': 'Governador',
  '0005': 'Senador',
  '0006': 'Deputado Federal',
  '0007': 'Deputado Estadual',
};

const app = {
  view: 'geral',
  year: '2026',
  round: '1',
  uf: 'SP',
  cityCode: '',
  office: '0003',
  historical: null,
  locations: [],
  busy: false,
  countdown: 300,
  syncTimer: null,
  countdownTimer: null,
};

const elements = Object.fromEntries([
  'sync-label', 'refresh-button', 'countdown', 'year-select', 'round-select', 'state-select',
  'city-select', 'office-select', 'year-field', 'round-field', 'state-field', 'city-field',
  'office-field', 'filter-note', 'error-banner', 'scope-eyebrow', 'scope-title', 'partial-pill',
  'partial-label', 'valid-votes', 'valid-foot', 'sections-count', 'sections-foot', 'progress-value',
  'progress-fill', 'progress-foot', 'electorate-count', 'electorate-foot', 'results-title',
  'order-note', 'candidate-rows', 'table-footer', 'states-panel', 'states-grid',
].map((id) => [id, document.getElementById(id)]));

const numberFormat = new Intl.NumberFormat('pt-BR');
const pctFormat = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 });

function formatNumber(value) {
  return numberFormat.format(Math.max(0, Math.round(Number(value) || 0)));
}

function formatPercent(value) {
  return `${pctFormat.format(Number(value) || 0)}%`;
}

function titleForUf(uf) {
  return uf === 'ZZ' ? 'Exterior' : `${STATES[uf] || uf} (${uf})`;
}

function setSyncStatus(text, live = false) {
  elements['sync-label'].textContent = text;
  elements['sync-label'].parentElement.classList.toggle('is-live', live);
}

function setError(message = '') {
  elements['error-banner'].textContent = message;
  elements['error-banner'].classList.toggle('hidden', !message);
}

function metric(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (Array.isArray(value)) return value.length ? metric(value[0]) : 0;
  if (typeof value === 'object') {
    for (const key of ['t', 'qt', 'q', 'v', 'total', 'valor']) {
      if (value[key] != null) return metric(value[key]);
    }
  }
  return 0;
}

function firstMetric(root, paths) {
  for (const path of paths) {
    let value = root;
    for (const key of path) value = value?.[key];
    if (value != null) {
      const result = metric(value);
      if (result || result === 0) return result;
    }
  }
  return 0;
}

function extractProgress(data) {
  const totalSections = firstMetric(data, [['s', 'ts', 't'], ['s', 'ts'], ['s', 't']]);
  const processedSections = firstMetric(data, [
    ['s', 'ts', 'st', 't'], ['s', 'ts', 'st'], ['s', 'st', 't'], ['s', 'st'], ['s', 'sa'],
  ]);
  const totalElectors = firstMetric(data, [['e', 'te', 't'], ['e', 'te'], ['e', 'total']]);
  const processedElectors = firstMetric(data, [['e', 'est', 't'], ['e', 'est'], ['e', 'eleitoradoTotalizado']]);
  return {
    totalSections,
    processedSections,
    totalElectors,
    processedElectors,
    percent: totalSections ? Math.min(100, (processedSections / totalSections) * 100) : 0,
  };
}

function collectCandidates(data) {
  const result = [];
  for (const cargo of data?.carg || []) {
    const cargoCode = String(cargo.cd ?? '').padStart(4, '0');
    if (cargoCode && cargoCode !== '0001' && app.view !== 'sao-paulo') continue;
    for (const group of cargo.agr || []) {
      for (const candidate of group.cand || []) result.push(candidate);
      for (const party of group.par || []) {
        for (const candidate of party.cand || []) result.push(candidate);
      }
    }
  }
  const unique = new Map();
  for (const candidate of result) {
    const name = candidate.nmu || candidate.nm || 'Candidatura';
    const number = String(candidate.n ?? '').trim();
    const key = `${number}:${name}`;
    if (!unique.has(key)) {
      unique.set(key, {
        number,
        name,
        votes: metric(candidate.vap),
        officialPercent: metric(candidate.pvap),
      });
    }
  }
  return [...unique.values()].sort((a, b) => {
    const nA = Number(a.number);
    const nB = Number(b.number);
    if (Number.isFinite(nA) && Number.isFinite(nB) && nA !== nB) return nA - nB;
    return a.name.localeCompare(b.name, 'pt-BR');
  });
}

function extractLiveResult(data, officeCode) {
  const candidates = collectCandidates(data);
  const officialValidVotes = firstMetric(data, [
    ['v', 'vvc', 'vv', 't'], ['v', 'vvc', 'vv'], ['v', 'vv', 't'], ['v', 'vv'],
  ]);
  const validVotes = officialValidVotes || candidates.reduce((sum, candidate) => sum + candidate.votes, 0);
  const candidatesWithShare = candidates.map((candidate) => ({
    ...candidate,
    percent: candidate.officialPercent || (validVotes ? (candidate.votes / validVotes) * 100 : 0),
  }));
  const progress = extractProgress(data);
  return {
    candidates: candidatesWithShare,
    validVotes,
    progress,
    officeName: OFFICE_NAMES[officeCode] || 'Resultados',
    generatedAt: data.hg && data.dg ? `${data.dg} ${data.hg}` : '',
    isFinal: data.and === 'f' || data.tf === 's',
  };
}

function aggregateHistoric(records, round) {
  const candidateMap = new Map();
  let validVotes = 0;
  for (const record of records) {
    const roundData = record.rounds?.[String(round)];
    if (!roundData) continue;
    validVotes += Number(roundData.validVotes) || 0;
    for (const candidate of roundData.candidates || []) {
      const key = `${candidate.number}:${candidate.name}`;
      const current = candidateMap.get(key) || { number: candidate.number, name: candidate.name, votes: 0 };
      current.votes += Number(candidate.votes) || 0;
      candidateMap.set(key, current);
    }
  }
  const candidates = [...candidateMap.values()].sort((a, b) => {
    const nA = Number(a.number);
    const nB = Number(b.number);
    if (Number.isFinite(nA) && Number.isFinite(nB) && nA !== nB) return nA - nB;
    return a.name.localeCompare(b.name, 'pt-BR');
  }).map((candidate) => ({
    ...candidate,
    percent: validVotes ? (candidate.votes / validVotes) * 100 : 0,
  }));
  return { candidates, validVotes, progress: null, officeName: 'Presidente da República', isFinal: true };
}

function historicRecordsForSelection() {
  const records = app.historical?.records || [];
  if (app.view === 'pais' || app.view === 'geral') return records;
  if (app.view === 'estado') return records.filter((record) => record.uf === app.uf);
  if (app.view === 'cidade') {
    return records.filter((record) => record.uf === app.uf && record.municipalityCode === app.cityCode);
  }
  return [];
}

function selectedLocation() {
  return app.locations.find((location) => location.uf === app.uf && location.code === app.cityCode);
}

function officialBase(electionCode) {
  return `${TSE.root}/oficial/${TSE.cycle}/${electionCode}`;
}

function resultUrl({ uf, municipalityCode, officeCode }) {
  const state = uf.toLowerCase();
  const electionCode = officeCode === '0001' ? TSE.federalElection : TSE.stateElection;
  const electionPadded = String(electionCode).padStart(6, '0');
  let filename;
  if (uf === 'BR') filename = `br-c${officeCode}-e${electionPadded}-u.json`;
  else if (municipalityCode) filename = `${state}${municipalityCode}-c${officeCode}-e${electionPadded}-u.json`;
  else filename = `${state}-c${officeCode}-e${electionPadded}-u.json`;
  return `${officialBase(electionCode)}/dados/${state}/${filename}`;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-cache', mode: 'cors' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function parseLocations(config) {
  const found = [];
  for (const area of config.abr || []) {
    const uf = String(area.cd || '').toUpperCase();
    for (const municipality of area.mu || []) {
      found.push({
        uf,
        code: String(municipality.cd || '').padStart(5, '0'),
        name: municipality.nm || 'Localidade sem nome',
        isExterior: uf === 'ZZ',
      });
    }
  }
  return found;
}

async function loadBaseData() {
  const tasks = [fetch('./data/2022-presidencia-cidades.json').then((data) => { app.historical = data; })];
  const municipalitiesUrl = `${officialBase(TSE.stateElection)}/config/mun-e${String(TSE.stateElection).padStart(6, '0')}-cm.json`;
  tasks.push(fetchJson(municipalitiesUrl).then((config) => { app.locations = parseLocations(config); }).catch(() => {}));
  await Promise.allSettled(tasks);

  if (!app.locations.length && app.historical?.records) {
    const unique = new Map();
    for (const record of app.historical.records) {
      unique.set(`${record.uf}:${record.municipalityCode}`, {
        uf: record.uf,
        code: record.municipalityCode,
        name: record.name,
        isExterior: record.isExterior,
      });
    }
    app.locations = [...unique.values()];
  }
  populateStateSelect();
  populateCitySelect();
}

function availableUfs() {
  const ufs = new Set(app.locations.map((location) => location.uf));
  for (const record of app.historical?.records || []) ufs.add(record.uf);
  const sorted = [...ufs].filter((uf) => uf !== 'BR').sort((a, b) => {
    if (a === 'ZZ') return 1;
    if (b === 'ZZ') return -1;
    return titleForUf(a).localeCompare(titleForUf(b), 'pt-BR');
  });
  return sorted;
}

function populateStateSelect() {
  const ufs = availableUfs();
  elements['state-select'].replaceChildren();
  for (const uf of ufs) {
    const option = document.createElement('option');
    option.value = uf;
    option.textContent = titleForUf(uf);
    elements['state-select'].append(option);
  }
  if (!ufs.includes(app.uf)) app.uf = ufs.includes('SP') ? 'SP' : (ufs[0] || 'SP');
  elements['state-select'].value = app.uf;
}

function populateCitySelect() {
  const sourceLocations = app.locations.length
    ? app.locations
    : (app.historical?.records || []).map((record) => ({
      uf: record.uf, code: record.municipalityCode, name: record.name, isExterior: record.isExterior,
    }));
  const seen = new Set();
  const locations = sourceLocations.filter((location) => location.uf === app.uf)
    .filter((location) => {
      const key = `${location.uf}:${location.code}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  elements['city-select'].replaceChildren();
  for (const location of locations) {
    const option = document.createElement('option');
    option.value = location.code;
    option.textContent = location.name;
    elements['city-select'].append(option);
  }
  if (!locations.some((location) => location.code === app.cityCode)) app.cityCode = locations[0]?.code || '';
  elements['city-select'].value = app.cityCode;
}

function setActiveView(view) {
  if (view === 'sao-paulo') {
    app.year = '2026';
    app.round = '1';
    elements['year-select'].value = '2026';
    elements['round-select'].value = '1';
  }
  app.view = view;
  document.querySelectorAll('.view-tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === view);
  });
  const isSp = view === 'sao-paulo';
  elements['year-field'].classList.toggle('hidden', isSp);
  elements['round-field'].classList.toggle('hidden', isSp || app.year !== '2022');
  elements['state-field'].classList.toggle('hidden', !['estado', 'cidade'].includes(view));
  elements['city-field'].classList.toggle('hidden', view !== 'cidade');
  elements['office-field'].classList.toggle('hidden', !isSp);
  elements['states-panel'].classList.toggle('hidden', view !== 'geral' || app.year !== '2026');
  elements['filter-note'].textContent = isSp ? 'Resultados de 2026 para o estado de São Paulo' : 'Votação para Presidente da República';
  refreshResults();
}

function setScopeHeading() {
  const names = {
    geral: ['VISÃO GERAL', 'Brasil inteiro'],
    pais: ['PAÍS · BRASIL', 'Brasil, incluindo exterior'],
    estado: ['ESTADO', titleForUf(app.uf)],
    cidade: ['CIDADE', selectedLocation()?.name || app.cityCode || 'Selecione uma cidade'],
    'sao-paulo': ['SÃO PAULO · 2026', 'Resultados no estado de São Paulo'],
  };
  const [eyebrow, title] = names[app.view] || names.geral;
  elements['scope-eyebrow'].textContent = eyebrow;
  elements['scope-title'].textContent = title;
}

function updateYearControls() {
  elements['round-field'].classList.toggle('hidden', app.view === 'sao-paulo' || app.year !== '2022');
  elements['states-panel'].classList.toggle('hidden', app.view !== 'geral' || app.year !== '2026');
  elements['round-select'].value = app.round;
}

function renderCandidateRows(result) {
  const rows = result?.candidates || [];
  elements['candidate-rows'].replaceChildren();
  if (!rows.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.className = 'empty-cell';
    cell.textContent = app.year === '2026' || app.view === 'sao-paulo'
      ? 'Aguardando a publicação do próximo arquivo oficial do TSE.'
      : 'Não há dados para esta localidade e turno.';
    row.append(cell);
    elements['candidate-rows'].append(row);
    return;
  }

  for (const candidate of rows) {
    const row = document.createElement('tr');
    const numberCell = document.createElement('td');
    const number = document.createElement('span');
    number.className = 'candidate-number';
    number.textContent = candidate.number || '—';
    numberCell.append(number);

    const nameCell = document.createElement('td');
    const name = document.createElement('span');
    name.className = 'candidate-name';
    name.textContent = candidate.name;
    nameCell.append(name);

    const votesCell = document.createElement('td');
    votesCell.className = 'numeric vote-value';
    votesCell.textContent = formatNumber(candidate.votes);

    const percentCell = document.createElement('td');
    percentCell.className = 'numeric share-value';
    percentCell.textContent = formatPercent(candidate.percent);

    row.append(numberCell, nameCell, votesCell, percentCell);
    elements['candidate-rows'].append(row);
  }
}

function updateProgressCards(result, sourceYear) {
  const progress = result?.progress;
  elements['valid-votes'].textContent = result ? formatNumber(result.validVotes) : '—';
  elements['valid-foot'].textContent = sourceYear === '2022' ? 'Apuração histórica final' : 'Total de votos válidos informado pelo TSE';

  if (!progress) {
    elements['sections-count'].textContent = sourceYear === '2022' ? 'Final' : '—';
    elements['sections-foot'].textContent = sourceYear === '2022' ? 'Resultado oficial da eleição' : 'Seções contabilizadas pelo TSE';
    elements['progress-value'].textContent = sourceYear === '2022' ? '100%' : '—';
    elements['progress-fill'].style.width = sourceYear === '2022' ? '100%' : '0%';
    elements['progress-foot'].textContent = sourceYear === '2022' ? 'Totalização encerrada' : 'Seções totalizadas sobre o total previsto';
    elements['electorate-count'].textContent = '—';
    elements['electorate-foot'].textContent = 'Eleitorado não incluído neste arquivo';
    return;
  }

  elements['sections-count'].textContent = progress.totalSections
    ? `${formatNumber(progress.processedSections)} / ${formatNumber(progress.totalSections)}` : '—';
  elements['sections-foot'].textContent = 'Seções informadas nos arquivos do TSE';
  elements['progress-value'].textContent = progress.totalSections ? formatPercent(progress.percent) : '—';
  elements['progress-fill'].style.width = `${progress.percent}%`;
  elements['progress-foot'].textContent = `${formatNumber(progress.processedSections)} seções totalizadas`;
  elements['electorate-count'].textContent = progress.totalElectors ? formatNumber(progress.processedElectors) : '—';
  elements['electorate-foot'].textContent = progress.totalElectors
    ? `de ${formatNumber(progress.totalElectors)} eleitoras e eleitores aptos`
    : 'Eleitorado das seções totalizadas';
}

function renderResult(result, sourceYear = app.year) {
  setScopeHeading();
  const isSp = app.view === 'sao-paulo';
  elements['results-title'].textContent = isSp ? OFFICE_NAMES[app.office] : 'Presidente da República';
  elements['order-note'].textContent = 'Lista em ordem de número de urna';
  elements['table-footer'].textContent = result
    ? `Fonte: TSE. Percentuais sobre os votos válidos. ${result.generatedAt ? `Última geração do arquivo: ${result.generatedAt}.` : ''}`
    : 'Fonte: TSE. Os dados são consultados diretamente nos arquivos oficiais.';
  updateProgressCards(result, sourceYear);
  renderCandidateRows(result);

  const isFinal = sourceYear === '2022' || result?.isFinal;
  elements['partial-label'].textContent = sourceYear === '2022'
    ? 'Totalização final · 2022'
    : (result ? (isFinal ? 'Totalização final' : 'Totalização parcial') : 'Aguardando dados oficiais');
  elements['partial-pill'].classList.toggle('is-live', sourceYear === '2026' && Boolean(result) && !isFinal);
}

function renderStates(stateResults) {
  elements['states-grid'].replaceChildren();
  const states = Object.keys(STATES).sort((a, b) => titleForUf(a).localeCompare(titleForUf(b), 'pt-BR'));
  for (const uf of states) {
    const result = stateResults.get(uf);
    const progress = result?.progress;
    const card = document.createElement('article');
    card.className = 'state-progress-card';
    const top = document.createElement('div');
    top.className = 'state-progress-top';
    const name = document.createElement('span');
    name.className = 'state-progress-name';
    name.textContent = titleForUf(uf);
    const value = document.createElement('span');
    value.className = 'state-progress-value';
    value.textContent = progress?.totalSections
      ? `${formatNumber(progress.processedSections)} / ${formatNumber(progress.totalSections)}` : 'Aguardando';
    top.append(name, value);
    const track = document.createElement('div');
    track.className = 'progress-track';
    const fill = document.createElement('span');
    fill.style.width = progress?.percent ? `${progress.percent}%` : '0%';
    track.append(fill);
    const caption = document.createElement('span');
    caption.className = 'state-progress-caption';
    caption.textContent = progress?.totalSections ? `${formatPercent(progress.percent)} totalizado` : 'Sem arquivo disponível';
    card.append(top, track, caption);
    elements['states-grid'].append(card);
  }
}

async function loadHistoric() {
  if (!app.historical) await loadBaseData();
  const records = historicRecordsForSelection();
  const result = aggregateHistoric(records, app.round);
  renderResult(result, '2022');
}

async function requestLiveResult(scope, officeCode = '0001') {
  const url = resultUrl({ ...scope, officeCode });
  const data = await fetchJson(url);
  return extractLiveResult(data, officeCode);
}

async function loadLive() {
  const officeCode = app.view === 'sao-paulo' ? app.office : '0001';
  let scope;
  if (app.view === 'geral' || app.view === 'pais') scope = { uf: 'BR' };
  else if (app.view === 'estado') scope = { uf: app.uf };
  else if (app.view === 'cidade') {
    const location = selectedLocation();
    if (!location) throw new Error('Selecione uma cidade disponível nos dados do TSE.');
    scope = { uf: location.uf, municipalityCode: location.code };
  } else scope = { uf: 'SP' };

  const result = await requestLiveResult(scope, officeCode);
  renderResult(result, '2026');

  if (app.view === 'geral') {
    const states = Object.keys(STATES);
    const stateResponses = await Promise.allSettled(states.map((uf) => requestLiveResult({ uf }, '0001')));
    const results = new Map();
    stateResponses.forEach((response, index) => {
      if (response.status === 'fulfilled') results.set(states[index], response.value);
    });
    renderStates(results);
  }
}

async function refreshResults() {
  if (app.busy) return;
  app.busy = true;
  const sourceYear = app.view === 'sao-paulo' ? '2026' : app.year;
  setError('');
  elements['refresh-button'].disabled = true;
  setSyncStatus('Consultando dados do TSE…');
  updateYearControls();
  try {
    if (app.view === 'sao-paulo') await loadLive();
    else if (sourceYear === '2022') await loadHistoric();
    else await loadLive();
    setSyncStatus(`Atualizado às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`, sourceYear === '2026');
  } catch (error) {
    renderResult(null, sourceYear);
    setSyncStatus('Sem arquivo novo');
    const isNotPublished = String(error.message).includes('404');
    setError(isNotPublished
      ? 'O arquivo oficial desta abrangência ainda não está disponível no TSE. A consulta automática continuará em até cinco minutos.'
      : `Não foi possível consultar os dados agora. Verifique a conexão e tente novamente. (${error.message})`);
  } finally {
    app.busy = false;
    elements['refresh-button'].disabled = false;
    app.countdown = 300;
  }
}

function startSyncClock() {
  clearInterval(app.syncTimer);
  clearInterval(app.countdownTimer);
  app.syncTimer = setInterval(() => {
    if (!document.hidden) refreshResults();
  }, TSE.autoSyncMs);
  app.countdown = 300;
  app.countdownTimer = setInterval(() => {
    app.countdown = app.countdown > 0 ? app.countdown - 1 : 300;
    const minutes = String(Math.floor(app.countdown / 60)).padStart(2, '0');
    const seconds = String(app.countdown % 60).padStart(2, '0');
    elements.countdown.textContent = `${minutes}:${seconds}`;
  }, 1000);
}

document.querySelectorAll('.view-tab').forEach((button) => {
  button.addEventListener('click', () => setActiveView(button.dataset.view));
});

elements['refresh-button'].addEventListener('click', () => {
  app.countdown = 300;
  refreshResults();
});

elements['year-select'].addEventListener('change', (event) => {
  app.year = event.target.value;
  if (app.year === '2026') app.round = '1';
  updateYearControls();
  refreshResults();
});

elements['round-select'].addEventListener('change', (event) => {
  app.round = event.target.value;
  refreshResults();
});

elements['state-select'].addEventListener('change', (event) => {
  app.uf = event.target.value;
  app.cityCode = '';
  populateCitySelect();
  setScopeHeading();
  refreshResults();
});

elements['city-select'].addEventListener('change', (event) => {
  app.cityCode = event.target.value;
  setScopeHeading();
  refreshResults();
});

elements['office-select'].addEventListener('change', (event) => {
  app.office = event.target.value;
  elements['filter-note'].textContent = `Resultados de 2026 para ${OFFICE_NAMES[app.office]} em São Paulo`;
  refreshResults();
});

async function initialize() {
  elements['year-select'].value = app.year;
  await loadBaseData();
  updateYearControls();
  setScopeHeading();
  await refreshResults();
  startSyncClock();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

initialize();
