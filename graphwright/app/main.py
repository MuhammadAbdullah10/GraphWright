"""Graphwright: map CSV data onto an OWL/RDFS ontology and explore the resulting knowledge graph."""
from __future__ import annotations

import json
import threading
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from rdflib import Graph, URIRef

from .compact import CompactError, compact, expand
from .csvdata import CsvData
from .engine import MappingRun
from .graphview import cyto_elements, node_detail, run_sparql
from .ontology import Ontology
from . import reasoner as rsn
from .suggest import suggest

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
SAMPLE = Path(__file__).resolve().parent / "sample"

app = FastAPI(title="Graphwright", version="1.0.0")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


class State:
    def __init__(self):
        self.lock = threading.RLock()
        self.onto: Ontology | None = None
        self.csv: CsvData | None = None
        self.mapping: dict = {}
        self.graph: Graph | None = None  # data + ontology, queryable
        self.data_graph: Graph | None = None  # data only, as generated
        self.meta: dict = {}
        self.stats: dict = {}
        self.updated_since_generate = False
        self.inferred: Graph | None = None
        self.closed: Graph | None = None
        self.reason_report: dict | None = None

    def user_edited_iri(self) -> URIRef:
        s = (self.mapping or {}).get("settings") or {}
        ns = self.onto.namespace if self.onto else ""
        return URIRef(s.get("userEditedIri") or ns + "userEdited")


S = State()


class MappingBody(BaseModel):
    mapping: dict


class SparqlBody(BaseModel):
    query: str
    allowUpdate: bool = False
    includeInferred: bool = False


class ReasonBody(BaseModel):
    profile: str = "owlrl"


def _require(onto=True, csv=True):
    if onto and S.onto is None:
        raise HTTPException(400, "Load an ontology first.")
    if csv and S.csv is None:
        raise HTTPException(400, "Load a CSV file first.")


def _status() -> dict:
    return {
        "ontology": S.onto.summary() if S.onto else None,
        "csv": S.csv.summary() if S.csv else None,
        "mapping": S.mapping or None,
        "graph": S.stats if S.graph is not None else None,
    }


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/state")
def get_state():
    with S.lock:
        return _status()


@app.post("/api/ontology")
async def upload_ontology(file: UploadFile = File(...)):
    data = await file.read()
    try:
        onto = Ontology.parse(data, file.filename or "ontology.ttl")
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not onto.classes:
        raise HTTPException(400, "No classes were found in this file. Check that it defines owl:Class or rdfs:Class terms.")
    with S.lock:
        S.onto = onto
        S.graph = S.data_graph = None
        S.stats = {}
        return _status()


@app.post("/api/csv")
async def upload_csv(file: UploadFile = File(...)):
    data = await file.read()
    try:
        csv = CsvData.parse(data, file.filename or "data.csv")
    except ValueError as e:
        raise HTTPException(400, str(e))
    with S.lock:
        S.csv = csv
        S.graph = S.data_graph = None
        S.stats = {}
        return _status()


@app.post("/api/sample")
def load_sample():
    with S.lock:
        S.onto = Ontology.parse((SAMPLE / "valuation.ttl").read_bytes(), "valuation.ttl")
        S.csv = CsvData.parse((SAMPLE / "valuations.csv").read_bytes(), "valuations.csv")
        S.mapping = json.loads((SAMPLE / "mapping.json").read_text())
        S.graph = S.data_graph = None
        S.stats = {}
        return _status()


@app.post("/api/reset")
def reset():
    with S.lock:
        S.__init__()
        return _status()


@app.post("/api/suggest")
def suggest_mapping(body: MappingBody):
    _require()
    with S.lock:
        return suggest(S.onto, S.csv, body.mapping)


@app.post("/api/preview")
def preview(body: MappingBody):
    _require()
    with S.lock:
        S.mapping = body.mapping
        run = MappingRun(S.onto, S.csv, body.mapping, preview=True).run()
        return run.preview_payload()


@app.post("/api/generate")
def generate(body: MappingBody):
    _require()
    with S.lock:
        S.mapping = body.mapping
        run = MappingRun(S.onto, S.csv, body.mapping).run()
        payload = run.preview_payload()
        if any(i["level"] == "error" for i in payload["issues"]):
            payload["generated"] = False
            return payload
        data_graph, meta = run.build_graph()
        full = Graph()
        for p, ns in data_graph.namespaces():
            full.bind(p, ns, override=True)
        for t in S.onto.graph:
            full.add(t)
        for t in data_graph:
            full.add(t)
        S.data_graph, S.graph, S.meta = data_graph, full, meta
        S.inferred = S.closed = S.reason_report = None
        S.updated_since_generate = False
        S.stats = _graph_stats()
        payload["generated"] = True
        auto = ((body.mapping.get("settings") or {}).get("reasoner") or {})
        if auto.get("auto"):
            payload["reasoning"] = _reason(auto.get("profile", "owlrl"))
        payload["graph"] = S.stats
        return payload


def _reason(profile: str) -> dict:
    res = rsn.run(S.graph, profile)
    S.inferred, S.closed = res.pop("inferredGraph"), res.pop("closedGraph")
    S.reason_report = res
    S.stats = _graph_stats()
    return res


def _view_graph(inferred: bool) -> Graph:
    return S.closed if inferred and S.closed is not None else S.graph


def _graph_stats() -> dict:
    g = S.graph
    q = g.query("""SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { ?s a ?c . FILTER(isIRI(?s)) ?c a ?k . FILTER(?k IN (<http://www.w3.org/2002/07/owl#Class>, <http://www.w3.org/2000/01/rdf-schema#Class>)) }""")
    individuals = int(next(iter(q))[0])
    data_triples = len(g) - len(S.onto.graph) if not S.updated_since_generate else len(g) - len(S.onto.graph)
    return {
        "triples": len(g),
        "dataTriples": max(data_triples, 0),
        "ontologyTriples": len(S.onto.graph),
        "individuals": individuals,
        "dataNamespace": ((S.mapping.get("settings") or {}).get("dataNamespace") or S.onto.namespace),
        "edited": S.updated_since_generate,
        "inferred": len(S.inferred) if S.inferred is not None else None,
        "consistent": S.reason_report["consistent"] if S.reason_report else None,
    }


@app.get("/api/graph")
def graph_view(classes: bool = False, literals: bool = False, inferred: bool = False):
    if S.graph is None:
        raise HTTPException(400, "Generate the graph first.")
    with S.lock:
        use_inf = inferred and S.closed is not None
        out = cyto_elements(_view_graph(use_inf), S.user_edited_iri(), classes, literals, S.inferred if use_inf else None)
        out["stats"] = S.stats
        return out


@app.get("/api/node")
def get_node(iri: str, inferred: bool = False):
    if S.graph is None:
        raise HTTPException(400, "Generate the graph first.")
    with S.lock:
        use_inf = inferred and S.closed is not None
        return node_detail(_view_graph(use_inf), iri, S.meta, S.user_edited_iri(), S.onto.namespace, S.inferred if use_inf else None)


@app.post("/api/sparql")
def sparql(body: SparqlBody):
    if S.graph is None:
        raise HTTPException(400, "Generate the graph first, then query it.")
    with S.lock:
        try:
            if body.includeInferred and S.closed is not None and not rsn_is_update(body.query):
                res = run_sparql(S.closed, body.query, False)
                res["inferred"] = True
            else:
                res = run_sparql(S.graph, body.query, body.allowUpdate)
        except Exception as e:  # rdflib raises many parser exception types
            msg = str(e).strip().splitlines()
            return JSONResponse({"error": (msg[0] if msg else type(e).__name__)[:600]}, status_code=200)
        if res.get("kind") == "update":
            S.updated_since_generate = True
            S.inferred = S.closed = S.reason_report = None
            S.stats = _graph_stats()
            res["graph"] = S.stats
        return res


EXPORT_FORMATS = {
    "turtle": ("text/turtle", "ttl"), "nt": ("application/n-triples", "nt"),
    "json-ld": ("application/ld+json", "jsonld"), "xml": ("application/rdf+xml", "rdf"),
}


@app.get("/api/export")
def export(format: str = "turtle", scope: str = "data"):
    if S.graph is None:
        raise HTTPException(400, "Generate the graph first.")
    if format not in EXPORT_FORMATS:
        raise HTTPException(400, "Unknown format.")
    with S.lock:
        if scope == "all":
            g = S.graph
        elif scope == "all-inferred" and S.closed is not None:
            g = S.closed
        elif scope == "data-inferred" and S.closed is not None:
            g = Graph()
            for p, ns in S.graph.namespaces():
                g.bind(p, ns, override=True)
            for t in S.closed:
                if t not in S.onto.graph:
                    g.add(t)
        else:
            g = Graph()
            for p, ns in S.graph.namespaces():
                g.bind(p, ns, override=True)
            onto_triples = S.onto.graph
            for t in S.graph:
                if t not in onto_triples:
                    g.add(t)
        mime, ext = EXPORT_FORMATS[format]
        body = g.serialize(format=format)
        suffix = {"all": "-with-ontology", "data-inferred": "-with-inferences", "all-inferred": "-with-ontology-and-inferences"}.get(scope, "")
        name = f"knowledge-graph{suffix}.{ext}"
        return Response(body, media_type=mime, headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.get("/api/mapping/export")
def export_mapping():
    with S.lock:
        body = json.dumps(S.mapping or {}, indent=2)
    return Response(body, media_type="application/json",
                    headers={"Content-Disposition": 'attachment; filename="mapping.json"'})


@app.post("/api/mapping/compact")
def to_compact(body: MappingBody):
    _require(csv=False)
    with S.lock:
        return compact(body.mapping, S.onto)


@app.post("/api/mapping/expand")
def from_compact(body: MappingBody):
    _require(csv=False)
    with S.lock:
        try:
            return expand(body.mapping, S.onto)
        except CompactError as e:
            raise HTTPException(400, str(e))


def rsn_is_update(query: str) -> bool:
    from .graphview import PROLOGUE_RE, UPDATE_RE
    return bool(UPDATE_RE.match(PROLOGUE_RE.sub("", query, count=1)))


@app.post("/api/reason")
def reason(body: ReasonBody):
    if S.graph is None:
        raise HTTPException(400, "Generate the graph first.")
    if body.profile not in rsn.PROFILES:
        raise HTTPException(400, "Unknown reasoning profile.")
    with S.lock:
        res = _reason(body.profile)
        return {**res, "graph": S.stats}


@app.get("/api/reason")
def reason_report():
    with S.lock:
        return {"report": S.reason_report, "graph": S.stats if S.graph is not None else None}


@app.delete("/api/reason")
def clear_reason():
    with S.lock:
        S.inferred = S.closed = S.reason_report = None
        if S.graph is not None:
            S.stats = _graph_stats()
        return {"graph": S.stats if S.graph is not None else None}
