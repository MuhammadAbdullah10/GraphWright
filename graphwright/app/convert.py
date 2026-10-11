"""Value conversion from CSV strings to typed RDF literals."""
from __future__ import annotations

import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from rdflib import Literal, URIRef
from rdflib.namespace import RDF, XSD

XSD_NS = str(XSD)

DATE_FORMATS = {
    "iso": ["%Y-%m-%d"],
    "dd-mm-yyyy": ["%d-%m-%Y"],
    "mm-dd-yyyy": ["%m-%d-%Y"],
    "dd/mm/yyyy": ["%d/%m/%Y"],
    "mm/dd/yyyy": ["%m/%d/%Y"],
    "dd.mm.yyyy": ["%d.%m.%Y"],
    "yyyy/mm/dd": ["%Y/%m/%d"],
    "yyyymmdd": ["%Y%m%d"],
    "d mon yyyy": ["%d %b %Y", "%d %B %Y"],
    "mon d, yyyy": ["%b %d, %Y", "%B %d, %Y"],
}
_AUTO_COMMON = ["%Y-%m-%d", "%Y/%m/%d", "%Y%m%d", "%d %b %Y", "%d %B %Y", "%b %d, %Y", "%B %d, %Y", "%d-%b-%Y", "%d-%b-%y"]
AUTO_DMY = _AUTO_COMMON + ["%d-%m-%Y", "%d/%m/%Y", "%d.%m.%Y", "%d/%m/%y", "%d-%m-%y"]
AUTO_MDY = _AUTO_COMMON + ["%m-%d-%Y", "%m/%d/%Y", "%m.%d.%Y", "%m/%d/%y", "%m-%d-%y"]

TRUE = {"true", "yes", "y", "1", "t"}
FALSE = {"false", "no", "n", "0", "f"}

_NUM_CLEAN = re.compile(r"[\s,$€£¥₹]|\b(USD|EUR|GBP|INR|JPY)\b", re.I)


def expand_xsd(dt: str) -> str:
    if not dt:
        return XSD_NS + "string"
    if dt.startswith("xsd:"):
        return XSD_NS + dt[4:]
    return dt


def short_dt(dt: str) -> str:
    return "xsd:" + dt[len(XSD_NS):] if dt.startswith(XSD_NS) else dt


def parse_number(value: str, fmt: str = "plain") -> Decimal | None:
    v = (value or "").strip()
    if not v:
        return None
    negative = False
    if v.startswith("(") and v.endswith(")"):  # accounting negative: (1,200)
        negative, v = True, v[1:-1]
    percent = v.endswith("%")
    if percent:
        v = v[:-1]
    v = _NUM_CLEAN.sub("", v)
    if v.startswith("-") and negative:
        return None
    try:
        n = Decimal(v)
    except InvalidOperation:
        return None
    if not n.is_finite():
        return None
    if negative:
        n = -n
    if percent and fmt == "percent-fraction":
        n = n / Decimal(100)
    return n


def parse_date(value: str, fmt: str = "auto-dmy") -> date | None:
    v = (value or "").strip()
    if not v:
        return None
    if fmt in DATE_FORMATS:
        patterns = DATE_FORMATS[fmt]
    elif fmt == "auto-mdy":
        patterns = AUTO_MDY
    else:
        patterns = AUTO_DMY
    # ISO date-times count as dates (take the date part)
    if "T" in v and fmt.startswith("auto"):
        try:
            return datetime.fromisoformat(v.replace("Z", "+00:00")).date()
        except ValueError:
            pass
    for p in patterns:
        try:
            return datetime.strptime(v, p).date()
        except ValueError:
            continue
    return None


def parse_datetime(value: str, fmt: str = "auto-dmy") -> datetime | None:
    v = (value or "").strip()
    if not v:
        return None
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        pass
    for p in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%d/%m/%Y %H:%M", "%d-%m-%Y %H:%M", "%m/%d/%Y %H:%M"):
        try:
            return datetime.strptime(v, p)
        except ValueError:
            continue
    d = parse_date(v, fmt)
    return datetime(d.year, d.month, d.day) if d else None


def parse_bool(value: str) -> bool | None:
    v = (value or "").strip().lower()
    if v in TRUE:
        return True
    if v in FALSE:
        return False
    return None


INTEGER_TYPES = {"integer", "int", "long", "short", "byte", "nonNegativeInteger", "positiveInteger",
                 "negativeInteger", "nonPositiveInteger", "unsignedInt", "unsignedLong", "unsignedShort"}


def to_literal(value: str, datatype: str, fmt: str = "", lang: str = "") -> tuple[Literal | None, str | None]:
    """Convert a raw CSV string into a typed literal. Returns (literal, error)."""
    raw = (value or "").strip()
    if raw == "":
        return None, None
    dt = expand_xsd(datatype)
    name = dt[len(XSD_NS):] if dt.startswith(XSD_NS) else ""

    if dt == str(RDF.langString) or (name == "string" and lang):
        return Literal(raw, lang=lang or None), None
    if name in ("string", "normalizedString", "token", ""):
        if not name and dt and dt != XSD_NS + "string":
            return Literal(raw, datatype=URIRef(dt)), None
        return Literal(raw, datatype=XSD.string), None
    if name in INTEGER_TYPES:
        n = parse_number(raw, "plain")
        if n is None or n != n.to_integral_value():
            return None, f"'{raw}' is not a whole number"
        return Literal(int(n), datatype=URIRef(dt)), None
    if name in ("decimal", "double", "float"):
        n = parse_number(raw, fmt or "plain")
        if n is None:
            return None, f"'{raw}' is not a number"
        if name == "decimal":
            return Literal(n, datatype=XSD.decimal), None
        return Literal(float(n), datatype=URIRef(dt)), None
    if name == "boolean":
        b = parse_bool(raw)
        if b is None:
            return None, f"'{raw}' is not true/false"
        return Literal(b, datatype=XSD.boolean), None
    if name == "date":
        d = parse_date(raw, fmt or "auto-dmy")
        if d is None:
            return None, f"'{raw}' is not a date in the chosen format"
        return Literal(d.isoformat(), datatype=XSD.date), None
    if name == "dateTime":
        d = parse_datetime(raw, fmt or "auto-dmy")
        if d is None:
            return None, f"'{raw}' is not a date-time"
        return Literal(d.isoformat(), datatype=XSD.dateTime), None
    if name == "gYear":
        m = re.match(r"^(?:FY)?\s*(\d{4})$", raw, re.I)
        if not m:
            return None, f"'{raw}' is not a year"
        return Literal(m.group(1), datatype=XSD.gYear), None
    if name == "anyURI":
        return Literal(raw, datatype=XSD.anyURI), None
    return Literal(raw, datatype=URIRef(dt)), None
