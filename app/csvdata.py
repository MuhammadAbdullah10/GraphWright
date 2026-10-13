"""CSV loading and column profiling."""
from __future__ import annotations

import csv
import io

from .convert import parse_bool, parse_date, parse_number


class CsvData:
    def __init__(self, filename: str, headers: list[str], rows: list[dict[str, str]], delimiter: str):
        self.filename = filename
        self.headers = headers
        self.rows = rows
        self.delimiter = delimiter
        self.profile = {h: profile_column([r.get(h, "") for r in rows]) for h in headers}

    @classmethod
    def parse(cls, data: bytes, filename: str) -> "CsvData":
        text = None
        for enc in ("utf-8-sig", "cp1252", "latin-1"):
            try:
                text = data.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        if text is None:
            raise ValueError("Could not decode the file. Save it as UTF-8 and try again.")
        sample = text[:20000]
        try:
            delimiter = csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
        except csv.Error:
            delimiter = ","
        reader = csv.reader(io.StringIO(text), delimiter=delimiter)
        all_rows = [r for r in reader if any(c.strip() for c in r)]
        if not all_rows:
            raise ValueError("The CSV file is empty.")
        raw_headers = all_rows[0]
        headers: list[str] = []
        for i, h in enumerate(raw_headers):
            h = h.strip() or f"column_{i + 1}"
            base, n = h, 2
            while h in headers:
                h = f"{base}_{n}"
                n += 1
            headers.append(h)
        rows = []
        for r in all_rows[1:]:
            rows.append({h: (r[i].strip() if i < len(r) else "") for i, h in enumerate(headers)})
        return cls(filename, headers, rows, delimiter)

    def summary(self, preview: int = 25) -> dict:
        return {
            "filename": self.filename,
            "headers": self.headers,
            "rowCount": len(self.rows),
            "delimiter": self.delimiter,
            "preview": self.rows[:preview],
            "profile": self.profile,
        }


def profile_column(values: list[str]) -> dict:
    filled = [v for v in values if v.strip()]
    kind = "empty"
    if filled:
        checks = [
            ("boolean", lambda v: parse_bool(v) is not None and v.strip().lower() not in ("1", "0")),
            ("integer", lambda v: (n := parse_number(v, "plain")) is not None and float(n) == int(float(n)) and "." not in v),
            ("decimal", lambda v: parse_number(v, "plain") is not None),
            ("date", lambda v: parse_date(v, "auto-dmy") is not None and len(v) >= 6),
        ]
        kind = "string"
        for name, fn in checks:
            if all(fn(v) for v in filled[:200]):
                kind = name
                break
    uniques = len(set(filled))
    return {
        "type": kind,
        "filled": len(filled),
        "total": len(values),
        "unique": uniques,
        "samples": list(dict.fromkeys(filled))[:4],
    }
