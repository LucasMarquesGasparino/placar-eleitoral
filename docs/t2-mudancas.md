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
