'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const T = require('../t2-tse.js');

const json = JSON.parse(fs.readFileSync(__dirname + '/fixtures/br-c0001-e006257-u.json', 'utf8'));
const metric = (path) => T.toNum(T.get(json, path));

test('EA20 Brasil do 1º turno confere com os totais oficiais e com o MAP observado', () => {
  const M = T.MAP;
  assert.equal(metric(M.comparecimento), 125275835);
  assert.equal(metric(M.abstencao), 33469244);
  assert.equal(metric(M.brancos), 2300798);
  assert.equal(metric(M.eleitorado), 158745502);
  assert.equal(metric(M.eleitoradoInstalado), 158745079);
  assert.equal(metric(M.secoesTotal), 499248);
  assert.equal(metric(M.secoesApuradas), 499248);

  const candidates = T.candidates(json);
  const votes = (number) => T.toNum(candidates.find((c) => String(c[M.candNumero]) === number)?.[M.candVotos]);
  assert.equal(votes('13'), 53879538);
  assert.equal(votes('22'), 56104503);
  assert.equal(candidates.length, 12);
  assert.equal(candidates.some((c) => String(c[M.candNumero]) === '28'), false);
  assert.equal(metric(['v', 'vn']) + metric(['v', 'vnt']), metric(['v', 'tvn']));
  assert.equal(metric(['v', 'vnt']), 5246);
});
