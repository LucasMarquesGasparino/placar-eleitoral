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

const PREDICTION = {
  lula: { label: 'Lula', number2022: '13', number2026: '13' },
  flavio: { label: 'Flávio Bolsonaro', number2022: '22', number2026: '22' },
  round2022: '1',
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
  countryMap: [],
  countryByCode: new Map(),
  selectedCountry: '',
  foreignResults: new Map(),
  exteriorAggregate: null,
  busy: false,
  refreshQueued: false,
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
  'foreign-panel', 'foreign-note', 'country-rows', 'all-countries-button',
  'prediction-panel', 'pred-lula-pct', 'pred-lula-votes', 'pred-lula-counted',
  'pred-flavio-pct', 'pred-flavio-votes', 'pred-flavio-counted',
  'prediction-bar-lula', 'prediction-bar-flavio', 'pred-intersection', 'pred-source-split',
  'prediction-rows', 'prediction-footer',
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

function aggregateLiveResults(results) {
  const entries = [...results.entries()];
  if (!entries.length) return null;
  const candidatesByKey = new Map();
  const progress = { totalSections: 0, processedSections: 0, totalElectors: 0, processedElectors: 0 };
  let validVotes = 0;
  for (const [, result] of entries) {
    validVotes += result.validVotes;
    for (const candidate of result.candidates) {
      const key = `${candidate.number}:${candidate.name}`;
      const current = candidatesByKey.get(key) || { number: candidate.number, name: candidate.name, votes: 0 };
      current.votes += candidate.votes;
      candidatesByKey.set(key, current);
    }
    if (result.progress) {
      progress.totalSections += result.progress.totalSections;
      progress.processedSections += result.progress.processedSections;
      progress.totalElectors += result.progress.totalElectors;
      progress.processedElectors += result.progress.processedElectors;
    }
  }
  const candidates = [...candidatesByKey.values()].sort((a, b) => {
    const nA = Number(a.number);
    const nB = Number(b.number);
    if (Number.isFinite(nA) && Number.isFinite(nB) && nA !== nB) return nA - nB;
    return a.name.localeCompare(b.name, 'pt-BR');
  }).map((candidate) => ({
    ...candidate,
    percent: validVotes ? (candidate.votes / validVotes) * 100 : 0,
  }));
  progress.percent = progress.totalSections
    ? Math.min(100, (progress.processedSections / progress.totalSections) * 100)
    : 0;
  return {
    candidates, validVotes, progress,
    officeName: 'Presidente da República',
    isFinal: entries.every(([, result]) => result.isFinal),
  };
}

function findCandidateVotes(candidates, number) {
  for (const c of candidates || []) {
    if (String(c.number) === String(number)) return c.votes || 0;
  }
  return 0;
}

async function computeNationalPrediction() {
  const round = PREDICTION.round2022;
  const records = app.historical?.records || [];

  // 1. Agregar 2022 por UF
  const byUf2022 = new Map();
  for (const record of records) {
    const roundData = record.rounds?.[round];
    if (!roundData) continue;
    const entry = byUf2022.get(record.uf) || { validVotes: 0, lulaVotes: 0, flavioVotes: 0 };
    entry.validVotes += Number(roundData.validVotes) || 0;
    for (const c of roundData.candidates || []) {
      if (String(c.number) === PREDICTION.lula.number2022) entry.lulaVotes += Number(c.votes) || 0;
      if (String(c.number) === PREDICTION.flavio.number2022) entry.flavioVotes += Number(c.votes) || 0;
    }
    byUf2022.set(record.uf, entry);
  }

  // 2. Buscar 2026 por UF (27 estados + ZZ)
  const ufs = [...Object.keys(STATES), 'ZZ'];
  const responses = await Promise.allSettled(
    ufs.map(async (uf) => ({ uf, result: await requestLiveResult({ uf }, '0001') }))
  );

  // 3. Cruzar por SEÇÃO: para cada UF, as seções já apuradas em 2026
  // entram com votos reais; as seções restantes são projetadas a partir
  // de 2022 (o resumo de 2022 não informa seções, então a projeção usa
  // a proporção de votos de 2022 aplicada sobre as seções faltantes de 2026)
  let totalValid = 0, totalLula = 0, totalFlavio = 0;
  let countedLula = 0, countedFlavio = 0, countedValid = 0;
  let used2026 = 0, used2022 = 0, usedMixed = 0;
  let sectionsTotal = 0, sectionsCounted = 0;
  const tableRows = [];

  for (const resp of responses) {
    if (resp.status !== 'fulfilled') continue;
    const { uf, result } = resp.value;
    const hist = byUf2022.get(uf);
    if (!hist) continue; // UF não existe em 2022 → fora da interseção

    const total = Number(result.progress?.totalSections) || 0;
    const counted = Math.min(Number(result.progress?.processedSections) || 0, total);
    const lula26 = findCandidateVotes(result.candidates, PREDICTION.lula.number2026);
    const flavio26 = findCandidateVotes(result.candidates, PREDICTION.flavio.number2026);
    const valid26 = result.validVotes || 0;

    let rowLula, rowFlavio, rowValid, rowSource, rowCountedPct;
    if (total <= 0) {
      // Sem total de seções no arquivo: decisão binária como antes
      if (counted > 0) {
        rowLula = lula26; rowFlavio = flavio26; rowValid = valid26;
        rowSource = '2026'; rowCountedPct = 100; used2026++;
      } else {
        rowLula = hist.lulaVotes; rowFlavio = hist.flavioVotes; rowValid = hist.validVotes;
        rowSource = '2022'; rowCountedPct = 0; used2022++;
      }
    } else if (counted <= 0) {
      rowLula = hist.lulaVotes; rowFlavio = hist.flavioVotes; rowValid = hist.validVotes;
      rowSource = '2022'; rowCountedPct = 0; used2022++;
      sectionsTotal += total;
    } else if (counted >= total) {
      rowLula = lula26; rowFlavio = flavio26; rowValid = valid26;
      rowSource = '2026'; rowCountedPct = 100; used2026++;
      sectionsTotal += total; sectionsCounted += total;
    } else {
      const remainingRatio = (total - counted) / total;
      rowLula = lula26 + hist.lulaVotes * remainingRatio;
      rowFlavio = flavio26 + hist.flavioVotes * remainingRatio;
      rowValid = valid26 + hist.validVotes * remainingRatio;
      rowSource = 'mista'; rowCountedPct = (counted / total) * 100; usedMixed++;
      sectionsTotal += total; sectionsCounted += counted;
    }

    totalValid += rowValid;
    totalLula += rowLula;
    totalFlavio += rowFlavio;
    if (rowSource === '2026' || rowSource === 'mista') {
      countedLula += lula26;
      countedFlavio += flavio26;
      countedValid += valid26;
    }

    tableRows.push({
      name: uf === 'ZZ' ? 'Exterior' : titleForUf(uf),
      uf,
      lulaVotes: rowLula,
      flavioVotes: rowFlavio,
      validVotes: rowValid,
      lulaPercent: rowValid ? (rowLula / rowValid) * 100 : 0,
      flavioPercent: rowValid ? (rowFlavio / rowValid) * 100 : 0,
      source: rowSource,
      countedPct: rowCountedPct,
      projectedPct: 100 - rowCountedPct,
    });
  }

  tableRows.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  const sectionsCountedPct = sectionsTotal ? (sectionsCounted / sectionsTotal) * 100 : 0;

  return {
    lula: {
      label: PREDICTION.lula.label,
      votes: totalLula,
      percent: totalValid ? (totalLula / totalValid) * 100 : 0,
    },
    flavio: {
      label: PREDICTION.flavio.label,
      votes: totalFlavio,
      percent: totalValid ? (totalFlavio / totalValid) * 100 : 0,
    },
    totalValidVotes: totalValid,
    counted: {
      lula: { votes: countedLula, percent: countedValid ? (countedLula / countedValid) * 100 : 0 },
      flavio: { votes: countedFlavio, percent: countedValid ? (countedFlavio / countedValid) * 100 : 0 },
      validVotes: countedValid,
    },
    used2026,
    used2022,
    usedMixed,
    totalIntersection: used2026 + used2022 + usedMixed,
    sectionsTotal,
    sectionsCounted,
    sectionsCountedPct,
    sectionsProjectedPct: 100 - sectionsCountedPct,
    tableRows,
  };
}

function countedLine(entry) {
  if (!entry || !entry.votes) return 'Nada apurado em 2026 ainda';
  return `${formatNumber(entry.votes)} votos · ${formatPercent(entry.percent)} só do apurado 2026`;
}

function renderPrediction(prediction) {
  if (!prediction) {
    elements['pred-lula-pct'].textContent = '—';
    elements['pred-lula-votes'].textContent = '';
    elements['pred-lula-counted'].textContent = '';
    elements['pred-flavio-pct'].textContent = '—';
    elements['pred-flavio-votes'].textContent = '';
    elements['pred-flavio-counted'].textContent = '';
    elements['prediction-bar-lula'].style.width = '50%';
    elements['prediction-bar-flavio'].style.width = '50%';
    elements['pred-intersection'].textContent = 'Sem dados suficientes';
    elements['pred-source-split'].textContent = '';
    elements['prediction-rows'].replaceChildren();
    return;
  }

  // Números do duelo
  elements['pred-lula-pct'].textContent = formatPercent(prediction.lula.percent);
  elements['pred-lula-votes'].textContent = `${formatNumber(prediction.lula.votes)} votos`;
  elements['pred-lula-counted'].textContent = countedLine(prediction.counted.lula);
  elements['pred-flavio-pct'].textContent = formatPercent(prediction.flavio.percent);
  elements['pred-flavio-votes'].textContent = `${formatNumber(prediction.flavio.votes)} votos`;
  elements['pred-flavio-counted'].textContent = countedLine(prediction.counted.flavio);

  // Barra proporcional (só Lula vs Flávio, ignora outros candidatos)
  const sumPercent = prediction.lula.percent + prediction.flavio.percent;
  const lulaWidth = sumPercent > 0 ? (prediction.lula.percent / sumPercent) * 100 : 50;
  elements['prediction-bar-lula'].style.width = `${lulaWidth}%`;
  elements['prediction-bar-flavio'].style.width = `${100 - lulaWidth}%`;

  // Metadados
  elements['pred-intersection'].textContent =
    `${formatNumber(prediction.totalIntersection)} UFs na interseção 2022 ∩ 2026`;
  elements['pred-source-split'].textContent =
    `${formatPercent(prediction.sectionsCountedPct)} das seções apuradas em 2026 (${formatNumber(prediction.sectionsCounted)} / ${formatNumber(prediction.sectionsTotal)}) · ${formatPercent(prediction.sectionsProjectedPct)} projetadas de 2022`;

  // Tabela por UF
  const tbody = elements['prediction-rows'];
  tbody.replaceChildren();
  for (const row of prediction.tableRows) {
    const tr = document.createElement('tr');
    if (row.source === '2022') tr.classList.add('pred-row-projected');

    const nameCell = document.createElement('td');
    nameCell.className = 'pred-cell-name';
    nameCell.textContent = row.name;

    const lulaCell = document.createElement('td');
    lulaCell.className = 'numeric pred-cell-lula';
    lulaCell.textContent = formatPercent(row.lulaPercent);

    const flavioCell = document.createElement('td');
    flavioCell.className = 'numeric pred-cell-flavio';
    flavioCell.textContent = formatPercent(row.flavioPercent);

    const y26Cell = document.createElement('td');
    y26Cell.className = 'numeric pred-cell-y26';
    y26Cell.textContent = formatPercent(row.countedPct);

    const y22Cell = document.createElement('td');
    y22Cell.className = 'numeric pred-cell-y22';
    y22Cell.textContent = formatPercent(row.projectedPct);

    const sourceCell = document.createElement('td');
    sourceCell.className = 'numeric';
    const badge = document.createElement('span');
    if (row.source === '2026') {
      badge.className = 'source-badge source-real';
      badge.textContent = '2026 ✓';
    } else if (row.source === 'mista') {
      badge.className = 'source-badge source-mix';
      badge.textContent = `Mista ${formatPercent(row.countedPct)}`;
    } else {
      badge.className = 'source-badge source-proj';
      badge.textContent = '2022 →';
    }
    sourceCell.append(badge);

    tr.append(nameCell, lulaCell, flavioCell, y26Cell, y22Cell, sourceCell);
    tbody.append(tr);
  }
}

async function loadPrediction() {
  setScopeHeading();
  setSyncStatus('Calculando previsão…');
  const prediction = await computeNationalPrediction();
  renderPrediction(prediction);
}

function countriesForExterior() {
  return [...new Set(app.countryMap.map((location) => location.country).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

function resultsForCountry(country) {
  const codes = new Set(app.countryMap
    .filter((location) => location.country === country)
    .map((location) => normalizeLocationCode(location.code)));
  return new Map([...app.foreignResults.entries()].filter(([code]) => codes.has(code)));
}

function historicRecordsForSelection() {
  const records = app.historical?.records || [];
  if (app.view === 'geral') return records;
  if (app.view === 'pais') {
    return records.filter((record) => {
      if (record.uf !== 'ZZ') return false;
      const country = app.countryByCode.get(normalizeLocationCode(record.municipalityCode))?.country || 'País não identificado';
      return !app.selectedCountry || country === app.selectedCountry;
    });
  }
  if (app.view === 'estado') return records.filter((record) => record.uf === app.uf);
  if (app.view === 'cidade') {
    return records.filter((record) => record.uf === app.uf
      && normalizeLocationCode(record.municipalityCode) === normalizeLocationCode(app.cityCode));
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

function normalizeLocationCode(value) {
  return String(value ?? '').trim().replace(/^0+(?=\d)/, '');
}

function parseLocations(config) {
  const found = [];
  for (const area of config.abr || []) {
    const uf = String(area.cd || '').toUpperCase();
    for (const municipality of area.mu || []) {
      const code = String(municipality.cd ?? '').trim().padStart(5, '0');
      found.push({
        uf,
        code,
        name: municipality.nm || 'Localidade sem nome',
        isExterior: uf === 'ZZ',
        country: uf === 'ZZ'
          ? (app.countryByCode.get(normalizeLocationCode(code))?.country || 'País não identificado')
          : '',
      });
    }
  }
  return found;
}

async function loadBaseData() {
  const municipalitiesUrl = `${officialBase(TSE.federalElection)}/config/mun-e${String(TSE.federalElection).padStart(6, '0')}-cm.json`;
  const [historyResult, mapResult, municipalitiesResult] = await Promise.allSettled([
    fetchJson('./data/2022-presidencia-cidades.json'),
    fetchJson('./data/exterior-country-map.json'),
    fetchJson(municipalitiesUrl),
  ]);
  app.historical = historyResult.status === 'fulfilled' ? historyResult.value : null;
  app.countryMap = mapResult.status === 'fulfilled' ? mapResult.value.locations || [] : [];
  app.countryByCode = new Map(app.countryMap.map((location) => [normalizeLocationCode(location.code), location]));

  const locations = new Map();
  if (municipalitiesResult.status === 'fulfilled') {
    for (const location of parseLocations(municipalitiesResult.value)) {
      locations.set(`${location.uf}:${normalizeLocationCode(location.code)}`, location);
    }
  }
  for (const record of app.historical?.records || []) {
    const normalizedCode = normalizeLocationCode(record.municipalityCode);
    const key = `${record.uf}:${normalizedCode}`;
    if (!locations.has(key)) {
      locations.set(key, {
        uf: record.uf, code: String(record.municipalityCode).padStart(5, '0'), name: record.name, isExterior: record.isExterior,
        country: record.uf === 'ZZ' ? (app.countryByCode.get(normalizedCode)?.country || 'País não identificado') : '',
      });
    }
  }
  for (const countryLocation of app.countryMap) {
    const code = String(countryLocation.code).trim().padStart(5, '0');
    const key = `ZZ:${normalizeLocationCode(code)}`;
    const current = locations.get(key) || {};
    locations.set(key, {
      ...current, uf: 'ZZ', code,
      name: current.name || countryLocation.city || 'Localidade no exterior',
      isExterior: true, country: countryLocation.country || 'País não identificado',
    });
  }
  app.locations = [...locations.values()];
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
      uf: record.uf, code: String(record.municipalityCode).padStart(5, '0'), name: record.name, isExterior: record.isExterior,
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
  const previousView = app.view;
  if (view === 'sao-paulo') {
    app.year = '2026';
    app.round = '1';
    elements['year-select'].value = '2026';
    elements['round-select'].value = '1';
  }
  if (view !== 'pais' || previousView !== 'pais') app.selectedCountry = '';
  app.view = view;
  document.querySelectorAll('.view-tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === view);
  });
  const isSp = view === 'sao-paulo';
  const isPred = view === 'previsao';
  elements['year-field'].classList.toggle('hidden', isSp || isPred);
  elements['round-field'].classList.toggle('hidden', isSp || isPred || app.year !== '2022');
  elements['state-field'].classList.toggle('hidden', !['estado', 'cidade'].includes(view));
  elements['city-field'].classList.toggle('hidden', view !== 'cidade');
  elements['office-field'].classList.toggle('hidden', !isSp);
  elements['states-panel'].classList.toggle('hidden', view !== 'geral' || app.year !== '2026');
  elements['foreign-panel'].classList.toggle('hidden', view !== 'pais');
  elements['prediction-panel'].classList.toggle('hidden', !isPred);
  document.getElementById('stats-grid').classList.toggle('hidden', isPred);
  document.querySelector('.results-panel').classList.toggle('hidden', isPred);
  elements['filter-note'].textContent = isPred
    ? 'Projeção Lula × Flávio Bolsonaro baseada na interseção 2022 ∩ 2026'
    : (isSp ? 'Resultados de 2026 para o estado de São Paulo' : 'Votação para Presidente da República');
  renderCountryRows(app.year);
  refreshResults();
}

function setScopeHeading() {
  const names = {
    geral: ['VISÃO GERAL', 'Brasil inteiro'],
    pais: ['EXTERIOR · PAÍSES', app.selectedCountry || 'Todos os países'],
    estado: ['ESTADO', titleForUf(app.uf)],
    cidade: ['CIDADE', selectedLocation()?.name || app.cityCode || 'Selecione uma cidade'],
    previsao: ['PREVISÃO · PRESIDENTE', 'Lula × Flávio Bolsonaro'],
    'sao-paulo': ['SÃO PAULO · 2026', 'Resultados no estado de São Paulo'],
  };
  const [eyebrow, title] = names[app.view] || names.geral;
  elements['scope-eyebrow'].textContent = eyebrow;
  elements['scope-title'].textContent = title;
}

function updateYearControls() {
  elements['round-field'].classList.toggle('hidden', app.view === 'sao-paulo' || app.year !== '2022');
  elements['states-panel'].classList.toggle('hidden', app.view !== 'geral' || app.year !== '2026');
  elements['foreign-panel'].classList.toggle('hidden', app.view !== 'pais');
  elements['all-countries-button'].classList.toggle('hidden', app.view !== 'pais' || !app.selectedCountry);
  elements['round-select'].value = app.round;
}

function updateForeignNote(sourceYear) {
  const note = elements['foreign-note'];
  note.replaceChildren();
  note.append(document.createTextNode(sourceYear === '2022'
    ? 'Em 2022, votos são somados dos registros históricos por localidade; esse arquivo não informa total de seções. País associado à localidade de votação. Mapeamento: '
    : 'Em 2026, cada linha soma arquivos municipais por país; “Todos os países” usa o arquivo oficial ZZ do TSE. País associado à localidade de votação. Mapeamento: '));
  const link = document.createElement('a');
  link.href = 'https://urna-a-urna.ovitordelucca.chatgpt.site/';
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = 'Urna-a-Urna';
  note.append(link, document.createTextNode('.'));
}

function renderCountryRows(sourceYear = app.year) {
  const tbody = elements['country-rows'];
  updateForeignNote(sourceYear);
  tbody.replaceChildren();
  const countries = countriesForExterior();
  if (!countries.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'empty-cell';
    cell.textContent = 'Aguardando a lista de localidades internacionais do TSE.';
    row.append(cell);
    tbody.append(row);
    return;
  }

  for (const country of countries) {
    const row = document.createElement('tr');
    if (app.selectedCountry === country) row.classList.add('selected');
    const locations = app.countryMap.filter((location) => location.country === country);
    const locationCodes = new Set(locations.map((location) => normalizeLocationCode(location.code)));
    const localityCount = locations.length;
    let processedText = '—';
    let votesText = '—';
    if (sourceYear === '2022') {
      const records = (app.historical?.records || []).filter((record) => record.uf === 'ZZ'
        && locationCodes.has(normalizeLocationCode(record.municipalityCode)));
      if (records.length) votesText = formatNumber(aggregateHistoric(records, app.round).validVotes);
    } else {
      const result = aggregateLiveResults(resultsForCountry(country));
      if (result) {
        processedText = result.progress.totalSections
          ? `${formatNumber(result.progress.processedSections)} / ${formatNumber(result.progress.totalSections)}`
          : '—';
        votesText = formatNumber(result.validVotes);
      }
    }

    // Calcular Lula% e Flávio% para este país
    let lulaPercent = '—';
    let flavioPercent = '—';
    if (sourceYear === '2022') {
      const countryRecords = (app.historical?.records || []).filter((record) => record.uf === 'ZZ'
        && locationCodes.has(normalizeLocationCode(record.municipalityCode)));
      if (countryRecords.length) {
        const agg = aggregateHistoric(countryRecords, app.round);
        const lulaC = agg.candidates.find((c) => String(c.number) === PREDICTION.lula.number2022);
        const flavioC = agg.candidates.find((c) => String(c.number) === PREDICTION.flavio.number2022);
        if (lulaC) lulaPercent = formatPercent(lulaC.percent);
        if (flavioC) flavioPercent = formatPercent(flavioC.percent);
      }
    } else {
      const countryResult = aggregateLiveResults(resultsForCountry(country));
      if (countryResult) {
        const lulaC = countryResult.candidates.find((c) => String(c.number) === PREDICTION.lula.number2026);
        const flavioC = countryResult.candidates.find((c) => String(c.number) === PREDICTION.flavio.number2026);
        if (lulaC) lulaPercent = formatPercent(lulaC.percent);
        if (flavioC) flavioPercent = formatPercent(flavioC.percent);
      }
    }

    const countryCell = document.createElement('td');
    const button = document.createElement('button');
    button.className = 'country-name-button';
    button.type = 'button';
    button.dataset.country = country;
    button.setAttribute('aria-pressed', String(app.selectedCountry === country));
    button.textContent = country;
    countryCell.append(button);
    const locationsCell = document.createElement('td');
    locationsCell.className = 'numeric';
    locationsCell.textContent = formatNumber(localityCount);
    const progressCell = document.createElement('td');
    progressCell.className = 'numeric';
    progressCell.textContent = processedText;
    const votesCell = document.createElement('td');
    votesCell.className = 'numeric';
    votesCell.textContent = votesText;
    const lulaCell = document.createElement('td');
    lulaCell.className = 'numeric country-lula';
    lulaCell.textContent = lulaPercent;
    const flavioCell = document.createElement('td');
    flavioCell.className = 'numeric country-flavio';
    flavioCell.textContent = flavioPercent;
    row.append(countryCell, locationsCell, progressCell, votesCell, lulaCell, flavioCell);
    tbody.append(row);
  }
  elements['all-countries-button'].classList.toggle('hidden', app.view !== 'pais' || !app.selectedCountry);
}

function displayCountrySelection() {
  setScopeHeading();
  updateYearControls();
  renderCountryRows(app.year);
  if (app.year === '2022') {
    renderResult(aggregateHistoric(historicRecordsForSelection(), app.round), '2022');
  } else if (app.selectedCountry) {
    renderResult(aggregateLiveResults(resultsForCountry(app.selectedCountry)), '2026');
  } else {
    renderResult(app.exteriorAggregate || aggregateLiveResults(app.foreignResults), '2026');
  }
}

async function fetchForeignResults() {
  const locations = app.locations.filter((location) => location.uf === 'ZZ');
  const batchSize = 24;
  let completed = 0;
  for (let start = 0; start < locations.length; start += batchSize) {
    const batch = locations.slice(start, start + batchSize);
    const responses = await Promise.allSettled(batch.map(async (location) => ({
      code: normalizeLocationCode(location.code),
      result: await requestLiveResult({ uf: 'ZZ', municipalityCode: location.code }, '0001'),
    })));
    for (const response of responses) {
      if (response.status === 'fulfilled') app.foreignResults.set(response.value.code, response.value.result);
    }
    completed += batch.length;
    setSyncStatus(`Exterior: ${formatNumber(completed)} / ${formatNumber(locations.length)} localidades`);
    renderCountryRows('2026');
    if (app.view === 'pais' && app.year === '2026') displayCountrySelection();
  }
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
  renderCountryRows('2022');
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
  if (app.view === 'pais') {
    try {
      app.exteriorAggregate = await requestLiveResult({ uf: 'ZZ' }, '0001');
    } catch {
      app.exteriorAggregate = null;
    }
    renderCountryRows('2026');
    displayCountrySelection();
    await fetchForeignResults();
    if (app.view === 'pais' && app.year === '2026') displayCountrySelection();
    return;
  }

  let scope;
  if (app.view === 'geral' || app.view === 'previsao') scope = { uf: 'BR' };
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
  if (app.busy) {
    app.refreshQueued = true;
    return;
  }
  app.busy = true;
  const sourceYear = app.view === 'sao-paulo' ? '2026' : app.year;
  setError('');
  elements['refresh-button'].disabled = true;
  setSyncStatus('Consultando dados do TSE…');
  updateYearControls();
  try {
    if (app.view === 'previsao') await loadPrediction();
    else if (app.view === 'sao-paulo') await loadLive();
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
    if (app.refreshQueued) {
      app.refreshQueued = false;
      refreshResults();
    }
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

elements['country-rows'].addEventListener('click', (event) => {
  const button = event.target.closest('[data-country]');
  if (!button) return;
  app.selectedCountry = button.dataset.country;
  displayCountrySelection();
});

elements['all-countries-button'].addEventListener('click', () => {
  app.selectedCountry = '';
  displayCountrySelection();
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
