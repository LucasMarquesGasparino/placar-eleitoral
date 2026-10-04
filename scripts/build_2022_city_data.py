#!/usr/bin/env python3
"""Build a compact city-level presidential result file from the TSE 2022 ZIP."""

import argparse
import csv
import io
import json
import zipfile
from collections import defaultdict
from pathlib import Path


SOURCE_URL = (
    "https://cdn.tse.jus.br/estatistica/sead/odsele/votacao_secao/"
    "votacao_secao_2022_BR.zip"
)
CSV_NAME = "votacao_secao_2022_BR.csv"
DEFAULT_ZIP = Path(__file__).resolve().parents[2] / "data" / "votacao_secao_2022_BR.zip"
DEFAULT_OUTPUT = Path(__file__).resolve().parents[2] / "data" / "2022-presidencia-cidades.json"
NON_CANDIDATE_NUMBERS = {"95", "96", "97", "98", "99"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("zip_path", nargs="?", type=Path, default=DEFAULT_ZIP)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    locations = {}
    candidate_codes = set()
    rows_read = 0

    with zipfile.ZipFile(args.zip_path) as archive:
        csv_name = next((name for name in archive.namelist() if name.endswith(CSV_NAME)), None)
        if csv_name is None:
            raise SystemExit(f"Não encontrei {CSV_NAME} dentro de {args.zip_path}")

        with archive.open(csv_name) as binary_file:
            text_file = io.TextIOWrapper(binary_file, encoding="cp1252", newline="")
            reader = csv.DictReader(text_file, delimiter=";")
            for row in reader:
                rows_read += 1
                if row.get("CD_CARGO") != "1" or row.get("NR_TURNO") not in {"1", "2"}:
                    continue

                uf = (row.get("SG_UF") or "").strip().upper()
                code = (row.get("CD_MUNICIPIO") or "").strip()
                name = (row.get("NM_MUNICIPIO") or "").strip()
                if not uf or not code or not name:
                    continue

                key = f"{uf}:{code}"
                location = locations.setdefault(
                    key,
                    {
                        "uf": uf,
                        "municipalityCode": code,
                        "name": name,
                        "isExterior": uf == "ZZ",
                        "rounds": {},
                    },
                )
                election_round = row["NR_TURNO"]
                round_data = location["rounds"].setdefault(
                    election_round, {"validVotes": 0, "candidates": {}}
                )

                number = (row.get("NR_VOTAVEL") or "").strip()
                candidate_name = (row.get("NM_VOTAVEL") or "").strip()
                try:
                    votes = int(row.get("QT_VOTOS") or 0)
                except ValueError:
                    votes = 0
                if votes <= 0 or not number or number in NON_CANDIDATE_NUMBERS:
                    continue

                candidate_codes.add((number, candidate_name))
                round_data["validVotes"] += votes
                candidate = round_data["candidates"].setdefault(
                    number, {"number": number, "name": candidate_name, "votes": 0}
                )
                candidate["votes"] += votes

    records = []
    for location in locations.values():
        for round_data in location["rounds"].values():
            round_data["candidates"] = sorted(
                round_data["candidates"].values(),
                key=lambda candidate: (int(candidate["number"]), candidate["name"]),
            )
        records.append(location)

    records.sort(key=lambda item: (item["uf"], item["name"], item["municipalityCode"]))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as output_file:
        json.dump(
            {
                "year": 2022,
                "source": SOURCE_URL,
                "dataset": "Resultados - 2022 - votação por seção eleitoral",
                "records": records,
            },
            output_file,
            ensure_ascii=False,
            separators=(",", ":"),
        )

    print(
        f"Gerado {args.output}: {len(records)} localidades, "
        f"{len(candidate_codes)} códigos/nome de candidatos, {rows_read:,} linhas lidas."
    )


if __name__ == "__main__":
    main()
