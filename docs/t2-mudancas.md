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

## 24/10/2026 — 2T-1.2 (curva de chegada, poller sem o arquivo nacional, faixa calibrada)

- **Ensaio com a ordem real (A0).** `scripts/t2_build_base.py` ganhou leitor por seção e os modos `--modo curva` (gera `data/t2/curva-2026-1t.json`, 2,2 MB, 6.251 zonas = 100% da base, soma das seções por zona idêntica à base) e `--modo replay2022` (gera `data/t2/dev/replay-2022.json` e `curva-2022-1t.json`). `--membro-detalhe` com nome terminado em `.csv` escolhe o CSV do zip pelo nome exato. `scripts/t2-replay.js` reproduz o 2T22 com a ordem real de chegada pelo `T2State` real (prior neutro). O backtest sintético antigo era otimista; a tabela realista está em `docs/t2-backtest.md`.
- **Curva de chegada (A1).** As seções que chegam primeiro não têm a composição da zona inteira (viés de cerca de −0,5 p.p. contra Lula entre 17:45 e 18:30 em 2022). `t2-engine.js`: cada unidade aceita `xc`/`xr` opcionais (composição do 1T da parte apurada e do restante); sem eles o comportamento é idêntico ao 2T-1.1. `t2-state.js`: `create({..., curve})`, `opts.arrivalAlpha` (padrão **0,5**; 0 desliga), interpolação linear do desvio em k = (st/s)·n, diagnóstico `arrivalApplied`. Critério do plano atendido (MAE 17:30–19:30 cai 70% no nacional, 56% e 81% nos dois grupos de UF; nenhum ponto piora mais de 0,1 p.p.). A curva é opcional: se faltar ou for inválida, a tela segue como no 2T-1.1 e avisa nos diagnósticos.
- **Contrato com plugins (modo "pertença").** `T2State.update(id, {..., xc})` aceita o `xc` exato (K números >= 0, votos do 1T das seções já apuradas); tem prioridade sobre a curva, é normalizado para somar `ec` e `xr = max(0, x_zona − xc)`; `xc: null` remove; vai em `exportState`/`importState`; diagnóstico `membershipApplied`. Update só com `xc` não altera `lastUpdateTs`. `t2.js` chama `window.T2Plugin.init({state, fetchq, urls, cfg})`, `await T2Plugin.tick()` a cada ciclo (isolado, limite de 8 s, sem acumular) e mostra `T2Plugin.status()` nos diagnósticos. Sem plugin nada muda.
- **Poller sem ponto único de falha (A2).** Depois das 17:00 o BR e o EA15 saem em paralelo; falha do BR (rede, 5xx, timeout ou 404 depois de iniciado) só incrementa `brFailures`, marca `officialStale` e o ciclo segue com EA15 e zonas. Antes de haver dados só uma UF sentinela (a maior) é consultada no EA15, para não abrir o disjuntor de 404. O canário roda na primeira resposta válida do BR ou do EA15 com apuração. `consecutiveFailures`/backoff só contam ciclos em que nada respondeu. BR sem mudar por mais de 5 min enquanto as zonas avançam => `officialFrozen`; a tela mostra "Arquivo nacional do TSE parado desde HH:MM" e esconde o aviso de defasagem. Novo estado de conexão `partial` ("AO VIVO (sem arquivo nacional)", nível aviso). Sem o BR, a fase `final` vem de todas as zonas completas. A2b (soma das 27 UFs) **não** foi feita.
- **Faixa calibrada (A3).** `compute()` devolve `uncertainty {pp, lo, hi}` a partir do envelope do ensaio (constantes `ENV_CURVA`/`ENV_SEM_CURVA` em `t2-state.js`). A tela mostra "Lula X% ± Y p.p." e, quando 50% cai dentro de [lo, hi], o destaque vira "Indefinido: diferença menor que o erro típico". A "faixa entre métodos" foi para os diagnósticos.
- **APK.** `android-t2/app/build.gradle` inclui a curva; versionCode 3, versionName 2T-1.2 (APK não gerado aqui).
- **Testes.** `t2-engine` (xc/xr), `t2-state` (curva, xc, faixa), `t2-tse` (BR em 503, BR congelado, backoff, 3 testes ajustados), `t2-ui-smoke` (± p.p., Indefinido, plugin, estado parcial). Selftest do Python cobre os dois modos novos. Parâmetros do motor (`lambda0`, `kappa*`, limites) não mudaram.

## 24/10/2026 — 2T-1.2.1 (faixa a cada 1% apurado)

- **Faixa calibrada com 100 classes.** O "± p.p." usava 8 classes e a regra de só diminuir, e por isso ficava em ±0,75 de 5% a 60% apurado. Agora há uma classe a cada 1%, cada uma com o erro observado perto daquele ponto (janela de ±3 pontos), sem monotonia. Com a curva: ±4,05 até 4%, ±0,65 em 10%, ±0,30 em 20%, ±0,80 em 40%, ±0,70 em 65%, ±0,40 em 80%, ±0,25 em 90% e ±0,10 em 99%.
- **Ensaio.** `scripts/t2-replay.js` acrescenta um ponto a cada 1% apurado (nacional, g1 e g2; só α=0 e o α alvo) e imprime as duas constantes prontas para `t2-state.js`. `--sem-fino` desliga esses pontos. Tabelas, MAE e o critério do α não mudaram (nacional 0,341 → 0,102).
- **Estado e tela.** `compute().uncertainty` ganhou `classe {de, ate}`; os diagnósticos mostram "Faixa calibrada: ±Y p.p. na classe N–N+1% apurado". `envelopeIndex()` exportado. Motor, curva e α não mudaram.
- **APKs.** 2T-1.2.1 (versionCode 4) e Seção-1.0.1 (versionCode 2), que usa o mesmo `t2-state.js`.

## 24/10/2026 — 2T-1.3 (α da curva em rampa por zona)

- **Diagnóstico.** No ensaio com a ordem real de 2022, o α que zera o viés de chegada depende da fração apurada da zona (f = st/s): ≈ 0,26 com f < 10% e 0,7–0,8 a partir de 10%. Com α=0,5 fixo, o 2T-1.2 ficava −0,2 a −0,35 p.p. contra Lula entre 25% e 70% apurado. Detalhes, modelos rejeitados (α fixo 0,75 e 1, α calibrado ao vivo, peso menor para zonas parciais, outros `kappa*`) e o platô de sensibilidade em `docs/t2-backtest.md`, seção "Modelos testados para o 2T-1.3".
- **Motor de estado (`t2-state.js`).** `ARRIVAL_ALPHA_DEFAULT` 0,5 → **0,8**; nova `ARRIVAL_RAMP_DEFAULT = 0,3` e `opts.arrivalRamp`. Em cada zona com curva, α_ef = α·min(1, f/rampa); `arrivalRamp: 0` volta ao α constante (`{arrivalAlpha: 0.5, arrivalRamp: 0}` reproduz o 2T-1.2). A pertença exata (`xc`) não muda. Diagnóstico `arrivalRamp`. `ENV_CURVA` regerada com a variante nova; `ENV_SEM_CURVA` regerada com os mesmos pontos (só a classe de 4% mudou, 3,55 → 3,60).
- **Resultado (MAE 5–95% apurado, pontos de 1%).** Nacional 0,126 → 0,054; N+NE 0,238 → 0,129; S+SE+CO+exterior 0,076 → 0,043; partições alfabéticas 0,106 → 0,026 e 0,152 → 0,086. Classes de 1% melhores/piores: 83/6, 79/9, 61/25, 81/4, 80/2. As que pioram ficam entre 10% e 20% apurado, por 0,02–0,04 p.p. Critério do plano atendido.
- **Faixa.** Com a curva: ±0,50 em 10%, ±0,30 em 20–25%, ±0,50 em 40%, ±0,35 em 60–70%, ±0,20 em 80%, ±0,10 a partir de 90%.
- **Limitação.** Entre 5% e 20% apurado sobra um viés de +0,1 a +0,2 p.p. que vem das zonas ainda sem dados; até a pertença exata erra ≈ 0,13 ali. Sem correção robusta por enquanto.
- **Ensaio (`scripts/t2-replay.js`).** Variantes `a0`, `a0.5` (2T-1.2), `v13` e pertença; pontos de 1% em cinco recortes (nacional, g1, g2, a1, a2); MAE por faixa de apurado; critério do 2T-1.3; `--sensibilidade` (grade α máx × rampa), `--alvo` e `--rampa`.
- **Tela.** Diagnóstico "α=0.8 (rampa até 30% da zona)".
- **APKs.** 2T-1.3 (versionCode 5) e Seção-1.0.2 (versionCode 3), que usa o mesmo `t2-state.js` nas zonas sem pertença.

## 25/10/2026 — 2T-1.4 (ensaio fora da amostra com 2018, faixa de dois anos, chance, contador vs 2022)

- **Ensaio de 2018.** `scripts/t2_build_base.py --modo replay --cands ...` generaliza o `replay2022` (que segue como apelido; com os padrões, regera os arquivos de 2022 iguais) e grava o Spearman da ordem 1T → 2T dentro da zona (`ordem_1t_2t`). `scripts/t2-replay.js` ganhou `--rotulo`, `--alfa-estrela` (α*(f)), `--mae-janela`, `--grade` (grade própria α/rampa) e `--combinar`, e a pertença exata ("oráculo") passa a rodar em todos os pontos de 1% para gerar a faixa da versão por seção. 2014 ficou de fora: não tem horário de chegada.
- **Resultado.** A curva (2T-1.2) se confirma fora da amostra: −79% no erro nacional. Já a rampa do 2T-1.3 **não passa** em 2018 (0,135 contra 0,070 da v1.2). A revisão metodológica mostrou o motivo: o viés das zonas ainda sem dados foi a favor do PT nos dois anos, e um α baixo o cancela por acaso; medido só no erro de composição, α alto é melhor nos dois anos. **α 0,8 e rampa 0,3 mantidos.** Nenhum ponto da grade fina vence a v1.2 nos dois anos, e o melhor compromisso ganharia só centésimos. Detalhes em `docs/t2-backtest.md`, "Ensaio fora da amostra: 2018".
- **Faixa ±.** `ENV_CURVA` e `ENV_SEM_CURVA` = máximo de 2022 e 2018, classe a classe: com a curva, ±1,10 em 10%, ±0,50 em 20%, ±0,80 em 50%, ±0,90 em 60–70%, ±0,50 em 80%, ±0,20 em 90%. Nova `ENV_PERTENCA` (versão por seção): com pertença exata em alguma zona, a faixa é máx(curva, pertença), por exemplo ±1,45 em 20% e ±0,90 em 50%.
- **Chance de vitória.** t de Student com 4 g.l. (escala = faixa/2) no lugar da normal; limitada a 5–95% até 95% apurado. Na borda do "Indefinido" a chance fica em 94%, sem contradição com a manchete. Na faixa só de 2022, o teste em 2018 deu 17% dos pontos de N+NE fora da faixa.
- **Contador "contra 2022"** (`compute().vs2022`): vantagem que Lula teria repetindo a fatia de 2022 de cada zona com os votos de hoje, margem já perdida no apurado, projeção ao fim ± erro, quanto Lula precisa no que falta e a chance de a sobra chegar a zero. O 2º turno de 2022 **não entra na projeção**: no ensaio 2018 → 2022 o swing por zona errou 0,38–0,56 p.p. contra 0,054 do motor, e as misturas pioraram.
- **Dois ensaios sintéticos na tela.** "1º turno de 2026" (como antes) e "entre 2022 e 2026" (verdade = metade do caminho até a fatia de 2022 de cada zona; `T2Sim.fakeSecondRound(..., { pull: { ref, lambda } })`). **Correção:** o ensaio rodava com a curva de 2026 ligada sobre dados sem viés de chegada (erro de cerca de +0,4 p.p.) e usava o τ global para st. Agora ele usa um estado próprio sem curva e st por zona, com erro de no máximo 0,06 depois de 14% apurado. O estado real fica intacto.
- **Textos.** A faixa é descrita como "2× o maior erro nos ensaios com a ordem real de 2018 e 2022". Aviso: nos dois ensaios o começo da noite superestimou o candidato do PT.
- **Testes.** Chance t4 e teto, faixa da versão por seção, contador, puxão do ensaio, estado próprio do ensaio. Selftest do Python com replay de 4 candidatos.
- **APKs.** 2T-1.4 (versionCode 6) e Seção-1.0.3 (versionCode 4).
- **Fica para depois da eleição.** Escolher α pelo erro de composição; modelar as zonas sem dados com variáveis (UF × porte, capital/interior), testado junto com o α; faixa que dependa do que falta apurar; validar em ~25 segundos turnos de governador de 2018 e 2022; repetir o ensaio com o 2T de 2026.


## 25/10/2026 — 2T-1.4.1: contador "contra 2022" em painel próprio

- O contador "contra 2022" (já calculado em `t2-state.js`, `out.vs2022`) saiu do parágrafo cinza em "Zonas lidas pelo app" para um painel próprio, logo abaixo da projeção, visível desde antes da apuração. Mostra:
  - a vantagem que Lula teria repetindo a fatia de 2022 de cada zona com os votos válidos de hoje;
  - três números: margem perdida (−) ou ganha (+) em relação a 2022 no já apurado, a mesma conta projetada ao fim (± o erro da faixa calibrada, em votos) e a sobra;
  - um medidor da parte da vantagem de 2022 consumida pela projeção, com a faixa de erro e a marca de "sobra zero";
  - a chance de a sobra chegar a zero (a mesma chance de Flávio vencer da faixa), o "no que falta" e a fatia no já apurado contra 2022;
  - a evolução da sobra ± erro pelo % apurado (SVG gerado pelo app). O histórico é salvo no aparelho por código de eleição (`t2-vs22-hist`), limpo ao trocar de eleição; o ensaio usa um histórico próprio, só em memória.
- Só apresentação: projeção, faixa e chance não mudaram.
- Correção: ao entrar ou sair do ensaio, o cache de `recompute()` (que compara só o número de versão do estado) é zerado. Desde o 2T-1.4 o ensaio usa um estado próprio, e as versões dos dois estados podiam coincidir, deixando na tela a saída do outro estado.
- Versões: `2T-1.4.1` (versionCode 7) e `Secao-1.0.4` (versionCode 5).

## 25/10/2026 — 2T-1.4.2: painel "contra 2022" simplificado

- O painel passa a ter cinco campos:
  1. a vantagem de Lula no 2º turno de 2022 nas mesmas zonas (fixa);
  2. os votos de margem que ele perdeu, somados nas zonas em que ficou abaixo de 2022;
  3. os votos de margem que ele ganhou, somados nas zonas em que ficou acima;
  4. a vantagem que resta (2022 − perdeu + ganhou) e quanto ela representa da vantagem de 2022;
  5. a chance de ela chegar a zero, que é a chance de Lula perder da projeção.
- Abaixo dos cartões, a vantagem consumida aparece comparada ao % apurado. Se a perda fosse uniforme, Lula termina na frente enquanto a vantagem consumida for menor que o apurado.
- Conta por zona (`out.vs2022.zonas`, em `t2-state.js`): a margem apurada da zona é comparada com a margem de 2022 multiplicada pela fração do eleitorado da zona já apurada. Com tudo apurado, "resta" é a margem de 2026 nessas zonas (há teste).
- Saíram o gráfico, o medidor e o histórico do 2T-1.4.1. Versões `2T-1.4.2` (versionCode 8) e `Secao-1.0.5` (versionCode 6).
