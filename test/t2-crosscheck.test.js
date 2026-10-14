'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { execFile } = require('child_process');
const S = require('../t2-sim.js');

function run(args) { return new Promise((res) => execFile('node', [path.join(__dirname, '..', 'scripts', 't2-crosscheck.js')].concat(args), (e, out, err) => res({ code: e ? e.code : 0, out, err }))); }
function mkBase() {
  const w = S.makeWorld({ seed: 2, nUf: 2, nMunPerUf: 10 });
  const names = { L: '13', F: '22', CURY: '70', SANTOS: '35', CAIADO: '55', ZEMA: '30' };
  const cand = {}; Object.keys(names).forEach((k) => { cand[k] = { numero: names[k], nome: k }; });
  const unidades = w.units.map((u) => ({ id: u.id, uf: u.uf, mun: u.mun, zona: u.zona, x: u.x.map(Math.round), E: Math.round(u.x.reduce((a, b) => a + Math.round(b), 0)) }));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-')), 'base.json');
  fs.writeFileSync(file, JSON.stringify({ rows: w.rows, candidatos: cand, unidades }));
  return { file, unidades, names };
}
function serve(base, tweak) {
  const idx = {};
  const mun = {}; base.unidades.forEach((u) => { (mun[u.uf + u.mun] = mun[u.uf + u.mun] || []).push(u); });
  const srv = http.createServer((req, res) => {
    const m = req.url.match(/\/dados\/([a-z0-9]{2})\/\1(\d{5})(?:-z(\d{4}))?-c0001-e006257-u\.json$/);
    const list = m && (mun[m[1].toUpperCase() + m[2]] || []).filter((u) => !m[3] || u.zona === m[3]);
    if (!list || !list.length) { res.statusCode = 404; return res.end(); }
    const sum = (i) => list.reduce((s, u) => s + u.x[i], 0);
    const nom = ['L', 'F', 'CURY', 'SANTOS', 'CAIADO', 'ZEMA'].map((k, i) => ({ n: base.names[k], vap: String(sum(i) + (tweak && i === 0 ? tweak : 0)) }));
    nom.push({ n: '80', vap: String(sum(6)) });                       // "demais" = um candidato qualquer
    const b = sum(7), nul = sum(8), a = sum(9), cand = nom.reduce((s, x) => s + Number(x.vap), 0);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ s: { ts: '10', st: '10' },
      e: { te: String(list.reduce((s, u) => s + u.E, 0)), esi: String(list.reduce((s, u) => s + u.E, 0)), c: String(cand + b + nul - (tweak || 0)), a: String(a) },
      v: { vb: String(b) }, carg: [{ agr: [{ par: [{ cand: nom }] }] }] }));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

test('crosscheck: --dry lista URLs sem rede', async () => {
  const b = mkBase();
  const r = await run(['--base', b.file, '--n', '4', '--dry']);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim().split('\n').length, 4);
  assert.ok(r.out.includes('-c0001-e006257-u.json'));
});

test('crosscheck: números iguais => ok (código 0); número adulterado => DIVERGE (código 3)', async () => {
  const b = mkBase();
  let srv = await serve(b), url = 'http://127.0.0.1:' + srv.address().port;
  let r = await run(['--base', b.file, '--n', '6', '--base-url', url]);
  srv.close();
  assert.equal(r.code, 0, r.out + r.err); assert.ok(/6 ok, 0 com problema/.test(r.out), r.out);
  srv = await serve(b, 7); url = 'http://127.0.0.1:' + srv.address().port;
  r = await run(['--base', b.file, '--n', '4', '--base-url', url]);
  srv.close();
  assert.equal(r.code, 3); assert.ok(r.out.includes('DIVERGE'));
});
