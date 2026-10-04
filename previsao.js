/* Previsão Lula × Flávio Bolsonaro — página standalone (APK alternativo).
   Mesma metodologia do app principal: por UF, seções apuradas em 2026
   entram com votos reais; seções restantes são projetadas de 2022
   (Lula 13→13, Jair 22→Flávio 22). */

const TSE = {
  root: 'https://resultados.tse.jus.br',
  cycle: 'ele2026',
  federalElection: '6257',
  autoSyncMs: 5 * 60 * 1000,
};

const STATES = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará',
  DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso',
  MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná',
  PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul',
  RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
};

const PREDICTION = {
  lula: { label: 'Lula', number2022: '13', number2026: '13' },
  flavio: { label: 'Flávio Bolsonaro', number2022: '22', number2026: '22' },
  round2022: '1',
};

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

function $(id) {
  return document.getElementById(id);
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
  return { totalSections, processedSections };
}

function collectCandidates(data) {
  const result = [];
  for (const cargo of data?.carg || []) {
    const cargoCode = String(cargo.cd ?? '').padStart(4, '0');
    if (cargoCode && cargoCode !== '0001') continue;
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
      unique.set(key, { number, name, votes: metric(candidate.vap) });
    }
  }
  return [...unique.values()];
}

function extractLiveResult(data) {
  const candidates = collectCandidates(data);
  const officialValidVotes = firstMetric(data, [
    ['v', 'vvc', 'vv', 't'], ['v', 'vvc', 'vv'], ['v', 'vv', 't'], ['v', 'vv'],
  ]);
  const validVotes = officialValidVotes || candidates.reduce((sum, c) => sum + c.votes, 0);
  return { candidates, validVotes, progress: extractProgress(data) };
}

function resultUrl(uf) {
  const state = uf.toLowerCase();
  const electionPadded = String(TSE.federalElection).padStart(6, '0');
  const filename = uf === 'BR'
    ? `br-c0001-e${electionPadded}-u.json`
    : `${state}-c0001-e${electionPadded}-u.json`;
  return `${TSE.root}/oficial/${TSE.cycle}/${TSE.federalElection}/dados/${state}/${filename}`;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-cache', mode: 'cors' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function findCandidateVotes(candidates, number) {
  for (const c of candidates || []) {
    if (String(c.number) === String(number)) return c.votes || 0;
  }
  return 0;
}

function countedLine(entry) {
  if (!entry || !entry.votes) return 'Nada apurado em 2026 ainda';
  return `${formatNumber(entry.votes)} votos · ${formatPercent(entry.percent)} só do apurado 2026`;
}

async function computePrediction(historical) {
  const round = PREDICTION.round2022;
  const records = historical?.records || [];

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

  const ufs = [...Object.keys(STATES), 'ZZ'];
  const responses = await Promise.allSettled(ufs.map(async (uf) => {
    const data = await fetchJson(resultUrl(uf));
    return { uf, result: extractLiveResult(data) };
  }));

  let totalValid = 0, totalLula = 0, totalFlavio = 0;
  let countedLula = 0, countedFlavio = 0, countedValid = 0;
  let sectionsTotal = 0, sectionsCounted = 0;
  const tableRows = [];

  for (const resp of responses) {
    if (resp.status !== 'fulfilled') continue;
    const { uf, result } = resp.value;
    const hist = byUf2022.get(uf);
    if (!hist) continue;

    const total = Number(result.progress?.totalSections) || 0;
    const counted = Math.min(Number(result.progress?.processedSections) || 0, total);
    const lula26 = findCandidateVotes(result.candidates, PREDICTION.lula.number2026);
    const flavio26 = findCandidateVotes(result.candidates, PREDICTION.flavio.number2026);
    const valid26 = result.validVotes || 0;

    let rowLula, rowFlavio, rowValid, rowSource, rowCountedPct;
    if (total <= 0) {
      if (counted > 0) {
        rowLula = lula26; rowFlavio = flavio26; rowValid = valid26;
        rowSource = '2026'; rowCountedPct = 100;
      } else {
        rowLula = hist.lulaVotes; rowFlavio = hist.flavioVotes; rowValid = hist.validVotes;
        rowSource = '2022'; rowCountedPct = 0;
      }
    } else if (counted <= 0) {
      rowLula = hist.lulaVotes; rowFlavio = hist.flavioVotes; rowValid = hist.validVotes;
      rowSource = '2022'; rowCountedPct = 0;
      sectionsTotal += total;
    } else if (counted >= total) {
      rowLula = lula26; rowFlavio = flavio26; rowValid = valid26;
      rowSource = '2026'; rowCountedPct = 100;
      sectionsTotal += total; sectionsCounted += total;
    } else {
      const remainingRatio = (total - counted) / total;
      rowLula = lula26 + hist.lulaVotes * remainingRatio;
      rowFlavio = flavio26 + hist.flavioVotes * remainingRatio;
      rowValid = valid26 + hist.validVotes * remainingRatio;
      rowSource = 'mista'; rowCountedPct = (counted / total) * 100;
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
    lula: { votes: totalLula, percent: totalValid ? (totalLula / totalValid) * 100 : 0 },
    flavio: { votes: totalFlavio, percent: totalValid ? (totalFlavio / totalValid) * 100 : 0 },
    counted: {
      lula: { votes: countedLula, percent: countedValid ? (countedLula / countedValid) * 100 : 0 },
      flavio: { votes: countedFlavio, percent: countedValid ? (countedFlavio / countedValid) * 100 : 0 },
    },
    totalIntersection: tableRows.length,
    sectionsTotal,
    sectionsCounted,
    sectionsCountedPct,
    sectionsProjectedPct: 100 - sectionsCountedPct,
    tableRows,
  };
}

function renderPrediction(prediction) {
  if (!prediction) {
    $('pred-lula-pct').textContent = '—';
    $('pred-lula-votes').textContent = '';
    $('pred-lula-counted').textContent = '';
    $('pred-flavio-pct').textContent = '—';
    $('pred-flavio-votes').textContent = '';
    $('pred-flavio-counted').textContent = '';
    $('pred-intersection').textContent = 'Sem dados suficientes';
    $('pred-source-split').textContent = '';
    $('prediction-rows').replaceChildren();
    return;
  }

  $('pred-lula-pct').textContent = formatPercent(prediction.lula.percent);
  $('pred-lula-votes').textContent = `${formatNumber(prediction.lula.votes)} votos`;
  $('pred-lula-counted').textContent = countedLine(prediction.counted.lula);
  $('pred-flavio-pct').textContent = formatPercent(prediction.flavio.percent);
  $('pred-flavio-votes').textContent = `${formatNumber(prediction.flavio.votes)} votos`;
  $('pred-flavio-counted').textContent = countedLine(prediction.counted.flavio);

  const sumPercent = prediction.lula.percent + prediction.flavio.percent;
  const lulaWidth = sumPercent > 0 ? (prediction.lula.percent / sumPercent) * 100 : 50;
  $('prediction-bar-lula').style.width = `${lulaWidth}%`;
  $('prediction-bar-flavio').style.width = `${100 - lulaWidth}%`;

  $('pred-intersection').textContent =
    `${formatNumber(prediction.totalIntersection)} UFs na interseção 2022 ∩ 2026`;
  $('pred-source-split').textContent =
    `${formatPercent(prediction.sectionsCountedPct)} das seções apuradas em 2026 (${formatNumber(prediction.sectionsCounted)} / ${formatNumber(prediction.sectionsTotal)}) · ${formatPercent(prediction.sectionsProjectedPct)} projetadas de 2022`;

  const tbody = $('prediction-rows');
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

let historical = null;
let busy = false;

async function refresh() {
  if (busy) return;
  busy = true;
  $('prev-refresh').disabled = true;
  $('prev-status').textContent = 'Consultando dados do TSE…';
  try {
    if (!historical) historical = await fetchJson('./data/2022-presidencia-cidades.json');
    renderPrediction(await computePrediction(historical));
    $('prev-status').textContent =
      `Atualizado às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  } catch (error) {
    renderPrediction(null);
    $('prev-status').textContent = `Sem dados agora (${error.message})`;
  } finally {
    busy = false;
    $('prev-refresh').disabled = false;
  }
}

$('prev-refresh').addEventListener('click', refresh);

refresh();
setInterval(() => { if (!document.hidden) refresh(); }, TSE.autoSyncMs);
