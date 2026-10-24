'use strict';
// Confere os arquivos gerados data/t2/secoes/<uf>.json contra a base por zona (soma das seções = x da zona).
// Se os arquivos não existirem (gerados por scripts/t2_build_secoes.py), o teste é ignorado.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'data', 't2', 'secoes');
const baseFile = path.join(__dirname, '..', 'data', 't2', 'base-2026-1t.json');

test('secoes: soma das seções de cada zona = x da base; mesmas rows; ids e chaves no formato', { skip: !fs.existsSync(dir) || !fs.existsSync(baseFile) }, () => {
  const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
  const K = base.rows.length;
  const porId = new Map(base.unidades.map((u) => [u.id, u]));
  let zonas = 0, secoes = 0, difAbs = 0;
  const vistas = new Set();
  for (const arq of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, arq), 'utf8'));
    assert.equal(j.v, 1); assert.equal(arq, j.uf.toLowerCase() + '.json'); assert.deepEqual(j.rows, base.rows);
    for (const [id, secs] of Object.entries(j.zonas)) {
      assert.match(id, /^[A-Z]{2}\|\d{5}\|\d{4}$/); assert.equal(id.slice(0, 2), j.uf);
      const u = porId.get(id);
      assert.ok(u, 'zona fora da base: ' + id);
      vistas.add(id); zonas++;
      const soma = new Array(K).fill(0);
      for (const [ns, x] of Object.entries(secs)) {
        assert.match(ns, /^\d{4}$/); assert.equal(x.length, K); secoes++;
        for (let i = 0; i < K; i++) { assert.ok(Number.isInteger(x[i]) && x[i] >= 0); soma[i] += x[i]; }
      }
      for (let i = 0; i < K; i++) difAbs += Math.abs(soma[i] - u.x[i]);
    }
  }
  assert.equal(zonas, base.unidades.length); assert.equal(vistas.size, porId.size);
  assert.equal(secoes, base.unidades.reduce((a, u) => a + u.secoes, 0));
  assert.equal(difAbs, 0);        // base real: soma exata em todas as zonas (o script tolera 0,01% do eleitorado)
});
