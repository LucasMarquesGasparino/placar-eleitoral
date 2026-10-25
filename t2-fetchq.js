/* t2-fetchq.js — Fila de requisições "educada" para o CDN do TSE.
 * Regras do TSE (2026): máx. 100 req/s por IP; bloqueio de 10 min se estourar; MUITOS 404 também bloqueiam.
 * Esta fila garante: concorrência limitada, taxa máxima, cache negativo de 404, disjuntor de 404 e pausa global em 403/429.
 * Robustez (2T-1.1): timeout por requisição (cabeçalhos + corpo), prazo por requisição (deadline),
 * limite de fila (overflow) e nenhuma promessa que fique pendurada.
 * NÃO envia cabeçalhos condicionais (If-None-Match) à mão: no navegador isso dispara pré-voo CORS.
 * Use fetchOptions {cache:'no-cache'} e deixe o navegador revalidar por ETag sozinho.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.T2FetchQ = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function createFetchQueue(opts) {
    var o = {
      fetchImpl: (typeof fetch === 'function' ? fetch.bind(typeof self !== 'undefined' ? self : globalThis) : null),
      fetchOptions: { cache: 'no-cache' },
      maxConcurrent: 6,       // requisições simultâneas
      maxRps: 15,             // início de requisições por segundo (limite do TSE é 100; ficamos longe)
      negTtlMs: 120000,       // não repetir uma URL que deu 404 por este tempo
      breaker404: 5,          // 404s ...
      breakerWindowMs: 30000, // ... dentro desta janela abrem o disjuntor
      breakerMs: 60000,       // tempo de disjuntor aberto
      pauseMs: 600000,        // pausa global após 403/429 (bloqueio de 10 min do TSE)
      timeoutMs: 15000,       // tempo máximo de uma requisição (fetch + leitura do corpo)
      maxQueue: 2000,         // máximo de itens esperando na fila
      now: function () { return Date.now(); },
      sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
      setTimer: function (fn, ms) { return setTimeout(fn, ms); },
      clearTimer: function (h) { clearTimeout(h); }
    };
    for (var k in opts) if (opts[k] !== undefined) o[k] = opts[k];

    var queue = [], workers = 0, seq = 0;
    var neg = {};                 // url -> instante até o qual não repetir
    var recent404 = [];           // instantes dos últimos 404
    var pausedUntil = 0, breakerUntil = 0, nextSlot = 0;
    var stats = {
      started: 0, ok: 0, notFound: 0, blocked: 0, errors: 0, skipped: 0,
      timeouts: 0, expired: 0, overflow: 0, lastOkAt: 0
    };

    function pick() {                      // maior prioridade primeiro; empate: ordem de chegada
      var best = 0;
      for (var i = 1; i < queue.length; i++) {
        if (queue[i].priority > queue[best].priority ||
            (queue[i].priority === queue[best].priority && queue[i].seq < queue[best].seq)) best = i;
      }
      return queue.splice(best, 1)[0];
    }

    async function handle(item) {
      var url = item.url, t = o.now();
      if (t < pausedUntil) { stats.skipped++; return item.resolve({ status: 0, error: 'paused', retryAt: pausedUntil }); }
      if (t < breakerUntil) { stats.skipped++; return item.resolve({ status: 0, error: 'breaker', retryAt: breakerUntil }); }
      if (neg[url] && t < neg[url]) { stats.skipped++; return item.resolve({ status: 404, cached: true }); }
      if (item.deadline && t > item.deadline) { stats.expired++; return item.resolve({ status: 0, error: 'expired' }); }
      var ttl = item.negTtlMs !== undefined ? item.negTtlMs : o.negTtlMs;
      var wait = nextSlot - t;               // limite de taxa
      nextSlot = Math.max(t, nextSlot) + 1000 / o.maxRps;
      if (wait > 0) await o.sleep(wait);
      t = o.now();
      if (t < pausedUntil) { stats.skipped++; return item.resolve({ status: 0, error: 'paused', retryAt: pausedUntil }); }
      if (item.deadline && t > item.deadline) { stats.expired++; return item.resolve({ status: 0, error: 'expired' }); }
      stats.started++;
      var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
      var fo = {}; for (var k2 in o.fetchOptions) fo[k2] = o.fetchOptions[k2];
      if (ctrl) fo.signal = ctrl.signal;
      var TIMEOUT = {}; var th = null;
      var timeoutP = new Promise(function (_, rej) { th = o.setTimer(function () { try { if (ctrl) ctrl.abort(); } catch (e) {} rej(TIMEOUT); }, o.timeoutMs); });
      timeoutP.catch(function () {});
      var res, json, asBuffer = item.as === 'buffer';
      try {
        res = await Promise.race([o.fetchImpl(url, fo), timeoutP]);
        if (res.status === 200) {
          try { json = await Promise.race([asBuffer ? res.arrayBuffer() : res.json(), timeoutP]); }
          catch (eJ) { if (eJ === TIMEOUT) throw eJ; o.clearTimer(th); stats.errors++; return item.resolve({ status: 200, error: 'json' }); }
        }
      } catch (e) {
        o.clearTimer(th);
        if (e === TIMEOUT || (e && e.name === 'AbortError')) { stats.timeouts++; return item.resolve({ status: 0, error: 'timeout' }); }
        stats.errors++; return item.resolve({ status: 0, error: 'network' });
      }
      o.clearTimer(th);
      if (res.status === 200) {
        if (json === null || json === undefined) { stats.errors++; return item.resolve({ status: 200, error: 'json' }); }
        stats.ok++; stats.lastOkAt = o.now();
        return item.resolve(asBuffer ? { status: 200, buffer: json } : { status: 200, json: json });
      }
      if (res.status === 404) {
        stats.notFound++;
        neg[url] = t + ttl;
        recent404 = recent404.filter(function (x) { return t - x < o.breakerWindowMs; });
        recent404.push(t);
        if (recent404.length >= o.breaker404) { breakerUntil = t + o.breakerMs; recent404 = []; }
        return item.resolve({ status: 404 });
      }
      if (res.status === 403 || res.status === 429) {
        stats.blocked++;
        pausedUntil = t + o.pauseMs;
        return item.resolve({ status: res.status, error: 'blocked', retryAt: pausedUntil });
      }
      stats.errors++;
      return item.resolve({ status: res.status, error: 'http' });
    }

    async function worker() {
      while (queue.length) {
        var item = pick();
        try { await handle(item); }
        catch (e) { stats.errors++; item.resolve({ status: 0, error: 'network' }); }
      }
    }
    function spawn() {
      while (workers < o.maxConcurrent && queue.length > workers) {
        workers++;
        worker().catch(function () {}).then(function () { workers--; if (queue.length) spawn(); });
      }
    }

    return {
      /* get(url, {priority, negTtlMs, deadline, as}) -> Promise<{status, json?, buffer?, error?, cached?, retryAt?}>. Nunca rejeita.
       * as: 'buffer' (opcional) lê o corpo como ArrayBuffer (ex.: boletim de urna .dat) e devolve { status: 200, buffer }.
       * negTtlMs (opcional) troca, só para esta URL, o tempo em que um 404 não é repetido.
       * deadline (opcional, ms no relógio o.now()): se a requisição ainda não começou depois disso, resolve 'expired'.
       * Fila cheia (queue >= maxQueue): resolve na hora 'overflow', sem enfileirar. */
      get: function (url, opt) {
        return new Promise(function (resolve) {
          if (queue.length >= o.maxQueue) { stats.overflow++; return resolve({ status: 0, error: 'overflow' }); }
          queue.push({ url: url, priority: (opt && opt.priority) || 0, negTtlMs: opt && opt.negTtlMs, deadline: opt && opt.deadline, as: opt && opt.as, seq: seq++, resolve: resolve });
          spawn();
        });
      },
      stats: function () { return Object.assign({ queued: queue.length, pausedUntil: pausedUntil, breakerUntil: breakerUntil }, stats); },
      resetBlocks: function () { pausedUntil = 0; breakerUntil = 0; neg = {}; recent404 = []; }
    };
  }

  return { createFetchQueue: createFetchQueue };
});
