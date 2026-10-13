"""Compact, hand-writable mapping format  <->  the full mapping the engine runs.

Compact example:

{
  "individuals": ":",                       # namespace for individuals (":" = ontology namespace)
  "provenance": {"editedBy": "column:entered_by", "editedAt": "column:entered_at", "pattern": "axiom-text"},
  "steps": [{"name": "Derive margin", "sparql": "INSERT { ... } WHERE { ... }"}],
  "validate": true,
  "queries": [{"name": "dcf-user-inputs", "sparql": "SELECT ..."}],
  "classes": {
    "company": {
      "class": ":PortfolioCompany",
      "name": "{company_name|pascal}",      # any naming pattern; "Company_{@n:3}" = numbered
      "columns": {
        "company_name": ":name",
        "sector": {"attr": ":sector", "user": true},
        "acquisition_date": {"attr": ":AcquisitionDate", "format": "dd-mm-yyyy"}
      }
    }
  },
  "links": ["company :hasValuation valuation"]
}
"""
from __future__ import annotations

import re

from rdflib.namespace import XSD

from .ontology import Ontology, local_name

XSD_NS = str(XSD)
NUMBERED = re.compile(r"^([^{}]*)\{@n(?::(\d+))?\}$")
DEFAULT_FORMAT = {"xsd:date": "auto-dmy", "xsd:dateTime": "auto-dmy"}


class CompactError(ValueError):
    pass


# ----------------------------------------------------------------- names <-> IRIs
def expand_name(name: str, onto: Ontology) -> str:
    name = (name or "").strip()
    if not name:
        return ""
    if name.startswith("http://") or name.startswith("https://") or name.startswith("urn:"):
        return name
    if name.startswith("<") and name.endswith(">"):
        return name[1:-1]
    if ":" in name:
        prefix, local = name.split(":", 1)
        if prefix == "":
            return onto.namespace + local
        nss = dict(onto.graph.namespaces())
        if prefix in nss:
            return str(nss[prefix]) + local
        raise CompactError(f"Unknown prefix '{prefix}:' in {name}")
    return onto.namespace + name


def short_name(iri: str, onto: Ontology) -> str:
    if not iri:
        return ""
    if iri.startswith(onto.namespace):
        return ":" + iri[len(onto.namespace):]
    q = onto.qname(iri)
    return q if ":" in q and not q.startswith("http") else iri


def range_datatype(prop_iri: str, onto: Ontology) -> str:
    info = onto.find_prop(prop_iri)
    for r in (info or {}).get("range", []):
        if r.startswith(XSD_NS):
            return "xsd:" + r[len(XSD_NS):]
    return "xsd:string"


# ----------------------------------------------------------------- compact -> full
def expand(compact: dict, onto: Ontology) -> dict:
    if not isinstance(compact.get("classes"), dict):
        raise CompactError('A compact mapping needs a "classes" object.')
    prov_in = compact.get("provenance") or {}

    def prov_part(value, default_mode):
        v = (value or "").strip()
        if v.startswith("column:"):
            return {"mode": "column", "value": v[7:].strip()}
        if default_mode == "now":
            return {"mode": "now", "value": ""}
        return {"mode": "constant", "value": v}

    ind = compact.get("individuals", ":")
    settings = {
        "dataNamespace": onto.namespace if ind in (":", "", None) else ind,
        "userEditedIri": expand_name(compact.get("userEdited", ":userEdited"), onto),
        "provenance": {
            "pattern": prov_in.get("pattern") or ("axiom-text" if prov_in.get("axioms", True) else "flag-only"),
            "editedBy": prov_part(prov_in.get("editedBy"), "constant"),
            "editedAt": prov_part(prov_in.get("editedAt"), "now"),
        },
    }

    if isinstance(prov_in.get("pattern"), dict):  # inline custom pattern
        settings["provenance"]["pattern"] = "custom"
        settings["provenance"]["custom"] = {k: prov_in["pattern"].get(k, "") for k in ("write", "read", "declarations")}
    settings["steps"] = [{"name": st.get("name", f"Step {i + 1}"), "enabled": st.get("enabled", True), "sparql": st.get("sparql", "")}
                         for i, st in enumerate(compact.get("steps") or [])]
    settings["queries"] = [{"name": q.get("name", f"query-{i + 1}"), "description": q.get("description", ""), "sparql": q.get("sparql", "")}
                           for i, q in enumerate(compact.get("queries") or [])]
    v = compact.get("validate", True)
    settings["validation"] = {"auto": bool(v), "withInferences": bool(isinstance(v, dict) and v.get("withInferences"))}
    if isinstance(v, dict):
        settings["validation"]["auto"] = bool(v.get("auto", True))
    r = compact.get("reasoner")
    if r:
        settings["reasoner"] = {"auto": True, "profile": r if r in ("rdfs", "owlrl", "rdfs-owlrl") else "owlrl"}

    nodes = []
    for nid, spec in compact["classes"].items():
        if not isinstance(spec, dict) or not spec.get("class"):
            raise CompactError(f'Class entry "{nid}" needs a "class".')
        cls = expand_name(spec["class"], onto)
        cls_local = local_name(cls)
        naming = {"mode": "auto", "prefix": cls_local + "_", "pad": 0, "template": "", "list": "",
                  "listMatch": "order", "listKey": "", "onMissing": "auto", "collision": "merge"}
        name = spec.get("name")
        if name:
            m = NUMBERED.match(name)
            if m and not spec.get("names"):
                naming.update(mode="auto", prefix=m.group(1) or cls_local + "_", pad=int(m.group(2) or 0))
            else:
                naming.update(mode="template", template=name)
        names = spec.get("names")
        if names:
            if isinstance(names, dict):
                if not spec.get("namesKey"):
                    raise CompactError(f'"{nid}": a names object needs "namesKey" (the column the keys come from).')
                naming.update(listMatch="key", listKey=spec["namesKey"],
                              list="\n".join(f"{k} => {v}" for k, v in names.items()))
            else:
                naming.update(listMatch="order", list="\n".join(str(x) for x in names))
            naming["mode"] = "hybrid" if spec.get("name") and not NUMBERED.match(spec["name"]) else "list"
            if naming["mode"] == "list" and name:
                m = NUMBERED.match(name)
                naming.update(prefix=m.group(1) or cls_local + "_", pad=int(m.group(2) or 0))
        dup = spec.get("duplicates", "merge")
        naming["collision"] = {"merge": "merge", "suffix": "suffix", "unique": "suffix", "error": "error"}.get(dup, "merge")
        naming["onMissing"] = "skip" if spec.get("ifEmpty") == "skip" else "auto"

        props = []
        for i, (col, target) in enumerate((spec.get("columns") or {}).items(), 1):
            t = {"attr": target} if isinstance(target, str) else dict(target or {})
            if not t.get("attr"):
                raise CompactError(f'"{nid}": column "{col}" needs an attribute.')
            prop = expand_name(t["attr"], onto)
            dt = t.get("type") or range_datatype(prop, onto)
            props.append({"id": f"{nid}_p{i}", "propIri": prop, "source": "column", "column": col, "constant": "",
                          "datatype": dt, "format": t.get("format", DEFAULT_FORMAT.get(dt, "")),
                          "lang": t.get("lang", ""), "userEntered": bool(t.get("user", False))})
        for j, (attr, value) in enumerate((spec.get("fixed") or {}).items(), 1):
            prop = expand_name(attr, onto)
            props.append({"id": f"{nid}_c{j}", "propIri": prop, "source": "constant", "column": "", "constant": str(value),
                          "datatype": range_datatype(prop, onto), "format": "", "lang": "", "userEntered": False})
        nodes.append({
            "id": nid, "label": spec.get("label") or onto.label(cls), "classIri": cls,
            "scope": "single" if spec.get("onePer") == "file" else "row",
            "requireData": bool(spec.get("onlyWithData", True)),
            "naming": naming, "props": props,
        })

    ids = {n["id"] for n in nodes}
    links = []
    for k, text in enumerate(compact.get("links") or [], 1):
        parts = str(text).split()
        if len(parts) != 3:
            raise CompactError(f'Link "{text}" should read "from :relationship to".')
        a, p, b = parts
        for x in (a, b):
            if x not in ids:
                raise CompactError(f'Link "{text}" refers to "{x}", which is not in "classes".')
        links.append({"id": f"l{k}", "from": a, "prop": expand_name(p, onto), "to": b})
    return {"version": 1, "settings": settings, "nodes": nodes, "links": links}


# ----------------------------------------------------------------- full -> compact
def compact(mapping: dict, onto: Ontology) -> dict:
    s = mapping.get("settings") or {}
    prov = s.get("provenance") or {}
    out: dict = {}
    ns = s.get("dataNamespace") or ""
    if ns and ns != onto.namespace:
        out["individuals"] = ns
    ue = s.get("userEditedIri") or ""
    if ue and ue != onto.namespace + "userEdited":
        out["userEdited"] = short_name(ue, onto)
    p_out = {}
    by, at = prov.get("editedBy") or {}, prov.get("editedAt") or {}
    if by.get("value"):
        p_out["editedBy"] = ("column:" if by.get("mode") == "column" else "") + by["value"]
    if at.get("mode") == "column" and at.get("value"):
        p_out["editedAt"] = "column:" + at["value"]
    pattern = prov.get("pattern") or ("axiom-text" if prov.get("writeAxioms", True) else "flag-only")
    if pattern == "custom":
        p_out["pattern"] = {k: (prov.get("custom") or {}).get(k, "") for k in ("write", "read", "declarations")}
    elif pattern != "axiom-text":
        p_out["pattern"] = pattern
    if p_out:
        out["provenance"] = p_out
    val = s.get("validation") or {}
    if val.get("auto") is False:
        out["validate"] = False
    elif val.get("withInferences"):
        out["validate"] = {"withInferences": True}
    if s.get("steps"):
        out["steps"] = [{k: v for k, v in st.items() if not (k == "enabled" and v is True)} for st in s["steps"]]
    if s.get("queries"):
        out["queries"] = [{k: v for k, v in q.items() if v != ""} for q in s["queries"]]
    rs = s.get("reasoner") or {}
    if rs.get("auto"):
        out["reasoner"] = rs.get("profile", "owlrl")

    classes = {}
    for n in mapping.get("nodes") or []:
        cls = n.get("classIri", "")
        cls_local = local_name(cls)
        e: dict = {"class": short_name(cls, onto)}
        if n.get("label") and n["label"] != onto.label(cls):
            e["label"] = n["label"]
        nm = n.get("naming") or {}
        mode = nm.get("mode", "auto")
        numbered = f"{nm.get('prefix') or cls_local + '_'}{{@n{':' + str(nm['pad']) if int(nm.get('pad') or 0) else ''}}}"
        if mode == "auto":
            if numbered != f"{cls_local}_{{@n}}":
                e["name"] = numbered
        elif mode == "template":
            e["name"] = nm.get("template", "")
        else:
            if mode == "hybrid":
                e["name"] = nm.get("template", "")
            elif numbered != f"{cls_local}_{{@n}}":
                e["name"] = numbered
            lines = [l.strip() for l in (nm.get("list") or "").splitlines() if l.strip() and not l.strip().startswith("#")]
            if nm.get("listMatch") == "key":
                pairs = {}
                for l in lines:
                    for sep in ("=>", "\t", ",", ";"):
                        if sep in l:
                            k, v = l.split(sep, 1)
                            pairs[k.strip()] = v.strip()
                            break
                e["names"], e["namesKey"] = pairs, nm.get("listKey", "")
            else:
                e["names"] = lines
        if n.get("scope") == "single":
            e["onePer"] = "file"
        if nm.get("collision", "merge") != "merge":
            e["duplicates"] = nm["collision"]
        if nm.get("onMissing") == "skip":
            e["ifEmpty"] = "skip"
        if n.get("requireData") is False:
            e["onlyWithData"] = False
        cols, fixed = {}, {}
        for p in n.get("props") or []:
            prop = p.get("propIri", "")
            if p.get("source") == "constant":
                fixed[short_name(prop, onto)] = p.get("constant", "")
                continue
            if not p.get("column"):
                continue
            dt = p.get("datatype") or "xsd:string"
            extra = {}
            if p.get("userEntered"):
                extra["user"] = True
            if dt != range_datatype(prop, onto):
                extra["type"] = dt
            if p.get("format") and p["format"] != DEFAULT_FORMAT.get(dt, ""):
                extra["format"] = p["format"]
            if p.get("lang"):
                extra["lang"] = p["lang"]
            cols[p["column"]] = {"attr": short_name(prop, onto), **extra} if extra else short_name(prop, onto)
        if cols:
            e["columns"] = cols
        if fixed:
            e["fixed"] = fixed
        classes[n["id"]] = e
    out["classes"] = classes
    links = [f"{l['from']} {short_name(l['prop'], onto)} {l['to']}" for l in mapping.get("links") or [] if l.get("from") and l.get("prop") and l.get("to")]
    if links:
        out["links"] = links
    return out
