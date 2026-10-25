#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""t2_build_base.py — Gera os dados-base do 2º turno a partir dos CSVs de dados abertos do TSE
(Votação por seção + Detalhe da votação por seção), SOMENTE cargo Presidente (CD_CARGO = 1).

Só biblioteca padrão. Lê .csv ou .zip (CSV ';' em latin-1) em streaming (não carrega tudo na memória).

MODOS
  --modo base2026   gera data/t2/base-2026-1t.json     (linhas: L,F,CURY,SANTOS,CAIADO,ZEMA,D,B,N,A) a partir do 1º turno
  --modo backtest   gera data/t2/dev/backtest-2022.json (linhas: L,F,D,B,N,A; x = 1T, yFull = 2T) a partir de 2022 (1º e 2º turnos)
  --modo curva      gera data/t2/curva-2026-1t.json (2T-1.2): POR SEÇÃO, a ordem de chegada dos resultados no 1º turno de 2026.
                    Para cada zona grava o desvio (composição das primeiras k seções apuradas − composição da zona) em 9 pontos.
  --modo replay     gera data/t2/dev/replay-2022.json (por seção: zona, x do 1T22, y do 2T22, hora de chegada no 2T22) e
                    data/t2/dev/curva-2022-1t.json (mesmo formato da curva de 2026, ordem do 1T22). Entrada do scripts/t2-replay.js.
                    Outros anos com --cands (L e F primeiro) e --dia-turno2 (2T-1.4; ex. 2018 abaixo). replay2022 = apelido.
                    Imprime e grava a estabilidade da ordem de chegada 1T x 2T dentro da zona (Spearman, 'ordem_1t_2t').
  --probe ARQ       imprime o cabeçalho e 3 linhas de um CSV/ZIP (use ANTES, para conferir os nomes das colunas)
  --selftest        cria CSVs sintéticos, roda os modos e confere os totais (teste de que o script funciona)

EXEMPLOS
  python3 scripts/t2_build_base.py --probe ~/dl/votacao_secao_2026_BR.zip
  # --votos e --detalhe aceitam VÁRIOS arquivos (ex.: um zip por UF). --membro-votos / --membro-detalhe escolhem o CSV dentro do zip
  # pelo INÍCIO do nome (ex.: votacao_secao_  e  detalhe_votacao_secao_).
  python3 scripts/t2_build_base.py --modo base2026 --votos votacao_secao_2026_BR.zip --detalhe detalhe_votacao_secao_2026_BR.zip \
      --cands L=13,F=22,CURY=70,SANTOS=14,CAIADO=55,ZEMA=30 --invalidos 28 \
      --esperado L=53879538,F=56104503,CURY=3448569,SANTOS=2675887,CAIADO=2605148,ZEMA=326488,B=2300798,N=3674249,A=33469244 \
      --out data/t2/base-2026-1t.json
  python3 scripts/t2_build_base.py --modo backtest --votos votacao_secao_2022_BR.zip --detalhe detalhe_votacao_secao_2022_BR.zip \
      --out data/t2/dev/backtest-2022.json
  # 2T-1.2 — curva de chegada de 2026 (ordem real das seções no 1T26) e ensaio com a ordem real de 2022.
  # No zip de detalhe de 2026 há dois CSVs (…_BRASIL.csv, com todos os cargos, e …_BR.csv, só Presidente): --membro-detalhe com o nome
  # terminado em .csv escolhe pelo nome EXATO; sem .csv vale o início do nome.
  python3 -I scripts/t2_build_base.py --modo curva --votos ~/dl/votacao_secao_2026_BR.zip --detalhe ~/dl/detalhe_votacao_secao_2026.zip \
      --membro-detalhe detalhe_votacao_secao_2026_BR.csv --cands L=13,F=22,CURY=70,SANTOS=14,CAIADO=55,ZEMA=30 --invalidos 28 \
      --base data/t2/base-2026-1t.json --out data/t2/curva-2026-1t.json
  python3 -I scripts/t2_build_base.py --modo replay2022 --votos ~/dl/votacao_secao_2022_BR.zip --detalhe ~/dl/detalhe_votacao_secao_2022.zip \
      --membro-detalhe detalhe_votacao_secao_2022_BRASIL.csv --out data/t2/dev/replay-2022.json --out-curva data/t2/dev/curva-2022-1t.json
  python3 -I scripts/t2_build_base.py --modo replay --votos ~/dl/tse2018/votacao_secao_2018_BR.zip --detalhe ~/dl/tse2018/detalhe_votacao_secao_2018.zip \
      --membro-detalhe detalhe_votacao_secao_2018_BR.csv --cands L=13,F=17,CIRO=12,ALCKMIN=45 --dia-turno2 28/10/2018 \
      --out data/t2/dev/replay-2018.json --out-curva data/t2/dev/curva-2018-1t.json

DEFINIÇÕES (iguais às do app ao vivo — NÃO mude sem mudar o adaptador do TSE):
  unidade   = "UF|mmmmm|zzzz"  (UF maiúscula; CD_MUNICIPIO = código do TSE com 5 dígitos; NR_ZONA com 4 dígitos)
  aptos     = soma de QT_APTOS das seções;  comp = soma de QT_COMPARECIMENTO;  A = max(0, aptos - comp)
  B (branco)= QT_VOTOS_BRANCOS (detalhe) ou, se faltar, votos do NR_VOTAVEL 95
  N (nulo)  = max(0, comp - soma(todos os candidatos) - B)      <- DERIVADO, para fechar a conta
  D (demais)= soma dos candidatos que não estão em --cands
  E         = comp + A    (eleitorado das seções instaladas)
"""
import argparse, csv, io, json, math, os, random, sys, tempfile, zipfile, datetime
from collections import defaultdict

csv.field_size_limit(2 ** 31 - 1)

UFS = {'AC': 'Acre', 'AL': 'Alagoas', 'AM': 'Amazonas', 'AP': 'Amapá', 'BA': 'Bahia', 'CE': 'Ceará', 'DF': 'Distrito Federal',
       'ES': 'Espírito Santo', 'GO': 'Goiás', 'MA': 'Maranhão', 'MG': 'Minas Gerais', 'MS': 'Mato Grosso do Sul', 'MT': 'Mato Grosso',
       'PA': 'Pará', 'PB': 'Paraíba', 'PE': 'Pernambuco', 'PI': 'Piauí', 'PR': 'Paraná', 'RJ': 'Rio de Janeiro', 'RN': 'Rio Grande do Norte',
       'RO': 'Rondônia', 'RR': 'Roraima', 'RS': 'Rio Grande do Sul', 'SC': 'Santa Catarina', 'SE': 'Sergipe', 'SP': 'São Paulo',
       'TO': 'Tocantins', 'ZZ': 'Exterior'}

ALIAS = {
    'turno': ['NR_TURNO'], 'cargo': ['CD_CARGO'], 'uf': ['SG_UF'], 'mun': ['CD_MUNICIPIO'], 'munnome': ['NM_MUNICIPIO'],
    'zona': ['NR_ZONA'], 'secao': ['NR_SECAO'], 'votavel': ['NR_VOTAVEL', 'NR_CANDIDATO'], 'nome': ['NM_VOTAVEL', 'NM_URNA_CANDIDATO'],
    'votos': ['QT_VOTOS', 'QT_VOTOS_NOMINAIS'], 'aptos': ['QT_APTOS'], 'comp': ['QT_COMPARECIMENTO'],
    'abst': ['QT_ABSTENCOES', 'QT_ELEITORES_FALTOSOS'], 'brancos': ['QT_VOTOS_BRANCOS'], 'nulos': ['QT_VOTOS_NULOS'],
}


def _abrir_texto(caminho, membro=None):
    """Abre o CSV (de um zip ou solto) como texto latin-1. membro terminado em .csv = nome EXATO do arquivo dentro do zip;
    caso contrário, o INÍCIO do nome."""
    if caminho.lower().endswith('.zip'):
        zf = zipfile.ZipFile(caminho)
        nomes = [n for n in zf.namelist() if n.lower().endswith('.csv')]
        if membro:
            if membro.lower().endswith('.csv'):
                nomes = [n for n in nomes if os.path.basename(n) == membro]
            else:
                nomes = [n for n in nomes if os.path.basename(n).startswith(membro)]
        if not nomes:
            raise SystemExit('nenhum CSV dentro de ' + caminho)
        if len(nomes) > 1:
            print('AVISO: vários CSVs no zip; usando %s. Use --membro para escolher entre: %s' % (nomes[0], nomes), file=sys.stderr)
        return io.TextIOWrapper(zf.open(nomes[0]), encoding='latin-1', newline='')
    return open(caminho, encoding='latin-1', newline='')


def abrir(caminho, membro=None):
    return csv.DictReader(_abrir_texto(caminho, membro), delimiter=';', quotechar='"')


def abrir_linhas(caminho, membro=None):
    """Como abrir(), mas devolve (cabeçalho, leitor por listas): bem mais rápido nos CSVs de milhões de linhas."""
    rd = csv.reader(_abrir_texto(caminho, membro), delimiter=';', quotechar='"')
    return next(rd), rd


def col(header, chave, obrigatoria=True):
    for c in ALIAS[chave]:
        if c in header:
            return c
    if obrigatoria:
        raise SystemExit('coluna "%s" não encontrada. Cabeçalho real: %s\nAjuste ALIAS em %s.' % (ALIAS[chave], header, __file__))
    return None


def chave(uf, mun, zona):
    return '%s|%05d|%04d' % (uf.strip().upper(), int(mun), int(zona))


def lista(x):
    return x if isinstance(x, (list, tuple)) else [x]


def agregar_votos(caminhos, turno, membro=None):
    """caminhos: um arquivo ou uma lista (ex.: um zip por UF). Soma tudo por unidade."""
    out = defaultdict(lambda: {'cand': defaultdict(int), 'branco': 0, 'nulo': 0})
    nomes, munnomes = {}, {}
    for caminho in lista(caminhos):
        rd = abrir(caminho, membro)
        H = rd.fieldnames
        cT, cC, cU, cM, cMn, cZ, cV, cN, cQ = (col(H, 'turno'), col(H, 'cargo'), col(H, 'uf'), col(H, 'mun'), col(H, 'munnome', False),
                                                col(H, 'zona'), col(H, 'votavel'), col(H, 'nome', False), col(H, 'votos'))
        for r in rd:
            if r[cC].strip() != '1' or r[cT].strip() != str(turno):
                continue
            k = chave(r[cU], r[cM], r[cZ])
            num, q = r[cV].strip(), int(r[cQ] or 0)
            u = out[k]
            if num == '95':
                u['branco'] += q
            elif num == '96':
                u['nulo'] += q
            else:
                u['cand'][num] += q
                if cN and num not in nomes:
                    nomes[num] = r[cN].strip()
            if cMn:
                munnomes[k.rsplit('|', 1)[0]] = r[cMn].strip()
    return out, nomes, munnomes


def agregar_detalhe(caminhos, turno, membro=None):
    out = defaultdict(lambda: {'aptos': 0, 'comp': 0, 'brancos': 0, 'temB': False, 'secoes': 0, 'maxSecao': 0})
    vistos = set()
    for caminho in lista(caminhos):
        rd = abrir(caminho, membro)
        H = rd.fieldnames
        cT, cC, cU, cM, cZ, cS = col(H, 'turno'), col(H, 'cargo'), col(H, 'uf'), col(H, 'mun'), col(H, 'zona'), col(H, 'secao')
        cA, cP = col(H, 'aptos'), col(H, 'comp')
        cB = col(H, 'brancos', False)
        for r in rd:
            if r[cC].strip() != '1' or r[cT].strip() != str(turno):
                continue
            k = chave(r[cU], r[cM], r[cZ])
            sk = (k, r[cS])
            if sk in vistos:
                continue
            vistos.add(sk)
            u = out[k]
            ap, co = int(r[cA] or 0), int(r[cP] or 0)
            u['aptos'] += ap
            u['comp'] += co
            u['secoes'] += 1
            u['maxSecao'] = max(u['maxSecao'], ap)
            if cB:
                u['temB'] = True
                u['brancos'] += int(r[cB] or 0)
    return out


def codigos_invalidos(texto):
    return {x.strip() for x in (texto or '').split(',') if x.strip()}


def montar_x(v, d, invalidos=None):
    """Devolve (x_por_origem dict, comp, A, B, N, total_cand)."""
    invalidos = invalidos or set()
    comp, aptos = d['comp'], d['aptos']
    A = max(0, aptos - comp)
    B = d['brancos'] if d['temB'] else v['branco']
    total_cand = sum(q for n, q in v['cand'].items() if n not in invalidos)
    N = max(0, comp - total_cand - B)
    return A, B, N, total_cand, comp


def base2026(args):
    cands = dict(p.split('=') for p in args.cands.split(','))                 # ex.: {'L':'13','F':'22',...}
    invalidos = codigos_invalidos(getattr(args, 'invalidos', None))
    rows = ['L', 'F', 'CURY', 'SANTOS', 'CAIADO', 'ZEMA', 'D', 'B', 'N', 'A']
    if [k for k in cands] != rows[:6]:
        raise SystemExit('--cands deve listar exatamente, nesta ordem: ' + ','.join(rows[:6]))
    votos, nomes, munnomes = agregar_votos(args.votos, 1, args.membro_votos)
    det = agregar_detalhe(args.detalhe, 1, args.membro_detalhe)
    por_cand = defaultdict(int)
    for v in votos.values():
        for n, q in v['cand'].items():
            por_cand[n] += q
    print('Candidatos no 1º turno (número, nome, votos) — confira com os totais oficiais antes de confiar em --cands:')
    for n, q in sorted(por_cand.items(), key=lambda t: -t[1]):
        print('  %-4s %-30s %12d' % (n, nomes.get(n, ''), q))
    unidades, tot, faltam = [], defaultdict(int), []
    for k in sorted(votos):
        d = det.get(k)
        if not d:
            faltam.append(k)
            continue
        A, B, N, total_cand, comp = montar_x(votos[k], d, invalidos)
        usados = set(cands.values())
        x = [votos[k]['cand'].get(cands[r], 0) for r in rows[:6]]
        x.append(sum(q for n, q in votos[k]['cand'].items() if n not in usados and n not in invalidos))
        x += [B, N, A]
        E = comp + A
        uf, mun, zona = k.split('|')
        unidades.append({'id': k, 'uf': uf, 'mun': mun, 'zona': zona, 'x': x, 'E': E, 'secoes': d['secoes'], 'maxSecao': d['maxSecao']})
        for r, q in zip(rows, x):
            tot[r] += q
    if faltam:
        print('AVISO: %d unidades sem detalhe (aptos/comparecimento): %s ...' % (len(faltam), faltam[:5]), file=sys.stderr)
    cand_info = {r: {'numero': cands[r], 'nome': nomes.get(cands[r], '')} for r in rows[:6]}
    saida = {'versao': 1, 'gerado_em': datetime.datetime.now().isoformat(timespec='seconds'), 'fonte': 'TSE dados abertos - votação por seção (1º turno 2026, Presidente)',
             'rows': rows, 'candidatos': cand_info, 'ufs': {u: UFS.get(u, u) for u in sorted({x['uf'] for x in unidades})},
             'muns': {k: v for k, v in sorted(munnomes.items())}, 'unidades': unidades}
    verificar(tot, args.esperado, args.force)
    gravar(args.out, saida, unidades, tot, rows)


def backtest(args):
    rows = ['L', 'F', 'D', 'B', 'N', 'A']
    invalidos = codigos_invalidos(getattr(args, 'invalidos', None))
    v1, _, _ = agregar_votos(args.votos, 1, args.membro_votos)
    v2, _, _ = agregar_votos(args.votos, 2, args.membro_votos)
    d1, d2 = agregar_detalhe(args.detalhe, 1, args.membro_detalhe), agregar_detalhe(args.detalhe, 2, args.membro_detalhe)
    unidades, tot = [], defaultdict(int)
    for k in sorted(set(v1) & set(v2) & set(d1) & set(d2)):
        A1, B1, N1, tc1, c1 = montar_x(v1[k], d1[k], invalidos)
        A2, B2, N2, tc2, c2 = montar_x(v2[k], d2[k], invalidos)
        L1, F1 = v1[k]['cand'].get('13', 0), v1[k]['cand'].get('22', 0)
        x = [L1, F1, tc1 - L1 - F1, B1, N1, A1]
        y = [v2[k]['cand'].get('13', 0), v2[k]['cand'].get('22', 0), B2, N2, A2]
        E = c1 + A1
        if abs(sum(y) - E) > max(2, 0.002 * E):      # unidade cujo eleitorado mudou entre turnos: reescala y para E
            s = sum(y)
            y = [v * E / s for v in y] if s > 0 else y
        uf, mun, zona = k.split('|')
        unidades.append({'id': k, 'uf': uf, 'mun': mun, 'zona': zona, 'x': x, 'E': E, 'yFull': y})
        for r, q in zip(rows, x):
            tot['1T_' + r] += q
        for r, q in zip(['L', 'F', 'B', 'N', 'A'], y):
            tot['2T_' + r] += q
    saida = {'versao': 1, 'gerado_em': datetime.datetime.now().isoformat(timespec='seconds'), 'rows': rows, 'unidades': unidades}
    gravar(args.out, saida, unidades, tot, None)


# ---------------------------------------------------------------- por seção (2T-1.2): curva de chegada e ensaio com a ordem real
SEM_HORA = 10 ** 12           # seção sem horário de chegada: vai para o fim da fila (e é contada em stats['sem_hora'])
_dias = {}


def segundos(txt):
    """'dd/mm/aaaa HH:MM:SS' (hora de Brasília como publicada pelo TSE) -> segundos desde 01/01/0001; None se vazio ou malformado."""
    txt = (txt or '').strip()
    if len(txt) < 19:
        return None
    dia = txt[:10]
    base = _dias.get(dia)
    try:
        if base is None:
            base = _dias[dia] = datetime.date(int(dia[6:10]), int(dia[3:5]), int(dia[:2])).toordinal() * 86400
        return base + int(txt[11:13]) * 3600 + int(txt[14:16]) * 60 + int(txt[17:19])
    except ValueError:
        return None


# Registro de uma seção (lista, para caber na memória):
#   [t, aptos, comp, brancos_do_detalhe (-1 = não há coluna), *candidatos_nomeados, outros_validos, voto95, voto96]
def _layout(nslot):
    return {'IT': 0, 'IAP': 1, 'ICO': 2, 'IBR': 3, 'IV0': 4, 'IOUT': 4 + nslot, 'I95': 5 + nslot, 'I96': 6 + nslot}


def ler_secoes(votos, detalhe, turno, slots, invalidos=None, membro_votos=None, membro_detalhe=None):
    """Lê POR SEÇÃO (Presidente, um turno). slots: {numero_do_candidato: posição 0..n-1} dos candidatos nomeados; os demais válidos
    somam em 'outros'. Devolve (secoes, zonas_com_voto, stats); secoes[(zona_id, nr_secao)] = registro (ver _layout).
    O detalhe manda na lista de seções (como em base2026); votos de seção ausente do detalhe são descartados e contados."""
    invalidos = invalidos or set()
    nslot = len(slots)
    L = _layout(nslot)
    secs, zc = {}, {}
    stats = {'detalhe_linhas': 0, 'sem_hora': 0, 'prim_vazio': 0, 'votos_sem_detalhe': 0, 'duplicadas': 0}
    ts = str(turno)

    def zona_id(uf, mun, zona):
        k = (uf, mun, zona)
        z = zc.get(k)
        if z is None:
            z = zc[k] = chave(uf, mun, zona)
        return z

    for caminho in lista(detalhe):
        H, rd = abrir_linhas(caminho, membro_detalhe)
        i = {n: H.index(col(H, n)) for n in ('turno', 'cargo', 'uf', 'mun', 'zona', 'secao', 'aptos', 'comp')}
        cB = col(H, 'brancos', False)
        iB = H.index(cB) if cB else None
        iPrim = H.index('DT_PRIM_TOT_PARCIAL_HOR_TSE') if 'DT_PRIM_TOT_PARCIAL_HOR_TSE' in H else None
        iRec = H.index('DT_RECEBIMENTO_BU_HOR_TSE') if 'DT_RECEBIMENTO_BU_HOR_TSE' in H else None
        if iPrim is None and iRec is None:
            raise SystemExit('o detalhe não tem DT_PRIM_TOT_PARCIAL_HOR_TSE nem DT_RECEBIMENTO_BU_HOR_TSE (horário de chegada). Cabeçalho: %s' % H)
        for r in rd:
            if r[i['cargo']].strip() != '1' or r[i['turno']].strip() != ts:
                continue
            stats['detalhe_linhas'] += 1
            sk = (zona_id(r[i['uf']], r[i['mun']], r[i['zona']]), int(r[i['secao']]))
            if sk in secs:
                stats['duplicadas'] += 1
                continue
            t = segundos(r[iPrim]) if iPrim is not None else None
            if t is None:
                if iPrim is not None:
                    stats['prim_vazio'] += 1
                t = segundos(r[iRec]) if iRec is not None else None
            if t is None:
                t = SEM_HORA
                stats['sem_hora'] += 1
            rec = [0] * (L['I96'] + 1)
            rec[L['IT']] = t
            rec[L['IAP']] = int(r[i['aptos']] or 0)
            rec[L['ICO']] = int(r[i['comp']] or 0)
            rec[L['IBR']] = int(r[iB] or 0) if iB is not None else -1
            secs[sk] = rec
    zonas_com_voto = set()
    for caminho in lista(votos):
        H, rd = abrir_linhas(caminho, membro_votos)
        iT, iC, iU, iM, iZ, iS, iV, iQ = (H.index(col(H, n)) for n in ('turno', 'cargo', 'uf', 'mun', 'zona', 'secao', 'votavel', 'votos'))
        for r in rd:
            if r[iC].strip() != '1' or r[iT].strip() != ts:
                continue
            z = zona_id(r[iU], r[iM], r[iZ])
            zonas_com_voto.add(z)
            rec = secs.get((z, int(r[iS])))
            if rec is None:
                stats['votos_sem_detalhe'] += 1
                continue
            num, q = r[iV].strip(), int(r[iQ] or 0)
            if num == '95':
                rec[L['I95']] += q
            elif num == '96':
                rec[L['I96']] += q
            elif num in invalidos:
                pass
            elif num in slots:
                rec[L['IV0'] + slots[num]] += q
            else:
                rec[L['IOUT']] += q
    return secs, zonas_com_voto, stats


def x_secao(rec, nslot):
    """Vetor de origem da seção, no mesmo critério de montar_x (zona): [nomeados..., outros, B, N, A]. Soma = aptos (se N não for cortado)."""
    L = _layout(nslot)
    aptos, comp = rec[L['IAP']], rec[L['ICO']]
    A = max(0, aptos - comp)
    B = rec[L['IBR']] if rec[L['IBR']] >= 0 else rec[L['I95']]
    nomeados = rec[L['IV0']:L['IOUT']]
    total_cand = sum(nomeados) + rec[L['IOUT']]
    N = max(0, comp - total_cand - B)
    return nomeados + [rec[L['IOUT']], B, N, A]


def y_secao(rec):
    """2º turno da seção (2 nomeados): [L, F, B, N, A]."""
    x = x_secao(rec, 2)
    return [x[0], x[1], x[3], x[4], x[5]]


def agrupar_por_zona(secs, zonas_com_voto, nslot):
    """-> {zona_id: [(t, nr_secao, x), ...]} só das zonas com algum voto (como base2026), já na ordem de chegada (desempate: nº da seção)."""
    por = defaultdict(list)
    for (z, ns), rec in secs.items():
        if z in zonas_com_voto:
            por[z].append((rec[0], ns, x_secao(rec, nslot)))
    for z in por:
        por[z].sort(key=lambda a: (a[0], a[1]))
    return por


def pontos_curva(n):
    """k_j = round(j·n/10), j = 1..9, só 1 <= k < n e sem repetir (aritmética inteira: arredonda .5 para cima)."""
    ks = []
    for j in range(1, 10):
        k = (2 * j * n + 10) // 20
        if 1 <= k < n and (not ks or k > ks[-1]):
            ks.append(k)
    return ks


def _compor(soma):
    tot = sum(soma)
    return [v / tot for v in soma] if tot > 0 else None


def _arred(v):
    return int(math.floor(v + 0.5))


def desvio_prefixo(ordenada, k, escala=10000):
    """d(k) = round(escala · (composição das k primeiras seções − composição da zona)). d(n) = 0 por construção."""
    K = len(ordenada[0][2])
    tot = [0] * K
    pre = [0] * K
    for j, (_, _, x) in enumerate(ordenada):
        for i in range(K):
            tot[i] += x[i]
            if j < k:
                pre[i] += x[i]
    sz, sk = _compor(tot), _compor(pre)
    if sz is None or sk is None:
        return [0] * K
    return [_arred(escala * (a - b)) for a, b in zip(sk, sz)]


def curva_zona(ordenada, escala=10000):
    """ordenada: [(t, secao, x)] na ordem de chegada. -> {n, k:[…], d:[[…]…]} (um passe só, soma acumulada)."""
    n = len(ordenada)
    K = len(ordenada[0][2])
    ks = pontos_curva(n)
    tot = [0] * K
    for _, _, x in ordenada:
        for i in range(K):
            tot[i] += x[i]
    sz = _compor(tot)
    pre = [0] * K
    d, kk = [], set(ks)
    for idx, (_, _, x) in enumerate(ordenada, 1):
        for i in range(K):
            pre[i] += x[i]
        if idx in kk:
            sk = _compor(pre)
            if sz is None or sk is None:
                d.append([0] * K)
            else:
                d.append([_arred(escala * (a - b)) for a, b in zip(sk, sz)])
    return {'n': n, 'k': ks, 'd': d}


def montar_curva(por_zona, rows, fonte, escala=10000, limite=3_000_000):
    """Se o arquivo passar de 3 MB, refaz com escala 10³ (plano A0)."""
    while True:
        unidades = {z: curva_zona(lst, escala) for z, lst in sorted(por_zona.items())}
        saida = {'v': 1, 'gerado_em': datetime.datetime.now().isoformat(timespec='seconds'), 'fonte': fonte, 'rows': rows, 'esc': escala, 'unidades': unidades}
        tam = len(json.dumps(saida, separators=(',', ':')).encode('utf-8'))
        if tam <= limite or escala <= 1000:
            return saida, tam
        print('curva com escala %d tem %.2f MB (> %.1f MB); refazendo com escala 1000' % (escala, tam / 1e6, limite / 1e6), file=sys.stderr)
        escala = 1000


def conferir_com_base(por_zona, base, rows):
    """Compara a soma das seções com as zonas da base. Devolve cobertura e divergências."""
    bz = {u['id']: u for u in base['unidades']}
    cobertas = [z for z in bz if z in por_zona]
    dif_zonas, dif_tot, n_dif = 0, 0, 0
    exemplos = []
    for z in cobertas:
        soma = [sum(a[2][i] for a in por_zona[z]) for i in range(len(rows))]
        dif = sum(abs(a - b) for a, b in zip(soma, bz[z]['x']))
        if dif:
            dif_zonas += 1
            dif_tot += dif
            if len(exemplos) < 5:
                exemplos.append((z, soma, bz[z]['x']))
        if len(por_zona[z]) != bz[z].get('secoes', len(por_zona[z])):
            n_dif += 1
    return {'zonas_base': len(bz), 'cobertas': len(cobertas), 'cobertura': len(cobertas) / max(1, len(bz)),
            'zonas_so_na_curva': len(set(por_zona) - set(bz)), 'zonas_com_diferenca_em_x': dif_zonas,
            'diferenca_total_abs': dif_tot, 'zonas_com_n_diferente': n_dif, 'exemplos': exemplos}


def curva2026(args):
    cands = dict(p.split('=') for p in args.cands.split(','))
    invalidos = codigos_invalidos(getattr(args, 'invalidos', None))
    rows = ['L', 'F', 'CURY', 'SANTOS', 'CAIADO', 'ZEMA', 'D', 'B', 'N', 'A']
    if [k for k in cands] != rows[:6]:
        raise SystemExit('--cands deve listar exatamente, nesta ordem: ' + ','.join(rows[:6]))
    slots = {cands[r]: i for i, r in enumerate(rows[:6])}
    secs, zonas, stats = ler_secoes(args.votos, args.detalhe, 1, slots, invalidos, args.membro_votos, args.membro_detalhe)
    print('seções lidas: %d | zonas com voto: %d | stats: %s' % (len(secs), len(zonas), stats))
    por_zona = agrupar_por_zona(secs, zonas, 6)
    del secs
    saida, tam = montar_curva(por_zona, rows, 'TSE dados abertos - votação por seção e detalhe (1º turno 2026, Presidente); ordem por DT_PRIM_TOT_PARCIAL_HOR_TSE')
    if getattr(args, 'base', None):
        base = json.load(open(args.base, encoding='utf-8'))
        if base['rows'] != rows:
            raise SystemExit('rows da base diferentes: %s' % base['rows'])
        conf = conferir_com_base(por_zona, base, rows)
        print('conferência com a base:', {k: v for k, v in conf.items() if k != 'exemplos'})
        for e in conf['exemplos']:
            print('  exemplo de diferença:', e)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(saida, f, ensure_ascii=False, separators=(',', ':'))
    print('gravado %s | %d zonas | escala %d | %.2f MB' % (args.out, len(saida['unidades']), saida['esc'], os.path.getsize(args.out) / 1e6))


def spearman_zonas(pares):
    """pares: {zona: [(pos_1T, pos_2T), ...]} -> estabilidade da ordem de chegada dentro da zona entre os turnos.
    Spearman (posições já sem empate: desempate pelo nº da seção) por zona com >= 3 seções; mediana e média ponderada pelo nº de seções."""
    rhos = []
    for lst in pares.values():
        n = len(lst)
        if n < 3:
            continue
        r1 = {p: i for i, p in enumerate(sorted(range(n), key=lambda j: lst[j][0]))}
        r2 = {p: i for i, p in enumerate(sorted(range(n), key=lambda j: lst[j][1]))}
        d2 = sum((r1[j] - r2[j]) ** 2 for j in range(n))
        rhos.append((1 - 6.0 * d2 / (n * (n * n - 1)), n))
    if not rhos:
        return {'zonas': 0}
    v = sorted(r for r, _ in rhos)
    med = v[len(v) // 2] if len(v) % 2 else (v[len(v) // 2 - 1] + v[len(v) // 2]) / 2
    pond = sum(r * n for r, n in rhos) / sum(n for _, n in rhos)
    return {'zonas': len(rhos), 'mediana': round(med, 4), 'media_ponderada': round(pond, 4),
            'fracao_positiva': round(sum(1 for r in v if r > 0) / len(v), 4)}


def replay(args):
    """Ensaio com a ordem real: 1º turno (x) e 2º turno (y, hora de chegada) por seção, só seções presentes nos dois turnos.
    --cands (padrão L=13,F=22, isto é, 2022): candidatos do 1º turno com linha própria em x, na ordem; os dois primeiros têm de ser L e F
    (os dois do 2º turno). Ex. 2018: L=13,F=17,CIRO=12,ALCKMIN=45."""
    cands = [p.split('=') for p in (getattr(args, 'cands', None) or 'L=13,F=22').split(',')]
    if [c[0] for c in cands[:2]] != ['L', 'F'] or len({c[1] for c in cands}) != len(cands):
        raise SystemExit('--cands deve começar por L=<nº>,F=<nº> (os dois do 2º turno) e não repetir números')
    rows = [c[0] for c in cands] + ['D', 'B', 'N', 'A']
    nslot = len(cands)
    ano = args.dia_turno2[-4:]
    invalidos = codigos_invalidos(getattr(args, 'invalidos', None))
    slots = {num: i for i, (_, num) in enumerate(cands)}
    s1, z1, st1 = ler_secoes(args.votos, args.detalhe, 1, slots, invalidos, args.membro_votos, args.membro_detalhe)
    print('1º turno: %d seções | stats %s' % (len(s1), st1))
    slots2 = {cands[0][1]: 0, cands[1][1]: 1}
    s2, z2, st2 = ler_secoes(args.votos, args.detalhe, 2, slots2, invalidos, args.membro_votos, args.membro_detalhe)
    print('2º turno: %d seções | stats %s' % (len(s2), st2))
    t0 = segundos('%s %s' % (args.dia_turno2, args.hora_inicio))
    if t0 is None:
        raise SystemExit('--dia-turno2/--hora-inicio inválidos')
    ambas = sorted(k for k in s2 if k in s1 and k[0] in z1 and k[0] in z2)
    zonas = sorted({k[0] for k in ambas})
    zi = {z: i for i, z in enumerate(zonas)}
    secoes, por_zona1 = [], defaultdict(list)
    tot_y, tot_x = [0] * 5, [0] * len(rows)
    pares = defaultdict(list)
    for k in ambas:
        r1, r2 = s1[k], s2[k]
        x, y = x_secao(r1, nslot), y_secao(r2)
        t2 = r2[0] - t0 if r2[0] != SEM_HORA else SEM_HORA
        secoes.append([zi[k[0]]] + x + y + [t2])
        por_zona1[k[0]].append((r1[0], k[1], x))
        pares[k[0]].append(((r1[0], k[1]), (r2[0], k[1])))
        for i in range(5):
            tot_y[i] += y[i]
        for i in range(len(rows)):
            tot_x[i] += x[i]
    for z in por_zona1:
        por_zona1[z].sort(key=lambda a: (a[0], a[1]))
    ordem = spearman_zonas(pares)
    print('ordem de chegada 1T x 2T dentro da zona (Spearman): %s' % ordem)
    val1 = sum(tot_x[:nslot + 1])
    print('1º turno (seções nos dois turnos), %% dos válidos: %s' % ', '.join('%s %.2f' % (r, 100.0 * tot_x[i] / max(1, val1)) for i, r in enumerate(rows[:nslot + 1])))
    saida = {'v': 1, 'gerado_em': datetime.datetime.now().isoformat(timespec='seconds'),
             'fonte': 'TSE dados abertos %s (Presidente): x = 1º turno; y e t2 = 2º turno de %s; t2 em segundos desde %s' % (ano, args.dia_turno2, args.hora_inicio),
             'rows': rows, 'colunas': ['zona'] + ['x_' + r for r in rows] + ['y_' + r for r in ['L', 'F', 'B', 'N', 'A']] + ['t2'],
             'zonas': zonas, 'secoes': secoes, 'ordem_1t_2t': ordem}
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(saida, f, ensure_ascii=False, separators=(',', ':'))
    print('gravado %s | %d zonas | %d seções | %.1f MB | 2T: L %d, F %d (L %.2f%% dos válidos)' % (
        args.out, len(zonas), len(secoes), os.path.getsize(args.out) / 1e6, tot_y[0], tot_y[1], 100.0 * tot_y[0] / max(1, tot_y[0] + tot_y[1])))
    curva, tam = montar_curva(por_zona1, rows, 'ordem de chegada do 1º turno de %s (DT_PRIM_TOT_PARCIAL_HOR_TSE), seções presentes nos dois turnos' % ano)
    os.makedirs(os.path.dirname(os.path.abspath(args.out_curva)), exist_ok=True)
    with open(args.out_curva, 'w', encoding='utf-8') as f:
        json.dump(curva, f, ensure_ascii=False, separators=(',', ':'))
    print('gravado %s | %d zonas | escala %d | %.2f MB' % (args.out_curva, len(curva['unidades']), curva['esc'], os.path.getsize(args.out_curva) / 1e6))


def verificar(tot, esperado, force):
    if not esperado:
        return
    exp = {p.split('=')[0]: int(p.split('=')[1]) for p in esperado.split(',')}
    ruim = []
    for k, e in exp.items():
        got = tot.get(k, 0)
        rel = abs(got - e) / max(1, e)
        print('  %-7s obtido %12d | esperado %12d | dif %.5f%%' % (k, got, e, rel * 100))
        if rel > 1e-4:
            ruim.append(k)
    if ruim:
        msg = 'TOTAIS NÃO BATEM em: ' + ','.join(ruim) + '. Reveja números dos candidatos (--cands) e definições.'
        if force:
            print('AVISO (--force):', msg, file=sys.stderr)
        else:
            raise SystemExit(msg)


def gravar(out, saida, unidades, tot, rows):
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(saida, f, ensure_ascii=False, separators=(',', ':'))
    print('gravado %s | %d unidades | %.1f KB' % (out, len(unidades), os.path.getsize(out) / 1024))
    print('totais:', dict(tot))


def probe(caminho, membro):
    rd = abrir(caminho, membro)
    print('CABEÇALHO:', rd.fieldnames)
    for i, r in zip(range(3), rd):
        print('linha %d:' % (i + 1), dict(r))


# ---------------------------------------------------------------- selftest
def selftest():
    rnd = random.Random(5)
    tmp = tempfile.mkdtemp()
    fv, fd = os.path.join(tmp, 'votos.csv'), os.path.join(tmp, 'detalhe.csv')
    esperado1 = defaultdict(int)
    HV = ['ANO_ELEICAO', 'NR_TURNO', 'SG_UF', 'CD_MUNICIPIO', 'NM_MUNICIPIO', 'NR_ZONA', 'NR_SECAO', 'CD_CARGO', 'NR_VOTAVEL', 'NM_VOTAVEL', 'QT_VOTOS']
    HD = ['ANO_ELEICAO', 'NR_TURNO', 'SG_UF', 'CD_MUNICIPIO', 'NM_MUNICIPIO', 'NR_ZONA', 'NR_SECAO', 'CD_CARGO', 'QT_APTOS', 'QT_COMPARECIMENTO', 'QT_ABSTENCOES',
          'DT_RECEBIMENTO_BU_HOR_TSE', 'DT_PRIM_TOT_PARCIAL_HOR_TSE']
    dia_turno = {1: '04/10/2026', 2: '25/10/2026'}

    def horas(turno, secao):
        """Horários sintéticos: a seção 3 não tem PRIM (usa o recebimento) e a 5 de BA/zona 2 não tem nenhum dos dois (vai para o fim)."""
        seg = rnd.randint(17 * 3600, 21 * 3600)
        rec = '%s %02d:%02d:%02d' % (dia_turno[turno], seg // 3600, seg % 3600 // 60, seg % 60)
        seg2 = seg + rnd.randint(1, 600)
        prim = '%s %02d:%02d:%02d' % (dia_turno[turno], seg2 // 3600, seg2 % 3600 // 60, seg2 % 60)
        return rec, prim
    with open(fv, 'w', encoding='latin-1', newline='') as a, open(fd, 'w', encoding='latin-1', newline='') as b:
        wa, wb = csv.writer(a, delimiter=';', quoting=csv.QUOTE_ALL), csv.writer(b, delimiter=';', quoting=csv.QUOTE_ALL)
        wa.writerow(HV)
        wb.writerow(HD)
        for turno in (1, 2):
            for uf in ('SP', 'BA', 'ZZ'):
                for mun in (71072, 38490, 5):
                    for zona in (1, 2):
                        for secao in range(1, 6):
                            aptos = rnd.randint(250, 420)
                            comp = int(aptos * rnd.uniform(0.7, 0.9))
                            br, nu, invalido = rnd.randint(0, 6), rnd.randint(0, 10), 1
                            valid = comp - br - nu - invalido
                            if turno == 1:
                                ids = ['13', '22', '70', '14', '55', '30', '80', '16']
                                cuts = sorted(rnd.randint(0, valid) for _ in range(len(ids) - 1))
                                parts = [b2 - a2 for a2, b2 in zip([0] + cuts, cuts + [valid])]
                            else:
                                ids = ['13', '22']
                                l = rnd.randint(0, valid)
                                parts = [l, valid - l]
                            for n, q in zip(ids, parts):
                                wa.writerow([2026, turno, uf, mun, 'MUN%d' % mun, zona, secao, 1, n, 'CAND' + n, q])
                                if turno == 1:
                                    esperado1[{'13': 'L', '22': 'F', '70': 'CURY', '14': 'SANTOS', '55': 'CAIADO', '30': 'ZEMA'}.get(n, 'D')] += q
                            wa.writerow([2026, turno, uf, mun, 'MUN%d' % mun, zona, secao, 1, 28, 'CANDIDATO INVALIDADO', invalido])
                            wa.writerow([2026, turno, uf, mun, 'MUN%d' % mun, zona, secao, 1, 95, 'Voto branco', br])
                            wa.writerow([2026, turno, uf, mun, 'MUN%d' % mun, zona, secao, 1, 96, 'Voto nulo', nu])
                            wa.writerow([2026, turno, uf, mun, 'MUN%d' % mun, zona, secao, 3, 13, 'LIXO (outro cargo)', 999])
                            rec_h, prim_h = horas(turno, secao)
                            if secao == 3:
                                prim_h = ''
                            if uf == 'BA' and zona == 2 and secao == 5:
                                rec_h = prim_h = ''
                            wb.writerow([2026, turno, uf, mun, 'MUN%d' % mun, zona, secao, 1, aptos, comp, aptos - comp, rec_h, prim_h])
                            if turno == 1:
                                esperado1['B'] += br
                                esperado1['N'] += nu + invalido
                                esperado1['A'] += aptos - comp
    ns = argparse.Namespace(votos=fv, detalhe=fd, membro_votos=None, membro_detalhe=None, force=False, invalidos='28',
                            cands='L=13,F=22,CURY=70,SANTOS=14,CAIADO=55,ZEMA=30', out=os.path.join(tmp, 'base.json'),
                            esperado=','.join('%s=%d' % (k, v) for k, v in esperado1.items() if k != 'D'))
    base2026(ns)
    j = json.load(open(ns.out))
    assert j['rows'] == ['L', 'F', 'CURY', 'SANTOS', 'CAIADO', 'ZEMA', 'D', 'B', 'N', 'A'] and len(j['unidades']) == 3 * 3 * 2
    assert all(abs(sum(u['x']) - u['E']) < 1e-9 for u in j['unidades']), 'sum(x) != E'
    assert sum(u['x'][6] for u in j['unidades']) == esperado1['D'], 'D (demais) não bate'
    assert j['unidades'][0]['id'].count('|') == 2 and len(j['unidades'][0]['id'].split('|')[1]) == 5
    ns2 = argparse.Namespace(votos=fv, detalhe=fd, membro_votos=None, membro_detalhe=None, force=False, invalidos='28', out=os.path.join(tmp, 'bt.json'))
    backtest(ns2)
    b = json.load(open(ns2.out))
    assert b['rows'] == ['L', 'F', 'D', 'B', 'N', 'A'] and len(b['unidades']) == 18
    for u in b['unidades']:
        assert abs(sum(u['x']) - u['E']) < 1e-6 and abs(sum(u['yFull']) - u['E']) < 1e-6

    # ---- por seção (2T-1.2)
    assert segundos('04/10/2026 17:00:00') - segundos('04/10/2026 16:59:59') == 1 and segundos('') is None and segundos('lixo lixo lixo lixo') is None
    assert segundos('05/10/2026 00:00:00') - segundos('04/10/2026 00:00:00') == 86400
    assert pontos_curva(1) == [] and pontos_curva(2) == [1] and pontos_curva(5) == [1, 2, 3, 4] and pontos_curva(100) == list(range(10, 100, 10))
    assert all(len(set(pontos_curva(n))) == len(pontos_curva(n)) and all(1 <= k < n for k in pontos_curva(n)) for n in range(1, 300))
    # escolha do membro do zip: nome exato (.csv) x início do nome
    zp = os.path.join(tmp, 'm.zip')
    with zipfile.ZipFile(zp, 'w') as zf:
        zf.writestr('det_BRASIL.csv', 'A;B\n1;2\n')
        zf.writestr('det_BR.csv', 'C;D\n3;4\n')
    assert abrir_linhas(zp, 'det_BR.csv')[0] == ['C', 'D'] and abrir_linhas(zp, 'det_BRASIL')[0] == ['A', 'B']
    cands = ns.cands
    ns3 = argparse.Namespace(votos=fv, detalhe=fd, membro_votos=None, membro_detalhe=None, invalidos='28', cands=cands, base=ns.out,
                             out=os.path.join(tmp, 'curva.json'))
    curva2026(ns3)
    c = json.load(open(ns3.out))
    assert c['v'] == 1 and c['rows'] == j['rows'] and c['esc'] == 10000 and set(c['unidades']) == {u['id'] for u in j['unidades']}
    slots6 = {'13': 0, '22': 1, '70': 2, '14': 3, '55': 4, '30': 5}
    secs, zonas, stats = ler_secoes(fv, fd, 1, slots6, {'28'})
    assert stats['sem_hora'] == 3 and stats['prim_vazio'] == 3 + 18 and stats['votos_sem_detalhe'] == 0, stats   # BA/zona 2/seção 5 (3 municípios) sem hora; a seção 3 (18 zonas) cai no recebimento
    por = agrupar_por_zona(secs, zonas, 6)
    conf = conferir_com_base(por, j, j['rows'])
    assert conf['cobertura'] == 1 and conf['diferenca_total_abs'] == 0 and conf['zonas_com_n_diferente'] == 0, conf    # soma das seções == zona da base
    for u in j['unidades']:
        cz, lst = c['unidades'][u['id']], por[u['id']]
        assert cz['n'] == u['secoes'] == len(lst) and cz['k'] == pontos_curva(cz['n']) and len(cz['d']) == len(cz['k'])
        assert desvio_prefixo(lst, cz['n']) == [0] * 10, 'd(k=n) deve ser 0'
        for k, d in zip(cz['k'], cz['d']):
            assert d == desvio_prefixo(lst, k) and abs(sum(d)) <= 10 and all(abs(v) <= 10000 for v in d)
        assert [a[0] for a in lst] == sorted(a[0] for a in lst)                                  # ordem de chegada
        assert [(a[0], a[1]) for a in lst] == sorted((a[0], a[1]) for a in lst)                  # com desempate pelo nº da seção
    ba2 = por['BA|00005|0002']
    assert ba2[-1][1] == 5 and ba2[-1][0] == SEM_HORA                                            # sem horário: última da zona
    pequeno, tam = montar_curva(por, j['rows'], 'teste', limite=1)
    assert pequeno['esc'] == 1000 and all(abs(v) <= 1000 for cz in pequeno['unidades'].values() for d in cz['d'] for v in d)
    ns4 = argparse.Namespace(votos=fv, detalhe=fd, membro_votos=None, membro_detalhe=None, invalidos='28', dia_turno2='25/10/2026', hora_inicio='17:00:00',
                             out=os.path.join(tmp, 'replay.json'), out_curva=os.path.join(tmp, 'curva22.json'))
    replay(ns4)
    rp, c22 = json.load(open(ns4.out)), json.load(open(ns4.out_curva))
    assert rp['rows'] == ['L', 'F', 'D', 'B', 'N', 'A'] and len(rp['zonas']) == 18 and len(rp['secoes']) == 90 and c22['rows'] == rp['rows']
    xz = defaultdict(lambda: [0] * 6)
    for sec in rp['secoes']:
        assert len(sec) == 1 + 6 + 5 + 1 and all(v >= 0 for v in sec[1:12])
        for i in range(6):
            xz[rp['zonas'][sec[0]]][i] += sec[1 + i]
        assert sec[12] >= 0 and (sec[12] < 5 * 3600 or sec[12] == SEM_HORA), sec                    # segundos desde 17:00 do dia do 2T
    for u in b['unidades']:
        assert xz[u['id']] == u['x'], (u['id'], xz[u['id']], u['x'])                                 # x do 1T por seção soma a zona do backtest
    assert all(c22['unidades'][z]['n'] == 5 for z in rp['zonas'])
    o = rp['ordem_1t_2t']
    assert o['zonas'] == 18 and -1 <= o['mediana'] <= 1 and -1 <= o['media_ponderada'] <= 1, o
    assert spearman_zonas({'a': [(1, 1), (2, 2), (3, 3)], 'b': [(1, 3), (2, 2), (3, 1)], 'c': [(1, 1)]}) == \
        {'zonas': 2, 'mediana': 0.0, 'media_ponderada': 0.0, 'fracao_positiva': 0.5}
    # replay com mais candidatos do 1º turno (2T-1.4): x tem linhas próprias para CURY e SANTOS e soma o mesmo que o x de 6 linhas
    ns5 = argparse.Namespace(**dict(vars(ns4), cands='L=13,F=22,CURY=70,SANTOS=14', out=os.path.join(tmp, 'replay8.json'),
                                    out_curva=os.path.join(tmp, 'curva8.json')))
    replay(ns5)
    rp8, c8 = json.load(open(ns5.out)), json.load(open(ns5.out_curva))
    assert rp8['rows'] == ['L', 'F', 'CURY', 'SANTOS', 'D', 'B', 'N', 'A'] and c8['rows'] == rp8['rows'] and len(rp8['secoes']) == 90
    for a6, a8 in zip(rp['secoes'], rp8['secoes']):
        assert len(a8) == 1 + 8 + 5 + 1 and a8[0] == a6[0] and a8[1:3] == a6[1:3] and sum(a8[3:6]) == a6[3]
        assert a8[6:9] == a6[4:7] and a8[9:] == a6[7:], (a6, a8)                                   # B, N, A, y e t2 iguais
    assert any(a8[3] > 0 for a8 in rp8['secoes']) and all(len(c8['unidades'][z]['d'][0]) == 8 for z in rp8['zonas'])
    try:
        replay(argparse.Namespace(**dict(vars(ns5), cands='F=22,L=13')))
        raise AssertionError('--cands sem L,F primeiro deveria falhar')
    except SystemExit:
        pass
    print('SELFTEST OK')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--modo', choices=['base2026', 'backtest', 'curva', 'replay', 'replay2022'])
    ap.add_argument('--votos', nargs='+'), ap.add_argument('--detalhe', nargs='+'), ap.add_argument('--out')
    ap.add_argument('--membro-votos', dest='membro_votos'), ap.add_argument('--membro-detalhe', dest='membro_detalhe')
    ap.add_argument('--cands'), ap.add_argument('--invalidos', help='números de candidaturas sem votos válidos, separados por vírgula'), ap.add_argument('--esperado'), ap.add_argument('--force', action='store_true')
    ap.add_argument('--base', help='(curva) base-2026-1t.json para conferir a soma das seções por zona')
    ap.add_argument('--out-curva', dest='out_curva', default='data/t2/dev/curva-2022-1t.json', help='(replay) curva do 1T22')
    ap.add_argument('--dia-turno2', dest='dia_turno2', default='30/10/2022', help='(replay) dia do 2º turno, dd/mm/aaaa')
    ap.add_argument('--hora-inicio', dest='hora_inicio', default='17:00:00', help='(replay) t=0 do ensaio (início da apuração em Brasília)')
    ap.add_argument('--probe'), ap.add_argument('--membro')
    ap.add_argument('--selftest', action='store_true')
    a = ap.parse_args()
    if a.selftest:
        selftest()
    elif a.probe:
        probe(a.probe, a.membro)
    elif a.modo == 'base2026':
        base2026(a)
    elif a.modo == 'backtest':
        backtest(a)
    elif a.modo == 'curva':
        curva2026(a)
    elif a.modo in ('replay', 'replay2022'):         # replay2022 = apelido (padrões de 2022)
        replay(a)
    else:
        ap.print_help()
