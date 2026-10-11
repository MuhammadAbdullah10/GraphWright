"""Auto-mapping suggestions: columns → datatype properties → class nodes → relationships."""
from __future__ import annotations

import re
from difflib import SequenceMatcher

from .convert import XSD_NS
from .csvdata import CsvData
from .ontology import Ontology, local_name

NAME_PROPS = {"name", "label", "title", "id", "identifier", "code", "companyname", "clientname"}
TYPE_TO_XSD = {"integer": "xsd:integer", "decimal": "xsd:decimal", "date": "xsd:date", "boolean": "xsd:boolean"}


def norm(s: str) -> str:
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", s or "")
    return re.sub(r"[^a-z0-9]", "", s.lower())


def tokens(s: str) -> set[str]:
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", s or "")
    return {t for t in re.split(r"[^a-z0-9]+", s.lower()) if t}


def score(col: str, prop: dict) -> float:
    best = 0.0
    for cand in {prop["local"], prop["label"]}:
        a, b = norm(col), norm(cand)
        if not a or not b:
            continue
        if a == b:
            return 1.0
        r = SequenceMatcher(None, a, b).ratio()
        ta, tb = tokens(col), tokens(cand)
        if ta and tb:
            overlap = len(ta & tb) / max(len(tb), 1)
            r = max(r, 0.55 + 0.4 * overlap if overlap else r)
        if b in a and len(b) >= 4:
            r = max(r, 0.8)
        best = max(best, r)
    return best


def range_to_dt(prop: dict, column_type: str) -> str:
    for r in prop.get("range", []):
        if r.startswith(XSD_NS):
            return "xsd:" + r[len(XSD_NS):]
    return TYPE_TO_XSD.get(column_type, "xsd:string")


def default_format(dt: str, profile: dict) -> str:
    if dt in ("xsd:date", "xsd:dateTime"):
        samples = profile.get("samples", [])
        if samples and all(re.match(r"^\d{4}-\d{2}-\d{2}", s) for s in samples):
            return "iso"
        return "auto-dmy"
    if dt in ("xsd:decimal", "xsd:double", "xsd:float"):
        if any(str(s).strip().endswith("%") for s in profile.get("samples", [])):
            return "percent-fraction"
    return ""


def suggest(onto: Ontology, data: CsvData, existing: dict | None = None) -> dict:
    existing = existing or {}
    taken_cols = {p.get("column") for n in existing.get("nodes", []) for p in n.get("props", [])}
    matches = []
    for col in data.headers:
        if col in taken_cols:
            continue
        best, best_s = None, 0.0
        for p in onto.datatype_props:
            s = score(col, p)
            # prefix match on class name helps: company_name -> PortfolioCompany.name
            if s < 1.0 and p["domain"]:
                for d in p["domain"]:
                    cl = norm(local_name(d))
                    if norm(col) == cl + norm(p["local"]) or norm(col) == norm(p["local"]):
                        s = max(s, 0.97)
                    elif any(t in cl for t in tokens(col) if len(t) > 3) and norm(p["local"]) in norm(col):
                        s = max(s, 0.93)
            if s > best_s:
                best, best_s = p, s
        if best and best_s >= 0.72:
            matches.append((col, best, best_s))

    # group by first domain class
    by_class: dict[str, list] = {}
    unassigned = []
    for col, prop, s in matches:
        if prop["domain"]:
            by_class.setdefault(prop["domain"][0], []).append((col, prop, s))
        else:
            unassigned.append((col, prop, s))

    existing_ids = {n.get("id") for n in existing.get("nodes", [])}
    nodes = []
    for cls, items in by_class.items():
        base = re.sub(r"[^a-z0-9]", "", local_name(cls).lower()) or "node"
        nid, k = base, 2
        while nid in existing_ids:
            nid, k = f"{base}{k}", k + 1
        existing_ids.add(nid)
        # one column per property: keep the best scoring
        best_per_prop: dict[str, tuple] = {}
        for col, prop, s in items:
            if prop["iri"] not in best_per_prop or s > best_per_prop[prop["iri"]][2]:
                best_per_prop[prop["iri"]] = (col, prop, s)
        props, name_col = [], None
        for i, (col, prop, s) in enumerate(sorted(best_per_prop.values(), key=lambda x: data.headers.index(x[0]))):
            dt = range_to_dt(prop, data.profile[col]["type"])
            props.append({"id": f"{nid}_p{i + 1}", "propIri": prop["iri"], "source": "column", "column": col,
                          "constant": "", "datatype": dt, "format": default_format(dt, data.profile[col]),
                          "lang": "", "userEntered": False, "confidence": round(s, 2)})
            if norm(prop["local"]) in NAME_PROPS and name_col is None:
                name_col = col
        naming = {"mode": "auto", "prefix": local_name(cls) + "_", "pad": 0, "template": "", "list": "",
                  "listMatch": "order", "listKey": "", "onMissing": "auto", "collision": "merge"}
        if name_col:
            naming.update(mode="template", template="{" + name_col + "|pascal}")
        nodes.append({"id": nid, "label": onto.label(cls), "classIri": cls, "scope": "row", "requireData": True,
                      "naming": naming, "props": props})

    # relationships between all nodes (existing + new) via object properties
    all_nodes = list(existing.get("nodes", [])) + nodes
    existing_links = {(l.get("from"), l.get("prop"), l.get("to")) for l in existing.get("links", [])}
    links = []
    for p in onto.object_props:
        if not p["domain"] or not p["range"]:
            continue
        srcs = [n for n in all_nodes if n.get("classIri") and set(p["domain"]) & onto.class_and_ancestors(n["classIri"])]
        tgts = [n for n in all_nodes if n.get("classIri") and set(p["range"]) & onto.class_and_ancestors(n["classIri"])]
        for a in srcs:
            for b in tgts:
                if a["id"] == b["id"] or (a["id"], p["iri"], b["id"]) in existing_links:
                    continue
                links.append({"id": f"l_{a['id']}_{local_name(p['iri'])}_{b['id']}", "from": a["id"], "prop": p["iri"], "to": b["id"]})
    return {
        "nodes": nodes,
        "links": links,
        "unassigned": [{"column": c, "prop": p["iri"], "score": round(s, 2)} for c, p, s in unassigned],
        "matched": len(matches),
    }
