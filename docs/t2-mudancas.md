# Mudanças e decisões do 2º turno

## 13/10/2026 — Esquema real do TSE e base eleitoral

- Renan Santos aparece no CSV presidencial com número de urna `14`; `35` pertence a Wilson Grassi. O exemplo e o selftest de `scripts/t2_build_base.py` foram atualizados para o número observado.
- A resposta EA20 separa `v.vn=3.669.003` e `v.vnt=5.246`; `v.tvn=3.674.249`. O CSV tem os 5.246 votos sob o código `28`, mas esse candidato não consta entre os candidatos válidos de `cand[]`. O gerador recebeu a opção `--invalidos 28` para manter esses votos em `N`, fora de `D`.
- `scripts/t2-probe.js` usa `T2FetchQ` e envia um `Origin` de sondagem para que o cabeçalho CORS seja observável.
- `t2-tse.js` agora usa os caminhos EA20/EA15 confirmados em `docs/t2-schema.md` e percorre `agr[].par[].cand[]` para localizar os candidatos.
- A base `data/t2/base-2026-1t.json` foi gerada do CSV oficial com `--invalidos 28`; os totais dos candidatos, brancos, nulos e abstenção conferem com o EA20 nacional. A diferença de 72 no eleitorado instalado é inferior a 0,01%.
- A validação amostral EA20 de 20 unidades terminou com 20 respostas válidas, sem divergências.
- A matriz e o fallback de 2022 foram gerados dos dados oficiais. O backtest reproduzido está em `docs/t2-backtest.md`; os parâmetros padrão foram mantidos.
- O app de 2T está em `t2.html` e `android-t2/`, separado dos arquivos da primeira versão. O APK inclui somente os dados necessários para a prévia offline.
- No ensaio completo da interface, `stateAt(..., 1)` deixava algumas unidades com término agendado além de τ=1; corrigi o endpoint e usei contador inteiro para que o ensaio feche exatamente em 100%. O harness da tela chegou à verdade sintética em 100% e confirmou que só consultou `ele-c.json`.
- Sem alteração de parâmetros do motor (`lambda0`, `kappa` ou limites de comparecimento).

## 18/10/2026 — Robustez para o dia da apuração (2T-1.1)

- **Fila (`t2-fetchq.js`):** timeout por requisição de 15 s, cobrindo cabeçalhos e corpo (com `AbortController`); prazo por requisição (`deadline`), para que pedidos que não começaram a tempo expirem em vez de se acumular; limite de fila de 2000 itens (acima disso, resposta imediata `overflow`); contadores `timeouts`, `expired`, `overflow` e `lastOkAt`.
- **Poller (`t2-tse.js`):** falhas transitórias não zeram a apuração (o último dado bom continua na tela); backoff exponencial após falhas, com teto de 2 min; unidades em voo não são pedidas de novo; o modo EA15 passa a usar a mesma prioridade da varredura (zonas nunca lidas primeiro); o canário só para a apuração em erro de formato (404 ou JSON sem campos), não por queda de rede; "atualizar agora" não dispara consulta em paralelo; `prime()` aproveita o estado salvo ao reabrir o app; `connectionState()` descreve a conexão para a tela. Busca profunda de candidatos e leitura de `1.234.567` como número.
- **Estado (`t2-state.js`):** o horário de `lastUpdateTs` é o dos dados salvos (não o da reabertura); `version()` marca mudanças para a tela recalcular só quando necessário; `importState` ignora objetos incompletos; `unitInfo()` para o aquecimento do poller.
- **Tela (`t2.html`, `t2.css`, `t2.js`):** faixa de estado da conexão (AO VIVO, ATRASADO, SEM CONEXÃO, TSE LIMITOU ACESSO, ERRO DE DADOS, FINAL); painel "Apuração oficial · TSE" com as seções e os votos publicados pelo TSE; a projeção passa a ser rotulada como "base da projeção" (zonas lidas), com aviso quando o TSE já tem muito mais seções que o app leu; percentuais de progresso arredondados para baixo (nunca 100,00% antes do fim); render dividido em pesado (só quando os dados mudam) e leve (1 por segundo); botões de UF por delegação de evento; erros inesperados aparecem em alerta sem apagar os dados.
- **APK (`android-t2/`):** versionCode 2, versionName 2T-1.1; tela ligada enquanto o app está na frente; ciclo de vida do WebView (pausa, retomada, recriação após queda do processo de renderização, aviso de texto se o componente do sistema não abrir); assinatura estável com `~/.android-keys/placar-t2.keystore`; script `android-t2/build-t2.sh`.
- **Testes:** `test/t2-fetchq`, `test/t2-tse`, `test/t2-state` ganharam casos de timeout, deadline, overflow, transitórios, justiça na varredura, aquecimento e estado de conexão; `test/t2-ui-smoke.test.js` roda a tela num DOM falso.
- O motor de projeção (`t2-engine.js`, `t2-sim.js`) e os parâmetros (`lambda0`, `kappa`, limites de comparecimento) não mudaram.
