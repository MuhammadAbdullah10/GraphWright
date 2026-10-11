"""Reasoning over the generated graph with owlrl (RDFS / OWL 2 RL), plus readable consistency checks.

The asserted graph is never modified. Inferred triples are returned as a separate graph,
so the UI can show what was stated versus what the reasoner derived.
"""
from __future__ import annotations

import time
from collections import Counter, defaultdict

import owlrl
from rdflib import BNode, Graph, Literal, Namespace, URIRef
from rdflib.collection import Collection
from rdflib.namespace import OWL, RDF, RDFS, XSD

from .convert import short_dt
from .ontology import META_TYPES, is_builtin, local_name

ERRNS = Namespace("http://www.daml.org/2002/03/agents/agent-ont#")
PROFILES = {
    "rdfs": ("RDFS", owlrl.RDFS_Semantics),
    "owlrl": ("OWL 2 RL", owlrl.OWLRL_Semantics),
    "rdfs-owlrl": ("RDFS + OWL 2 RL", owlrl.RDFS_OWLRL_Semantics),
}
NOISE_TYPES = {OWL.Thing, RDFS.Resource, OWL.NamedIndividual, RDFS.Literal}
REFLEXIVE = {OWL.sameAs, RDFS.subClassOf, RDFS.subPropertyOf, OWL.equivalentClass, OWL.equivalentProperty}
NUMERIC = {"integer", "decimal", "double", "float", "int", "long", "short", "nonNegativeInteger", "positiveInteger"}


def _keep(s, p, o) -> bool:
    """Drop the bookkeeping triples a rule closure adds; keep what a person would call a new fact."""
    if isinstance(s, (BNode, Literal)) or isinstance(o, BNode):
        return False
    if is_builtin(s):
        return False
    if p in REFLEXIVE and s == o:
        return False
    if p == RDF.type and (o in NOISE_TYPES or o in META_TYPES or is_builtin(o)):
        return False
    if p in (RDFS.subClassOf, RDFS.subPropertyOf, OWL.equivalentClass) and is_builtin(o):
        return False
    if p in (RDFS.domain, RDFS.range) and is_builtin(o):
        return False
    if is_builtin(p) and p not in (RDF.type, RDFS.subClassOf, RDFS.subPropertyOf, OWL.sameAs, OWL.equivalentClass,
                                   OWL.equivalentProperty, OWL.inverseOf, RDFS.domain, RDFS.range):
        return False
    return True


def _disjoint_pairs(g: Graph) -> set[tuple[URIRef, URIRef]]:
    pairs = set()
    for a, b in g.subject_objects(OWL.disjointWith):
        if isinstance(a, URIRef) and isinstance(b, URIRef):
            pairs.add(tuple(sorted((a, b))))
    for node in g.subjects(RDF.type, OWL.AllDisjointClasses):
        for lst in g.objects(node, OWL.members):
            members = [m for m in Collection(g, lst) if isinstance(m, URIRef)]
            for i, a in enumerate(members):
                for b in members[i + 1:]:
                    pairs.add(tuple(sorted((a, b))))
    return pairs


def _lit_ok(lit: Literal, rng: URIRef) -> bool:
    if rng == RDFS.Literal:
        return True
    want = str(rng)[len(str(XSD)):] if str(rng).startswith(str(XSD)) else None
    if want is None:
        return True
    have = str(lit.datatype)[len(str(XSD)):] if lit.datatype and str(lit.datatype).startswith(str(XSD)) else ("string" if not lit.datatype else None)
    if have == want:
        return True
    if want in NUMERIC and have in NUMERIC:
        return want not in ("integer", "int", "long", "short", "nonNegativeInteger", "positiveInteger") or have in ("integer", "int", "long", "short")
    if want == "string" and lit.language:
        return True
    return False


def consistency_checks(closed: Graph, label) -> list[dict]:
    issues: list[dict] = []
    # 1. disjoint classes
    pairs = _disjoint_pairs(closed)
    if pairs:
        types = defaultdict(set)
        for s, t in closed.subject_objects(RDF.type):
            if isinstance(s, URIRef) and isinstance(t, URIRef):
                types[s].add(t)
        for s, ts in types.items():
            for a, b in pairs:
                if a in ts and b in ts:
                    issues.append({"kind": "disjoint", "level": "error", "subject": str(s), "property": None,
                                   "message": f"{label(s)} is both {local_name(a)} and {local_name(b)}, which the ontology declares disjoint."})
    # 2. functional properties with more than one value
    for p in set(closed.subjects(RDF.type, OWL.FunctionalProperty)):
        per = defaultdict(set)
        for s, o in closed.subject_objects(p):
            if isinstance(s, URIRef):
                per[s].add(o)
        for s, vals in per.items():
            if len(vals) > 1:
                shown = ", ".join(sorted(label(v) if isinstance(v, URIRef) else str(v) for v in vals))
                issues.append({"kind": "functional", "level": "error", "subject": str(s), "property": str(p),
                               "message": f"{label(s)} has {len(vals)} values for {local_name(p)} ({shown}), but it allows only one."})
    # 3. datatype ranges
    for p, rng in closed.subject_objects(RDFS.range):
        if not (isinstance(rng, URIRef) and (str(rng).startswith(str(XSD)) or rng == RDFS.Literal)):
            continue
        bad = [(s, o) for s, o in closed.subject_objects(p) if isinstance(o, Literal) and not _lit_ok(o, rng)]
        for s, o in bad[:50]:
            issues.append({"kind": "range", "level": "warning", "subject": str(s), "property": str(p),
                           "message": f"{label(s)}: {local_name(p)} is '{o}' ({short_dt(str(o.datatype)) if o.datatype else 'plain text'}), but its range is {short_dt(str(rng))}."})
    # 4. object property pointing at a literal, or datatype property pointing at an individual
    for p in closed.subjects(RDF.type, OWL.ObjectProperty):
        for s, o in closed.subject_objects(p):
            if isinstance(o, Literal) and isinstance(s, URIRef):
                issues.append({"kind": "kind", "level": "warning", "subject": str(s), "property": str(p),
                               "message": f"{label(s)}: {local_name(p)} links to individuals, but has the value '{o}'."})
    return issues


def run(asserted: Graph, profile: str = "owlrl") -> dict:
    name, semantics = PROFILES.get(profile, PROFILES["owlrl"])
    started = time.perf_counter()
    closed = Graph()
    for pfx, ns in asserted.namespaces():
        closed.bind(pfx, ns, override=True)
    for t in asserted:
        closed.add(t)
    owlrl.DeductiveClosure(semantics, improved_datatypes=False, axiomatic_triples=False,
                           datatype_axioms=False, rdfs_closure=False).expand(closed)

    # collect and strip owlrl's own error nodes
    reasoner_msgs = []
    for e in list(closed.subjects(RDF.type, ERRNS.ErrorMessage)):
        for m in closed.objects(e, ERRNS.error):
            reasoner_msgs.append(str(m))
        closed.remove((e, None, None))

    inferred = Graph()
    for pfx, ns in asserted.namespaces():
        inferred.bind(pfx, ns, override=True)
    for t in closed:
        if t not in asserted and _keep(*t):
            inferred.add(t)
    # the closure graph used for queries = asserted + kept inferences (no noise)
    usable = Graph()
    for pfx, ns in asserted.namespaces():
        usable.bind(pfx, ns, override=True)
    for t in asserted:
        usable.add(t)
    for t in inferred:
        usable.add(t)

    def label(x):
        for v in usable.objects(x, RDFS.label):
            return str(v)
        return local_name(x) if isinstance(x, URIRef) else str(x)

    issues = consistency_checks(usable, label)
    covered = {i["kind"] for i in issues}
    for m in reasoner_msgs:
        low = m.lower()
        if ("disjoint" in low and "disjoint" in covered) or ("functional" in low and "functional" in covered):
            continue
        issues.append({"kind": "reasoner", "level": "error", "subject": None, "property": None, "message": m.strip()})

    # summary of what was inferred
    individuals = {s for s, t in asserted.subject_objects(RDF.type) if isinstance(s, URIRef) and t not in META_TYPES and not is_builtin(t)}
    cats = Counter()
    by_pred = Counter()
    examples = defaultdict(list)
    for s, p, o in inferred:
        if p == RDF.type and s in individuals:
            cat = "types"
        elif s in individuals and isinstance(o, URIRef) and o in individuals:
            cat = "links"
        elif s in individuals and isinstance(o, Literal):
            cat = "values"
        elif s in individuals:
            cat = "other"
        else:
            cat = "schema"
        cats[cat] += 1
        key = (cat, str(p), str(o) if p == RDF.type else "")
        by_pred[key] += 1
        if len(examples[key]) < 3:
            examples[key].append({"subject": str(s), "object": str(o), "subjectLabel": label(s),
                                  "objectLabel": label(o) if isinstance(o, URIRef) else str(o)})
    groups = []
    for (cat, p, o), n in by_pred.most_common():
        groups.append({"category": cat, "property": p, "propertyLabel": local_name(p),
                       "object": o or None, "objectLabel": local_name(o) if o else None, "count": n, "examples": examples[(cat, p, o)]})
    return {
        "profile": profile, "profileName": name,
        "ms": round((time.perf_counter() - started) * 1000, 1),
        "asserted": len(asserted), "inferred": len(inferred),
        "categories": dict(cats), "groups": groups,
        "issues": issues, "consistent": not any(i["level"] == "error" for i in issues),
        "inferredGraph": inferred, "closedGraph": usable,
    }
