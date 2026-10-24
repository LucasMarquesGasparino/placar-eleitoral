# Backtest e ensaio sintético do 2º turno

> **Atenção (24/10/2026):** o backtest sintético abaixo (corte proporcional e ordem sintética) é **otimista**: subestima o erro no meio da apuração de 3 a 40 vezes. A medida realista é a seção "Ensaio com a ordem real (2022)" mais abaixo.

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

## Ensaio com a ordem real (2022)

Gerado em 24/10/2026 por `scripts/t2-replay.js` (código real: `T2State` + `T2Engine`), sobre o 2º turno de 2022 com a **ordem real de chegada das seções**: `DT_PRIM_TOT_PARCIAL_HOR_TSE` (se faltar, `DT_RECEBIMENTO_BU_HOR_TSE`) dos Dados Abertos, 472029 seções presentes nos dois turnos, 6242 zonas. A cada t minutos depois das 17:00 só as seções já recebidas entram no estado (`y`, `E`, `s` = seções da zona, `st` = seções apuradas) e a projeção sai de `compute()`. **Prior neutro** (`T2Engine.neutralPrior`): 2022 não é usado como prior dentro da própria amostra. Erro = Lula projetado − Lula final, em p.p. dos votos válidos (final: Lula 50,90% dos válidos).

Por que o método de zona errava: dentro de cada zona as seções que chegam primeiro são menos lulistas que a zona inteira (Spearman +0,10 entre a ordem de chegada e a fatia de Lula no 1T). O app comparava o apurado com a composição da zona inteira e ficava cerca de 0,5 p.p. contra Lula entre 17:45 e 18:30. A **curva de chegada** (`data/t2/curva-2026-1t.json`) corrige isso: para cada zona guarda o desvio da composição das k primeiras seções do 1T26 em relação à zona; o app interpola em k = (st/s)·n e aplica a fração α. Na coluna "pertença exata" o motor recebe `xc/xr` verdadeiros (é o que o modo "Placar 2T Seção" faria se soubesse quais seções já foram apuradas).

### Nacional

| Hora | Apurado | α=0 (2T-1.1) | α=0,25 | α=0,5 (adotado) | α=0,75 | Pertença exata |
|---|---:|---:|---:|---:|---:|---:|
| 17:15 | 1,3% | +1,24 | +1,24 | +1,25 | +1,25 | +1,04 |
| 17:30 | 7,6% | −0,30 | −0,11 | +0,09 | +0,28 | +0,20 |
| 17:45 | 17,1% | −0,45 | −0,22 | +0,00 | +0,23 | +0,11 |
| 18:00 | 27,8% | −0,61 | −0,39 | −0,18 | +0,04 | +0,04 |
| 18:15 | 38,8% | −0,60 | −0,42 | −0,24 | −0,05 | +0,02 |
| 18:30 | 52,6% | −0,49 | −0,34 | −0,18 | −0,03 | −0,01 |
| 18:45 | 68,2% | −0,34 | −0,23 | −0,13 | −0,03 | −0,01 |
| 19:00 | 83,0% | −0,16 | −0,11 | −0,05 | +0,01 | −0,01 |
| 19:15 | 92,4% | −0,09 | −0,06 | −0,03 | −0,01 | −0,01 |
| 19:30 | 96,9% | −0,04 | −0,03 | −0,02 | −0,00 | −0,01 |
| **MAE 17:30–19:30** | | **0,34** | **0,21** | **0,10** | **0,07** | **0,05** |

### Grupo N+NE (2388 zonas)

| Hora | Apurado | α=0 (2T-1.1) | α=0,25 | α=0,5 (adotado) | α=0,75 | Pertença exata |
|---|---:|---:|---:|---:|---:|---:|
| 17:15 | 1,0% | +0,37 | +0,40 | +0,42 | +0,45 | +0,23 |
| 17:30 | 9,3% | −0,16 | +0,02 | +0,20 | +0,38 | −0,05 |
| 17:45 | 19,7% | −0,45 | −0,24 | −0,02 | +0,19 | −0,02 |
| 18:00 | 31,0% | −0,74 | −0,52 | −0,30 | −0,08 | −0,06 |
| 18:15 | 42,6% | −0,80 | −0,58 | −0,36 | −0,14 | −0,06 |
| 18:30 | 56,9% | −0,74 | −0,54 | −0,35 | −0,15 | −0,07 |
| 18:45 | 71,4% | −0,52 | −0,39 | −0,26 | −0,13 | −0,05 |
| 19:00 | 85,1% | −0,28 | −0,20 | −0,12 | −0,04 | −0,03 |
| 19:15 | 93,3% | −0,15 | −0,11 | −0,07 | −0,03 | −0,01 |
| 19:30 | 97,0% | −0,08 | −0,06 | −0,04 | −0,02 | −0,01 |
| **MAE 17:30–19:30** | | **0,44** | **0,30** | **0,19** | **0,13** | **0,04** |

### Grupo S+SE+CO+exterior (3854 zonas)

| Hora | Apurado | α=0 (2T-1.1) | α=0,25 | α=0,5 (adotado) | α=0,75 | Pertença exata |
|---|---:|---:|---:|---:|---:|---:|
| 17:15 | 1,5% | +1,57 | +1,57 | +1,56 | +1,56 | +1,36 |
| 17:30 | 6,7% | −0,40 | −0,20 | +0,00 | +0,20 | +0,30 |
| 17:45 | 15,7% | −0,45 | −0,22 | +0,01 | +0,25 | +0,16 |
| 18:00 | 26,1% | −0,54 | −0,33 | −0,11 | +0,10 | +0,08 |
| 18:15 | 36,8% | −0,50 | −0,33 | −0,17 | −0,00 | +0,04 |
| 18:30 | 50,3% | −0,36 | −0,23 | −0,10 | +0,03 | +0,01 |
| 18:45 | 66,5% | −0,24 | −0,16 | −0,07 | +0,02 | −0,00 |
| 19:00 | 81,9% | −0,10 | −0,06 | −0,01 | +0,03 | −0,00 |
| 19:15 | 91,8% | −0,06 | −0,04 | −0,02 | +0,00 | −0,01 |
| 19:30 | 96,8% | −0,02 | −0,01 | −0,01 | +0,00 | −0,01 |
| **MAE 17:30–19:30** | | **0,30** | **0,17** | **0,06** | **0,07** | **0,07** |

Conferência cruzada: as mesmas contas com duas UFs alternadas (pares/ímpares em ordem alfabética) dão MAE de α=0 → α=0,5 de 0,32 → 0,09 e 0,36 → 0,12.

### Critério de adoção do α=0,5 (A1)

- MAE (17:30–19:30) cai pelo menos 50% em relação a α=0 nos dois grupos: nacional −70%, N+NE −56%, S+SE+CO+exterior −81%. **Passa.**
- Nenhum ponto da grade de 15 min piora mais de 0,1 p.p. (pior: 0,05 p.p.). **Passa.**
- Reprodução do teste rápido (±0,03): α=0 dá −0,61 às 18:00 (referência −0,58) e MAE 0,34 (0,36); α=0,5 dá −0,18 às 18:00 (−0,15) e MAE 0,10 (0,10); pertença MAE 0,05 (0,05). A pequena diferença vem de a base aqui ter 472029 seções (todas as presentes nos dois turnos) em vez das ~460 mil do teste rápido.
- Decisão: `arrivalAlpha` padrão **0,5**. O α=0,75 tem MAE menor no conjunto, mas erra mais no começo (+0,28 às 17:30, contra +0,09) e a relação entre as ordens do 1T e do 2T de 2026 pode ser mais fraca que a de 2022.

### Envelope de erro (faixa calibrada, A3)

Regra: 2× o maior |erro| observado na faixa de apuração (nacional e os dois grupos, grade de 5 min), com pisos de 1,5 p.p. até 5%, 0,3 até 60%, 0,2 até 90% e 0,1 depois; monótono não crescente; arredondado para cima a 0,05. Constantes em `t2-state.js` (`ENV_CURVA`, usada com α > 0, e `ENV_SEM_CURVA`):

| Apurado até | ± p.p. com a curva (α=0,5) | ± p.p. sem a curva |
|---:|---:|---:|
| 5% | 4,05 | 4,05 |
| 10% | 0,75 | 1,65 |
| 20% | 0,75 | 1,65 |
| 30% | 0,75 | 1,65 |
| 40% | 0,75 | 1,65 |
| 60% | 0,75 | 1,65 |
| 90% | 0,70 | 1,40 |
| 100% | 0,20 | 0,40 |

O envelope de até 5% (±4,05) é dominado pelo prior neutro do ensaio (erro de +1,2 a +2,0 p.p. nos primeiros minutos), e a transferência do prior de 2022 para 2026 é desconhecida; por isso a tela fica em "Indefinido" enquanto a diferença projetada for menor que a faixa.

Limitações: um único 2º turno (2022); o α e o envelope devem ser recalibrados com o 2T de 2026 quando o TSE publicar o detalhe por seção (`node scripts/t2-replay.js` sobre 2026). Nenhum parâmetro do motor (`lambda0`, `kappa*`) foi alterado.

### Como reproduzir

```sh
python3 -I scripts/t2_build_base.py --modo replay2022 --votos ~/dl/votacao_secao_2022_BR.zip --detalhe ~/dl/detalhe_votacao_secao_2022.zip \
    --membro-detalhe detalhe_votacao_secao_2022_BRASIL.csv --out data/t2/dev/replay-2022.json --out-curva data/t2/dev/curva-2022-1t.json
node scripts/t2-replay.js        # grava data/t2/dev/replay-2022-resultado.json
```
