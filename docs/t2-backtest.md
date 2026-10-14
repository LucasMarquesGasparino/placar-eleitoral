# Backtest e ensaio sintético do 2º turno

Executado em 13/10/2026 com o motor e os parâmetros padrão (`lambda0`/`kappa`), a partir dos arquivos oficiais de 2022 e da base oficial do 1º turno de 2026. O backtest corta cada unidade proporcionalmente; por isso representa uma apuração mais regular do que a ordem real de chegada dos resultados.

## 2022: Lula × Bolsonaro

Verdade final: Lula `60.346.943` votos (50,90% dos válidos); Bolsonaro `58.207.402`.

Erro em pontos percentuais da parcela projetada de Lula, em relação à parcela final:

| Eleitorado apurado | Ordem por tamanho (erro) | Ordem aleatória, semente 21 (erro) |
|---:|---:|---:|
| 0% | +1,727 p.p. | +1,727 p.p. |
| ~1% | +0,613 p.p. (1,0%) | — |
| ~3% | — | +0,179 p.p. (2,6%) |
| ~10% | — | +0,010 p.p. (10,0%) |
| ~13% | +0,145 p.p. (13,4%) | — |
| ~22% | — | −0,008 p.p. (22,1%) |
| ~36% | +0,015 p.p. (35,6%) | −0,020 p.p. (36,0%) |
| ~50% | — | −0,015 p.p. (49,8%) |
| ~62% | +0,002 p.p. (61,6%) | −0,012 p.p. (63,6%) |
| ~90% | — | −0,002 p.p. (90,1%) |
| ~93% | ≈0 p.p. (93,3%) | — |
| 100% | ≈0 p.p. | ≈0 p.p. |

O erro fica abaixo de 0,5 p.p. por volta de 10% na ordem aleatória e desde cerca de 13% na ordem por tamanho. O começo pode errar mais de 1 p.p.; a tela não deve ser interpretada como previsão firme nos primeiros resultados. Com 100% apurado, o vetor final coincide com os votos simulados.

A busca exploratória `--grid` teve MAE aproximado de 0,826 p.p. nos parâmetros padrão e encontrou combinações perto de 0,717 p.p. neste conjunto. Mantive os parâmetros: a diferença da busca isolada não satisfaz a regra do plano de validar uma melhora nas duas ordens e em duas sementes antes de mudar a configuração.

## 2026: verdade sintética

O ensaio aplicou uma verdade oculta sintética às unidades reais da base de 2026, usando a matriz de migração de 2022 como prior. Erro da parcela de Lula: `−0,353 p.p.` no início; `−0,066 p.p.` a 13,7%; `−0,017 p.p.` a 36,2%; `−0,003 p.p.` a 62,3%; aproximadamente zero a 93,9%; e zero a 100%. O erro chega a zero no encerramento, por conservação dos votos.

Esses números medem o funcionamento do motor diante de uma verdade criada pelo próprio simulador. Não medem nem antecipam o resultado real de 2026.
