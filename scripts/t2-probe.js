#!/usr/bin/env node
/* t2-probe.js — Descobre a ESTRUTURA real de um JSON do TSE (nomes de campos), sem supor nada.
 * Uso: node scripts/t2-probe.js <url> [--save arquivo.json] [--depth 7]
 * Faz UMA requisição. Se der 404, PARE (404 repetido bloqueia o IP por 10 min). Não rode em laço.
 */
'use strict';
const fs = require('fs');
const Q = require('../t2-fetchq.js');
const url = process.argv[2];
if (!url || url.startsWith('--')) { console.error('uso: node scripts/t2-probe.js <url> [--save arq.json] [--depth 7]'); process.exit(2); }
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const maxDepth = +arg('depth', 7);
const origin = arg('origin', 'http://127.0.0.1:4173');

function show(v, key, depth, out) {
  const pad = '  '.repeat(depth);
  if (Array.isArray(v)) {
    out.push(pad + key + ': array[' + v.length + ']');
    if (v.length && depth < maxDepth) show(v[0], '[0]', depth + 1, out);
  } else if (v && typeof v === 'object') {
    out.push(pad + key + ': {' + Object.keys(v).length + ' chaves}');
    if (depth < maxDepth) for (const k of Object.keys(v)) show(v[k], k, depth + 1, out);
  } else {
    const s = JSON.stringify(v);
    out.push(pad + key + ': ' + (typeof v) + ' ' + (s && s.length > 60 ? s.slice(0, 57) + '...' : s));
  }
}

(async () => {
  let headers = null;
  const q = Q.createFetchQueue({
    maxRps: 5,
    maxConcurrent: 1,
    fetchOptions: { cache: 'no-cache', headers: { Origin: origin } },
    fetchImpl: async (requestUrl, options) => {
      const response = await fetch(requestUrl, options);
      headers = response.headers;
      return response;
    },
  });
  const result = await q.get(url, { priority: 100 });
  const header = (name) => headers ? headers.get(name) : null;
  console.log('HTTP', result.status, '| etag:', header('etag'), '| last-modified:', header('last-modified'),
              '| content-length:', header('content-length'), '| CORS allow-origin:', header('access-control-allow-origin'));
  if (result.status !== 200 || !result.json) { console.log('Sem corpo útil. NÃO tente de novo em laço.'); process.exit(3); }
  const txt = JSON.stringify(result.json);
  if (arg('save')) { fs.writeFileSync(arg('save'), txt); console.log('salvo em', arg('save'), '(' + txt.length + ' bytes)'); }
  const json = result.json;
  const out = []; show(json, '(raiz)', 0, out);
  console.log(out.join('\n'));
})().catch((e) => { console.error('erro:', e.message); process.exit(1); });
