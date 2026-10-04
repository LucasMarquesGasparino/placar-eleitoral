# Placar Eleitoral

Aplicativo web instalável para consultar resultados oficiais das eleições por Brasil, país, estado e cidade. A tela **Geral** mostra o quadro nacional e a totalização por estado. A aba **Países** detalha as localidades internacionais por país. A aba **São Paulo · cargos estaduais** apresenta resultados de Governador, Senador, Deputado Federal e Deputado Estadual.

Os registros de candidatos são exibidos em ordem de número de urna. As consultas mostram votos e percentual dos votos válidos; a tela geral também mostra seções totalizadas. O app atualiza automaticamente a cada cinco minutos e tem um botão de atualização manual. O total nacional do TSE inclui o exterior.

## Executar no Termux

```sh
npm start
```

Abra `http://127.0.0.1:4173` no navegador. O app não usa dependências npm externas.

## APK Android

O projeto inclui uma Activity Android que abre o app web empacotado no APK. A tela de São Paulo fixa a eleição de 2026 e consulta apenas os arquivos dessa eleição.

Com o Android SDK instalado, gere o APK de depuração assim:

```sh
cd android
./gradlew assembleDebug
```

O arquivo sai em `android/app/build/outputs/apk/debug/app-debug.apk`. Ele inclui o resumo histórico de 2022 e precisa de conexão à internet para consultar resultados ao vivo do TSE. O APK de depuração é assinado automaticamente para instalação e uso local. No Termux, o Gradle usa automaticamente o AAPT2 ARM64 instalado.

## Dados

- **2022:** resumo por município derivado do arquivo oficial [Votação por seção eleitoral — 2022](https://dadosabertos.tse.jus.br/dataset/resultados-2022). O JSON gerado mantém os votos por candidatura e turno para Presidente; a tela soma os municípios quando a consulta é por estado ou País.
- **2026:** arquivos oficiais JSON da CDN do TSE para totalização consolidada. O código da eleição presidencial é 6257 e o dos cargos estaduais é 6259. A configuração presidencial do TSE fornece as localidades do exterior (`ZZ`); cada país agrupa as localidades associadas a ele. O painel conjunto do exterior usa o arquivo oficial `ZZ` e os detalhes por país somam os arquivos das localidades.
- **Países:** os códigos e nomes das localidades vêm da configuração do TSE; a associação da localidade ao país usa o mapa público referenciado em [Urna-a-Urna](https://urna-a-urna.ovitordelucca.chatgpt.site/). O painel informa votos e percentuais observados nos arquivos históricos/oficiais, sem estimar seções pendentes.
- Fontes e regras técnicas: [Informações técnicas da divulgação de resultados 2026](https://www.tse.jus.br/eleicoes/informacoes-tecnicas-sobre-a-divulgacao-de-resultados) e [Resultados 2022 — Dados Abertos](https://dadosabertos.tse.jus.br/dataset/resultados-2022).

### Regerar o resumo de 2022

Baixe `votacao_secao_2022_BR.zip` do conjunto de dados do TSE e execute:

```sh
python3 scripts/build_2022_city_data.py /caminho/votacao_secao_2022_BR.zip
```

O script produz `data/2022-presidencia-cidades.json`. O arquivo bruto não deve ser incluído no repositório.

## Observações

- Durante a apuração, os arquivos oficiais podem ainda não existir para algumas abrangências; o app mostra esse estado e continua tentando na próxima sincronização.
- O resumo histórico de 2022 não inclui eleitorado nem total de seções. O TSE fornece esses dados na divulgação em tempo real de 2026.
- A listagem segue o número de urna, sem ordenação por votos.
