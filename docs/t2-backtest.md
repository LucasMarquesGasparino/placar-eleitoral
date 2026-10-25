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

| Hora | Apurado | α=0 (2T-1.1) | α=0,25 | α=0,5 (2T-1.2) | α=0,75 | Pertença exata |
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

| Hora | Apurado | α=0 (2T-1.1) | α=0,25 | α=0,5 (2T-1.2) | α=0,75 | Pertença exata |
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

| Hora | Apurado | α=0 (2T-1.1) | α=0,25 | α=0,5 (2T-1.2) | α=0,75 | Pertença exata |
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
- Decisão (2T-1.2): `arrivalAlpha` padrão **0,5**; no 2T-1.3 passou a 0,8 em rampa (seção seguinte). O α=0,75 tem MAE menor no conjunto, mas erra mais no começo (+0,28 às 17:30, contra +0,09) e a relação entre as ordens do 1T e do 2T de 2026 pode ser mais fraca que a de 2022.

### Modelos testados para o 2T-1.3

Pergunta: há modelo com erro menor que o 2T-1.2 (α=0,5 fixo) em cada faixa de apurado, sem sobreajuste ao 2T de 2022? Mesmo ensaio (ordem real, prior neutro, `T2State` real). Os pontos são cada 1% apurado de cada recorte: nacional, g1 (N+NE), g2 (resto) e, como checagem independente, duas partições alfabéticas de UF (a1, a2). Erro em p.p. de Lula nos válidos.

**De onde vinha o erro do 2T-1.2**

1. O viés dentro da zona é de composição. As seções que chegam primeiro têm outra composição no 1T. O "swing" residual, medido à parte, é ≤ 0,1 p.p.
2. O α que zera o viés depende da fração apurada da zona (f = st/s). No nacional, por faixa de f:

   | f | 0–10% | 10–20% | 20–30% | 30–40% | 40–50% | 50–60% | 60–70% | 70–80% | 80–90% | 90–100% |
   |---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
   | α* | 0,26 | 0,73 | 0,81 | 0,77 | 0,82 | 0,78 | 0,76 | 0,71 | 0,72 | 0,82 |

   O padrão se repete nos cinco recortes. Com α=0,5 fixo, o 2T-1.2 ficava −0,2 a −0,35 p.p. contra Lula entre 25% e 70% apurado.
3. Entre 5% e 20% apurado há outro viés, de +0,1 a +0,2 p.p. Ele vem das zonas que ainda não mandaram nada, não da composição. Até a pertença exata erra ≈ 0,13 ali (+0,36 de contribuição dessas zonas na margem aos 7,6% apurado). O 2T-1.2 ia bem nessa faixa porque os dois vieses se cancelavam por acaso. Não achei correção robusta; fica como limitação.

**Modelos testados** (MAE de 5–95% apurado, pontos de 1%)

| Modelo | Nacional | g1 | g2 | a1 | a2 | Veredito |
|---|---:|---:|---:|---:|---:|---|
| 2T-1.2 (α=0,5 fixo) | 0,126 | 0,238 | 0,076 | 0,106 | 0,152 | referência |
| α=0,75 fixo | 0,074 | 0,149 | 0,065 | 0,081 | 0,091 | pior de 5–20% (até 0,45) |
| α=1 fixo | 0,182 | 0,162 | 0,195 | 0,214 | 0,161 | corrige demais |
| α calibrado ao vivo pelas zonas completas | 0,046–0,14 | 0,17–0,30 | — | — | — | instável: a regressão dá ≈ 0,5 por atenuação; a razão é ruidosa no começo |
| peso menor para zonas parciais na matriz | 0,129 | 0,239 | 0,077 | — | — | sem ganho |
| kappaUf/kappaMun diferentes | ±0,01 | — | — | — | — | inconsistente; não mexer |
| **α em rampa: 0,8·min(1, f/0,3) (2T-1.3)** | **0,054** | **0,129** | **0,043** | **0,026** | **0,086** | **adotado** |
| pertença exata (teto) | 0,043 | 0,046 | 0,059 | 0,048 | 0,040 | inalcançável sem o `cs` |

**2T-1.3 contra 2T-1.2 por faixa de apurado** (MAE em p.p.)

| Recorte | Versão | 5–10 | 10–20 | 20–30 | 30–40 | 40–50 | 50–60 | 60–70 | 70–80 | 80–90 | 90–95 | máx 5–95 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Nacional | 1.2 | 0,11 | 0,03 | 0,12 | 0,21 | 0,22 | 0,18 | 0,15 | 0,10 | 0,05 | 0,03 | 0,25 |
| Nacional | 1.3 | 0,04 | 0,05 | 0,06 | 0,12 | 0,10 | 0,06 | 0,03 | 0,02 | 0,01 | 0,00 | 0,15 |
| g1 | 1.2 | 0,30 | 0,12 | 0,14 | 0,32 | 0,34 | 0,35 | 0,32 | 0,23 | 0,13 | 0,08 | 0,38 |
| g1 | 1.3 | 0,25 | 0,17 | 0,06 | 0,18 | 0,18 | 0,17 | 0,15 | 0,09 | 0,04 | 0,02 | 0,35 |
| g2 | 1.2 | 0,04 | 0,05 | 0,09 | 0,16 | 0,14 | 0,10 | 0,07 | 0,05 | 0,02 | 0,01 | 0,18 |
| g2 | 1.3 | 0,07 | 0,07 | 0,06 | 0,10 | 0,05 | 0,01 | 0,02 | 0,02 | 0,03 | 0,01 | 0,18 |
| a1 | 1.2 | 0,16 | 0,06 | 0,10 | 0,12 | 0,13 | 0,16 | 0,14 | 0,08 | 0,06 | 0,04 | 0,32 |
| a1 | 1.3 | 0,07 | 0,04 | 0,03 | 0,02 | 0,02 | 0,03 | 0,03 | 0,01 | 0,01 | 0,02 | 0,20 |
| a2 | 1.2 | 0,09 | 0,07 | 0,16 | 0,32 | 0,26 | 0,20 | 0,15 | 0,11 | 0,04 | 0,03 | 0,34 |
| a2 | 1.3 | 0,07 | 0,07 | 0,12 | 0,23 | 0,14 | 0,08 | 0,04 | 0,03 | 0,02 | 0,01 | 0,26 |

Classes de 1% (5–95%) melhores / piores que o 2T-1.2, com margem de 0,005: nacional 83/6, g1 79/9, g2 61/25, a1 81/4, a2 80/2. As que pioram ficam quase todas entre 10% e 20% apurado (o cancelamento por acaso do item 3), por 0,02–0,04 p.p. Na grade de 15 min, MAE 17:30–19:30: nacional 0,10 → 0,05, g1 0,19 → 0,10, g2 0,06 → 0,04; o pior ponto piora 0,08 p.p. (g2).

**Critério de adoção do 2T-1.3: passa.**
- MAE de 5–95% cai ≥ 30% em nacional (−57%), g1 (−46%) e g2 (−43%).
- Nenhum ponto da grade de 15 min piora mais de 0,1 p.p.
- Pelo menos 60% das classes de 1% melhoram e no máximo 30% pioram, nos cinco recortes.

**Por que não é sobreajuste**
- **Platô, não ponto.** `--sensibilidade`, MAE 5–95% (a referência 2T-1.2 está na última linha):

  | α máx / rampa | Nacional | g1 | g2 | a1 | a2 |
  |---|---:|---:|---:|---:|---:|
  | 0,7 / 0,25 | 0,076 | 0,162 | 0,050 | 0,048 | 0,104 |
  | 0,7 / 0,3 | 0,087 | 0,168 | 0,063 | 0,058 | 0,115 |
  | 0,7 / 0,4 | 0,114 | 0,186 | 0,090 | 0,089 | 0,141 |
  | 0,8 / 0,25 | 0,050 | 0,124 | 0,037 | 0,031 | 0,078 |
  | **0,8 / 0,3** | **0,054** | **0,129** | **0,043** | **0,026** | **0,086** |
  | 0,8 / 0,4 | 0,077 | 0,145 | 0,062 | 0,048 | 0,111 |
  | 0,85 / 0,25 | 0,043 | 0,108 | 0,039 | 0,040 | 0,067 |
  | 0,85 / 0,3 | 0,045 | 0,111 | 0,040 | 0,027 | 0,075 |
  | 0,85 / 0,4 | 0,062 | 0,126 | 0,053 | 0,030 | 0,097 |
  | 2T-1.2 | 0,126 | 0,238 | 0,076 | 0,106 | 0,152 |

  As nove combinações batem o 2T-1.2 em todos os recortes. 0,85 dá um pouco menos de erro aqui, mas fica na borda de α alto; 0,8/0,3 fica no meio.
- **O mecanismo foi medido à parte.** A forma da rampa vem da decomposição α*(f), não de varrer o MAE.
- **Vale com outros priors.** A melhora se mantém com prior neutro, 50% verdadeiro e verdadeiro.
- **Dois parâmetros redondos.** As partições a1/a2, que não entraram na escolha, melhoram 75% e 44%.

**Risco restante.** Em 2026 a relação entre a ordem do 1T e a do 2T pode ser mais fraca que em 2022. Isso já valia para o 2T-1.2. `opts.arrivalAlpha`/`opts.arrivalRamp` permitem voltar: `{arrivalAlpha: 0.5, arrivalRamp: 0}` reproduz o 2T-1.2.

### Envelope de erro (faixa calibrada, A3)

Regra (2T-1.2.1; constantes regeradas no 2T-1.3): **100 classes de 1% apurado**. Os pontos do ensaio são a grade de 5 min mais um ponto a cada 1% apurado de cada escopo (nacional e os dois grupos, mais os pontos de 1% de a1/a2; 502 por escopo). A classe [i%, i+1%) usa 2× o maior |erro| observado com apurado entre i−3% e i+4%, com pisos de 1,5 p.p. até 5%, 0,3 até 60%, 0,2 até 90% e 0,1 depois; arredondado para cima a 0,05. **Não** é monótona: em 2022 o erro foi menor entre 10% e 25% e cresceu entre 30% e 60%, e a faixa acompanha isso (até o 2T-1.2 a regra era só diminuir, com 8 classes, e ficava em ±0,75 de 5% a 60%). Lista completa em `t2-state.js` (`ENV_CURVA`, usada com α > 0, e `ENV_SEM_CURVA`); abaixo, a classe que começa em cada ponto:

| Classe a partir de | ± p.p. com a curva (2T-1.3) | ± p.p. sem a curva |
|---:|---:|---:|
| 0% | 4,05 | 4,05 |
| 1% | 4,05 | 4,05 |
| 2% | 4,05 | 4,05 |
| 3% | 4,05 | 4,05 |
| 4% | 3,50 | 3,60 |
| 5% | 2,00 | 1,90 |
| 10% | 0,50 | 1,25 |
| 15% | 0,55 | 1,00 |
| 20% | 0,30 | 1,20 |
| 25% | 0,30 | 1,40 |
| 30% | 0,40 | 1,50 |
| 35% | 0,45 | 1,60 |
| 40% | 0,50 | 1,65 |
| 45% | 0,45 | 1,65 |
| 50% | 0,40 | 1,65 |
| 55% | 0,35 | 1,55 |
| 60% | 0,35 | 1,50 |
| 65% | 0,35 | 1,40 |
| 70% | 0,35 | 1,25 |
| 75% | 0,25 | 1,05 |
| 80% | 0,20 | 0,85 |
| 85% | 0,20 | 0,65 |
| 90% | 0,10 | 0,55 |
| 95% | 0,10 | 0,35 |
| 99% | 0,10 | 0,20 |

O envelope de até 5% (±4,05) é dominado pelo prior neutro do ensaio (erro de +1,2 a +2,0 p.p. nos primeiros minutos), e a transferência do prior de 2022 para 2026 é desconhecida; por isso a tela fica em "Indefinido" enquanto a diferença projetada for menor que a faixa.

Com o 2T-1.3 a faixa com a curva ficou mais estreita de 25% a 95% (±0,30–0,50 contra ±0,50–0,80) e um pouco mais larga em 10–20% (±0,50–0,55 contra ±0,40–0,65), onde fica o viés das zonas ainda sem dados.

Limitações (2T-1.3): um único 2º turno (2022). No 2T-1.4 a faixa passou a cobrir também 2018 (seção "Ensaio fora da amostra: 2018"); o α, a rampa e o envelope devem ser recalibrados com o 2T de 2026 quando o TSE publicar o detalhe por seção (`node scripts/t2-replay.js` sobre 2026). Nenhum parâmetro do motor (`lambda0`, `kappa*`) foi alterado.

### Como reproduzir

```sh
python3 -I scripts/t2_build_base.py --modo replay2022 --votos ~/dl/votacao_secao_2022_BR.zip --detalhe ~/dl/detalhe_votacao_secao_2022.zip \
    --membro-detalhe detalhe_votacao_secao_2022_BRASIL.csv --out data/t2/dev/replay-2022.json --out-curva data/t2/dev/curva-2022-1t.json
node scripts/t2-replay.js        # grava data/t2/dev/replay-2022-resultado.json, tabelas por faixa, critério do 2T-1.3 e ENV_CURVA/ENV_SEM_CURVA prontas
node scripts/t2-replay.js --sensibilidade   # + grade α máx × rampa (cerca de 16 min); --alvo 0.8 --rampa 0.3 mudam a variante v13
```

## Ensaio fora da amostra: 2018 (2T-1.4)

α 0,8, rampa 0,3 e a faixa do 2T-1.3 foram escolhidos só com 2022. O 2T de 2018 (Haddad × Bolsonaro) tem o mesmo formato no TSE, inclusive o horário de recebimento de cada seção nos dois turnos (`detalhe_votacao_secao_2018.zip`, republicado em 04/2026), e serve de **teste fora da amostra**: a curva sai da ordem do 1T18 e é aplicada à ordem real do 2T18, como o app fará com 1T26 → 2T26. No 1T, Ciro (12) e Alckmin (45) entram como linhas próprias do x (`L,F,CIRO,ALCKMIN,D,B,N,A`).

- **Totais.** 2T18 nas seções presentes nos dois turnos: Haddad 47.040.906, Bolsonaro 57.797.847 (Haddad 44,87% dos válidos, igual ao oficial). 1T18: Bolsonaro 46,03%, Haddad 29,28%.
- **Diferenças de 2018.** Cada UF fechava às 17h locais (AC às 19h de Brasília; AM, RO, RR, MT e MS às 18h). Isso não muda a ordem **dentro** da zona, que é o que a curva usa, mas muda a ordem **entre** UFs. Desde 2022 o horário é unificado. A apuração dura mais no relógio (`--tmax 240`).
- **Estabilidade da ordem 1T → 2T dentro da zona** (Spearman entre a posição de chegada no 1T e no 2T):

  | Ano | Mediana | Média ponderada por seções | Zonas com correlação positiva |
  |---|---:|---:|---:|
  | 2022 | 0,39 | 0,38 | 83% |
  | 2018 | 0,58 | 0,47 | 91% |

- **2014 ficou de fora da curva.** O detalhe por seção de 2014 não tem colunas de horário (termina em `NR_LOCAL_VOTACAO`), e o boletim de urna só traz a data. Serviu só para o teste de persistência do resíduo por zona (abaixo).

### Resultado (MAE 5–95% apurado, pontos de 1%, p.p. de Haddad nos válidos)

| Recorte | a0 (sem curva) | a0.5 (2T-1.2) | v13 (2T-1.3) |
|---|---:|---:|---:|
| nacional | 0,430 | **0,070** | 0,135 |
| g1 (N+NE) | 0,526 | **0,112** | 0,231 |
| g2 (S+SE+CO+exterior) | 0,304 | **0,079** | 0,123 |
| a1 (UFs pares) | **0,175** | 0,196 | 0,332 |
| a2 (UFs ímpares) | 0,640 | 0,211 | **0,168** |

O critério do 2T-1.2 (curva α 0,5 contra nenhuma curva) **passa** em 2018: −79% no nacional, −70% e −84% nos grupos. A curva de chegada se confirma fora da amostra.

O critério do 2T-1.3 (v13 contra a0.5) **não passa**: a v13 erra o dobro da v1.2 no nacional, com classes de 1% melhores/piores 20/65. Nos dois anos, a grade fina de α máximo × rampa (`--grade`) mostra que os ótimos apontam para lados opostos:

| α / rampa | nacional 2022 | nacional 2018 | pior dos dois |
|---|---:|---:|---:|
| 0,5 / 0 (2T-1.2) | 0,126 | **0,070** | 0,126 |
| 0,6 / 0 | 0,097 | 0,079 | 0,097 |
| 0,65 / 0 | 0,086 | 0,108 | 0,108 |
| 0,7 / 0 | 0,078 | 0,141 | 0,141 |
| 0,65 / 0,15 | 0,081 | 0,093 | **0,093** |
| 0,7 / 0,15 | 0,068 | 0,120 | 0,120 |
| 0,7 / 0,3 | 0,087 | 0,112 | 0,112 |
| 0,8 / 0,3 (2T-1.3) | **0,054** | 0,135 | 0,135 |
| 0,85 / 0,25 | 0,043 | 0,176 | 0,176 |

α*(f), o α constante que zeraria o viés da parte apurada por faixa de f = st/s (estimador razão Σw·g / Σw·d na margem L−F):

| f | 0–10% | 10–20% | 20–30% | 30–40% | 40–50% | 50–60% | 60–70% | 70–80% | 80–90% | 90–100% |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2022 | 0,10 | 0,67 | 0,89 | 0,81 | 0,91 | 0,87 | 0,81 | 0,74 | 0,79 | 0,97 |
| 2018 | 0,19 | 0,84 | 0,95 | 0,91 | 0,95 | 0,98 | 0,98 | 0,93 | 0,95 | 0,99 |

### Por que α* alto convive com α alto piorando o nacional

O erro da projeção tem duas partes. A **composição** é o viés das primeiras seções de cada zona, que a curva corrige; ela se mede como variante − pertença exata ("oráculo"). A parte **não composicional** é o erro do próprio oráculo, e vem sobretudo das zonas ainda sem dados, que herdam o desvio das zonas que chegaram antes na UF ou no país.

Nos dois anos a parte não composicional foi **a favor do PT**:
- 2022: +0,20 (5–10% apurado), +0,14 (10–20%), +0,07 (20–30%), +0,02 (30–50%);
- 2018: +0,43 (10–20%), +0,46 (20–30%), +0,33 (30–50%), +0,21 (50–70%), +0,09 (70–95%). São cerca de +0,55 p.p. por unidade de eleitorado restante a noite toda, em boa parte por causa do fuso.

Um α baixo subcorrige a composição (puxa contra o PT) e por isso **cancela** esse viés por acaso. Escolher α pelo erro total premia o cancelamento de cada ano, e é por isso que 2022 pede α alto e 2018 pede α baixo.

Medido só no erro de composição (MAE 5–95%, análise avulsa da revisão metodológica), α alto é o melhor nos dois anos:

| Variante | 2022 | 2018 |
|---|---:|---:|
| α 0,75 constante | 0,040 | 0,076 |
| v13 | 0,075 | 0,154 |
| α 0,5 constante | 0,136 | 0,231 |

### Decisão do 2T-1.4

- **α 0,8 e rampa 0,3 mantidos.** A regra fixada no plano (adotar o ponto da grade com menor pior caso só se ele vencesse o 2T-1.2 nos dois anos) não elege nenhum ponto. Ela também escolheria pelo erro total, que é justamente o critério que premia o cancelamento.
  - O melhor compromisso pelo erro total (0,65/0,15) reduziria o pior caso de 0,135 para 0,093 p.p. Isso é pouco perto das faixas de ±0,3 a ±0,9 e seria outra escolha ajustada aos dois anos.
  - A correção do viés das zonas sem dados (delta por UF × porte do município, que na análise avulsa reduziu o erro do oráculo nos dois anos) fica para depois da eleição. Ela precisa ser testada junto com o α, porque, ligada à v13 sem reescolher o α, piorou o resultado.
- **A faixa e a chance passam a cobrir os dois anos** (abaixo).
- **Aviso na tela:** nos dois ensaios o começo da noite superestimou o candidato do PT.

### Faixa ± combinada (2T-1.4)

Mesma regra do 2T-1.2.1 em cada ano; a constante é o **máximo, classe a classe**, de 2022 e 2018 (`--combinar`). A versão por seção usa máx(curva, pertença): a pertença exata (o "oráculo" do ensaio) não tem o erro de composição, mas tem todo o erro das zonas sem dados, que em 2018 chegou a +0,47 p.p. com 22% apurado.

| Classe a partir de | com a curva: 2022 | 2018 | **2T-1.4** | sem a curva (2T-1.4) | versão por seção (2T-1.4) |
|---:|---:|---:|---:|---:|---:|
| 0% | 4,05 | 11,55 | **11,55** | 11,45 | 11,60 |
| 5% | 2,00 | 5,55 | **5,55** | 5,95 | 6,85 |
| 10% | 0,50 | 1,10 | **1,10** | 2,05 | 1,35 |
| 15% | 0,55 | 0,80 | **0,80** | 2,05 | 1,55 |
| 20% | 0,30 | 0,50 | **0,50** | 1,95 | 1,45 |
| 25% | 0,30 | 0,40 | **0,40** | 2,00 | 1,30 |
| 30% | 0,40 | 0,35 | **0,40** | 2,00 | 1,00 |
| 35% | 0,45 | 0,55 | **0,55** | 1,75 | 0,85 |
| 40% | 0,50 | 0,65 | **0,65** | 1,65 | 0,90 |
| 45% | 0,45 | 0,75 | **0,75** | 1,65 | 0,90 |
| 50% | 0,40 | 0,80 | **0,80** | 1,65 | 0,90 |
| 55% | 0,35 | 0,80 | **0,80** | 1,55 | 0,90 |
| 60% | 0,35 | 0,90 | **0,90** | 1,50 | 0,90 |
| 65% | 0,35 | 0,90 | **0,90** | 1,40 | 0,90 |
| 70% | 0,35 | 0,90 | **0,90** | 1,25 | 0,90 |
| 75% | 0,25 | 0,55 | **0,55** | 1,05 | 0,55 |
| 80% | 0,20 | 0,50 | **0,50** | 0,85 | 0,50 |
| 85% | 0,20 | 0,30 | **0,30** | 0,65 | 0,30 |
| 90% | 0,10 | 0,20 | **0,20** | 0,55 | 0,20 |
| 95% | 0,10 | 0,15 | **0,15** | 0,35 | 0,15 |
| 99% | 0,10 | 0,10 | **0,10** | 0,20 | 0,10 |

De 0% a 5% a faixa de 2018 (±11,5) é dominada pelos primeiros minutos com prior neutro; a tela fica em "Indefinido" e a chance perto de 50% até haver dados.

### Chance de vitória fora da amostra

Com a faixa só de 2022, a chance Φ((L − 50%)/σ), σ = faixa/2, ficou otimista demais em 2018 em N+NE:
- **nacional:** 34% dos pontos com |erro| > σ e nenhum fora da faixa (RMS(erro/σ) 0,85);
- **g1:** 55% com |erro| > σ e 17% fora da faixa (RMS 1,36);
- **g2:** 25% com |erro| > σ e nenhum fora da faixa (RMS 0,77).

Com só duas eleições, o maior erro dos dois anos é superado numa terceira com probabilidade de cerca de 1/3. Por isso, no 2T-1.4:
- a chance usa uma **t de Student com 4 graus de liberdade** (caudas mais grossas), com escala = faixa/2;
- até 95% apurado ela fica **limitada a 5–95%**. Na borda do "Indefinido" (diferença = faixa) a t dá 94%, então a tela não mostra mais "Indefinido" junto com "97%".

### Sinal do 2º turno anterior por zona (swing)

Foi testado como preditor no ensaio 2018 → 2022, com o swing por UF das zonas completas (A), de toda a parte apurada (B) e com o da própria zona (C). Resultado em MAE nacional:

| Variante | Só swing | Motor |
|---|---:|---:|
| A | 0,56 | 0,054 |
| B | 0,42 | 0,054 |
| C | 0,38 | 0,054 |

As misturas pioraram quase sempre. A persistência do resíduo da zona (fatia − previsão da matriz):
- 2018 → 2022: correlação 0,11 no bruto, 0,01 dentro da UF e −0,45 dentro do município (provável rezoneamento);
- 2014 → 2018: 0,38 dentro da UF.

O 1T de 2026 (Lula 45,16%, Flávio 47,03%, demais 7,8%) se parece com 2022. Por isso o 2º turno de 2022 **não entra na projeção**: aparece só no contador "contra 2022".

### Ensaio sintético da tela

Até o 2T-1.3 o ensaio rodava no estado com a curva de 2026 ligada. Mas os dados sintéticos são proporcionais dentro da zona, sem viés de chegada, então a correção da curva virava erro: cerca de +0,4 p.p. para Lula com 15–60% apurado, fora da faixa com 62%. Além disso, st era calculado com o τ global.

No 2T-1.4 o ensaio usa um estado próprio sem curva e st pela fração de cada zona. Com isso o erro fica em −0,06 com 14% apurado e 0,00 a partir de 36%. O estado real fica intacto e volta no fim.

### Como reproduzir (2018)

```sh
python3 -I scripts/t2_build_base.py --modo replay --cands L=13,F=17,CIRO=12,ALCKMIN=45 --dia-turno2 28/10/2018 \
    --votos ~/dl/tse2018/votacao_secao_2018_BR.zip --detalhe ~/dl/tse2018/detalhe_votacao_secao_2018.zip \
    --membro-detalhe detalhe_votacao_secao_2018_BR.csv --out data/t2/dev/replay-2018.json --out-curva data/t2/dev/curva-2018-1t.json
node scripts/t2-replay.js --replay data/t2/dev/replay-2018.json --curva data/t2/dev/curva-2018-1t.json --rotulo 2018 --tmax 240 --alfa-estrela
node scripts/t2-replay.js ... --sensibilidade --grade 0.5/0,0.6/0,0.65/0.15,0.8/0.3   # grade própria α/rampa (0 = α constante)
node scripts/t2-replay.js --combinar data/t2/dev/replay-2022-resultado.json,data/t2/dev/replay-2018-resultado.json   # ENV_* combinadas
```
