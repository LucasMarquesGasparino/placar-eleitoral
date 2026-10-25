# Prévia do exterior (ZZ) antes da totalização do TSE

Desde o 2T-1.6 (`t2-ext.js`), o Placar 2T mostra os votos do exterior antes de o TSE totalizá-los. Os votos vêm dos boletins de urna (BU) que os postos no exterior transmitem durante a madrugada. Ao mesmo tempo, esses boletins entram na projeção, cidade a cidade.

## Fontes

| Fonte | O que é | Como o app lê |
|---|---|---|
| **Boletins do TSE** (`arquivo-urna/3221`) | Boletim de cada seção, publicado pelo TSE assim que é recebido. É oficial, mas ainda não totalizado. Traz Lula, Flávio, brancos, nulos, aptos e comparecimento. | Direto do WebView, porque o CORS do TSE aceita o app. Usa uma fila `T2FetchQ` própria, com no máximo 1 pedido a cada 1,5 s. |
| **Jornal Razão** (`jornalrazao.com/eleicoes/d2/v.json` e `ext.json`) | Soma dos mesmos boletins por país e cidade. Brancos, nulos e aptos vêm só por país. | Pelo proxy fixo do APK: `/jr/v.json` e `/jr/ext.json?v=N`. |
| **ascaribe** (`dados.ascaribe.tech/real/exterior.json`) | Soma por cidade, identificada pelo código TSE. Só traz Lula e Flávio (válidos). | Pelo proxy fixo do APK: `/asc/exterior.json`. |

O proxy roda no `shouldInterceptRequest` dos dois `MainActivity.java`, fora da thread da tela. O `fetch` do JavaScript é assíncrono, então nada trava. O proxy só atende esses três endereços: nenhum host ou caminho vem do JavaScript. Também valem:
- tempo limite de 5 + 5 s;
- resposta de até 2 MB;
- `User-Agent` com a versão do app.

A ponte síncrona `PlacarJornalRazao` das versões 1.5.x foi retirada: ela travava a tela por até 10 s.

**No navegador** (fora do APK), JR e ascaribe não liberam CORS, por isso a prévia fica desligada e a tela avisa.

## Regras

**Por cidade:**
- Vale a fonte com mais urnas. No empate, a ordem é boletins > JR > ascaribe.
- O país vem do mapa do TSE (`data/exterior-country-map.json`, pelo código do município), nunca do nome que cada fonte usa. O campo `pais` do ascaribe tem erros.

**Jornal Razão:**
- Brancos + nulos da cidade = comparecimento − Lula − Flávio, o que é exato.
- Uma cidade cujos boletins já foram lidos com as mesmas urnas e votos usa os números exatos dos boletins.
- O resto do país (abstenção, brancos e nulos) é rateado entre as outras cidades. A abstenção é rateada pelo eleitorado esperado das urnas recebidas.
- Se sobrar uma só cidade, ela também fica exata. Senão, fica marcada como estimada.
- Cidade sem correspondência sai sozinha e o resto do país continua (no 1.5.x saía o país inteiro).
- Uma correção para baixo no feed é aplicada normalmente.

**ascaribe:**
- Brancos, nulos e abstenção são estimados com as proporções das fontes exatas.
- A cidade fica sempre marcada como estimada.

**Boletins:**
- Só são procurados nas cidades em que JR ou ascaribe já contam mais urnas que os boletins lidos. São até "faltando + 2" seções por cidade e no máximo 30 seções por ciclo. Com o ciclo de 10 s, quem limita é a fila: 1 pedido a cada 1,5 s (40 por minuto), qualquer que seja o ritmo da sincronização.
- O TSE bloqueia quem gera muitos 404, por isso não há varredura às cegas.
- Cada boletim é lido uma vez e guardado no aparelho (`localStorage`, chave `t2.zzbu.3221`).
- O decodificador DER confere:
  - a seção pedida;
  - a eleição 6258;
  - o cargo de presidente;
  - que só há os candidatos 13 e 22;
  - L + F + brancos + nulos = comparecimento ≤ aptos;
  - o tamanho máximo de 64 KB.
- Ao receber 403 ou 429, a leitura de boletins para por 15 min.
- **Às 16:45 (Brasília), a leitura de boletins para de vez**, para nunca disputar o TSE com o placar das 17h. JR e ascaribe continuam.

**Grupo externo** (`T2State.setExternalGroups`):
- Cada cidade vira um grupo, com:
  - `y = [L, F, B, N, aptos − comparecimento]`, só das urnas recebidas;
  - `E` = eleitorado da zona na base;
  - `s` = o maior entre as seções da base e as urnas do `cs`;
  - `st` = urnas recebidas.
- O grupo substitui a(s) zona(s) ZZ da cidade.
- Uma cidade fora da base do 1º turno vira grupo sem zona, com a composição média do exterior.
- Grupos recusados aparecem no Diagnóstico com o motivo.
- O grupo não é salvo no estado.

**Troca para o TSE:**
- É automática e por cidade. O grupo sai assim que as zonas da cidade com dado oficial somam pelo menos as urnas do grupo, ou quando todas estão completas no TSE.
- Enquanto o TSE tem menos urnas que a prévia, a prévia vale, porque é um superconjunto dos mesmos boletins. Os votos oficiais escondidos aparecem no diagnóstico "Oficial × soma das zonas".

## Sincronização

- **Ritmo:** uma cadeia de `setTimeout` de 10 s, que nunca se sobrepõe. Um "Atualizar" no meio de um ciclo agenda o próximo para logo depois dele.
- **Fontes:** rodam em paralelo, cada uma com 15 s e `AbortController`. Uma fonte com erro não segura as outras, e a tela se atualiza à medida que cada uma chega.
- **Pausas:** pausa com o app em segundo plano e durante o ensaio. Ao voltar, sincroniza na hora se passou de 10 s.

## Na tela

**Antes do primeiro arquivo nacional do TSE com seções**, o painel oficial vira "PRÉVIA DO EXTERIOR · BOLETINS DE URNA" e mostra:
- urnas e cidades;
- Lula × Flávio;
- brancos, nulos e abstenção das urnas recebidas;
- urnas por fonte;
- a lista por país (completo ou parcial, fontes, estimativa);
- a linha "Exterior sincronizado às HH:MM:SS · próxima em N s";
- os links das fontes.

**Depois**, o painel volta a ser "APURAÇÃO OFICIAL · TSE", com "+ N urnas do exterior ainda fora do TSE".

## Código da eleição

O app Base deixou de mostrar a prévia nas 1.5.x porque tinha um código de eleição ≠ 6258 gravado pelo Diagnóstico, e a fonte desligava sem aviso.

Desde o 1.6.0:
- um código salvo diferente de 6258 volta para 6258 e o app avisa uma vez. Só o ensaio de rede (`?t2start=0`) mantém o código;
- antes das 17h de 25/10, um estado salvo é descartado, porque nada legítimo do 2º turno pode existir antes disso.
