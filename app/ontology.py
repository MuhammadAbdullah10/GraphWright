"""Ontology loading and introspection (classes, properties, hierarchy)."""
from __future__ import annotations

from collections import Counter
from typing import Iterable

from rdflib import BNode, Graph, Literal, URIRef
from rdflib.collection import Collection
from rdflib.namespace import OWL, RDF, RDFS, SKOS, XSD

FORMAT_BY_EXT = {
    "ttl": "turtle", "turtle": "turtle", "n3": "n3", "nt": "nt", "owl": "xml",
    "rdf": "xml", "xml": "xml", "jsonld": "json-ld", "json": "json-ld", "trig": "trig",
}

# Vocabulary that is never a domain class
BUILTIN_NS = (str(RDF), str(RDFS), str(OWL), str(XSD), str(SKOS))
META_TYPES = {
    OWL.Class, RDFS.Class, OWL.ObjectProperty, OWL.DatatypeProperty, OWL.AnnotationProperty,
    RDF.Property, OWL.Ontology, OWL.Axiom, OWL.Restriction, OWL.FunctionalProperty,
    OWL.InverseFunctionalProperty, OWL.TransitiveProperty, OWL.SymmetricProperty,
    OWL.AsymmetricProperty, OWL.ReflexiveProperty, OWL.IrreflexiveProperty,
    RDFS.Datatype, OWL.AllDisjointClasses, OWL.AllDifferent, OWL.NamedIndividual,
}


def guess_format(filename: str) -> str:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "ttl"
    return FORMAT_BY_EXT.get(ext, "turtle")


def local_name(iri: str) -> str:
    s = str(iri)
    for sep in ("#", "/", ":"):
        if sep in s:
            tail = s.rsplit(sep, 1)[1]
            if tail:
                return tail
    return s


def is_builtin(iri) -> bool:
    return str(iri).startswith(BUILTIN_NS)


class Ontology:
    def __init__(self, graph: Graph, filename: str = "ontology.ttl"):
        self.graph = graph
        self.filename = filename
        self._analyse()

    # ------------------------------------------------------------------ parse
    @classmethod
    def parse(cls, data: bytes | str, filename: str) -> "Ontology":
        g = Graph()
        fmt = guess_format(filename)
        try:
            g.parse(data=data, format=fmt)
        except Exception as first:  # fall back to other syntaxes before giving up
            for alt in ("turtle", "xml", "json-ld", "nt"):
                if alt == fmt:
                    continue
                try:
                    g = Graph()
                    g.parse(data=data, format=alt)
                    break
                except Exception:
                    continue
            else:
                raise ValueError(f"Could not parse {filename}: {first}") from first
        return cls(g, filename)

    # ---------------------------------------------------------------- helpers
    def qname(self, iri) -> str:
        try:
            q = self.graph.namespace_manager.normalizeUri(URIRef(iri))
            if q.startswith("<"):
                return local_name(iri)
            return q
        except Exception:
            return local_name(iri)

    def label(self, iri) -> str:
        for p in (RDFS.label, SKOS.prefLabel):
            vals = list(self.graph.objects(URIRef(iri), p))
            en = [v for v in vals if isinstance(v, Literal) and v.language in (None, "en")]
            if en or vals:
                return str((en or vals)[0])
        return local_name(iri)

    def comment(self, iri) -> str:
        for v in self.graph.objects(URIRef(iri), RDFS.comment):
            return str(v)
        return ""

    def _expand(self, node) -> list[URIRef]:
        """Expand a domain/range value, following owl:unionOf lists."""
        if isinstance(node, URIRef):
            return [node]
        if isinstance(node, BNode):
            out: list[URIRef] = []
            for lst in self.graph.objects(node, OWL.unionOf):
                for item in Collection(self.graph, lst):
                    out.extend(self._expand(item))
            return out
        return []

    def _values(self, s, p) -> list[URIRef]:
        out: list[URIRef] = []
        for o in self.graph.objects(s, p):
            out.extend(self._expand(o))
        return out

    # ---------------------------------------------------------------- analyse
    def _analyse(self) -> None:
        g = self.graph
        onto_iri = next(iter(g.subjects(RDF.type, OWL.Ontology)), None)
        self.ontology_iri = str(onto_iri) if isinstance(onto_iri, URIRef) else ""

        classes: set[URIRef] = set()
        for t in (OWL.Class, RDFS.Class):
            classes.update(s for s in g.subjects(RDF.type, t) if isinstance(s, URIRef))
        for s, o in g.subject_objects(RDFS.subClassOf):
            if isinstance(s, URIRef):
                classes.add(s)
            if isinstance(o, URIRef):
                classes.add(o)

        obj_props = {s for s in g.subjects(RDF.type, OWL.ObjectProperty) if isinstance(s, URIRef)}
        dt_props = {s for s in g.subjects(RDF.type, OWL.DatatypeProperty) if isinstance(s, URIRef)}
        ann_props = {s for s in g.subjects(RDF.type, OWL.AnnotationProperty) if isinstance(s, URIRef)}
        for s in g.subjects(RDF.type, RDF.Property):
            if not isinstance(s, URIRef) or s in obj_props | dt_props | ann_props:
                continue
            ranges = self._values(s, RDFS.range)
            if ranges and all(str(r).startswith(str(XSD)) or r == RDFS.Literal for r in ranges):
                dt_props.add(s)
            else:
                obj_props.add(s)

        # Domain / range classes count as classes too
        for p in obj_props | dt_props:
            for d in self._values(p, RDFS.domain):
                if not is_builtin(d):
                    classes.add(d)
        for p in obj_props:
            for r in self._values(p, RDFS.range):
                if not is_builtin(r):
                    classes.add(r)
        classes = {c for c in classes if not is_builtin(c)}

        self.class_iris = classes
        self.parents: dict[str, list[str]] = {}
        for c in classes:
            self.parents[str(c)] = sorted(
                str(o) for o in g.objects(c, RDFS.subClassOf) if isinstance(o, URIRef) and o in classes
            )
        self.ancestors_cache: dict[str, set[str]] = {}

        functional = {s for s in g.subjects(RDF.type, OWL.FunctionalProperty)}

        def prop_info(p, kind):
            return {
                "iri": str(p),
                "qname": self.qname(p),
                "local": local_name(p),
                "label": self.label(p),
                "comment": self.comment(p),
                "kind": kind,
                "domain": [str(d) for d in self._values(p, RDFS.domain)],
                "range": [str(r) for r in self._values(p, RDFS.range)],
                "functional": p in functional,
            }

        self.classes = sorted(
            (
                {
                    "iri": str(c),
                    "qname": self.qname(c),
                    "local": local_name(c),
                    "label": self.label(c),
                    "comment": self.comment(c),
                    "parents": self.parents[str(c)],
                }
                for c in classes
            ),
            key=lambda x: x["local"].lower(),
        )
        self.object_props = sorted((prop_info(p, "object") for p in obj_props), key=lambda x: x["local"].lower())
        self.datatype_props = sorted((prop_info(p, "datatype") for p in dt_props), key=lambda x: x["local"].lower())
        self.annotation_props = sorted(
            (prop_info(p, "annotation") for p in ann_props if not is_builtin(p)), key=lambda x: x["local"].lower()
        )
        self.namespace = self._detect_namespace()

    def _detect_namespace(self) -> str:
        nm = dict(self.graph.namespaces())
        if "" in nm:
            return str(nm[""])
        if self.ontology_iri:
            base = self.ontology_iri
            return base if base.endswith(("#", "/")) else base + "#"
        counts = Counter()
        for c in self.class_iris:
            s = str(c)
            ln = local_name(s)
            counts[s[: len(s) - len(ln)]] += 1
        if counts:
            return counts.most_common(1)[0][0]
        return "http://example.org/data#"

    def ancestors(self, iri: str) -> set[str]:
        if iri in self.ancestors_cache:
            return self.ancestors_cache[iri]
        seen: set[str] = set()
        stack = [iri]
        while stack:
            cur = stack.pop()
            for p in self.parents.get(cur, []):
                if p not in seen:
                    seen.add(p)
                    stack.append(p)
        self.ancestors_cache[iri] = seen
        return seen

    def class_and_ancestors(self, iri: str) -> set[str]:
        return {iri} | self.ancestors(iri)

    def find_prop(self, iri: str) -> dict | None:
        for coll in (self.datatype_props, self.object_props, self.annotation_props):
            for p in coll:
                if p["iri"] == iri:
                    return p
        return None

    def prefixes(self) -> dict[str, str]:
        return {p: str(ns) for p, ns in self.graph.namespaces() if p not in ("brick", "csvw", "dc", "dcat", "dcmitype", "dcam", "doap", "foaf", "geo", "odrl", "org", "prof", "qb", "schema", "sh", "sosa", "ssn", "time", "vann", "void", "wgs", "dcterms", "prov")}

    def summary(self) -> dict:
        return {
            "filename": self.filename,
            "ontologyIri": self.ontology_iri,
            "namespace": self.namespace,
            "prefixes": self.prefixes(),
            "tripleCount": len(self.graph),
            "classes": self.classes,
            "objectProps": self.object_props,
            "datatypeProps": self.datatype_props,
            "annotationProps": self.annotation_props,
        }


def iter_individual_types(g: Graph, s) -> Iterable[URIRef]:
    for t in g.objects(s, RDF.type):
        if isinstance(t, URIRef) and t not in META_TYPES:
            yield t
