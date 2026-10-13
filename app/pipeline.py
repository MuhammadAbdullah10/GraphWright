"""Pipeline stages that are configured, not coded: SPARQL transform steps and saved queries."""
from __future__ import annotations

import re
import time

from rdflib import Graph

from .provenance import prefix_block

DECLARED_PREFIX = re.compile(r"^\s*PREFIX\s+([\w\-]*):", re.I | re.M)


def with_prefixes(query: str, onto) -> str:
    """Prepend the ontology's prefixes that the query doesn't declare itself, so steps can be short."""
    declared = {m.group(1) for m in DECLARED_PREFIX.finditer(query)}
    lines = [l for l in prefix_block(onto).splitlines() if l.split()[1][:-1] not in declared]
    return "\n".join(lines) + "\n" + query


def run_steps(graph: Graph, steps: list[dict], onto) -> list[dict]:
    """Run enabled SPARQL UPDATE steps in order. Stops at the first failing step."""
    out = []
    failed = False
    for i, step in enumerate(steps or []):
        name = step.get("name") or f"Step {i + 1}"
        if not step.get("enabled", True):
            out.append({"name": name, "status": "skipped", "reason": "turned off"})
            continue
        if failed:
            out.append({"name": name, "status": "skipped", "reason": "an earlier step failed"})
            continue
        sparql = (step.get("sparql") or "").strip()
        if not sparql:
            out.append({"name": name, "status": "skipped", "reason": "empty"})
            continue
        before = len(graph)
        started = time.perf_counter()
        try:
            graph.update(with_prefixes(sparql, onto))
        except Exception as e:
            failed = True
            out.append({"name": name, "status": "error", "error": str(e).strip().splitlines()[0][:400]})
            continue
        out.append({"name": name, "status": "ok", "before": before, "after": len(graph), "delta": len(graph) - before,
                    "ms": round((time.perf_counter() - started) * 1000, 1)})
    return out


def find_query(queries: list[dict], name: str) -> dict | None:
    key = name.strip().lower()
    for q in queries or []:
        if (q.get("name") or "").strip().lower() == key or (q.get("id") or "") == name:
            return q
    return None
