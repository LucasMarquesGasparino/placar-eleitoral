# Esquema observado nos arquivos do TSE

Sondagem feita em 13/10/2026 com `eleição 6257` (1º turno), usando `t2-probe.js` e `T2FetchQ`. As amostras completas ficam em `docs/t2-amostras/` (ignoradas pelo Git). Todas as URLs sondadas responderam HTTP 200.

## Configuração de eleições (`ele-c.json`)

| Conceito | Caminho | Valor observado |
|---|---|---|
| Pleito do 1º turno | `pl[].cd` | `3220` |
| Eleição presidencial do 1º turno | `pl[].e[].cd`, `pl[].e[].t` | `6257`, turno `1` |
| Pleito do 2º turno | `pl[].cd` | `3221` |
| Eleição presidencial do 2º turno | `pl[].e[].cd`, `pl[].e[].t` | `6258`, turno `2` |
| Eleição estadual do 2º turno | `pl[].e[].cd`, `pl[].e[].t` | `6260`, turno `2` |

## Configuração de municípios (`mun-e006257-cm.json`)

Lista em `abr[]`; cada UF tem `cd` e municípios em `mu[]`; cada município tem `cd`, `nm` e zonas em `z[]`. Exemplo: Rio Branco/AC, código `01392`, zonas `0009` e `0001`.

## Resultado unificado EA20 (`-u.json`)

Estrutura encontrada em Brasil, UF, município e zona. O `tpabr` diferencia `br`, `uf`, `mu` e `zona`.

| Conceito | Caminho | Valor de exemplo (Brasil, 1T) |
|---|---|---:|
| Comparecimento | `e.c` | 125.275.835 |
| Abstenção | `e.a` | 33.469.244 |
| Eleitorado total | `e.te` | 158.745.502 |
| Eleitorado das seções instaladas | `e.esi` | 158.745.079 |
| Seções totais | `s.ts` | 499.248 |
| Seções apuradas | `s.st` | 499.248 |
| Votos brancos | `v.vb` | 2.300.798 |
| Votos válidos | `v.vvc` (também `v.vv`) | 119.300.788 |
| Nulos ordinários | `v.vn` | 3.669.003 |
| Nulos técnicos | `v.vnt` | 5.246 |
| Nulos totais | `v.tvn` | 3.674.249 |
| Lista de grupos/candidaturas | `carg[0].agr[*].par[*].cand[*]` | 12 candidaturas válidas no Brasil |
| Número de urna | `cand.n` | `13` (Lula), `22` (Flávio) |
| Votos nominais válidos | `cand.vap` | 53.879.538 (Lula), 56.104.503 (Flávio) |

Os candidatos ficam dentro de `agr[].par[].cand[]`; `agr[].cand[]` não existe neste arquivo. O campo `carg[0].agr` contém 12 grupos no Brasil. O parser precisa percorrer todos os grupos e partidos.

O CSV presidencial contém 5.246 votos sob `NR_VOTAVEL=28` (Leonardo Alves de Araújo), mas esse número não aparece na lista `cand[]` válida do EA20. A diferença coincide com `v.vnt`. Na base, o código 28 deve sair de `D` e entrar em `N`; assim `N = comparecimento − válidos − brancos = 3.674.249`.

No Brasil, a base de aptos do CSV difere em 72 eleitores do `e.esi` do EA20 (diferença relativa menor que 0,01%). O total nacional do plano continua dentro da tolerância definida. O crosscheck de 20 unidades retornou `20 ok, 0 com problema`, cobrindo municípios de zona única e municípios com múltiplas zonas.

## Acompanhamento EA15 (`-ab.json` de UF)

| Conceito | Caminho | Valor de exemplo (AC) |
|---|---|---:|
| Lista de municípios | `abr[]` | 23 municípios |
| Código do município | `abr[].cdabr` | `01007` |
| Seções totais | `abr[].s.ts` | 41 |
| Seções apuradas | `abr[].s.st` | 41 |

O valor de `cdabr` tem cinco dígitos. A configuração municipal (`mun-e...-cm.json`) confirma os códigos e a lista de zonas.

## Tipos de abrangência e CORS

Resultado de município `ac01120-c0001-e006257-u.json`: `tpabr="mu"`; resultado de zona `ac01392-z0001-c0001-e006257-u.json`: `tpabr="zona"`. Ambos responderam 200.

As respostas de produção refletiram o `Origin` de teste `http://127.0.0.1:4173` em `Access-Control-Allow-Origin`. O probe inclui `Origin` para observar essa resposta, e seu único pedido passa pela fila `T2FetchQ`.
