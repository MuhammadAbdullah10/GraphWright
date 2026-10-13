"""Graphwright: map CSV data onto an OWL/RDFS ontology and run a configurable knowledge-graph pipeline."""
from __future__ import annotations

import csv
import io
import json
import threading
import time
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from rdflib import Graph, URIRef

from . import pipeline as pl
from . import provenance as prov
from . import reasoner as rsn
from . import validation as shacl
from .compact import CompactError, compact, expand
from .csvdata import CsvData
from .engine import MappingRun
from .graphview import PROLOGUE_RE, UPDATE_RE, cyto_elements, node_detail, run_sparql
from .ontology import Ontology
from .suggest import suggest

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
SAMPLE = Path(__file__).resolve().parent / "sample"

app = FastAPI(title="Graphwright", version="1.1.0",
              description="Map CSV data onto an ontology and run a configurable knowledge-graph pipeline.")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


class State:
    def __init__(self):
        self.lock = threading.RLock()
        self.onto: Ontology | None = None
        self.csv: CsvData | None = None
        self.shapes: shacl.Shapes | None = None
        self.mapping: dict = {}
        self.graph: Graph | None = None  # data + ontology, queryable
        self.meta: dict = {}
        self.stats: dict = {}
        self.updated_since_generate = False
        self.inferred: Graph | None = None
        self.closed: Graph | None = None
        self.reason_report: dict | None = None
        self.validation: dict | None = None
        self.prov_index: dict = {}
        self.pipeline_report: list[dict] | None = None

    def settings(self) -> dict:
        return (self.mapping or {}).get("settings") or {}

    def user_edited_iri(self) -> URIRef:
        return prov.flag_iri(self.settings(), self.onto)

    def violations_by_node(self) -> dict:
        out: dict = {}
        for r in (self.validation or {}).get("results", []):
            if r["focus"]:
                out.setdefault(r["focus"], []).append(r)
        return out

    def clear_derived(self):
        self.inferred = self.closed = self.reason_report = self.validation = None


S = State()


class MappingBody(BaseModel):
    mapping: dict


class SparqlBody(BaseModel):
    query: str
    allowUpdate: bool = False
    includeInferred: bool = False


class ReasonBody(BaseModel):
    profile: str = "owlrl"


class ValidateBody(BaseModel):
    withInferences: bool = False


def _require(onto=True, csv=True):
    if onto and S.onto is None:
        raise HTTPException(400, "Load an ontology first.")
    if csv and S.csv is None:
        raise HTTPException(400, "Load a CSV file first.")


def _status() -> dict:
    return {
        "ontology": S.onto.summary() if S.onto else None,
        "csv": S.csv.summary() if S.csv else None,
        "shapes": S.shapes.summary() if S.shapes else None,
        "mapping": S.mapping or None,
        "graph": S.stats if S.graph is not None else None,
        "pipeline": S.pipeline_report,
        "validation": S.validation,
    }


def _reset_graph():
    S.graph = None
    S.stats = {}
    S.prov_index = {}
    S.pipeline_report = None
    S.clear_derived()


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/state")
def get_state():
    with S.lock:
        return _status()


# ------------------------------------------------------------------ sources
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
        _reset_graph()
        return _status()


@app.post("/api/csv")
async def upload_csv(file: UploadFile = File(...)):
    data = await file.read()
    try:
        data_csv = CsvData.parse(data, file.filename or "data.csv")
    except ValueError as e:
        raise HTTPException(400, str(e))
    with S.lock:
        S.csv = data_csv
        _reset_graph()
        return _status()


@app.post("/api/shapes")
async def upload_shapes(file: UploadFile = File(...)):
    data = await file.read()
    try:
        shapes = shacl.Shapes.parse(data, file.filename or "shapes.ttl")
    except ValueError as e:
        raise HTTPException(400, str(e))
    with S.lock:
        S.shapes = shapes
        S.validation = None
        return _status()


@app.delete("/api/shapes")
def remove_shapes():
    with S.lock:
        S.shapes = None
        S.validation = None
        return _status()


@app.post("/api/sample")
def load_sample():
    with S.lock:
        S.onto = Ontology.parse((SAMPLE / "valuation.ttl").read_bytes(), "valuation.ttl")
        S.csv = CsvData.parse((SAMPLE / "valuations.csv").read_bytes(), "valuations.csv")
        S.shapes = shacl.Shapes.parse((SAMPLE / "valuation-shapes.ttl").read_bytes(), "valuation-shapes.ttl")
        S.mapping = json.loads((SAMPLE / "mapping.json").read_text())
        _reset_graph()
        return _status()


@app.post("/api/reset")
def reset():
    with S.lock:
        S.__init__()
        return _status()


# ------------------------------------------------------------------ mapping
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


# ------------------------------------------------------------------ provenance patterns
@app.get("/api/provenance/presets")
def provenance_presets():
    try:
        return {"presets": prov.load_presets(), "default": prov.DEFAULT_PRESET}
    except prov.ProvenanceError as e:
        raise HTTPException(500, str(e))


@app.post("/api/provenance/preview")
def provenance_preview(body: MappingBody):
    _require(csv=False)
    with S.lock:
        try:
            settings = body.mapping.get("settings") or {}
            return {"turtle": prov.preview(S.onto, settings), "read": prov.read_query(S.onto, settings),
                    "readBody": prov.read_body(S.onto, settings), "prefixes": prov.prefix_block(S.onto)}
        except prov.ProvenanceError as e:
            return JSONResponse({"error": str(e)}, status_code=200)


# ------------------------------------------------------------------ pipeline
def _stage(name: str, status: str, summary: str, **extra) -> dict:
    return {"stage": name, "status": status, "summary": summary, **extra}


@app.post("/api/generate")
def generate(body: MappingBody):
    """Run the whole pipeline: build → provenance → transform steps → reason → validate."""
    _require()
    with S.lock:
        S.mapping = body.mapping
        settings = S.settings()
        stages: list[dict] = []

        # 1. build from the mapping
        t0 = time.perf_counter()
        run = MappingRun(S.onto, S.csv, body.mapping).run()
        payload = run.preview_payload()
        if any(i["level"] == "error" for i in payload["issues"]):
            payload["generated"] = False
            return payload
        data_graph, meta, events = run.build_graph()
        full = Graph()
        for p, ns in data_graph.namespaces():
            full.bind(p, ns, override=True)
        for t in S.onto.graph:
            full.add(t)
        for t in data_graph:
            full.add(t)
        stages.append(_stage("build", "ok", f"{len(run.instances)} individuals, {len(data_graph)} triples",
                             ms=round((time.perf_counter() - t0) * 1000, 1)))

        # 2. provenance, written by the configured pattern
        t0 = time.perf_counter()
        try:
            res = prov.write(full, S.onto, settings, events, run.data_ns)
            stages.append(_stage("provenance", "ok" if events else "skipped",
                                 f"{res['records']} user-entered values recorded with '{res['pattern']}' (+{res['triples']} triples)"
                                 if events else "No columns are marked as user-entered",
                                 ms=round((time.perf_counter() - t0) * 1000, 1)))
        except prov.ProvenanceError as e:
            payload["generated"] = False
            payload["issues"].insert(0, {"level": "error", "message": str(e), "node": None, "rows": [], "code": "prov"})
            return payload

        S.graph, S.meta = full, meta
        S.clear_derived()
        S.updated_since_generate = False

        # 3. transform steps (SPARQL updates)
        steps = settings.get("steps") or []
        if steps:
            step_report = pl.run_steps(full, steps, S.onto)
            failed = [s for s in step_report if s["status"] == "error"]
            ran = [s for s in step_report if s["status"] == "ok"]
            stages.append(_stage("steps", "error" if failed else "ok" if ran else "skipped",
                                 f"{len(ran)} of {len(steps)} steps ran" + (f"; '{failed[0]['name']}' failed" if failed else ""),
                                 steps=step_report))
        else:
            stages.append(_stage("steps", "skipped", "No transform steps"))

        S.prov_index = prov.index(full, S.onto, settings)

        # 4. reasoning
        rcfg = settings.get("reasoner") or {}
        if rcfg.get("auto"):
            payload["reasoning"] = _reason(rcfg.get("profile", "owlrl"))
            r = payload["reasoning"]
            errs = sum(1 for i in r["issues"] if i["level"] == "error")
            stages.append(_stage("reason", "warning" if errs else "ok",
                                 f"{r['inferred']} facts inferred with {r['profileName']}" + (f"; {errs} problems" if errs else ""), ms=r["ms"]))
        else:
            stages.append(_stage("reason", "skipped", "Turned off"))

        # 5. validation
        vcfg = settings.get("validation") or {}
        if S.shapes is None:
            stages.append(_stage("validate", "skipped", "No SHACL shapes loaded"))
        elif vcfg.get("auto", True):
            v = _validate(bool(vcfg.get("withInferences")))
            stages.append(_stage("validate", "ok" if v["conforms"] else "warning",
                                 "Conforms" if v["conforms"] else f"{v['counts']['violation']} violations, {v['counts']['warning']} warnings",
                                 ms=v["ms"]))
            payload["validation"] = v
        else:
            stages.append(_stage("validate", "skipped", "Turned off"))

        S.stats = _graph_stats()
        S.pipeline_report = stages
        payload["generated"] = True
        payload["pipeline"] = stages
        payload["graph"] = S.stats
        return payload


def _reason(profile: str) -> dict:
    res = rsn.run(S.graph, profile)
    S.inferred, S.closed = res.pop("inferredGraph"), res.pop("closedGraph")
    S.reason_report = res
    S.stats = _graph_stats()
    return res


def _validate(with_inferences: bool) -> dict:
    target = S.closed if with_inferences and S.closed is not None else S.graph
    data = Graph()
    for t in target:
        if t not in S.onto.graph:
            data.add(t)
    S.validation = {**shacl.run(data, S.shapes, S.onto.graph, target), "withInferences": with_inferences and S.closed is not None,
                    "shapes": S.shapes.filename}
    return S.validation


def _view_graph(inferred: bool) -> Graph:
    return S.closed if inferred and S.closed is not None else S.graph


def _graph_stats() -> dict:
    g = S.graph
    q = g.query("""SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { ?s a ?c . FILTER(isIRI(?s)) ?c a ?k . FILTER(?k IN (<http://www.w3.org/2002/07/owl#Class>, <http://www.w3.org/2000/01/rdf-schema#Class>)) }""")
    individuals = int(next(iter(q))[0])
    return {
        "triples": len(g),
        "dataTriples": max(len(g) - len(S.onto.graph), 0),
        "ontologyTriples": len(S.onto.graph),
        "individuals": individuals,
        "dataNamespace": (S.settings().get("dataNamespace") or S.onto.namespace),
        "edited": S.updated_since_generate,
        "inferred": len(S.inferred) if S.inferred is not None else None,
        "consistent": S.reason_report["consistent"] if S.reason_report else None,
        "conforms": S.validation["conforms"] if S.validation else None,
        "userEditedValues": sum(len(v) for v in S.prov_index.values()),
    }


# ------------------------------------------------------------------ graph
@app.get("/api/graph")
def graph_view(classes: bool = False, literals: bool = False, inferred: bool = False):
    if S.graph is None:
        raise HTTPException(400, "Generate the graph first.")
    with S.lock:
        use_inf = inferred and S.closed is not None
        out = cyto_elements(_view_graph(use_inf), S.user_edited_iri(), classes, literals, S.inferred if use_inf else None,
                            S.prov_index, S.violations_by_node())
        out["stats"] = S.stats
        return out


@app.get("/api/node")
def get_node(iri: str, inferred: bool = False):
    if S.graph is None:
        raise HTTPException(400, "Generate the graph first.")
    with S.lock:
        use_inf = inferred and S.closed is not None
        return node_detail(_view_graph(use_inf), iri, S.meta, S.user_edited_iri(), S.onto.namespace,
                           S.inferred if use_inf else None, S.prov_index, S.violations_by_node())


# ------------------------------------------------------------------ SPARQL
def _is_update(query: str) -> bool:
    return bool(UPDATE_RE.match(PROLOGUE_RE.sub("", query, count=1)))


@app.post("/api/sparql")
def sparql(body: SparqlBody):
    if S.graph is None:
        raise HTTPException(400, "Generate the graph first, then query it.")
    with S.lock:
        try:
            if body.includeInferred and S.closed is not None and not _is_update(body.query):
                res = run_sparql(S.closed, body.query, False)
                res["inferred"] = True
            else:
                res = run_sparql(S.graph, body.query, body.allowUpdate)
        except Exception as e:  # rdflib raises many parser exception types
            msg = str(e).strip().splitlines()
            return JSONResponse({"error": (msg[0] if msg else type(e).__name__)[:600]}, status_code=200)
        if res.get("kind") == "update":
            S.updated_since_generate = True
            S.clear_derived()
            S.prov_index = prov.index(S.graph, S.onto, S.settings())
            S.stats = _graph_stats()
            res["graph"] = S.stats
        return res


@app.get("/api/queries")
def list_queries():
    with S.lock:
        return {"queries": [{"name": q.get("name"), "description": q.get("description", "")} for q in S.settings().get("queries") or []]}


@app.get("/api/queries/{name}")
def run_saved_query(name: str, format: str = "json", inferred: bool = False):
    """Run a saved pipeline query by name. format=json or csv. This is the endpoint applications call."""
    if S.graph is None:
        raise HTTPException(400, "Generate the graph first.")
    with S.lock:
        q = pl.find_query(S.settings().get("queries") or [], name)
        if not q:
            raise HTTPException(404, f"No saved query named '{name}'.")
        query = pl.with_prefixes(q.get("sparql", ""), S.onto)
        if _is_update(query):
            raise HTTPException(400, "Saved queries must be read-only (SELECT, ASK or CONSTRUCT).")
        try:
            res = run_sparql(S.closed if inferred and S.closed is not None else S.graph, query, False)
        except Exception as e:
            raise HTTPException(400, f"Query '{name}' failed: {str(e).splitlines()[0][:400]}")
        if format == "csv" and res["kind"] == "select":
            buf = io.StringIO()
            w = csv.writer(buf)
            w.writerow(res["vars"])
            for row in res["rows"]:
                w.writerow([c["value"] if c else "" for c in row])
            return Response(buf.getvalue(), media_type="text/csv",
                            headers={"Content-Disposition": f'attachment; filename="{name}.csv"'})
        if res["kind"] == "select":
            return {"name": q.get("name"), "count": res["total"],
                    "results": [{v: (c["value"] if c else None) for v, c in zip(res["vars"], row)} for row in res["rows"]]}
        return {"name": q.get("name"), **res}


# ------------------------------------------------------------------ reasoning and validation
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


@app.post("/api/validate")
def validate(body: ValidateBody):
    if S.graph is None:
        raise HTTPException(400, "Generate the graph first.")
    if S.shapes is None:
        raise HTTPException(400, "Load a SHACL shapes file first (Sources tab).")
    with S.lock:
        v = _validate(body.withInferences)
        S.stats = _graph_stats()
        return {**v, "graph": S.stats}


# ------------------------------------------------------------------ export
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
        else:
            source = S.closed if scope == "data-inferred" and S.closed is not None else S.graph
            g = Graph()
            for p, ns in S.graph.namespaces():
                g.bind(p, ns, override=True)
            for t in source:
                if t not in S.onto.graph:
                    g.add(t)
        mime, ext = EXPORT_FORMATS[format]
        out = g.serialize(format=format)
        suffix = {"all": "-with-ontology", "data-inferred": "-with-inferences", "all-inferred": "-with-ontology-and-inferences"}.get(scope, "")
        return Response(out, media_type=mime, headers={"Content-Disposition": f'attachment; filename="knowledge-graph{suffix}.{ext}"'})


@app.get("/api/mapping/export")
def export_mapping():
    with S.lock:
        out = json.dumps(S.mapping or {}, indent=2)
    return Response(out, media_type="application/json", headers={"Content-Disposition": 'attachment; filename="mapping.json"'})
