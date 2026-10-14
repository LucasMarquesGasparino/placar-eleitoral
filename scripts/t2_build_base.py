#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""t2_build_base.py — Gera os dados-base do 2º turno a partir dos CSVs de dados abertos do TSE
(Votação por seção + Detalhe da votação por seção), SOMENTE cargo Presidente (CD_CARGO = 1).

Só biblioteca padrão. Lê .csv ou .zip (CSV ';' em latin-1) em streaming (não carrega tudo na memória).

MODOS
  --modo base2026   gera data/t2/base-2026-1t.json     (linhas: L,F,CURY,SANTOS,CAIADO,ZEMA,D,B,N,A) a partir do 1º turno
  --modo backtest   gera data/t2/dev/backtest-2022.json (linhas: L,F,D,B,N,A; x = 1T, yFull = 2T) a partir de 2022 (1º e 2º turnos)
  --probe ARQ       imprime o cabeçalho e 3 linhas de um CSV/ZIP (use ANTES, para conferir os nomes das colunas)
  --selftest        cria CSVs sintéticos, roda os dois modos e confere os totais (teste de que o script funciona)

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

DEFINIÇÕES (iguais às do app ao vivo — NÃO mude sem mudar o adaptador do TSE):
  unidade   = "UF|mmmmm|zzzz"  (UF maiúscula; CD_MUNICIPIO = código do TSE com 5 dígitos; NR_ZONA com 4 dígitos)
  aptos     = soma de QT_APTOS das seções;  comp = soma de QT_COMPARECIMENTO;  A = max(0, aptos - comp)
  B (branco)= QT_VOTOS_BRANCOS (detalhe) ou, se faltar, votos do NR_VOTAVEL 95
  N (nulo)  = max(0, comp - soma(todos os candidatos) - B)      <- DERIVADO, para fechar a conta
  D (demais)= soma dos candidatos que não estão em --cands
  E         = comp + A    (eleitorado das seções instaladas)
"""
import argparse, csv, io, json, os, random, sys, tempfile, zipfile, datetime
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


def abrir(caminho, membro=None):
    if caminho.lower().endswith('.zip'):
        zf = zipfile.ZipFile(caminho)
        nomes = [n for n in zf.namelist() if n.lower().endswith('.csv')]
        if membro:
            nomes = [n for n in nomes if os.path.basename(n).startswith(membro)]
        if not nomes:
            raise SystemExit('nenhum CSV dentro de ' + caminho)
        if len(nomes) > 1:
            print('AVISO: vários CSVs no zip; usando %s. Use --membro para escolher entre: %s' % (nomes[0], nomes), file=sys.stderr)
        f = io.TextIOWrapper(zf.open(nomes[0]), encoding='latin-1', newline='')
    else:
        f = open(caminho, encoding='latin-1', newline='')
    return csv.DictReader(f, delimiter=';', quotechar='"')


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
    HD = ['ANO_ELEICAO', 'NR_TURNO', 'SG_UF', 'CD_MUNICIPIO', 'NM_MUNICIPIO', 'NR_ZONA', 'NR_SECAO', 'CD_CARGO', 'QT_APTOS', 'QT_COMPARECIMENTO', 'QT_ABSTENCOES']
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
                            wb.writerow([2026, turno, uf, mun, 'MUN%d' % mun, zona, secao, 1, aptos, comp, aptos - comp])
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
    print('SELFTEST OK')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--modo', choices=['base2026', 'backtest'])
    ap.add_argument('--votos', nargs='+'), ap.add_argument('--detalhe', nargs='+'), ap.add_argument('--out')
    ap.add_argument('--membro-votos', dest='membro_votos'), ap.add_argument('--membro-detalhe', dest='membro_detalhe')
    ap.add_argument('--cands'), ap.add_argument('--invalidos', help='números de candidaturas sem votos válidos, separados por vírgula'), ap.add_argument('--esperado'), ap.add_argument('--force', action='store_true')
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
    else:
        ap.print_help()
