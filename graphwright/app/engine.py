"""Mapping engine: instance naming, value conversion, link creation and graph building."""
from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import date, datetime, timezone

from rdflib import BNode, Graph, Literal, URIRef
from rdflib.namespace import OWL, RDF, RDFS, XSD

from .convert import parse_datetime, short_dt, to_literal
from .csvdata import CsvData
from .ontology import Ontology, local_name

TOKEN_RE = re.compile(r"\{([^{}]+)\}")
PREVIEW_ROW_LIMIT = 2000


class TemplateError(Exception):
    pass


# ----------------------------------------------------------------- naming helpers
def ascii_fold(s: str) -> str:
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")


def sanitize_local(s: str) -> str:
    """Turn arbitrary text into a safe IRI local name."""
    s = ascii_fold(s or "").strip()
    s = re.sub(r"\s+", "_", s)
    s = re.sub(r"[^A-Za-z0-9_\-.]", "", s)
    s = re.sub(r"_{2,}", "_", s)
    s = s.strip("_-.")
    return s


def _words(s: str) -> list[str]:
    s = ascii_fold(s)
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", s)
    return [w for w in re.split(r"[^A-Za-z0-9]+", s) if w]


MODIFIERS = {
    "slug": lambda v: "_".join(_words(v)),
    "lower": lambda v: v.lower(),
    "upper": lambda v: v.upper(),
    "pascal": lambda v: "".join(w[:1].upper() + w[1:] for w in _words(v)),
    "camel": lambda v: (lambda s: s[:1].lower() + s[1:])("".join(w[:1].upper() + w[1:] for w in _words(v))),
    "hash": lambda v: hashlib.sha1(v.encode("utf-8")).hexdigest()[:8],
    "trim": lambda v: v.strip(),
    "initials": lambda v: "".join(w[0].upper() for w in _words(v)),
}


def template_refs(template: str) -> tuple[set[str], set[str]]:
    """Return (columns, node ids) referenced by a template."""
    cols, nodes = set(), set()
    for m in TOKEN_RE.finditer(template or ""):
        head = m.group(1).split("|")[0].strip()
        if head.startswith("@"):
            name, _, arg = head[1:].partition(":")
            if name.lower() == "node" and arg:
                nodes.add(arg.strip())
        else:
            cols.add(head)
    return cols, nodes


def render_template(template: str, row: dict, ctx: dict) -> tuple[str, bool]:
    """Render a naming template. Returns (text, any_value_missing)."""
    missing = False

    def rep(m):
        nonlocal missing
        parts = [p.strip() for p in m.group(1).split("|")]
        head, mods = parts[0], parts[1:]
        if head.startswith("@"):
            name, _, arg = head[1:].partition(":")
            name = name.lower()
            if name == "class":
                val = ctx["class_local"]
            elif name == "row":
                val = str(ctx["row"] + 1)
            elif name == "n":
                val = str(ctx["n"]).zfill(int(arg)) if arg.strip().isdigit() else str(ctx["n"])
            elif name == "node":
                val = ctx["node_locals"].get(arg.strip()) or ""
            elif name == "today":
                val = date.today().isoformat()
            elif name == "node_label":
                val = ctx.get("node_label", "")
            else:
                raise TemplateError(f"Unknown token {{@{name}}}")
        else:
            if head not in row:
                raise TemplateError(f"Unknown column '{head}'")
            val = row.get(head, "")
        val = (val or "").strip()
        if not val:
            missing = True
        for mod in mods:
            fn = MODIFIERS.get(mod.lower())
            if fn is None:
                raise TemplateError(f"Unknown modifier '|{mod}'")
            val = fn(val)
        return val

    return TOKEN_RE.sub(rep, template or ""), missing


def parse_name_list(text: str, keyed: bool) -> tuple[list[str], dict[str, str]]:
    ordered, keyed_map = [], {}
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if keyed:
            for sep in ("=>", "\t", ",", ";"):
                if sep in line:
                    k, v = line.split(sep, 1)
                    keyed_map[k.strip()] = v.strip()
                    break
        else:
            ordered.append(line)
    return ordered, keyed_map


# ----------------------------------------------------------------- data classes
@dataclass
class Instance:
    iri: str
    node_id: str
    class_iri: str
    method: str
    rows: list[int] = field(default_factory=list)
    values: dict[str, list[Literal]] = field(default_factory=dict)
    user_props: dict[str, tuple[str, str]] = field(default_factory=dict)  # prop -> (by, at)
    extra_nodes: list[str] = field(default_factory=list)


class Issues:
    def __init__(self):
        self.items: list[dict] = []
        self._agg: dict[tuple, dict] = {}

    def add(self, level: str, message: str, node: str | None = None, rows: list[int] | None = None, code: str = "", prop: str | None = None):
        self.items.append({"level": level, "message": message, "node": node, "rows": rows or [], "code": code, "prop": prop})

    def tally(self, key: tuple, level: str, message: str, node: str | None, row: int | None, prop: str | None = None):
        item = self._agg.get(key)
        if item is None:
            item = {"level": level, "message": message, "node": node, "rows": [], "count": 0, "code": key[0], "prop": prop}
            self._agg[key] = item
            self.items.append(item)
        item["count"] += 1
        if row is not None and len(item["rows"]) < 5:
            item["rows"].append(row + 1)

    def finish(self) -> list[dict]:
        for it in self.items:
            if it.get("count", 0) > 1:
                it["message"] = f"{it['message']} ({it['count']} occurrences)"
        order = {"error": 0, "warning": 1, "info": 2}
        return sorted(self.items, key=lambda i: order.get(i["level"], 3))


# ----------------------------------------------------------------- engine
class MappingRun:
    def __init__(self, onto: Ontology, data: CsvData, mapping: dict, preview: bool = False):
        self.onto = onto
        self.data = data
        self.mapping = mapping or {}
        self.preview = preview
        self.rows = data.rows[:PREVIEW_ROW_LIMIT] if preview else data.rows
        self.issues = Issues()
        self.settings = self.mapping.get("settings") or {}
        ns = (self.settings.get("dataNamespace") or onto.namespace or "http://example.org/data#").strip()
        self.data_ns = ns
        self.nodes = [n for n in (self.mapping.get("nodes") or [])]
        self.links = self.mapping.get("links") or []
        self.instances: dict[str, Instance] = {}
        self.assign: dict[str, list[str | None]] = {}
        self.node_stats: dict[str, dict] = {}
        self.generated_at = datetime.now(timezone.utc).replace(microsecond=0)

    # .............................................................. ordering
    def _ordered_nodes(self) -> list[dict]:
        ids = {n.get("id") for n in self.nodes}
        deps: dict[str, set[str]] = {}
        for n in self.nodes:
            nm = n.get("naming") or {}
            _, refs = template_refs(nm.get("template", ""))
            bad = refs - ids
            for b in bad:
                self.issues.add("error", f"Template refers to node '@node:{b}', which doesn't exist.", n.get("id"), code="tpl")
            deps[n["id"]] = (refs & ids) - {n["id"]}
            if n["id"] in refs:
                self.issues.add("error", "A node's template can't refer to the node itself.", n["id"], code="tpl")
        ordered, done, visiting = [], set(), set()
        by_id = {n["id"]: n for n in self.nodes}

        def visit(nid, path):
            if nid in done:
                return True
            if nid in visiting:
                self.issues.add("error", "Templates refer to each other in a loop: " + " → ".join(path + [nid]), nid, code="cycle")
                return False
            visiting.add(nid)
            ok = all(visit(d, path + [nid]) for d in deps.get(nid, ()))
            visiting.discard(nid)
            if ok:
                done.add(nid)
                ordered.append(by_id[nid])
            return ok

        for n in self.nodes:
            visit(n["id"], [])
        return ordered

    # .............................................................. run
    def run(self) -> "MappingRun":
        headers = set(self.data.headers)
        global_owner: dict[str, str] = {}
        used_columns: set[str] = set()

        for node in self._ordered_nodes():
            nid = node["id"]
            cls = node.get("classIri") or ""
            label = node.get("label") or nid
            naming = node.get("naming") or {}
            mode = naming.get("mode", "auto")
            stats = {"instances": 0, "rowsUsed": 0, "skippedNoData": 0, "skippedNoName": 0, "merged": 0,
                     "fromList": 0, "fromTemplate": 0, "auto": 0, "fallback": 0, "sample": []}
            self.node_stats[nid] = stats
            assign: list[str | None] = [None] * len(self.rows)
            self.assign[nid] = assign
            if not cls:
                self.issues.add("error", f"Choose a class for '{label}'.", nid, code="class")
                continue
            if cls not in {c["iri"] for c in self.onto.classes}:
                self.issues.add("warning", f"Class {local_name(cls)} isn't defined in the ontology.", nid, code="class")
            class_local = local_name(cls)
            props = node.get("props") or []

            # validate templates and columns up front
            template = naming.get("template", "")
            try:
                if mode in ("template", "hybrid"):
                    if not template.strip():
                        raise TemplateError("The naming rule is empty.")
                    render_template(template, {h: "x" for h in headers}, {"class_local": class_local, "row": 0, "n": 1, "node_locals": {}})
                    used_columns |= template_refs(template)[0]
            except TemplateError as e:
                self.issues.add("error", f"Naming rule: {e}", nid, code="tpl")
                continue
            ordered_names, keyed_names = [], {}
            list_key = naming.get("listKey") or ""
            keyed = naming.get("listMatch") == "key"
            if mode in ("list", "hybrid"):
                ordered_names, keyed_names = parse_name_list(naming.get("list", ""), keyed)
                if keyed:
                    if list_key not in headers:
                        self.issues.add("error", "Choose the key column that the name list is matched on.", nid, code="list")
                        continue
                    used_columns.add(list_key)
                if not ordered_names and not keyed_names:
                    self.issues.add("warning", "The name list is empty.", nid, code="list")

            column_props = []
            for p in props:
                if p.get("source", "column") == "column":
                    col = p.get("column")
                    if col and col in headers:
                        column_props.append(col)
                        used_columns.add(col)
                    elif col:
                        self.issues.add("error", f"Column '{col}' isn't in the CSV.", nid, code="col")
            require = bool(node.get("requireData", True)) and bool(column_props)
            prefix = naming.get("prefix")
            if prefix is None or prefix == "":
                prefix = class_local + "_"
            pad = int(naming.get("pad") or 0)
            collision = naming.get("collision", "merge")
            on_missing = naming.get("onMissing", "auto")
            scope = node.get("scope", "row")
            node_iris: dict[str, Instance] = {}
            used_list_keys: set[str] = set()

            def auto_name():
                return prefix + str(stats["instances"] + 1).zfill(pad)

            def compute(i, row):
                ctx = {"class_local": class_local, "row": i, "n": stats["instances"] + 1, "node_label": label,
                       "node_locals": {k: local_name(v[i]) if v[i] else "" for k, v in self.assign.items()}}
                if mode == "auto":
                    return auto_name(), "auto"
                if mode in ("list", "hybrid"):
                    nm = None
                    if keyed:
                        key = (row.get(list_key) or "").strip()
                        nm = keyed_names.get(key)
                        if nm:
                            used_list_keys.add(key)
                    else:
                        # line k names the k-th row that has data for this node
                        idx = 0 if scope == "single" else seen["eligible"] - 1
                        nm = ordered_names[idx] if 0 <= idx < len(ordered_names) else None
                    if nm and sanitize_local(nm):
                        return nm, "list"
                    if mode == "list":
                        self.issues.tally(("unmatched", nid), "warning",
                                          "No name in the list for this row, so a generic name was used", nid, i)
                        return auto_name(), "fallback"
                try:
                    text, missing = render_template(template, row, ctx)
                except TemplateError as e:
                    self.issues.tally(("tplrow", nid, str(e)), "error", f"Naming rule: {e}", nid, i)
                    return None, "skipped"
                if missing or not sanitize_local(text):
                    if on_missing == "skip":
                        self.issues.tally(("noname", nid), "info", "Row skipped because the naming rule had empty values", nid, i)
                        return None, "skipped"
                    self.issues.tally(("namefb", nid), "warning", "Naming rule had empty values, so a generic name was used", nid, i)
                    return auto_name(), "fallback"
                return text, "template"

            seen = {"eligible": 0}

            def eligible(row):
                return not require or any((row.get(c) or "").strip() for c in column_props)

            def attach(i, raw_name, method):
                local = sanitize_local(raw_name)
                if not local:
                    stats["skippedNoName"] += 1
                    return None
                if local != raw_name.strip() and method in ("template", "list"):
                    self.issues.tally(("sanitized", nid), "info",
                                      "Some names contained characters that aren't allowed in IRIs and were cleaned", nid, i)
                iri = self.data_ns + local
                if iri in node_iris:
                    if collision == "merge":
                        inst = node_iris[iri]
                        inst.rows.append(i)
                        stats["merged"] += 1
                        return iri
                    if collision == "error":
                        self.issues.tally(("dup", nid), "error",
                                          f"Two rows produced the same name ({local}); the later row was skipped", nid, i)
                        return None
                if iri in node_iris or (iri in global_owner and global_owner[iri] != nid and collision == "suffix"):
                    k = 2
                    while f"{self.data_ns}{local}_{k}" in global_owner:
                        k += 1
                    iri = f"{self.data_ns}{local}_{k}"
                elif iri in global_owner and global_owner[iri] != nid:
                    other = global_owner[iri]
                    self.issues.tally(("shared", nid, other), "warning",
                                      f"Names overlap with node '{other}', so those individuals get both classes", nid, i)
                    inst = self.instances[iri]
                    if cls not in inst.extra_nodes and cls != inst.class_iri:
                        inst.extra_nodes.append(cls)
                    node_iris[iri] = inst
                    inst.rows.append(i)
                    return iri
                inst = Instance(iri=iri, node_id=nid, class_iri=cls, method=method, rows=[i])
                node_iris[iri] = inst
                self.instances[iri] = inst
                global_owner[iri] = nid
                stats["instances"] += 1
                stats[{"list": "fromList", "template": "fromTemplate", "auto": "auto"}.get(method, "fallback")] += 1
                if len(stats["sample"]) < 8:
                    stats["sample"].append({"local": local, "iri": iri, "method": method, "row": i + 1})
                return iri

            if scope == "single":
                rows_ok = [i for i, r in enumerate(self.rows) if eligible(r)]
                if rows_ok:
                    first = rows_ok[0]
                    name, method = compute(first, self.rows[first])
                    iri = attach(first, name, method) if name else None
                    if iri:
                        for i in rows_ok:
                            assign[i] = iri
                            if i != first:
                                self.instances[iri].rows.append(i)
                        stats["rowsUsed"] = len(rows_ok)
                stats["skippedNoData"] = len(self.rows) - len(rows_ok)
            else:
                for i, row in enumerate(self.rows):
                    if not eligible(row):
                        stats["skippedNoData"] += 1
                        continue
                    seen["eligible"] += 1
                    name, method = compute(i, row)
                    if not name:
                        stats["skippedNoName"] += 1
                        continue
                    iri = attach(i, name, method)
                    if iri:
                        assign[i] = iri
                        stats["rowsUsed"] += 1

            if keyed and mode in ("list", "hybrid"):
                unused = [k for k in keyed_names if k not in used_list_keys]
                if unused:
                    self.issues.add("info", f"{len(unused)} name(s) in the list matched no row: " + ", ".join(unused[:5]), nid, code="listunused")
            if not keyed and mode in ("list", "hybrid") and scope == "row" and 0 < len(ordered_names) < seen["eligible"]:
                self.issues.add("info", f"The list has {len(ordered_names)} names for {seen['eligible']} rows; the remaining rows use the "
                                + ("generic name." if mode == "list" else "naming rule."), nid, code="listshort")

            self._fill_values(node, cls)

        self._check_links()
        self._unused_columns(used_columns)
        return self

    # .............................................................. values
    def _fill_values(self, node: dict, cls: str):
        nid = node["id"]
        assign = self.assign[nid]
        ancestors = self.onto.class_and_ancestors(cls)
        prov = self.settings.get("provenance") or {}
        by_cfg, at_cfg = prov.get("editedBy") or {}, prov.get("editedAt") or {}
        for p in node.get("props") or []:
            prop = p.get("propIri")
            if not prop:
                self.issues.add("error", f"Choose the attribute that column '{p.get('column') or '?'}' fills.", nid, code="prop", prop="")
                continue
            info = self.onto.find_prop(prop)
            pname = local_name(prop)
            if info and info["kind"] == "object":
                self.issues.add("warning", f"{pname} is an object property; it links to other individuals rather than holding a value. Use Relationships instead.", nid, code="kind", prop=prop)
            if info and info["domain"] and not (set(info["domain"]) & ancestors):
                self.issues.add("warning", f"{pname} is defined for {', '.join(local_name(d) for d in info['domain'])}, not {local_name(cls)}.", nid, code="domain", prop=prop)
            source = p.get("source", "column")
            col = p.get("column")
            if source == "column" and (not col or col not in self.data.headers):
                continue
            dt = p.get("datatype") or "xsd:string"
            for i, row in enumerate(self.rows):
                iri = assign[i]
                if not iri:
                    continue
                raw = p.get("constant", "") if source == "constant" else row.get(col, "")
                lit, err = to_literal(raw, dt, p.get("format", ""), p.get("lang", ""))
                if err:
                    self.issues.tally(("conv", nid, prop), "warning", f"{pname}: {err}; value skipped", nid, i, prop)
                    continue
                if lit is None:
                    continue
                inst = self.instances[iri]
                vals = inst.values.setdefault(prop, [])
                if lit not in vals:
                    vals.append(lit)
                    if len(vals) == 2:
                        self.issues.tally(("multi", nid, prop), "warning",
                                          f"{pname}: merged rows give different values, so an individual holds several", nid, i, prop)
                if p.get("userEntered") and source == "column" or p.get("userEntered") and source == "constant":
                    by = (row.get(by_cfg.get("value", ""), "") if by_cfg.get("mode") == "column" else by_cfg.get("value", "")).strip()
                    at = ""
                    if at_cfg.get("mode") == "column":
                        d = parse_datetime(row.get(at_cfg.get("value", ""), ""))
                        at = d.isoformat() if d else ""
                    inst.user_props[prop] = (by or "unknown", at or self.generated_at.isoformat().replace("+00:00", "Z"))

    def _check_links(self):
        node_cls = {n["id"]: n.get("classIri") for n in self.nodes}
        self.link_counts = {}
        for ln in self.links:
            f, t, prop = ln.get("from"), ln.get("to"), ln.get("prop")
            lid = ln.get("id")
            if not (f and t and prop):
                self.issues.add("error", "A relationship is missing its source, property or target.", None, code="link")
                continue
            if f not in self.assign or t not in self.assign:
                continue
            info = self.onto.find_prop(prop)
            pname = local_name(prop)
            if info:
                if info["kind"] == "datatype":
                    self.issues.add("warning", f"{pname} is a datatype property; relationships should use object properties.", None, code="linkkind")
                fc, tc = node_cls.get(f) or "", node_cls.get(t) or ""
                if info["domain"] and fc and not (set(info["domain"]) & self.onto.class_and_ancestors(fc)):
                    self.issues.add("warning", f"{pname} expects {', '.join(local_name(d) for d in info['domain'])} as the source, but the source is {local_name(fc)}.", f, code="linkdomain")
                if info["range"] and tc and not (set(info["range"]) & self.onto.class_and_ancestors(tc)):
                    self.issues.add("warning", f"{pname} expects {', '.join(local_name(r) for r in info['range'])} as the target, but the target is {local_name(tc)}.", t, code="linkrange")
            pairs = set()
            for a, b in zip(self.assign[f], self.assign[t]):
                if a and b:
                    pairs.add((a, b))
            self.link_counts[lid] = len(pairs)
            ln["_pairs"] = pairs

    def _unused_columns(self, used: set[str]):
        prov = self.settings.get("provenance") or {}
        for k in ("editedBy", "editedAt"):
            c = prov.get(k) or {}
            if c.get("mode") == "column" and c.get("value"):
                used.add(c["value"])
        unused = [h for h in self.data.headers if h not in used]
        if unused and self.nodes:
            self.issues.add("info", f"{len(unused)} column(s) aren't mapped: " + ", ".join(unused[:8]) + ("…" if len(unused) > 8 else ""), None, code="unused")

    # .............................................................. output
    def preview_payload(self) -> dict:
        return {
            "nodes": self.node_stats,
            "links": getattr(self, "link_counts", {}),
            "issues": self.issues.finish(),
            "rowsConsidered": len(self.rows),
            "rowsTotal": len(self.data.rows),
            "instanceCount": len(self.instances),
        }

    def build_graph(self) -> tuple[Graph, dict]:
        onto = self.onto
        g = Graph()
        for p, ns in onto.graph.namespaces():
            g.bind(p, ns, override=True)
        if self.data_ns != onto.namespace:
            g.bind("data", self.data_ns, override=True)

        ns = onto.namespace
        prov = self.settings.get("provenance") or {}
        user_edited = URIRef(self.settings.get("userEditedIri") or ns + "userEdited")
        edited_by = URIRef(ns + "editedBy")
        edited_at = URIRef(ns + "editedAt")
        user_cls = URIRef(ns + "User")
        user_id = URIRef(ns + "userId")

        meta: dict[str, dict] = {}
        node_labels = {n["id"]: n.get("label") or n["id"] for n in self.nodes}
        any_user = False
        for iri, inst in self.instances.items():
            s = URIRef(iri)
            g.add((s, RDF.type, URIRef(inst.class_iri)))
            for extra in inst.extra_nodes:
                g.add((s, RDF.type, URIRef(extra)))
            for prop, vals in inst.values.items():
                for v in vals:
                    g.add((s, URIRef(prop), v))
            for prop, (by, at) in inst.user_props.items():
                any_user = True
                g.add((s, user_edited, URIRef(prop)))
                if prov.get("writeAxioms", True):
                    ax = BNode()
                    user = URIRef(self.data_ns + "user_" + (sanitize_local(by) or "unknown"))
                    g.add((user, RDF.type, user_cls))
                    g.add((user, user_id, Literal(by)))
                    g.add((ax, RDF.type, OWL.Axiom))
                    g.add((ax, OWL.annotatedSource, s))
                    g.add((ax, OWL.annotatedProperty, user_edited))
                    g.add((ax, OWL.annotatedTarget, URIRef(prop)))
                    g.add((ax, edited_by, user))
                    g.add((ax, edited_at, Literal(at, datatype=XSD.dateTime)))
            meta[iri] = {
                "node": inst.node_id,
                "nodeLabel": node_labels.get(inst.node_id, inst.node_id),
                "class": inst.class_iri,
                "rows": [r + 1 for r in inst.rows[:50]],
                "rowCount": len(inst.rows),
                "naming": inst.method,
            }
        for ln in self.links:
            for a, b in ln.get("_pairs", ()):
                g.add((URIRef(a), URIRef(ln["prop"]), URIRef(b)))

        # declare the provenance vocabulary if the ontology doesn't have it
        if any_user:
            declared = set(onto.graph.subjects(RDF.type, OWL.AnnotationProperty))
            for p, lbl in ((user_edited, "user edited"), (edited_by, "edited by"), (edited_at, "edited at")):
                if p not in declared and (p == user_edited or prov.get("writeAxioms", True)):
                    g.add((p, RDF.type, OWL.AnnotationProperty))
                    g.add((p, RDFS.label, Literal(lbl, lang="en")))
            if prov.get("writeAxioms", True) and (user_cls, RDF.type, OWL.Class) not in onto.graph:
                g.add((user_cls, RDF.type, OWL.Class))
        return g, meta


def describe_dt(dt: str) -> str:
    return short_dt(dt)
