"""Provenance driven by patterns, not code.

A pattern has three parts (see presets/provenance.json):
  write         SPARQL INSERT template run once per user-entered value
  read          SPARQL graph pattern that finds those records again
  declarations  Turtle added once for vocabulary the ontology lacks
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from rdflib import Graph, Literal, URIRef
from rdflib.namespace import XSD

from .engine import sanitize_local

PRESET_FILE = Path(__file__).resolve().parent / "presets" / "provenance.json"
DEFAULT_PRESET = "axiom-text"
STD_PREFIXES = {
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
    "owl": "http://www.w3.org/2002/07/owl#",
    "xsd": "http://www.w3.org/2001/XMLSchema#",
}
VARS = ("subject", "property", "value", "user", "userIri", "time", "flag", "class")


class ProvenanceError(ValueError):
    pass


def load_presets() -> list[dict]:
    try:
        data = json.loads(PRESET_FILE.read_text(encoding="utf-8"))
        return [p for p in data.get("presets", []) if p.get("id") and p.get("read")]
    except (OSError, json.JSONDecodeError) as e:  # a broken preset file must not stop the app
        raise ProvenanceError(f"Could not read {PRESET_FILE.name}: {e}") from e


def prefix_block(onto) -> str:
    seen, lines = set(), []
    for p, ns in [("", onto.namespace), *STD_PREFIXES.items(), *((p, str(n)) for p, n in onto.graph.namespaces())]:
        if p in seen:
            continue
        seen.add(p)
        lines.append(f"PREFIX {p}: <{ns}>")
    return "\n".join(lines) + "\n"


def resolve(settings: dict) -> dict:
    """Turn the provenance settings into a concrete pattern {id, name, write, read, declarations}."""
    prov = (settings or {}).get("provenance") or {}
    preset_id = prov.get("pattern")
    if not preset_id:  # files saved before patterns existed
        preset_id = DEFAULT_PRESET if prov.get("writeAxioms", True) else "flag-only"
    if preset_id == "custom":
        custom = prov.get("custom") or {}
        if not (custom.get("read") or "").strip():
            raise ProvenanceError("A custom provenance pattern needs a 'read' pattern.")
        return {"id": "custom", "name": "Custom", "write": custom.get("write", ""),
                "read": custom["read"], "declarations": custom.get("declarations", "")}
    for p in load_presets():
        if p["id"] == preset_id:
            return p
    raise ProvenanceError(f"Unknown provenance pattern '{preset_id}'. Choose one from the list or use 'custom'.")


def flag_iri(settings: dict, onto) -> URIRef:
    return URIRef((settings or {}).get("userEditedIri") or onto.namespace + "userEdited")


def _cell(term) -> str:
    return "UNDEF" if term is None else term.n3()


def write(graph: Graph, onto, settings: dict, events: list[dict], data_ns: str) -> dict:
    """Apply the write template for every event. Each event: subject, property, value, user, time, class."""
    pattern = resolve(settings)
    template = (pattern.get("write") or "").strip()
    if not events or not template:
        return {"pattern": pattern["id"], "records": 0, "triples": 0}
    flag = flag_iri(settings, onto)
    rows = []
    for e in events:
        user = (e.get("user") or "").strip()
        rows.append("(" + " ".join(_cell(t) for t in (
            URIRef(e["subject"]), URIRef(e["property"]), e.get("value"),
            Literal(user) if user else None,
            URIRef(data_ns + "user_" + sanitize_local(user)) if user and sanitize_local(user) else None,
            Literal(e["time"], datatype=XSD.dateTime) if e.get("time") else None,
            flag, URIRef(e["class"]) if e.get("class") else None,
        )) + ")")
    query = (prefix_block(onto) + "INSERT {\n" + template + "\n}\nWHERE {\n  VALUES (" +
             " ".join("?" + v for v in VARS) + ") {\n    " + "\n    ".join(rows) + "\n  }\n}")
    before = len(graph)
    try:
        graph.update(query)
    except Exception as e:
        raise ProvenanceError(f"The provenance 'write' pattern is not valid SPARQL: {str(e).splitlines()[0].split(' (at char')[0][:300]}") from e
    added = len(graph) - before
    decl = (pattern.get("declarations") or "").strip()
    if decl:
        d = Graph()
        try:
            d.parse(data=prefix_block(onto).replace("PREFIX ", "@prefix ").replace(">\n", "> .\n") + decl, format="turtle")
        except Exception as e:
            raise ProvenanceError(f"The provenance 'declarations' are not valid Turtle: {str(e).splitlines()[0][:300]}") from e
        for t in d:
            if t not in onto.graph:
                graph.add(t)
    return {"pattern": pattern["id"], "records": len(events), "triples": added}


def read_body(onto, settings: dict) -> str:
    """The read pattern with ?flag bound, ready to drop into a WHERE clause."""
    pattern = resolve(settings)
    return f"VALUES ?flag {{ <{flag_iri(settings, onto)}> }}\n" + pattern["read"]


def read_query(onto, settings: dict, select: str = "?subject ?property ?user ?time") -> str:
    return (prefix_block(onto) + f"SELECT DISTINCT {select} WHERE {{\n  "
            + read_body(onto, settings).replace("\n", "\n  ") + "\n}")


def index(graph: Graph, onto, settings: dict) -> dict[str, dict[str, list[dict]]]:
    """subject -> property -> [{by, at}] built from the read pattern."""
    out: dict[str, dict[str, list[dict]]] = {}
    try:
        res = graph.query(read_query(onto, settings))
    except Exception:
        return out
    for row in res:
        s, p, u, t = row
        if s is None or p is None:
            continue
        edits = out.setdefault(str(s), {}).setdefault(str(p), [])
        if u is not None or t is not None:
            edits.append({"by": str(u) if u is not None else None, "at": str(t) if t is not None else None})
    for props in out.values():
        for k in props:
            props[k].sort(key=lambda e: e["at"] or "", reverse=True)
    return out


def preview(onto, settings: dict) -> str:
    """Turtle showing what one user-entered value would look like with the current pattern."""
    ns = onto.namespace
    g = Graph()
    for p, n in onto.graph.namespaces():
        g.bind(p, n, override=True)
    g.bind("", ns, override=True)
    subject, prop = URIRef(ns + "ABC_Company"), URIRef(ns + "sector")
    g.add((subject, prop, Literal("IT")))
    write(g, onto, settings, [{"subject": subject, "property": prop, "value": Literal("IT"), "user": "jsmith@firm.com",
                               "time": datetime(2026, 10, 10, 14, 35, 10, tzinfo=timezone.utc).isoformat().replace("+00:00", "Z"),
                               "class": ns + "PortfolioCompany"}], ns)
    for t in list(g):
        if t in onto.graph:
            g.remove(t)
    return g.serialize(format="turtle")
