# Reconhecimento do repositório para o 2º turno

Verificado em 13/10/2026 no ambiente Termux.

## Ambiente

- Node.js: `v24.17.0`.
- Python: `3.13.13`.
- Gradle wrapper: `8.5` (JVM 21.0.11).
- O app principal é HTML/CSS/JavaScript sem dependências npm externas; `npm start` executa `server.js`.

## Respostas do passo 0.1

(a) `app.js` e `previsao.js` formam as URLs diretamente em `https://resultados.tse.jus.br/oficial/ele2026/{eleição}/dados/...`; não usam proxy local. `server.js` serve os arquivos locais e não encaminha requisições ao TSE. `fetchJson()` usa `fetch(url, { cache: 'no-cache', mode: 'cors' })`, rejeita respostas não-2xx e converte o corpo para JSON.

(b) `resultUrl()` em `app.js` monta o caminho do EA20, e `fetchJson()` baixa o documento. `extractLiveResult(data)` lê candidatos (`carg[].agr[].cand[]` e `par[].cand[]`, com `nmu`/`nm`, `n`, `vap` e `pvap`), votos válidos (`v.vvc.vv.t`, com alternativas), e progresso de seções/eleitorado nos objetos `s` e `e`. `previsao.js` tem seu próprio `resultUrl()` presidencial e `extractLiveResult()` equivalente. A eleição presidencial corrente é 6257; os cargos estaduais usam 6259.

(c) `MainActivity` carrega uma página `https://appassets.androidplatform.net/assets/www/{página}` e intercepta as requisições desse host para abrir os assets empacotados. A tarefa Gradle `syncWebAssets` copia HTML, JavaScript, CSS, `assets/**` e `data/**` da raiz para `build/generated/webAssets/www`, de onde entram no APK.

(d) Sim. `MainActivity` chama `settings.setDomStorageEnabled(true)`, habilitando `localStorage` no WebView.

(e) Node `v24.17.0`; Gradle `8.5` pelo wrapper (`android/gradlew`).

(f) `sw.js` usa o cache `placar-static-v7`: no install pré-carrega a interface e os dados históricos; em requisições same-origin tenta a rede primeiro, grava respostas bem-sucedidas no cache e usa o cache se a rede falhar. Respostas externas do TSE não são interceptadas. A página nova do 2º turno não registrará esse service worker.

## Artefatos APK encontrados

- `/storage/emulated/0/Download/placar eleitoral.apk`: pacote `br.com.lucasgasparino.placar.debug`, versão `1.5.0-debug`, código 7, contendo `index.html`, `previsao.html` e os assets do app principal.
- `/storage/emulated/0/Download/PlacarEleitoral.apk`: pacote do mesmo app, versão `1.0.0-debug`, código 1.

Ambos permanecem fora do repositório.
