"""SHACL validation with pySHACL, returned as plain records the UI can list and link to."""
from __future__ import annotations

import time

from pyshacl import validate as shacl_validate
from rdflib import BNode, Graph, Literal, Namespace, URIRef
from rdflib.namespace import RDF

from .ontology import local_name

SH = Namespace("http://www.w3.org/ns/shacl#")
SEVERITY = {SH.Violation: "violation", SH.Warning: "warning", SH.Info: "info"}


class Shapes:
    def __init__(self, graph: Graph, filename: str):
        self.graph = graph
        self.filename = filename
        self.shape_count = len(set(graph.subjects(RDF.type, SH.NodeShape)) | set(graph.subjects(RDF.type, SH.PropertyShape)))

    @classmethod
    def parse(cls, data: bytes, filename: str) -> "Shapes":
        g = Graph()
        fmt = "xml" if filename.lower().endswith((".rdf", ".owl", ".xml")) else "json-ld" if filename.lower().endswith(".jsonld") else "turtle"
        try:
            g.parse(data=data, format=fmt)
        except Exception as e:
            raise ValueError(f"Could not parse {filename}: {str(e).splitlines()[0][:300]}") from e
        shapes = cls(g, filename)
        if not shapes.shape_count and not any(g.triples((None, SH.targetClass, None))):
            raise ValueError("No SHACL shapes were found. The file should contain sh:NodeShape or sh:PropertyShape definitions.")
        return shapes

    def summary(self) -> dict:
        return {"filename": self.filename, "shapes": self.shape_count, "triples": len(self.graph)}


def _label(g: Graph, term) -> str:
    if isinstance(term, URIRef):
        return local_name(term)
    if isinstance(term, Literal):
        return str(term)
    return ""


def run(data: Graph, shapes: Shapes, ontology: Graph | None, label_graph: Graph) -> dict:
    started = time.perf_counter()
    conforms, report, _ = shacl_validate(data, shacl_graph=shapes.graph, ont_graph=ontology,
                                         inference="none", abort_on_first=False, allow_warnings=True,
                                         advanced=True, meta_shacl=False)
    results = []
    for r in report.subjects(RDF.type, SH.ValidationResult):
        focus = report.value(r, SH.focusNode)
        path = report.value(r, SH.resultPath)
        value = report.value(r, SH.value)
        sev = SEVERITY.get(report.value(r, SH.resultSeverity), "violation")
        msgs = [str(m) for m in report.objects(r, SH.resultMessage)]
        constraint = report.value(r, SH.sourceConstraintComponent)
        shape = report.value(r, SH.sourceShape)
        results.append({
            "severity": sev,
            "focus": str(focus) if isinstance(focus, URIRef) else None,
            "focusLabel": _label(label_graph, focus) or "(blank node)",
            "path": str(path) if isinstance(path, URIRef) else None,
            "pathLabel": _label(label_graph, path) if isinstance(path, URIRef) else ("(complex path)" if isinstance(path, BNode) else ""),
            "value": str(value) if value is not None else None,
            "message": msgs[0] if msgs else local_name(constraint or "") or "Constraint not met",
            "constraint": local_name(constraint) if constraint is not None else "",
            "shape": local_name(shape) if isinstance(shape, URIRef) else "",
        })
    order = {"violation": 0, "warning": 1, "info": 2}
    results.sort(key=lambda x: (order[x["severity"]], x["focusLabel"], x["pathLabel"]))
    counts = {k: sum(1 for x in results if x["severity"] == k) for k in order}
    return {"conforms": bool(conforms), "counts": counts, "results": results[:2000], "total": len(results),
            "ms": round((time.perf_counter() - started) * 1000, 1)}
