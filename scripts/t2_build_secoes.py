#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""t2_build_secoes.py — Base POR SEÇÃO do 1º turno de 2026 (Presidente) para o app "Placar 2T Seção".

Gera um arquivo por UF, data/t2/secoes/<uf>.json (uf minúscula; exterior = zz.json):
  {"v":1, "uf":"AC", "rows":[...], "zonas":{ "AC|01066|0004": { "0077":[x0..x9], "0078":[...], ... }, ... }}
O vetor de cada seção segue EXATAMENTE as mesmas rows e os mesmos critérios de data/t2/base-2026-1t.json
(candidatos de --cands/base, "demais" = D, branco, nulo DERIVADO, abstenção = aptos - comparecimento, --invalidos fora dos válidos).
Reaproveita abrir/col/chave/codigos_invalidos de t2_build_base.py (sem alterá-lo).

SEÇÕES AGREGADAS: o índice "cs" do TSE lista também seções agregadas (campo "nsp"); elas NÃO têm linha nos dados abertos
(os votos vão na seção principal). Logo aqui só existem as seções principais, e o total por zona confere com "s.ts" do EA20.

VERIFICAÇÃO (sempre feita ao final, contra --base): para cada zona, soma das seções = x da zona na base.
Diferença esperada: só nas linhas N e A, quando alguma seção tem comparecimento < válidos+brancos (ou aptos < comparecimento) e o zero-clamp
por seção difere do zero-clamp por zona. A tolerância (--tol, padrão 0,01% do eleitorado total) vale para a soma de |dif| em todo o país;
estourar a tolerância é erro. Zonas com diferença são listadas (até 10).

EXEMPLOS (zips são dados não confiáveis: use sempre python3 -I; caminhos como argumento)
  python3 -I scripts/t2_build_secoes.py --votos ~/dl/votacao_secao_2026_BR.zip --detalhe ~/dl/detalhe_votacao_secao_2026.zip
  python3 -I scripts/t2_build_secoes.py --selftest
"""
import argparse, csv, json, os, random, sys, tempfile, shutil

# python3 -I não põe a pasta do script no sys.path: adiciona só a pasta deste arquivo (código do projeto, confiável).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import t2_build_base as B0   # noqa: E402  (abrir, col, chave, codigos_invalidos, UFS)

csv.field_size_limit(2 ** 31 - 1)

MEMBRO_VOTOS = 'votacao_secao_2026_BR.csv'
MEMBRO_DETALHE = 'detalhe_votacao_secao_2026_BR.csv'   # só o _BR tem o Presidente; _BRASIL.csv é estadual/federal
RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE_PADRAO = os.path.join(RAIZ, 'data', 't2', 'base-2026-1t.json')
SAIDA_PADRAO = os.path.join(RAIZ, 'data', 't2', 'secoes')


def sec4(v):
    return '%04d' % int(v)


def ler_votos(caminhos, membro, num2idx, idxD, invalidos, turno=1):
    """Um passe em streaming. Devolve {(uf,mun,zona,secao): [c0..c5, D, branco95]} (votos de candidaturas por linha de rows)."""
    out = {}
    n = 0
    for caminho in B0.lista(caminhos):
        rd = B0.abrir(caminho, membro)
        H = rd.fieldnames
        iT, iC, iU, iM, iZ, iS, iV, iQ = [H.index(B0.col(H, k)) for k in ('turno', 'cargo', 'uf', 'mun', 'zona', 'secao', 'votavel', 'votos')]
        sturno = str(turno)
        for r in rd.reader:
            if r[iC] != '1' or r[iT] != sturno:
                continue
            k = (r[iU].strip().upper(), int(r[iM]), int(r[iZ]), int(r[iS]))
            acc = out.get(k)
            if acc is None:
                acc = out[k] = [0] * (idxD + 2)
            num = r[iV].strip()
            q = int(r[iQ] or 0)
            if num == '95':
                acc[idxD + 1] += q
            elif num == '96' or num in invalidos:
                continue
            else:
                acc[num2idx.get(num, idxD)] += q
            n += 1
    print('linhas de votos lidas (Presidente, %do turno): %d | seções: %d' % (turno, n, len(out)), file=sys.stderr)
    return out


def ler_detalhe(caminhos, membro, turno=1):
    """{(uf,mun,zona,secao): [aptos, comp, brancos|None]} — primeira ocorrência de cada seção vale (como t2_build_base)."""
    out = {}
    for caminho in B0.lista(caminhos):
        rd = B0.abrir(caminho, membro)
        H = rd.fieldnames
        iT, iC, iU, iM, iZ, iS, iA, iP = [H.index(B0.col(H, k)) for k in ('turno', 'cargo', 'uf', 'mun', 'zona', 'secao', 'aptos', 'comp')]
        cB = B0.col(H, 'brancos', False)
        iB = H.index(cB) if cB else None
        sturno = str(turno)
        for r in rd.reader:
            if r[iC] != '1' or r[iT] != sturno:
                continue
            k = (r[iU].strip().upper(), int(r[iM]), int(r[iZ]), int(r[iS]))
            if k in out:
                continue
            out[k] = [int(r[iA] or 0), int(r[iP] or 0), (int(r[iB] or 0) if iB is not None else None)]
    print('seções no detalhe: %d' % len(out), file=sys.stderr)
    return out


def montar(votos, det, rows, idxD):
    """-> (zonas {id:{secao:[x...]}}, sem_detalhe). x na ordem de rows: cands..., D, B, N, A (mesmos critérios de montar_x)."""
    zonas = {}
    sem_detalhe = 0
    for k in sorted(votos):
        d = det.get(k)
        if d is None:
            sem_detalhe += 1
            continue
        v = votos[k]
        aptos, comp, brancos = d
        b = brancos if brancos is not None else v[idxD + 1]
        total_cand = sum(v[:idxD + 1])
        n = max(0, comp - total_cand - b)
        a = max(0, aptos - comp)
        x = v[:idxD + 1] + [b, n, a]
        zid = '%s|%05d|%04d' % (k[0], k[1], k[2])
        zonas.setdefault(zid, {})[sec4(k[3])] = x
    return zonas, sem_detalhe


def verificar(zonas, base, tol_rel):
    """Compara soma das seções com x da zona na base. Devolve dict de resultados; levanta SystemExit se estourar a tolerância."""
    bx = {u['id']: u for u in base['unidades']}
    K = len(base['rows'])
    exatas = 0
    difs = []
    soma_abs = 0
    so_na_base = [i for i in bx if i not in zonas]
    so_nas_secoes = [i for i in zonas if i not in bx]
    for zid, secs in zonas.items():
        u = bx.get(zid)
        if not u:
            continue
        s = [0] * K
        for x in secs.values():
            for i in range(K):
                s[i] += x[i]
        d = [s[i] - u['x'][i] for i in range(K)]
        if any(d):
            difs.append((zid, d))
            soma_abs += sum(abs(t) for t in d)
        else:
            exatas += 1
    sec_base = sum(u.get('secoes', 0) for u in bx.values())
    sec_aqui = sum(len(s) for s in zonas.values())
    E = sum(u['E'] for u in bx.values())
    res = {'zonas': len(zonas), 'exatas': exatas, 'com_dif': len(difs), 'soma_abs_dif': soma_abs, 'eleitorado_base': E,
           'so_na_base': len(so_na_base), 'so_nas_secoes': len(so_nas_secoes), 'secoes': sec_aqui, 'secoes_base': sec_base}
    print('verificação contra a base: %d zonas | %d exatas | %d com diferença (soma |dif| = %d, %.5f%% do eleitorado) | seções %d (base: %d) | zonas só na base: %d, só aqui: %d'
          % (res['zonas'], exatas, len(difs), soma_abs, 100.0 * soma_abs / max(1, E), sec_aqui, sec_base, len(so_na_base), len(so_nas_secoes)))
    for zid, d in sorted(difs, key=lambda t: -sum(abs(q) for q in t[1]))[:10]:
        print('  dif %s: %s' % (zid, dict((base['rows'][i], d[i]) for i in range(K) if d[i])))
    if so_na_base or so_nas_secoes:
        print('  (exemplos) só na base: %s | só aqui: %s' % (so_na_base[:3], so_nas_secoes[:3]))
    if soma_abs > tol_rel * max(1, E):
        raise SystemExit('ERRO: diferença total %d acima da tolerância (%.4f%% do eleitorado = %d)' % (soma_abs, 100 * tol_rel, tol_rel * E))
    if sec_aqui != sec_base:
        print('AVISO: nº de seções difere da base (%d x %d)' % (sec_aqui, sec_base), file=sys.stderr)
    return res


def gravar_ufs(zonas, rows, outdir):
    os.makedirs(outdir, exist_ok=True)
    por_uf = {}
    for zid, secs in zonas.items():
        por_uf.setdefault(zid.split('|')[0], {})[zid] = secs
    total = 0
    for uf in sorted(por_uf):
        caminho = os.path.join(outdir, uf.lower() + '.json')
        with open(caminho, 'w', encoding='utf-8') as f:
            json.dump({'v': 1, 'uf': uf, 'rows': rows, 'zonas': por_uf[uf]}, f, ensure_ascii=False, separators=(',', ':'))
        tam = os.path.getsize(caminho)
        total += tam
        print('  %s: %d zonas | %d seções | %.1f KB' % (uf, len(por_uf[uf]), sum(len(s) for s in por_uf[uf].values()), tam / 1024.0))
    print('gravado em %s | %d arquivos | %.2f MB no total' % (outdir, len(por_uf), total / 1048576.0))
    return total


def construir(args):
    base = json.load(open(args.base, encoding='utf-8'))
    rows = base['rows']
    cands = rows[:rows.index('D')]
    num2idx = {}
    for i, r in enumerate(cands):
        num2idx[str(base['candidatos'][r]['numero'])] = i
    idxD = rows.index('D')
    if rows[idxD:] != ['D', 'B', 'N', 'A']:
        raise SystemExit('rows da base inesperadas: ' + str(rows))
    invalidos = B0.codigos_invalidos(args.invalidos)
    votos = ler_votos(args.votos, args.membro_votos, num2idx, idxD, invalidos)
    det = ler_detalhe(args.detalhe, args.membro_detalhe)
    zonas, sem_det = montar(votos, det, rows, idxD)
    if sem_det:
        print('AVISO: %d seções com votos mas sem detalhe foram ignoradas' % sem_det, file=sys.stderr)
    verificar(zonas, base, args.tol)
    gravar_ufs(zonas, rows, args.out)


# ---------------------------------------------------------------- selftest
def selftest():
    rnd = random.Random(11)
    tmp = tempfile.mkdtemp()
    try:
        fv, fd = os.path.join(tmp, 'votos.csv'), os.path.join(tmp, 'detalhe.csv')
        HV = ['ANO_ELEICAO', 'NR_TURNO', 'SG_UF', 'CD_MUNICIPIO', 'NM_MUNICIPIO', 'NR_ZONA', 'NR_SECAO', 'CD_CARGO', 'NR_VOTAVEL', 'NM_VOTAVEL', 'QT_VOTOS']
        HD = ['ANO_ELEICAO', 'NR_TURNO', 'SG_UF', 'CD_MUNICIPIO', 'NM_MUNICIPIO', 'NR_ZONA', 'NR_SECAO', 'CD_CARGO', 'QT_APTOS', 'QT_COMPARECIMENTO', 'QT_ABSTENCOES']
        linhas_v, linhas_d = [], []
        for turno in (1, 2):
            for uf in ('SP', 'AC', 'ZZ'):
                for mun in (71072, 1066, 5):
                    for zona in (1, 4):
                        for secao in rnd.sample(range(1, 200), 6):
                            aptos = rnd.randint(250, 420)
                            comp = int(aptos * rnd.uniform(0.7, 0.9))
                            br, nu, inval = rnd.randint(0, 6), rnd.randint(0, 10), 1
                            valid = comp - br - nu - inval
                            if turno == 1:
                                ids = ['13', '22', '70', '14', '55', '30', '80', '16']
                                cuts = sorted(rnd.randint(0, valid) for _ in range(len(ids) - 1))
                                parts = [b - a for a, b in zip([0] + cuts, cuts + [valid])]
                            else:
                                ids = ['13', '22']
                                l = rnd.randint(0, valid)
                                parts = [l, valid - l]
                            for nid, q in zip(ids, parts):
                                linhas_v.append([2026, turno, uf, mun, 'M', zona, secao, 1, nid, 'C' + nid, q])
                            linhas_v.append([2026, turno, uf, mun, 'M', zona, secao, 1, 28, 'INVALIDADO', inval])
                            linhas_v.append([2026, turno, uf, mun, 'M', zona, secao, 1, 95, 'Branco', br])
                            linhas_v.append([2026, turno, uf, mun, 'M', zona, secao, 1, 96, 'Nulo', nu])
                            linhas_v.append([2026, turno, uf, mun, 'M', zona, secao, 3, 13, 'OUTRO CARGO', 999])
                            linhas_d.append([2026, turno, uf, mun, 'M', zona, secao, 1, aptos, comp, aptos - comp])
        # caso de borda: seção com comparecimento menor que válidos+brancos (clamp do N difere entre seção e zona)
        linhas_v.append([2026, 1, 'AC', 1066, 'M', 1, 999, 1, 13, 'C13', 50])
        linhas_d.append([2026, 1, 'AC', 1066, 'M', 1, 999, 1, 300, 40, 260])
        rnd.shuffle(linhas_v)    # os dados reais NÃO vêm agrupados por seção
        rnd.shuffle(linhas_d)
        with open(fv, 'w', encoding='latin-1', newline='') as a, open(fd, 'w', encoding='latin-1', newline='') as b:
            wa, wb = csv.writer(a, delimiter=';', quoting=csv.QUOTE_ALL), csv.writer(b, delimiter=';', quoting=csv.QUOTE_ALL)
            wa.writerow(HV), wb.writerow(HD)
            wa.writerows(linhas_v), wb.writerows(linhas_d)
        # base da zona, gerada pelo próprio t2_build_base (a fonte da verdade)
        ns = argparse.Namespace(votos=fv, detalhe=fd, membro_votos=None, membro_detalhe=None, force=True, invalidos='28',
                                cands='L=13,F=22,CURY=70,SANTOS=14,CAIADO=55,ZEMA=30', out=os.path.join(tmp, 'base.json'), esperado=None)
        B0.base2026(ns)
        base = json.load(open(ns.out))
        outdir = os.path.join(tmp, 'secoes')
        a = argparse.Namespace(base=ns.out, votos=fv, detalhe=fd, membro_votos=None, membro_detalhe=None, invalidos='28', tol=1e-3, out=outdir)
        construir(a)
        arqs = sorted(os.listdir(outdir))
        assert arqs == ['ac.json', 'sp.json', 'zz.json'], arqs
        sp = json.load(open(os.path.join(outdir, 'sp.json')))
        assert sp['v'] == 1 and sp['uf'] == 'SP' and sp['rows'] == base['rows']
        # cada seção: soma(x) = aptos da seção; 1 seção só tem chave de 4 dígitos
        todas = {}
        for arq in arqs:
            j = json.load(open(os.path.join(outdir, arq)))
            for zid, secs in j['zonas'].items():
                assert zid.count('|') == 2 and len(zid.split('|')[1]) == 5 and len(zid.split('|')[2]) == 4
                for sid, x in secs.items():
                    assert len(sid) == 4 and len(x) == len(base['rows']) and all(isinstance(q, int) and q >= 0 for q in x)
                todas[zid] = secs
        assert len(todas) == len(base['unidades'])
        # soma das seções = zona (exata em todas, exceto a zona do caso de borda, onde só N/A podem diferir)
        K = len(base['rows'])
        iN, iA = base['rows'].index('N'), base['rows'].index('A')
        difs = 0
        for u in base['unidades']:
            s = [sum(x[i] for x in todas[u['id']].values()) for i in range(K)]
            for i in range(K):
                if s[i] != u['x'][i]:
                    assert i in (iN, iA) and u['id'] == 'AC|01066|0001', ('diferença inesperada', u['id'], base['rows'][i], s[i], u['x'][i])
                    difs += 1
        assert difs > 0, 'o caso de borda deveria produzir diferença em N/A (teste da tolerância)'
        # tolerância estourada -> erro
        try:
            verificar(todas, base, 0.0)
            raise AssertionError('deveria falhar com tolerância 0')
        except SystemExit:
            pass
        # seção da exterior e ordenação estável
        assert 'ZZ|00005|0001' in json.load(open(os.path.join(outdir, 'zz.json')))['zonas']
        print('SELFTEST OK')
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--votos', nargs='+', help='votacao_secao_2026_BR.zip (ou .csv)')
    ap.add_argument('--detalhe', nargs='+', help='detalhe_votacao_secao_2026.zip (ou .csv)')
    ap.add_argument('--membro-votos', dest='membro_votos', default=MEMBRO_VOTOS)
    ap.add_argument('--membro-detalhe', dest='membro_detalhe', default=MEMBRO_DETALHE)
    ap.add_argument('--base', default=BASE_PADRAO, help='base por zona (rows, candidatos e conferência)')
    ap.add_argument('--invalidos', default='28', help='números sem votos válidos (padrão: 28, como na base)')
    ap.add_argument('--tol', type=float, default=1e-4, help='tolerância da soma de |dif| em relação ao eleitorado total (padrão 0,01%%)')
    ap.add_argument('--out', default=SAIDA_PADRAO)
    ap.add_argument('--selftest', action='store_true')
    a = ap.parse_args()
    if a.selftest:
        selftest()
    elif a.votos and a.detalhe:
        construir(a)
    else:
        ap.print_help()
