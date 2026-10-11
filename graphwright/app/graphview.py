"""Turn the RDF graph into Cytoscape elements and node detail payloads; run SPARQL."""
from __future__ import annotations

import re
import time

from rdflib import BNode, Graph, Literal, URIRef
from rdflib.namespace import OWL, RDF, RDFS, XSD

from .convert import short_dt
from .ontology import META_TYPES, local_name

UPDATE_RE = re.compile(r"^\s*(INSERT|DELETE|LOAD|CLEAR|CREATE|DROP|COPY|MOVE|ADD|WITH)\b", re.I)
PROLOGUE_RE = re.compile(r"^\s*((PREFIX\s+[\w\-]*:\s*<[^>]*>|BASE\s+<[^>]*>|#[^\n]*)\s*)*", re.I)
MAX_ROWS = 5000


def qn(g: Graph, term) -> str:
    if isinstance(term, URIRef):
        try:
            q = g.namespace_manager.normalizeUri(term)
            return local_name(term) if q.startswith("<") else q
        except Exception:
            return local_name(term)
    return str(term)


def term_json(g: Graph, t) -> dict | None:
    if t is None:
        return None
    if isinstance(t, URIRef):
        return {"type": "uri", "value": str(t), "short": qn(g, t)}
    if isinstance(t, BNode):
        return {"type": "bnode", "value": "_:" + str(t), "short": "_:" + str(t)[:8]}
    if isinstance(t, Literal):
        return {"type": "literal", "value": str(t), "datatype": short_dt(str(t.datatype)) if t.datatype else "",
                "lang": t.language or ""}
    return {"type": "literal", "value": str(t)}


def label_of(g: Graph, s) -> str:
    for v in g.objects(s, RDFS.label):
        return str(v)
    return local_name(s) if isinstance(s, URIRef) else str(s)[:10]


def individuals(g: Graph) -> dict[URIRef, list[URIRef]]:
    out: dict[URIRef, list[URIRef]] = {}
    for s, t in g.subject_objects(RDF.type):
        if isinstance(s, URIRef) and isinstance(t, URIRef) and t not in META_TYPES:
            if (s, RDF.type, OWL.Class) in g or (s, RDF.type, RDFS.Class) in g:
                continue
            out.setdefault(s, []).append(t)
    return out


def cyto_elements(g: Graph, user_edited: URIRef, show_classes: bool, show_literals: bool, inferred: Graph | None = None, limit: int = 2500) -> dict:
    inf = inferred if inferred is not None else Graph()
    inds = individuals(g)
    truncated = len(inds) > limit
    keep = dict(list(inds.items())[:limit])
    nodes, edges = [], []
    classes_used: dict[str, int] = {}
    for s, types in keep.items():
        lits = sum(1 for _, o in g.predicate_objects(s) if isinstance(o, Literal))
        edited = sum(1 for _ in g.objects(s, user_edited))
        asserted_types = [t for t in types if (s, RDF.type, t) not in inf] or types
        primary = sorted(asserted_types, key=lambda t: str(t))[0]
        nodes.append({"data": {
            "id": str(s), "label": label_of(g, s), "kind": "individual", "cls": str(primary),
            "clsLabel": local_name(primary), "types": [str(t) for t in types], "literals": lits, "edited": edited,
            "inferredTypes": sum(1 for t in types if (s, RDF.type, t) in inf),
        }})
        classes_used[str(primary)] = classes_used.get(str(primary), 0) + 1
    ids = {str(s) for s in keep}
    eid = 0
    for s in keep:
        for p, o in g.predicate_objects(s):
            if p in (RDF.type, user_edited):
                continue
            if isinstance(o, URIRef) and str(o) in ids:
                eid += 1
                edges.append({"data": {"id": f"e{eid}", "source": str(s), "target": str(o), "label": local_name(p), "prop": str(p),
                                       "kind": "inferred" if (s, p, o) in inf else "link"}})
            elif show_literals and isinstance(o, Literal):
                eid += 1
                lid = f"lit{eid}"
                val = str(o)
                nodes.append({"data": {"id": lid, "label": val if len(val) <= 28 else val[:26] + "…", "kind": "literal",
                                       "full": val, "datatype": short_dt(str(o.datatype)) if o.datatype else "", "owner": str(s), "prop": str(p)}})
                edges.append({"data": {"id": f"e{eid}", "source": str(s), "target": lid, "label": local_name(p), "prop": str(p), "kind": "literal"}})
    if show_classes:
        cls_ids = set()
        for s, types in keep.items():
            for t in types:
                cls_ids.add(t)
                eid += 1
                edges.append({"data": {"id": f"e{eid}", "source": str(s), "target": "class:" + str(t), "label": "a", "kind": "type"}})
        # include ancestors so the hierarchy is visible
        frontier = list(cls_ids)
        while frontier:
            c = frontier.pop()
            for parent in g.objects(c, RDFS.subClassOf):
                if isinstance(parent, URIRef):
                    eid += 1
                    edges.append({"data": {"id": f"e{eid}", "source": "class:" + str(c), "target": "class:" + str(parent), "label": "subClassOf", "kind": "subclass"}})
                    if parent not in cls_ids:
                        cls_ids.add(parent)
                        frontier.append(parent)
        for c in cls_ids:
            nodes.append({"data": {"id": "class:" + str(c), "label": label_of(g, c), "kind": "class", "cls": str(c), "clsLabel": local_name(c)}})
    return {"elements": {"nodes": nodes, "edges": edges}, "truncated": truncated, "individualCount": len(inds),
            "classes": [{"iri": k, "label": local_name(k), "count": v} for k, v in sorted(classes_used.items(), key=lambda x: -x[1])]}


def node_detail(g: Graph, iri: str, meta: dict, user_edited: URIRef, ns: str, inferred: Graph | None = None) -> dict:
    inf = inferred if inferred is not None else Graph()
    if iri.startswith("class:"):
        iri = iri[6:]
    s = URIRef(iri)
    is_class = (s, RDF.type, OWL.Class) in g or (s, RDF.type, RDFS.Class) in g or (None, RDF.type, s) in g and not individuals_has(g, s)
    if is_class:
        instances = [str(x) for x in g.subjects(RDF.type, s) if isinstance(x, URIRef)]
        props = []
        for p in g.subjects(RDFS.domain, s):
            props.append({"iri": str(p), "short": qn(g, p),
                          "kind": "object" if (p, RDF.type, OWL.ObjectProperty) in g else "datatype",
                          "range": [qn(g, r) for r in g.objects(p, RDFS.range)]})
        return {
            "kind": "class", "iri": iri, "short": qn(g, s), "label": label_of(g, s),
            "comment": next((str(c) for c in g.objects(s, RDFS.comment)), ""),
            "parents": [{"iri": str(p), "short": qn(g, p)} for p in g.objects(s, RDFS.subClassOf) if isinstance(p, URIRef)],
            "children": [{"iri": str(c), "short": qn(g, c)} for c in g.subjects(RDFS.subClassOf, s)],
            "instanceCount": len(instances), "instances": [{"iri": i, "short": qn(g, URIRef(i))} for i in instances[:30]],
            "properties": props,
        }

    edited_by, edited_at = URIRef(ns + "editedBy"), URIRef(ns + "editedAt")
    edits: dict[str, list[dict]] = {}
    for ax in g.subjects(OWL.annotatedSource, s):
        if (ax, OWL.annotatedProperty, user_edited) not in g:
            continue
        target = next(g.objects(ax, OWL.annotatedTarget), None)
        by = next(g.objects(ax, edited_by), None)
        at = next(g.objects(ax, edited_at), None)
        by_label = None
        if isinstance(by, URIRef):
            by_label = next((str(v) for v in g.objects(by, URIRef(ns + "userId"))), local_name(by))
        elif by is not None:
            by_label = str(by)
        edits.setdefault(str(target), []).append({"by": by_label, "at": str(at) if at else None})
    edited_props = {str(o) for o in g.objects(s, user_edited)}

    values, out_links, other = [], [], []
    for p, o in sorted(g.predicate_objects(s), key=lambda x: (str(x[0]), str(x[1]))):
        if p == RDF.type or p == user_edited:
            continue
        if isinstance(o, Literal):
            values.append({"prop": str(p), "short": qn(g, p), "value": str(o),
                           "datatype": short_dt(str(o.datatype)) if o.datatype else ("rdf:langString" if o.language else "xsd:string"),
                           "lang": o.language or "", "userEdited": str(p) in edited_props,
                           "edits": sorted(edits.get(str(p), []), key=lambda e: e["at"] or "", reverse=True),
                           "inferred": (s, p, o) in inf})
        elif isinstance(o, URIRef):
            target = {"prop": str(p), "short": qn(g, p), "iri": str(o), "target": qn(g, o), "label": label_of(g, o), "inferred": (s, p, o) in inf}
            if any(True for _ in g.objects(o, RDF.type)):
                out_links.append(target)
            else:
                other.append(target)
    in_links = [{"prop": str(p), "short": qn(g, p), "iri": str(x), "source": qn(g, x), "label": label_of(g, x), "inferred": (x, p, s) in inf}
                for x, p in g.subject_predicates(s) if isinstance(x, URIRef) and p not in (OWL.annotatedSource,)]
    types = [{"iri": str(t), "short": qn(g, t), "inferred": (s, RDF.type, t) in inf} for t in g.objects(s, RDF.type)]
    triples = sum(1 for _ in g.triples((s, None, None)))
    return {
        "kind": "individual", "iri": iri, "short": qn(g, s), "label": label_of(g, s), "types": types,
        "values": values, "outgoing": out_links, "incoming": in_links, "other": other,
        "userEdited": [{"iri": p, "short": qn(g, URIRef(p))} for p in sorted(edited_props)],
        "meta": meta.get(iri), "tripleCount": triples,
    }


def individuals_has(g: Graph, s) -> bool:
    return any(isinstance(t, URIRef) and t not in META_TYPES for t in g.objects(s, RDF.type))


def run_sparql(g: Graph, query: str, allow_update: bool) -> dict:
    body = PROLOGUE_RE.sub("", query, count=1)
    started = time.perf_counter()
    if UPDATE_RE.match(body):
        if not allow_update:
            return {"error": "This is an update (it changes the graph). Turn on 'Allow updates' to run it."}
        before = len(g)
        g.update(query)
        return {"kind": "update", "before": before, "after": len(g), "ms": round((time.perf_counter() - started) * 1000, 1)}
    res = g.query(query)
    ms = round((time.perf_counter() - started) * 1000, 1)
    if res.type == "ASK":
        return {"kind": "ask", "boolean": bool(res.askAnswer), "ms": ms}
    if res.type in ("CONSTRUCT", "DESCRIBE"):
        out = Graph()
        for p, n in g.namespaces():
            out.bind(p, n)
        for t in res:
            out.add(t)
        return {"kind": "graph", "count": len(out), "turtle": out.serialize(format="turtle"), "ms": ms}
    vars_ = [str(v) for v in res.vars]
    rows, total = [], 0
    for r in res:
        total += 1
        if total <= MAX_ROWS:
            rows.append([term_json(g, r[v]) for v in res.vars])
    return {"kind": "select", "vars": vars_, "rows": rows, "total": total, "truncated": total > MAX_ROWS, "ms": ms}
