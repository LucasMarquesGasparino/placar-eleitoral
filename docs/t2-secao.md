# Placar 2T Seção (Plano B)

Segundo app, "Placar 2T Seção", instalado ao lado do Placar 2T (`br.com.lucasgasparino.placar.t2secao`, versão `Secao-1.0`). É o mesmo app do 2T, com um plugin que descobre **quais seções de cada zona já foram apuradas** e entrega ao motor a composição exata dessa parte (`xc`), em vez da curva de chegada estimada do 2T-1.2.

## Por que isso importa

Dentro de cada zona, as seções que chegam primeiro não são representativas da zona. No ensaio com a ordem real de 2022 (ver `docs/t2-backtest.md`), o app comparava o apurado com a composição da zona inteira e errava cerca de −0,5 p.p. contra Lula entre 17:45 e 18:30. O que corrige o viés é saber **quais** seções já contaram; os votos de cada BU não são necessários.

| Método | Erro médio absoluto, 17:30–19:30 (p.p. de Lula nos válidos) |
|---|---|
| 2T-1.1 (zona inteira) | 0,36 |
| Curva de chegada α=0,5 (2T-1.2) | 0,10 |
| Zona + saber quais seções (este app) | 0,05 |
| Motor por seção (referência) | 0,04 |

## Como funciona

1. **Base por seção** (`data/t2/secoes/<uf>.json`, 16,3 MB no total; SP 3,6 MB): o vetor `x` do 1T26 de cada seção, com as mesmas linhas (`rows`) e os mesmos critérios de `base-2026-1t.json`. Gerada por `scripts/t2_build_secoes.py`. A soma das seções de cada zona é igual ao `x` da zona na base, nas 6.251 zonas. O app só baixa a UF de que precisa (carga sob demanda, cache em memória).
2. **Índice `cs`** do TSE, por UF: `…/ele2026/arquivo-urna/3221/config/<uf>/<uf>-p003221-cs.json`. Lista as seções de cada zona; a seção que tem `da`/`ha` (data e hora) foi publicada. Seções agregadas (campo `nsp`) não têm carimbo próprio e não entram em `s.ts` nem nos dados abertos; o parser as ignora. `parseCs` (em `t2-pertenca.js`) devolve, por zona, as seções publicadas.
3. **Coerência.** Para cada zona parcial (0 < `st` < `s`), `xcPorZona` compara o número de seções publicadas no `cs` com o `st` oficial. Só envia `xc` se estiver dentro de ±10% (mínimo de 1 seção), se a lista de seções do `cs` for parecida com a do 1T (diferença de até 10%) e se pelo menos 90% das seções publicadas existirem na base do 1T. Caso contrário a zona fica sem `xc` e o motor usa a curva de chegada do 2T-1.2. Quem já tinha `xc` e deixou de ser coerente recebe `xc: null`.
4. **Plugin** (`t2s-plugin.js`, `window.T2Plugin`): a cada ciclo do poller lê no máximo **um** `cs`, em rodízio, escolhendo a UF com maior eleitorado parcial e leitura mais antiga. SP no máximo a cada 5 min; as demais, no mínimo 90 s entre leituras da mesma UF. Usa a fila `T2FetchQ` do app com prioridade 1, abaixo das zonas (10 a 50). A cada ciclo, sem rede, confere de novo as zonas que têm `xc` contra o `st` oficial mais recente. O `xc` enviado vale no máximo 15 min sem uma leitura nova do `cs`. `state.update(id, {xc})` só é chamado quando o vetor muda.
5. **Texto de status** nos diagnósticos: "seções: 3 UFs ao vivo · 412 zonas · defasagem ~8 min" (a defasagem é a idade do carimbo mais novo do `cs`) ou "seções: TSE ainda sem lista ao vivo (usando curva)".

## Só ganha do 2T-1.2 se o `cs` vier ao vivo

No 1º turno de 2026 os carimbos por seção do `cs` chegaram em lotes, **horas depois** da apuração: AC por volta de 21h (as seções foram recebidas por volta de 19h), SP por volta de 23h, MG, RS e DF só no dia seguinte, às 12:50. A exceção foi o exterior, que entrou ao longo do dia. O TSE anunciou uma rotina nova para o 2T, sem detalhes.

- Se o `cs` repetir o comportamento do 1T, nenhuma zona passará na checagem de coerência (o `cs` fica quase vazio enquanto o `st` oficial cresce) e o app se comporta **exatamente como o 2T-1.2**: curva de chegada, sem `xc`. Não há perda, só custo de rede (um `cs` por ciclo, que falha ou volta sem utilidade e é repetido no máximo a cada 5 min).
- Se o `cs` acompanhar o oficial com defasagem pequena (10 min ou menos), as zonas passam e o app ganha a diferença da tabela acima.
- Defasagem grande, mas constante, não ajuda: o `cs` mostraria o que o oficial já mostrava há muito tempo, e a checagem de ±10% o descarta.
- Limite conhecido: o `cs` de SP tem ~6,3 MB e o `timeoutMs` padrão da fila é 15 s. Em rede lenta a leitura de SP expira; o app tenta de novo depois de 5 min.

## Observador de domingo (B1)

Mede o que o app não pode saber de antemão: o `cs` acompanha a apuração ao vivo? Roda no Termux, separado do app, com a fila `T2FetchQ` a 2 req/s (cerca de 20 requisições por rodada com 5 UFs).

Antes das 17:00, no Termux:

```sh
termux-wake-lock
cd ~/projects/placar-eleitoral
nohup node scripts/t2-observador.js > data/t2/dev/observador-2t.log 2>&1 &
tail -f data/t2/dev/observador-2t.log
```

Ele espera a janela (17:00 às 21:00, horário de Brasília) e para sozinho às 21:00. Padrões: pleito 3221 (2T), UFs AC, RR, AP, SE e DF, rodada a cada 5 min, até 10 `aux` por rodada no total. Para encerrar antes: `pkill -f t2-observador` (ele termina a rodada atual). Depois: `termux-wake-unlock`.

Opções úteis: `--uf ac,rr,ap,se,df`, `--intervalo 300`, `--janela 17:00-21:00`, `--aux 10`, `--sem-aux`, `--agora` (ignora a janela), `--uma-vez`, `--help`.

Ensaio antes de domingo, com o 1T (4 requisições, UF pequena):

```sh
node scripts/t2-observador.js --pleito 3220 --uf ac --agora --uma-vez --aux 2
```

Cada rodada imprime uma linha por UF, por exemplo:

```
18:35:02 | AC | cs 812/2270 | oficial 790/2270 | razão 1,028 | último carimbo 18:34:40 (há 0.4 min) | cs = oficial de 5 min atrás | publicação-recebimento 1.8 min (n=2) | +45 novas
```

- `razão` = seções publicadas no `cs` ÷ `s.st` oficial. Perto de 1 e estável: o `cs` acompanha. Perto de 0: o `cs` está vazio ou em lote.
- `cs = oficial de N min atrás`: há quantos minutos o `st` oficial alcançou a contagem atual do `cs`. Vazio quando o `cs` está adiantado.
- `publicação-recebimento`: média de (carimbo do `cs` − hora de recebimento do BU, `hashes[].hr` do `aux`) nas seções amostradas.
- O `aux` só é pedido para seções que o `cs` já marca como publicadas; três 404 de `aux` suspendem a amostragem na rodada. Se o TSE bloquear (403/429), a fila pausa e a rodada é pulada.

O registro completo fica em `data/t2/dev/observador-2t.jsonl` (uma linha JSON por UF por rodada; a pasta `dev/` não vai para o Git). Resumo rápido:

```sh
node -e 'for (const l of require("fs").readFileSync("data/t2/dev/observador-2t.jsonl","utf8").trim().split("\n")) { const r = JSON.parse(l); if (r.cs) console.log(r.hora, r.uf, r.cs.publicadas, r.oficial && r.oficial.st, r.razao, r.defasagemContagemMin) }'
```

**Decisão** (às 18:30, e de novo no fim): com `razão` entre 0,9 e 1,1 e `defasagemContagemMin` de 10 ou menos na maior parte das rodadas, o `cs` serve para o modo pertença. Com `razão` perto de 0 ou defasagem de horas, vale só o 2T-1.2.

## Arquivos

| Arquivo | Papel |
|---|---|
| `t2-pertenca.js` | Puro: `parseCs`, `xcPorZona`, `parseCarimbo`. |
| `t2s-plugin.js` | `window.T2Plugin` (`init`, `tick`, `status`). |
| `t2s.html` | Cópia de `t2.html` com `t2-pertenca.js` e `t2s-plugin.js` antes de `t2.js`. Gerado por `sh scripts/t2s-sync.sh`; não edite à mão. |
| `manifest-t2s.webmanifest` | Manifest da versão Seção. |
| `data/t2/secoes/<uf>.json` | Base por seção: `{v:1, uf, rows, zonas:{"UF\|mmmmm\|zzzz":{"0077":[x…]}}}`. |
| `scripts/t2_build_secoes.py` | Gera a base por seção e confere contra `base-2026-1t.json`. |
| `scripts/t2-observador.js` | Medidor de domingo. |
| `scripts/t2s-sync.sh` | Regenera `t2s.html` e confere o Android. |
| `android-t2s/` | Projeto Android do app Seção; `sh android-t2s/build-t2s.sh` gera `android-t2s/build/placar-2t-secao.apk`. |

Regenerar a base por seção (zips são dados não confiáveis: sempre `python3 -I`, caminhos como argumento; leva menos de 1 min):

```sh
python3 -I scripts/t2_build_secoes.py --votos ~/dl/votacao_secao_2026_BR.zip --detalhe ~/dl/detalhe_votacao_secao_2026.zip
python3 -I scripts/t2_build_secoes.py --selftest
```

A verificação é feita a cada geração: soma das seções por zona contra o `x` da base, com tolerância de 0,01% do eleitorado total na soma de |diferença|. Na base real a diferença é zero. A diferença só pode aparecer nas linhas N e A, quando alguma seção tem comparecimento menor que válidos mais brancos (o zero-clamp por seção difere do por zona).

Testes: `node --test test/t2-observador.test.js test/t2-pertenca.test.js test/t2s-plugin.test.js test/t2-secoes.test.js`. Nenhum faz requisição ao TSE.

## B4: roteiro depois da eleição

1. Quando o TSE publicar `votacao_secao_2026` e `detalhe_votacao_secao_2026` do 2T nos Dados Abertos, baixar e conferir o cabeçalho com `t2_build_base.py --probe`.
2. Rodar `scripts/t2-replay.js` sobre 2026, com o horário real de chegada de cada seção (`DT_PRIM_TOT_PARCIAL_HOR_TSE`): 2T-1.1 (α=0), 2T-1.2 (α=0,5) e pertença (xc exato). Comparar o erro médio absoluto de 17:30 a 19:30 com a tabela acima.
3. Cruzar com o registro da tela do app (série hora, % apurado, projeção, faixa) e com o `observador-2t.jsonl`: em que horário o `cs` teria permitido pertença e qual foi a cobertura (zonas com `xc` ÷ zonas parciais) em cada UF.
4. Recalibrar α e o envelope da faixa (A3) com a ordem real do 2T de 2026.
5. Reajustar `lambda0` e `kappa*`, se for o caso, com validação cruzada por grupos de UF.
6. Decidir para 2028 e 2030: se o `cs` vier ao vivo com defasagem de 10 min ou menos, manter o modo pertença como padrão; senão, ficar com a curva de chegada.
7. B3 (decodificador de BU, só para auditoria) segue fora do escopo.
