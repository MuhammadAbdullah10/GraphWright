/* Graphwright front end. Vanilla JS; talks to the FastAPI backend under /api. */
'use strict';

// ------------------------------------------------------------------ utilities
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const localName = (iri) => { const s = String(iri || ''); const m = s.match(/[^#/:]+$/); return m ? m[0] : s; };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const fmtNum = (n) => Number(n || 0).toLocaleString('en-GB');

async function api(path, opts = {}) {
  const init = { ...opts };
  if (opts.json !== undefined) {
    init.method = init.method || 'POST';
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.json);
    delete init.json;
  }
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  if (!res.ok) throw new Error((data && (data.detail || data.error)) || `Request failed (${res.status})`);
  return data;
}

async function upload(path, file) {
  const fd = new FormData();
  fd.append('file', file);
  return api(path, { method: 'POST', body: fd });
}

let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 6000 : 3200);
}

function downloadText(name, text, mime) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

// ------------------------------------------------------------------ state
const XSD_TYPES = ['xsd:string', 'xsd:integer', 'xsd:decimal', 'xsd:double', 'xsd:boolean', 'xsd:date', 'xsd:dateTime', 'xsd:gYear', 'xsd:anyURI'];
const DATE_FORMATS = [
  ['auto-dmy', 'Auto, day first'], ['auto-mdy', 'Auto, month first'], ['iso', 'YYYY-MM-DD'],
  ['dd-mm-yyyy', 'DD-MM-YYYY'], ['mm-dd-yyyy', 'MM-DD-YYYY'], ['dd/mm/yyyy', 'DD/MM/YYYY'], ['mm/dd/yyyy', 'MM/DD/YYYY'],
  ['dd.mm.yyyy', 'DD.MM.YYYY'], ['yyyy/mm/dd', 'YYYY/MM/DD'], ['yyyymmdd', 'YYYYMMDD'], ['d mon yyyy', '1 Feb 2020'],
];
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const XSD_NS = 'http://www.w3.org/2001/XMLSchema#';

function emptyMapping() {
  return {
    version: 1,
    settings: {
      dataNamespace: '', userEditedIri: '',
      provenance: { pattern: 'axiom-text', editedBy: { mode: 'constant', value: '' }, editedAt: { mode: 'now', value: '' } },
      steps: [], queries: [], validation: { auto: true, withInferences: false }, reasoner: { auto: false, profile: 'owlrl' },
    },
    nodes: [], links: [],
  };
}

const state = {
  onto: null, csv: null, mapping: emptyMapping(), preview: null, graphStats: null,
  stale: false, tab: 'sources', cy: null, graphLoaded: false, lastResult: null, focusTpl: {},
};

// ------------------------------------------------------------------ theme + colours
// Ordered so neighbouring entries differ in hue; mapped classes take the first slots.
const PALETTE_LIGHT = ['#2B5B9E', '#C26A00', '#0B7A6B', '#9D2E8A', '#B3322A', '#5E8C14', '#6B4FBB', '#0E7FA0', '#A3720C', '#C2185B', '#55606B', '#7A4A24'];
const PALETTE_DARK = ['#7EAAF0', '#F0A43E', '#3CC2AC', '#E28AD4', '#F07A70', '#A3D45C', '#ADA1F7', '#4FC3DC', '#E3C25E', '#F48FB1', '#AAB6C2', '#D19A6A'];
function colorOrder() {
  const mapped = state.mapping.nodes.map((n) => n.classIri);
  const all = (state.onto?.classes || []).map((c) => c.iri);
  return [...new Set([...mapped, ...all])];
}

function isDark() {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function classColor(iri) {
  let i = colorOrder().indexOf(iri);
  if (i < 0) { i = 0; for (const ch of String(iri)) i = (i * 31 + ch.charCodeAt(0)) >>> 0; }
  const pal = isDark() ? PALETTE_DARK : PALETTE_LIGHT;
  return pal[i % pal.length];
}
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  store.set('gw-theme', t || null);
  onThemeChange();
}
function onThemeChange() {
  if (state.cy) { recolorGraph(); state.cy.style(cyStyle()); }
  if (state.tab === 'mapping') renderMapping();
  if (state.onto) renderExplorer();
  renderLegend();
}

// ------------------------------------------------------------------ ontology helpers
let ontoIndex = { classes: new Map(), props: new Map(), children: new Map() };
function indexOntology() {
  ontoIndex = { classes: new Map(), props: new Map(), children: new Map() };
  if (!state.onto) return;
  for (const c of state.onto.classes) ontoIndex.classes.set(c.iri, c);
  for (const coll of ['datatypeProps', 'objectProps', 'annotationProps']) for (const p of state.onto[coll]) ontoIndex.props.set(p.iri, p);
  for (const c of state.onto.classes) for (const p of c.parents) {
    if (!ontoIndex.children.has(p)) ontoIndex.children.set(p, []);
    ontoIndex.children.get(p).push(c.iri);
  }
}
function ancestors(iri) {
  const out = new Set([iri]); const stack = [iri];
  while (stack.length) { const c = ontoIndex.classes.get(stack.pop()); for (const p of c?.parents || []) if (!out.has(p)) { out.add(p); stack.push(p); } }
  return out;
}
function propFits(p, classIri) {
  if (!p.domain || !p.domain.length) return null;
  const anc = ancestors(classIri);
  return p.domain.some((d) => anc.has(d));
}
function classTree() {
  const roots = state.onto.classes.filter((c) => !c.parents.length).map((c) => c.iri);
  const seen = new Set();
  const walk = (iri, depth, out) => {
    if (seen.has(iri)) return; seen.add(iri);
    out.push({ iri, depth });
    for (const ch of (ontoIndex.children.get(iri) || []).sort((a, b) => localName(a).localeCompare(localName(b)))) walk(ch, depth + 1, out);
  };
  const out = [];
  roots.forEach((r) => walk(r, 0, out));
  state.onto.classes.forEach((c) => walk(c.iri, 0, out)); // anything in a cycle
  return out;
}
function classOptions(selected) {
  if (!state.onto) return '';
  let html = selected ? '' : '<option value="">Choose a class…</option>';
  for (const { iri, depth } of classTree()) {
    html += `<option value="${esc(iri)}"${iri === selected ? ' selected' : ''}>${' '.repeat(depth)}${esc(localName(iri))}</option>`;
  }
  return html;
}
function rangeDatatype(p, colType) {
  const r = (p?.range || []).find((x) => x.startsWith(XSD_NS));
  if (r) return 'xsd:' + r.slice(XSD_NS.length);
  return { integer: 'xsd:integer', decimal: 'xsd:decimal', date: 'xsd:date', boolean: 'xsd:boolean' }[colType] || 'xsd:string';
}
function ontoPrefix() {
  if (!state.onto) return { label: ':', decl: '' };
  const ns = state.onto.namespace;
  const entry = Object.entries(state.onto.prefixes).find(([, v]) => v === ns);
  const p = entry ? entry[0] : 'ex';
  return { label: p + ':', decl: `PREFIX ${p}: <${ns}>` };
}

// fuzzy column → property similarity (light version of the server's matcher)
const normTxt = (s) => String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]/g, '');
function similarity(a, b) {
  a = normTxt(a); b = normTxt(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) && b.length >= 3) return 0.85;
  if (b.includes(a) && a.length >= 3) return 0.8;
  const grams = (s) => { const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; };
  const ga = grams(a), gb = grams(b); let inter = 0; ga.forEach((x) => { if (gb.has(x)) inter++; });
  return (2 * inter) / (ga.size + gb.size || 1);
}

// ------------------------------------------------------------------ mapping model helpers
const nodeById = (id) => state.mapping.nodes.find((n) => n.id === id);
function uniqueNodeId(base) {
  base = (base || 'node').toLowerCase().replace(/[^a-z0-9]/g, '') || 'node';
  let id = base, k = 2;
  while (nodeById(id)) id = base + k++;
  return id;
}
function newNode(classIri) {
  const local = localName(classIri);
  return {
    id: uniqueNodeId(local), label: ontoIndex.classes.get(classIri)?.label || local, classIri, scope: 'row', requireData: true,
    naming: { mode: 'auto', prefix: local + '_', pad: 0, template: '', list: '', listMatch: 'order', listKey: '', onMissing: 'auto', collision: 'merge' },
    props: [],
  };
}
let propSeq = Date.now() % 100000;
function newProp(node, column) {
  const profile = state.csv?.profile?.[column] || {};
  let best = null, bestS = 0;
  if (column) {
    for (const p of state.onto.datatypeProps) {
      const fits = propFits(p, node.classIri);
      if (fits === false) continue;
      const s = Math.max(similarity(column, p.local), similarity(column, p.label)) + (fits ? 0.05 : 0);
      if (s > bestS) { best = p; bestS = s; }
    }
  }
  if (bestS < 0.5) best = null;
  const taken = new Set(node.props.map((x) => x.propIri));
  if (best && taken.has(best.iri)) best = null;
  const dt = best ? rangeDatatype(best, profile.type) : rangeDatatype(null, profile.type);
  return {
    id: `${node.id}_p${++propSeq}`, propIri: best ? best.iri : '', source: 'column', column: column || '', constant: '',
    datatype: dt, format: defaultFormat(dt, profile), lang: '', userEntered: false,
  };
}
function defaultFormat(dt, profile) {
  if (dt === 'xsd:date' || dt === 'xsd:dateTime') {
    const s = profile?.samples || [];
    return s.length && s.every((x) => /^\d{4}-\d{2}-\d{2}/.test(x)) ? 'iso' : 'auto-dmy';
  }
  if (['xsd:decimal', 'xsd:double', 'xsd:float'].includes(dt) && (profile?.samples || []).some((x) => String(x).trim().endsWith('%'))) return 'percent-fraction';
  return '';
}
function normaliseMapping(m) {
  const base = emptyMapping();
  const out = { ...base, ...m, settings: { ...base.settings, ...(m.settings || {}) } };
  out.settings.provenance = { ...base.settings.provenance, ...(out.settings.provenance || {}) };
  if (!(m.settings?.provenance?.pattern)) out.settings.provenance.pattern = m.settings?.provenance?.writeAxioms === false ? 'flag-only' : 'axiom-text';
  out.settings.validation = { ...base.settings.validation, ...(out.settings.validation || {}) };
  out.settings.reasoner = { ...base.settings.reasoner, ...(out.settings.reasoner || {}) };
  out.nodes = (m.nodes || []).map((n) => ({
    scope: 'row', requireData: true, props: [], ...n,
    naming: { mode: 'auto', prefix: localName(n.classIri) + '_', pad: 0, template: '', list: '', listMatch: 'order', listKey: '', onMissing: 'auto', collision: 'merge', ...(n.naming || {}) },
  }));
  out.links = (m.links || []).map((l, i) => ({ id: l.id || `l${Date.now()}_${i}`, ...l }));
  return out;
}
function setPath(obj, path, val) {
  const keys = path.split('.'); let o = obj;
  for (let i = 0; i < keys.length - 1; i++) { o[keys[i]] = o[keys[i]] || {}; o = o[keys[i]]; }
  o[keys[keys.length - 1]] = val;
}
function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj); }

// ------------------------------------------------------------------ tabs
function showTab(name) {
  state.tab = name;
  $$('.tab').forEach((t) => { t.hidden = t.dataset.view !== name; });
  $$('.step').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  try { history.replaceState(null, '', '#' + name); } catch { /* ignore */ }
  if (name === 'mapping') renderMapping();
  if (name === 'pipeline') renderPipeline();
  if (name === 'graph') ensureGraph();
  if (name === 'sparql') { renderExamples(); fetchProvInfo().then(renderExamples); setTimeout(() => cm && cm.refresh(), 0); }
}
function updateStepMarks() {
  $('#tab-sources').classList.toggle('done', !!(state.onto && state.csv));
  $('#tab-mapping').classList.toggle('done', state.mapping.nodes.length > 0);
  $('#tab-graph').classList.toggle('done', !!state.graphStats);
  $('#tab-pipeline').classList.toggle('done', !!state.pipeline);
  $('#btn-generate').disabled = !(state.onto && state.csv && state.mapping.nodes.length);
}
function updateStatus() {
  const pill = $('#graph-status');
  if (!state.graphStats) { pill.textContent = 'No graph yet'; pill.className = 'status-pill'; }
  else if (state.stale) { pill.textContent = 'Settings changed · run again'; pill.className = 'status-pill stale'; }
  else {
    pill.textContent = `${fmtNum(state.graphStats.triples)} triples · ${fmtNum(state.graphStats.individuals)} individuals${state.graphStats.inferred != null ? ` · +${fmtNum(state.graphStats.inferred)} inferred` : ''}`;
    pill.className = 'status-pill live';
  }
  updateStepMarks();
}

// ------------------------------------------------------------------ sources tab
function applyServerState(s) {
  state.onto = s.ontology; state.csv = s.csv;
  state.shapes = s.shapes || null; state.validation = s.validation || null; state.pipeline = s.pipeline || null;
  indexOntology();
  if (s.mapping) state.mapping = normaliseMapping(s.mapping);
  state.graphStats = s.graph;
  state.graphLoaded = false;
  state.seenCand = new Set(); if (state.onto && state.csv) markCandidatesSeen();
  renderSources();
  updateStatus();
}
function classAttributes(iri) {
  // Datatype attributes that apply to a class: its own, then inherited (nearest ancestor first).
  const order = [];
  const seen = new Set([iri]); let frontier = [iri];
  while (frontier.length) {
    order.push(...frontier);
    const next = [];
    for (const c of frontier) for (const p of ontoIndex.classes.get(c)?.parents || []) if (!seen.has(p)) { seen.add(p); next.push(p); }
    frontier = next;
  }
  const rows = [];
  for (const c of order) for (const p of state.onto.datatypeProps) if (p.domain.includes(c)) rows.push({ p, from: c, own: c === iri });
  const anyClass = state.onto.datatypeProps.filter((p) => !p.domain.length);
  return { rows, anyClass };
}
function classLinks(iri) {
  const anc = ancestors(iri);
  const out = state.onto.objectProps.filter((p) => p.domain.some((d) => anc.has(d)));
  const inc = state.onto.objectProps.filter((p) => p.range.some((r) => anc.has(r)));
  return { out, inc };
}
const xsdShort = (r) => (r.startsWith(XSD_NS) ? 'xsd:' + r.slice(XSD_NS.length) : localName(r));

function renderSources() {
  const o = state.onto, c = state.csv;
  $('#onto-file-name').textContent = o ? o.filename : 'Drop a .ttl file or browse';
  $('#csv-file-name').textContent = c ? c.filename : 'Drop a .csv file or browse';
  $('#shapes-file-name').textContent = state.shapes ? `${state.shapes.filename} · ${state.shapes.shapes} shapes` : 'Drop a shapes .ttl or browse';
  $('#drop-shapes').classList.toggle('loaded', !!state.shapes);
  $('#drop-onto').classList.toggle('loaded', !!o);
  $('#drop-csv').classList.toggle('loaded', !!c);
  renderExplorer();
  renderCsvSummary();
}

function renderExplorer() {
  const o = state.onto, os = $('#onto-summary');
  if (!o) { os.innerHTML = '<div class="panel-head"><h2>Ontology</h2></div><p class="empty-note">No ontology loaded yet. Once it is, every class and its datatype attributes are listed here.</p>'; return; }
  if (!state.exploreClass || !ontoIndex.classes.has(state.exploreClass)) {
    const best = [...o.classes].sort((a, b) => classAttributes(b.iri).rows.length - classAttributes(a.iri).rows.length)[0];
    state.exploreClass = best?.iri;
  }
  os.innerHTML = `
    <div class="panel-head"><h2>Ontology</h2><span class="muted mono">${esc(o.filename)}</span></div>
    <div class="stat-row">
      <div class="stat"><b>${o.classes.length}</b><span>Classes</span></div>
      <div class="stat"><b>${o.datatypeProps.length}</b><span>Datatype attributes</span></div>
      <div class="stat"><b>${o.objectProps.length}</b><span>Relationships</span></div>
      <div class="stat"><b>${o.annotationProps.length}</b><span>Annotations</span></div>
      <div class="stat"><b>${fmtNum(o.tripleCount)}</b><span>Triples</span></div>
    </div>
    <dl class="kv"><dt>Namespace</dt><dd class="mono">${esc(o.namespace)}</dd>${o.ontologyIri ? `<dt>Ontology IRI</dt><dd class="mono">${esc(o.ontologyIri)}</dd>` : ''}</dl>
    <div class="explorer">
      <div class="ex-side">
        <input type="search" class="input" id="ex-search" placeholder="Find a class or attribute" aria-label="Find a class or attribute" value="${esc(state.exploreQuery || '')}">
        <ul class="ex-tree" id="ex-tree"></ul>
      </div>
      <div class="ex-detail" id="ex-detail"></div>
    </div>`;
  renderExplorerTree();
  renderExplorerDetail();
}
function renderExplorerTree() {
  const q = (state.exploreQuery || '').trim().toLowerCase();
  const html = classTree().map(({ iri, depth }) => {
    const c = ontoIndex.classes.get(iri);
    const { rows } = classAttributes(iri);
    const nameHit = !q || c.local.toLowerCase().includes(q) || c.label.toLowerCase().includes(q);
    const attrHits = q ? rows.filter((r) => r.own && (r.p.local.toLowerCase().includes(q) || r.p.label.toLowerCase().includes(q))) : [];
    if (!nameHit && !attrHits.length) return '';
    return `<li><button class="ex-item${iri === state.exploreClass ? ' on' : ''}" data-explore="${esc(iri)}" style="padding-left:${10 + depth * 16}px" aria-current="${iri === state.exploreClass}">
        <span class="dot" style="background:${classColor(iri)}"></span><span class="ex-name">${esc(c.local)}</span><span class="ex-count" title="Datatype attributes, including inherited">${rows.length}</span></button>
        ${attrHits.map((r) => `<div class="ex-hit" style="padding-left:${32 + depth * 16}px">${esc(r.p.local)}</div>`).join('')}</li>`;
  }).join('');
  $('#ex-tree').innerHTML = html || '<li class="muted pad">Nothing matches.</li>';
}
function renderExplorerDetail() {
  const iri = state.exploreClass, el = $('#ex-detail');
  const c = ontoIndex.classes.get(iri);
  if (!c) { el.innerHTML = ''; return; }
  // breadcrumb along the first parent chain
  const chain = []; let cur = c; const guard = new Set();
  while (cur && cur.parents.length && !guard.has(cur.iri)) { guard.add(cur.iri); cur = ontoIndex.classes.get(cur.parents[0]); if (cur) chain.unshift(cur); }
  const { rows, anyClass } = classAttributes(iri);
  const { out, inc } = classLinks(iri);
  const kids = ontoIndex.children.get(iri) || [];
  const attrRows = rows.map(({ p, from, own }) => `<tr>
      <td><span class="mono attr-name">${esc(p.local)}</span>${p.label && p.label.toLowerCase() !== p.local.toLowerCase() ? `<div class="muted small">${esc(p.label)}</div>` : ''}</td>
      <td>${p.range.length ? p.range.map((r) => `<span class="chip mono">${esc(xsdShort(r))}</span>`).join(' ') : '<span class="muted">any</span>'}</td>
      <td>${own ? '<span class="chip chip-accent">this class</span>' : `<button class="link-btn" data-explore="${esc(from)}">inherited from ${esc(localName(from))}</button>`}</td>
      <td class="muted small">${p.functional ? '<span class="chip">single value</span> ' : ''}${esc(p.comment)}</td></tr>`).join('');
  const linkItem = (p, dir) => dir === 'out'
    ? `<li><span class="mono">${esc(p.local)}</span> → ${p.range.map((r) => `<button class="link-btn" data-explore="${esc(r)}">${esc(localName(r))}</button>`).join(', ') || 'any'}</li>`
    : `<li>${p.domain.map((d) => `<button class="link-btn" data-explore="${esc(d)}">${esc(localName(d))}</button>`).join(', ') || 'any'} <span class="mono">${esc(p.local)}</span> → this</li>`;
  el.innerHTML = `
    <div class="ex-crumb">${chain.map((x) => `<button class="link-btn" data-explore="${esc(x.iri)}">${esc(x.local)}</button> ›`).join(' ')} <b>${esc(c.local)}</b></div>
    <h3 class="ex-title"><span class="dot" style="background:${classColor(iri)}"></span>${esc(c.label)}</h3>
    ${c.comment ? `<p class="muted">${esc(c.comment)}</p>` : ''}
    <code class="ex-iri">${esc(iri)}</code>
    <h4>Datatype attributes <span class="chip">${rows.length}</span></h4>
    ${rows.length ? `<div class="table-wrap ex-table"><table class="data"><thead><tr><th>Attribute</th><th>Type</th><th>Defined on</th><th>Notes</th></tr></thead><tbody>${attrRows}</tbody></table></div>`
      : `<p class="muted">This class has no datatype attributes of its own${kids.length ? '. Its subclasses carry the values.' : '.'}</p>`}
    ${anyClass.length ? `<p class="muted small">Also usable on any class (no domain set): ${anyClass.map((p) => `<span class="mono">${esc(p.local)}</span>`).join(', ')}</p>` : ''}
    <div class="ex-cols">
      <div><h4>Links to</h4>${out.length ? `<ul class="ex-links">${out.map((p) => linkItem(p, 'out')).join('')}</ul>` : '<p class="muted">None.</p>'}</div>
      <div><h4>Linked from</h4>${inc.length ? `<ul class="ex-links">${inc.map((p) => linkItem(p, 'in')).join('')}</ul>` : '<p class="muted">None.</p>'}</div>
    </div>
    ${kids.length ? `<h4>Subclasses</h4><div class="field-row">${kids.map((k) => `<button class="chip ex-kid" data-explore="${esc(k)}"><span class="dot" style="background:${classColor(k)}"></span>${esc(localName(k))}</button>`).join('')}</div>` : ''}`;
}
function renderCsvSummary() {
  const c = state.csv, cs = $('#csv-summary');
  if (!c) { cs.innerHTML = '<div class="panel-head"><h2>Data</h2></div><p class="empty-note">No CSV loaded yet.</p>'; return; }
  const typeChip = (t) => `<span class="chip ${t === 'string' ? '' : 'chip-info'}">${esc(t)}</span>`;
  const prof = c.headers.map((h) => {
    const p = c.profile[h];
    const pct = p.total ? Math.round((p.filled / p.total) * 100) : 0;
    return `<tr><td class="mono">${esc(h)}</td><td>${typeChip(p.type)}</td><td>${pct}%</td><td>${fmtNum(p.unique)}</td><td class="muted">${esc(p.samples.join(' · '))}</td></tr>`;
  }).join('');
  const head = c.headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const rows = c.preview.map((r) => `<tr>${c.headers.map((h) => `<td title="${esc(r[h])}">${esc(r[h])}</td>`).join('')}</tr>`).join('');
  cs.innerHTML = `
    <div class="panel-head"><h2>Data</h2><span class="muted mono">${esc(c.filename)}</span></div>
    <div class="stat-row">
      <div class="stat"><b>${fmtNum(c.rowCount)}</b><span>Rows</span></div>
      <div class="stat"><b>${c.headers.length}</b><span>Columns</span></div>
      <div class="stat"><b class="mono">${c.delimiter === '\t' ? 'tab' : esc(c.delimiter)}</b><span>Delimiter</span></div>
    </div>
    <div class="table-wrap" style="max-height:300px"><table class="data"><thead><tr><th>Column</th><th>Detected</th><th>Filled</th><th>Unique</th><th>Examples</th></tr></thead><tbody>${prof}</tbody></table></div>
    <div class="panel-head"><h3>First ${c.preview.length} rows</h3></div>
    <div class="table-wrap"><table class="data"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
function wireExplorer() {
  const os = $('#onto-summary');
  os.addEventListener('click', (e) => {
    const b = e.target.closest('[data-explore]'); if (!b || !ontoIndex.classes.has(b.dataset.explore)) return;
    state.exploreClass = b.dataset.explore; renderExplorerTree(); renderExplorerDetail();
  });
  os.addEventListener('input', (e) => { if (e.target.id === 'ex-search') { state.exploreQuery = e.target.value; renderExplorerTree(); } });
}

function wireDrop(zoneId, inputId, path) {
  const zone = $('#' + zoneId), input = $('#' + inputId);
  const handle = async (file) => {
    if (!file) return;
    try {
      const s = await upload(path, file);
      applyServerState({ ...s, mapping: s.mapping || state.mapping });
      toast(`Loaded ${file.name}`);
      if (state.onto && state.csv) schedulePreview();
    } catch (e) { toast(e.message, 'error'); }
    input.value = '';
  };
  input.addEventListener('change', () => handle(input.files[0]));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('drag'); handle(e.dataTransfer.files[0]); });
}

// ------------------------------------------------------------------ mapping tab
// Three steps on one page: (1) column → class + attribute, (2) how individuals are named,
// (3) which relationships connect the classes. Advanced options sit behind "More options".
const NAMEISH = /^(name|label|title|id|identifier|code|.*name)$/i;
const HOW_LABELS = { numbered: 'Numbered', column: 'From a column', pattern: 'Pattern', list: 'Name list' };
const COLUMN_TPL = /^\{([^@{}|]+)((?:\|[a-z]+)*)\}$/;
state.openRows = new Set(); state.openNames = new Set(); state.extraRows = new Set(); state.seenCand = new Set();
state.colFilter = 'all';

function howOf(node) {
  const n = node.naming;
  if (n.mode === 'auto') return 'numbered';
  if (n.mode === 'list' || n.mode === 'hybrid') return 'list';
  if (n.ui === 'pattern') return 'pattern';
  return COLUMN_TPL.test(n.template || '') ? 'column' : 'pattern';
}
function nodeColumns(node) { return node.props.filter((p) => p.source !== 'constant' && p.column); }
function bestNameColumn(node) {
  const named = nodeColumns(node).find((p) => NAMEISH.test(localName(p.propIri)));
  return (named || nodeColumns(node)[0])?.column || state.csv.headers[0];
}
function createNode(classIri, auto = true) {
  const node = newNode(classIri);
  if (nodeById(node.id)) node.id = uniqueNodeId(node.id);
  const same = state.mapping.nodes.filter((n) => n.classIri === classIri).length;
  if (same) node.label += ' ' + (same + 1);
  node.auto = auto;
  state.mapping.nodes.push(node);
  return node;
}
function removeNode(node) {
  state.mapping.nodes = state.mapping.nodes.filter((n) => n !== node);
  state.mapping.links = state.mapping.links.filter((l) => l.from !== node.id && l.to !== node.id);
}
function removeProp(node, pid) {
  node.props = node.props.filter((p) => p.id !== pid);
  if (node.auto && !node.props.length) removeNode(node);
}

// candidate relationships the ontology allows between the current nodes
function linkCandidates() {
  const out = [];
  for (const p of state.onto.objectProps) {
    if (!p.domain.length || !p.range.length) continue;
    for (const a of state.mapping.nodes) for (const b of state.mapping.nodes) {
      if (a.id === b.id || !a.classIri || !b.classIri) continue;
      if (p.domain.some((d) => ancestors(a.classIri).has(d)) && p.range.some((r) => ancestors(b.classIri).has(r))) out.push({ from: a.id, prop: p.iri, to: b.id });
    }
  }
  return out;
}
const candKey = (c) => `${c.from}|${c.prop}|${c.to}`;
function markCandidatesSeen() { for (const c of linkCandidates()) state.seenCand.add(candKey(c)); }
function syncLinkCandidates() {
  // New, unambiguous candidates (only one property fits a pair of classes) are switched on automatically.
  const cands = linkCandidates();
  const perPair = {};
  for (const c of cands) perPair[c.from + '|' + c.to] = (perPair[c.from + '|' + c.to] || 0) + 1;
  for (const c of cands) {
    const k = candKey(c);
    if (state.seenCand.has(k)) continue;
    state.seenCand.add(k);
    const exists = state.mapping.links.some((l) => candKey(l) === k);
    if (!exists && perPair[c.from + '|' + c.to] === 1) state.mapping.links.push({ id: 'l' + Date.now() + Math.random().toString(36).slice(2, 6), ...c });
  }
}

function renderMapping() {
  const ready = !!(state.onto && state.csv);
  $('#map-empty').hidden = ready; $('#map-body').hidden = !ready;
  if (!ready) return;
  renderSummary(); renderColumnTable(); renderNameList(); renderLinkList(); renderSettings(); renderChecks();
}

// ............................................................ summary + checks
function renderSummary() {
  const used = new Set(state.mapping.nodes.flatMap((n) => nodeColumns(n).map((p) => p.column)));
  const pv = state.preview;
  const issues = pv?.issues || [];
  const errs = issues.filter((i) => i.level === 'error').length, warns = issues.filter((i) => i.level === 'warning').length;
  const cls = errs ? 'err' : warns ? 'warn' : 'ok';
  $('#map-summary').innerHTML = `
    <span class="sum-item"><b>${state.csv.headers.filter((h) => used.has(h) || provenanceUse(h)).length}</b> of ${state.csv.headers.length} columns used</span>
    <span class="sum-item"><b>${state.mapping.nodes.length}</b> classes</span>
    <span class="sum-item"><b>${pv ? fmtNum(pv.instanceCount) : '–'}</b> individuals</span>
    <span class="sum-item"><b>${state.mapping.links.length}</b> relationships</span>
    <span class="spacer"></span>
    <button class="checks-btn ${cls}" data-act="toggle-checks" aria-expanded="${!$('#checks').hidden}">${pv ? (errs || warns ? `${errs} error${errs === 1 ? '' : 's'} · ${warns} warning${warns === 1 ? '' : 's'}` : 'All checks pass') : 'Checking…'}</button>`;
}
function renderChecks() {
  const issues = state.preview?.issues || [];
  const el = $('#checks');
  el.innerHTML = issues.length ? `<ul class="issue-list">${issues.map((i) => {
    const n = i.node ? nodeById(i.node) : null;
    const where = [n ? n.label : '', i.rows?.length ? `rows ${i.rows.join(', ')}` : ''].filter(Boolean).join(' · ');
    return `<li class="issue ${i.level}"><div>${esc(i.message)}${where ? `<span class="where">${esc(where)}</span>` : ''}</div></li>`;
  }).join('')}</ul>` : '<p class="issue-ok">Everything checks out.</p>';
}

// ............................................................ step 1: columns
function classSelect(currentNodeId) {
  const nodes = state.mapping.nodes.map((n) => {
    const cl = localName(n.classIri);
    const text = n.label.replace(/\s/g, '').toLowerCase() === cl.toLowerCase() ? cl : `${n.label} (${cl})`;
    return `<option value="n:${esc(n.id)}"${n.id === currentNodeId ? ' selected' : ''}>${esc(text)}</option>`;
  }).join('');
  const taken = new Set(state.mapping.nodes.map((n) => n.classIri));
  const free = classTree().filter(({ iri }) => !taken.has(iri))
    .map(({ iri, depth }) => `<option value="c:${esc(iri)}">${' '.repeat(depth)}${esc(localName(iri))}</option>`).join('');
  return `<option value=""${currentNodeId ? '' : ' selected'}>Not mapped</option>`
    + (nodes ? `<optgroup label="Classes in this mapping">${nodes}</optgroup>` : '')
    + (free ? `<optgroup label="Add a class">${free}</optgroup>` : '');
}
function attrSelect(node, p) {
  if (!node) return '<option value="">Choose a class first</option>';
  const { rows, anyClass } = classAttributes(node.classIri);
  const sel = p?.propIri || '';
  const opt = (iri, text) => `<option value="${esc(iri)}"${iri === sel ? ' selected' : ''}>${esc(text)}</option>`;
  const inClass = rows.map((r) => opt(r.p.iri, r.p.local + (r.own ? '' : `  (from ${localName(r.from)})`))).join('');
  const listed = new Set([...rows.map((r) => r.p.iri), ...anyClass.map((p) => p.iri)]);
  const others = state.onto.datatypeProps.filter((p) => !listed.has(p.iri)).map((p) => opt(p.iri, p.local)).join('');
  let html = `<option value=""${sel ? '' : ' selected'}>Choose attribute…</option>`;
  if (inClass) html += `<optgroup label="${esc(localName(node.classIri))} attributes">${inClass}</optgroup>`;
  html += `<optgroup label="General">${opt(RDFS_LABEL, 'rdfs:label')}${anyClass.map((p) => opt(p.iri, p.local)).join('')}</optgroup>`;
  if (state.onto.annotationProps.length) html += `<optgroup label="Annotation properties">${state.onto.annotationProps.map((p) => opt(p.iri, p.local)).join('')}</optgroup>`;
  if (others) html += `<optgroup label="Attributes of other classes">${others}</optgroup>`;
  if (sel && !ontoIndex.props.has(sel) && sel !== RDFS_LABEL) html += opt(sel, localName(sel));
  return html;
}
function dtOptions(p) {
  const list = [...XSD_TYPES];
  if (p.datatype && !list.includes(p.datatype)) list.push(p.datatype);
  return list.map((d) => `<option value="${d}"${d === p.datatype ? ' selected' : ''}>${d}</option>`).join('');
}
function formatControl(p) {
  if (p.datatype === 'xsd:date' || p.datatype === 'xsd:dateTime') {
    return `<label class="field"><span>Date format in the CSV</span><select data-pf="format">${DATE_FORMATS.map(([v, l]) => `<option value="${v}"${(p.format || 'auto-dmy') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;
  }
  if (['xsd:decimal', 'xsd:double', 'xsd:float'].includes(p.datatype)) {
    return `<label class="field"><span>Percentages</span><select data-pf="format"><option value=""${!p.format ? ' selected' : ''}>Keep as written (12% → 12)</option><option value="percent-fraction"${p.format === 'percent-fraction' ? ' selected' : ''}>Convert to fraction (12% → 0.12)</option></select></label>`;
  }
  if (p.datatype === 'xsd:string') return `<label class="field"><span>Language tag</span><input type="text" data-pf="lang" value="${esc(p.lang)}" placeholder="none, or e.g. en"></label>`;
  return '';
}
function provenanceUse(col) {
  const p = state.mapping.settings.provenance, uses = [];
  if (p.editedBy?.mode === 'column' && p.editedBy.value === col) uses.push('who edited');
  if (p.editedAt?.mode === 'column' && p.editedAt.value === col) uses.push('when edited');
  return uses.join(' & ');
}
function columnRows() {
  const rows = [];
  for (const h of state.csv.headers) {
    const maps = [];
    for (const n of state.mapping.nodes) for (const p of n.props) if (p.source !== 'constant' && p.column === h) maps.push({ node: n, p });
    if (!maps.length || state.extraRows.has(h)) maps.push({ node: null, p: null });
    maps.forEach((m, i) => rows.push({ col: h, first: i === 0, ...m }));
  }
  return rows;
}
function renderColumnTable() {
  const rows = columnRows().filter((r) => state.colFilter === 'all' || (!r.node && !provenanceUse(r.col)));
  $$('#col-filter button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === state.colFilter)));
  const body = rows.map((r) => {
    const prof = state.csv.profile[r.col];
    const key = `${r.col}|${r.p?.id || ''}`;
    const open = r.p && state.openRows.has(key);
    const provUse = provenanceUse(r.col);
    const colCell = r.first || state.colFilter !== 'all'
      ? `<div class="col-name">${esc(r.col)}</div><div class="col-sample">${esc(prof.samples.slice(0, 2).join(' · ') || 'empty')}</div>${provUse && r.first ? `<span class="chip chip-amber prov-chip" title="Set in Output settings">used for ${provUse}</span>` : ''}`
      : `<div class="col-again">↳ also</div>`;
    return `<tr class="crow${r.node ? '' : ' unmapped'}" data-col="${esc(r.col)}" data-node="${esc(r.node?.id || '')}" data-p="${esc(r.p?.id || '')}">
      <td class="c-col">${colCell}</td>
      <td class="c-type"><span class="type-badge">${esc(prof.type)}</span></td>
      <td class="c-arrow" aria-hidden="true">→</td>
      <td class="c-class">${r.node ? `<span class="dot" style="background:${classColor(r.node.classIri)}"></span>` : ''}<select data-cf="class" aria-label="Class for ${esc(r.col)}">${classSelect(r.node?.id)}</select></td>
      <td class="c-attr"><select data-cf="attr" aria-label="Attribute for ${esc(r.col)}"${r.node ? '' : ' disabled'}>${attrSelect(r.node, r.p)}</select><div class="row-issue" data-slot="issue"></div></td>
      <td class="c-user">${r.p ? `<label class="user-toggle${r.p.userEntered ? ' on' : ''}" title="Values were typed in by a user. Adds :userEdited."><input type="checkbox" data-pf="userEntered"${r.p.userEntered ? ' checked' : ''}>User</label>` : ''}</td>
      <td class="c-more">${r.p ? `<button class="more-btn" data-act="row-more" aria-expanded="${open}" title="Datatype, format and more">${open ? 'Less' : 'More'}</button>` : ''}</td>
    </tr>${open ? `<tr class="crow-more" data-col="${esc(r.col)}" data-node="${esc(r.node.id)}" data-p="${esc(r.p.id)}"><td colspan="7"><div class="more-grid">
        <label class="field"><span>Datatype</span><select data-pf="datatype">${dtOptions(r.p)}</select></label>
        ${formatControl(r.p)}
        <div class="field"><span>This column also fills</span><div><button class="btn btn-sm" data-act="map-again">Map it to another class too</button></div></div>
        <div class="field"><span>&nbsp;</span><div><button class="btn btn-sm btn-ghost danger-text" data-act="unmap">Remove this mapping</button></div></div>
      </div></td></tr>` : ''}`;
  }).join('');
  $('#col-table').innerHTML = `<thead><tr><th>CSV column</th><th>Detected</th><th></th><th>Class</th><th>Attribute</th><th title="Mark columns whose values were entered by a user">Entered by</th><th></th></tr></thead>
    <tbody>${body || '<tr><td colspan="7" class="muted pad">Every column is mapped.</td></tr>'}</tbody>`;
  updateInlineIssues();
}

// ............................................................ step 2: naming
function howInput(node) {
  const n = node.naming, how = howOf(node);
  const colOpts = (sel) => state.csv.headers.map((h) => `<option value="${esc(h)}"${h === sel ? ' selected' : ''}>${esc(h)}</option>`).join('');
  if (how === 'numbered') {
    const prefix = n.prefix || localName(node.classIri) + '_';
    return `<div class="in-line"><input type="text" class="mono-input" data-nf="prefix" value="${esc(n.prefix)}" placeholder="${esc(localName(node.classIri))}_" aria-label="Name prefix"><span class="muted small nowrap">${esc(prefix)}1, ${esc(prefix)}2…</span></div>`;
  }
  if (how === 'column') {
    const m = (n.template || '').match(COLUMN_TPL);
    return `<select data-nf="namecol" aria-label="Column that holds the name">${colOpts(m ? m[1] : '')}</select>`;
  }
  if (how === 'pattern') {
    const refs = state.mapping.nodes.filter((x) => x.id !== node.id).map((x) => `<option value="{@node:${esc(x.id)}}">${esc(x.label)} name</option>`).join('');
    return `<div class="in-stack"><input type="text" class="mono-input" data-nf="template" value="${esc(n.template)}" placeholder="{company_name}_FY{fiscal_year}" aria-label="Naming pattern">
      <select data-insert class="insert-select" aria-label="Insert into pattern"><option value="">Insert…</option>
        <optgroup label="Column value">${state.csv.headers.map((h) => `<option value="{${esc(h)}}">${esc(h)}</option>`).join('')}</optgroup>
        ${refs ? `<optgroup label="Name of a linked individual">${refs}</optgroup>` : ''}
        <optgroup label="Other"><option value="{@class}">Class name</option><option value="{@n}">Running number</option><option value="{@n:3}">Running number, 001</option><option value="{@row}">CSV row number</option></optgroup>
      </select></div>`;
  }
  const matchVal = n.listMatch === 'key' ? 'key:' + n.listKey : 'order';
  return `<div class="in-stack"><textarea rows="3" class="mono-input" data-nf="list" placeholder="${n.listMatch === 'key' ? 'Northwind Analytics => ABC_Company' : 'ABC_Company&#10;XYZ_Company'}" aria-label="Names">${esc(n.list)}</textarea>
    <label class="in-line small"><span class="muted nowrap">Match by</span><select data-nf="match"><option value="order"${matchVal === 'order' ? ' selected' : ''}>row order</option>
      ${state.csv.headers.map((h) => `<option value="key:${esc(h)}"${matchVal === 'key:' + h ? ' selected' : ''}>key column: ${esc(h)}</option>`).join('')}</select></label></div>`;
}
function nameMore(node) {
  const n = node.naming, how = howOf(node);
  const m = (n.template || '').match(COLUMN_TPL);
  const style = m ? m[2] : '';
  const constants = node.props.filter((p) => p.source === 'constant');
  return `<div class="more-grid">
    <label class="field"><span>Display name</span><input type="text" data-nf="label" value="${esc(node.label)}"></label>
    <label class="field"><span>How many individuals</span><select data-nf="scope"><option value="row"${node.scope !== 'single' ? ' selected' : ''}>One per row</option><option value="single"${node.scope === 'single' ? ' selected' : ''}>One for the whole file</option></select></label>
    <label class="field"><span>Same name appears again</span><select data-nf="collision">
      <option value="merge"${n.collision === 'merge' ? ' selected' : ''}>Treat as the same individual</option>
      <option value="suffix"${n.collision === 'suffix' ? ' selected' : ''}>Make it unique (_2, _3)</option>
      <option value="error"${n.collision === 'error' ? ' selected' : ''}>Report an error</option></select></label>
    ${how === 'column' ? `<label class="field"><span>Name style</span><select data-nf="style">
      <option value=""${style === '' ? ' selected' : ''}>As written (Northwind_Analytics)</option>
      <option value="|pascal"${style === '|pascal' ? ' selected' : ''}>Joined (NorthwindAnalytics)</option>
      <option value="|slug|lower"${style === '|slug|lower' ? ' selected' : ''}>Lower case (northwind_analytics)</option></select></label>` : ''}
    ${how === 'list' ? `<label class="field"><span>Rows not in the list</span><select data-nf="fallback"><option value="list"${n.mode === 'list' ? ' selected' : ''}>Get a numbered name</option><option value="hybrid"${n.mode === 'hybrid' ? ' selected' : ''}>Use a pattern</option></select></label>
      ${n.mode === 'hybrid' ? `<label class="field"><span>Pattern for those rows</span><input type="text" class="mono-input" data-nf="template" value="${esc(n.template)}" placeholder="{client_name}"></label>` : ''}` : ''}
    ${how === 'column' || how === 'pattern' || n.mode === 'hybrid' ? `<label class="field"><span>Name value is empty</span><select data-nf="onMissing"><option value="auto"${n.onMissing !== 'skip' ? ' selected' : ''}>Use a numbered name</option><option value="skip"${n.onMissing === 'skip' ? ' selected' : ''}>Skip that row</option></select></label>` : ''}
    <label class="toggle span-all"><input type="checkbox" data-nf="requireData"${node.requireData ? ' checked' : ''}><span>Only create an individual when the row has a value in one of this class's columns</span></label>
    <div class="field span-all"><span>Fixed values (same for every individual)</span>
      ${constants.map((p) => `<div class="const-row" data-p="${esc(p.id)}"><select data-pf="propIri">${attrSelect(node, p)}</select><input type="text" data-pf="constant" value="${esc(p.constant)}" placeholder="Value"><button class="x-btn" data-act="remove-const" aria-label="Remove fixed value">×</button></div>`).join('')}
      <div><button class="btn btn-sm" data-act="add-const">Add a fixed value</button></div></div>
    <div class="field span-all more-foot"><span class="muted small">Use <code class="copyable" data-copy="{@node:${esc(node.id)}}">{@node:${esc(node.id)}}</code> in another pattern to build names from this one.</span>
      <button class="btn btn-sm btn-ghost danger-text" data-act="remove-node">Remove ${esc(node.label)} from the mapping</button></div>
  </div>`;
}
function renderNameList() {
  const list = $('#name-list');
  if (!state.mapping.nodes.length) {
    list.innerHTML = '<p class="muted pad">Map a column to a class in step 1, or add a class below.</p>';
  } else {
    list.innerHTML = state.mapping.nodes.map((node) => {
      const how = howOf(node), open = state.openNames.has(node.id);
      const nCols = nodeColumns(node).length;
      return `<div class="nrow-wrap${open ? ' open' : ''}" data-node="${esc(node.id)}">
        <div class="nrow">
          <div class="n-class"><span class="dot" style="background:${classColor(node.classIri)}"></span><div><b>${esc(node.label)}</b><div class="muted small">${esc(localName(node.classIri))} · ${nCols ? `${nCols} column${nCols === 1 ? '' : 's'}` : 'no columns'}</div></div></div>
          <select class="n-how" data-nf="how" aria-label="How names are made">${Object.entries(HOW_LABELS).map(([v, l]) => `<option value="${v}"${v === how ? ' selected' : ''}>${l}</option>`).join('')}</select>
          <div class="n-input">${howInput(node)}</div>
          <div class="n-preview" data-slot="names"></div>
          <button class="more-btn" data-act="name-more" aria-expanded="${open}">${open ? 'Less' : 'More options'}</button>
        </div>
        <div class="n-issues" data-slot="node-issues"></div>
        ${open ? `<div class="nmore">${nameMore(node)}</div>` : ''}
      </div>`;
    }).join('');
  }
  const taken = new Set(state.mapping.nodes.map((n) => n.classIri));
  $('#add-class-select').innerHTML = `<option value="">Choose a class…</option>` + classTree().map(({ iri, depth }) => `<option value="${esc(iri)}">${' '.repeat(depth)}${esc(localName(iri))}${taken.has(iri) ? ' (another one)' : ''}</option>`).join('');
  updatePreviewSlots();
}

// ............................................................ step 3: relationships
function renderLinkList() {
  const el = $('#link-list');
  const cands = linkCandidates();
  const all = [...cands];
  for (const l of state.mapping.links) if (!cands.some((c) => candKey(c) === candKey(l))) all.push({ ...l, custom: true });
  if (!all.length) {
    el.innerHTML = `<p class="muted pad">${state.mapping.nodes.length > 1 ? 'The ontology defines no relationships between these classes. Add a custom one below if you need it.' : 'Relationships appear here once two or more classes are mapped.'}</p>`;
  } else {
    el.innerHTML = all.map((c) => {
      const link = state.mapping.links.find((l) => candKey(l) === candKey(c));
      const a = nodeById(c.from), b = nodeById(c.to);
      if (!a || !b) return '';
      return `<label class="lrow${link ? ' on' : ''}" data-key="${esc(candKey(c))}">
        <input type="checkbox" data-act="toggle-link"${link ? ' checked' : ''}>
        <span class="l-node"><span class="dot" style="background:${classColor(a.classIri)}"></span>${esc(a.label)}</span>
        <span class="l-prop mono">${esc(localName(c.prop) || '?')} →</span>
        <span class="l-node"><span class="dot" style="background:${classColor(b.classIri)}"></span>${esc(b.label)}</span>
        ${c.custom ? '<span class="chip chip-warn">custom</span>' : ''}
        <span class="l-count" data-link-count="${esc(link?.id || '')}"></span>
      </label>`;
    }).join('');
  }
  const nodeOpts = state.mapping.nodes.map((n) => `<option value="${esc(n.id)}">${esc(n.label)}</option>`).join('');
  $('#custom-link').innerHTML = `<select id="cl-from" aria-label="From">${nodeOpts}</select>
    <select id="cl-prop" aria-label="Relationship">${state.onto.objectProps.map((p) => `<option value="${esc(p.iri)}">${esc(p.local)}</option>`).join('')}</select>
    <select id="cl-to" aria-label="To">${nodeOpts}</select><button class="btn btn-sm" data-act="add-custom-link">Add</button>`;
  updatePreviewSlots();
}

// ............................................................ preview → UI
function updateInlineIssues() {
  const issues = state.preview?.issues || [];
  for (const tr of $$('#col-table tr.crow')) {
    const slot = $('[data-slot="issue"]', tr); if (!slot) continue;
    const node = nodeById(tr.dataset.node); const p = node?.props.find((x) => x.id === tr.dataset.p);
    if (!node || !p) { slot.textContent = ''; continue; }
    const mine = issues.filter((i) => i.node === node.id && (p.propIri ? i.prop === p.propIri : i.code === 'prop' && i.message.includes(`'${p.column}'`)));
    slot.innerHTML = mine.map((i) => `<span class="${i.level}">${esc(i.message)}</span>`).join('');
  }
}
function updatePreviewSlots() {
  const pv = state.preview;
  const issues = pv?.issues || [];
  for (const w of $$('#name-list .nrow-wrap')) {
    const id = w.dataset.node, st = pv?.nodes?.[id];
    const names = $('[data-slot="names"]', w);
    if (!pv) names.innerHTML = '<span class="muted small">Checking…</span>';
    else if (!st) names.innerHTML = '<span class="muted small">Fix the problem below to see names.</span>';
    else {
      const chips = st.sample.slice(0, 3).map((s) => `<span class="name-chip" title="${esc(s.iri)}"><span>${esc(s.local)}</span></span>`).join('');
      names.innerHTML = `<div class="n-count"><b>${fmtNum(st.instances)}</b> individual${st.instances === 1 ? '' : 's'}${st.merged ? ` <span class="muted">· ${fmtNum(st.merged)} row${st.merged === 1 ? '' : 's'} merged</span>` : ''}</div><div class="n-chips">${chips}${st.instances > 3 ? `<span class="muted small">+${fmtNum(st.instances - 3)}</span>` : ''}</div>`;
    }
    const nodeIssues = issues.filter((i) => i.node === id && !i.prop && i.prop !== '' && i.level !== 'info');
    $('[data-slot="node-issues"]', w).innerHTML = nodeIssues.map((i) => `<span class="${i.level}">${esc(i.message)}</span>`).join('');
  }
  for (const el of $$('[data-link-count]')) {
    const c = pv?.links?.[el.dataset.linkCount];
    el.textContent = c !== undefined && el.dataset.linkCount ? `${fmtNum(c)} link${c === 1 ? '' : 's'}` : '';
  }
  updateInlineIssues();
}

let previewSeq = 0;
const schedulePreview = debounce(async () => {
  if (!state.onto || !state.csv) return;
  const seq = ++previewSeq;
  try {
    const pv = await api('/api/preview', { json: { mapping: state.mapping } });
    if (seq !== previewSeq) return;
    state.preview = pv;
    if (state.tab === 'mapping') { updatePreviewSlots(); renderSummary(); renderChecks(); }
  } catch (e) { toast(e.message, 'error'); }
}, 350);

function mappingChanged({ rerender = false } = {}) {
  if (state.graphStats) state.stale = true;
  updateStatus();
  if (rerender && state.tab === 'mapping') { renderColumnTable(); renderNameList(); renderLinkList(); renderSummary(); }
  schedulePreview();
}

async function autoMap() {
  if (!state.onto || !state.csv) return;
  try {
    const res = await api('/api/suggest', { json: { mapping: state.mapping } });
    if (!res.nodes.length && !res.links.length) { toast('No more columns match an attribute name. Map the rest in the table.'); return; }
    for (const n of res.nodes) {
      const node = normaliseMapping({ nodes: [n] }).nodes[0];
      if (nodeById(node.id)) node.id = uniqueNodeId(node.id);
      node.auto = true;
      state.mapping.nodes.push(node);
    }
    for (const l of res.links) if (!state.mapping.links.some((x) => candKey(x) === candKey(l))) state.mapping.links.push(l);
    markCandidatesSeen();
    mappingChanged({ rerender: true });
    toast(`Mapped ${res.matched} columns to ${res.nodes.length} classes and added ${res.links.length} relationships. Check them below.`);
  } catch (e) { toast(e.message, 'error'); }
}

function renderSettings() {
  const s = state.mapping.settings;
  $('#settings-panel').innerHTML = `
    <div class="settings-head span-all"><h2>Output settings</h2><button class="x-btn" data-act="close-settings" aria-label="Close settings">×</button></div>
    <label class="field"><span>Namespace for individuals</span><input type="text" class="mono-input" data-s="dataNamespace" value="${esc(s.dataNamespace)}" placeholder="${esc(state.onto.namespace)}">
      <small>Empty means the ontology namespace, so individuals look like <code>:ABC_Company</code>.</small></label>
    <p class="small muted">Who and when for user-entered values, and how they are written, are set in the <button class="link-btn" data-goto="pipeline">Pipeline</button> tab.</p>`;
}

function wireMapping() {
  const view = $('#view-mapping');
  const rowCtx = (el) => {
    const tr = el.closest('[data-col], [data-node]');
    const node = nodeById(tr?.dataset.node);
    const p = node?.props.find((x) => x.id === (el.closest('[data-p]')?.dataset.p));
    return { tr, node, p, col: tr?.dataset.col };
  };
  const insertToken = (node, token) => {
    const input = $(`.nrow-wrap[data-node="${CSS.escape(node.id)}"] .n-input [data-nf="template"]`); if (!input) return;
    const s = input.selectionStart ?? input.value.length, en = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, s) + token + input.value.slice(en);
    input.focus(); input.setSelectionRange(s + token.length, s + token.length);
    node.naming.template = input.value; mappingChanged();
  };

  const onField = (t, isInput) => {
    const { node, p, col } = rowCtx(t);
    // step 1: class / attribute
    if (t.dataset.cf === 'class') {
      const oldNode = node, oldP = p;
      if (oldNode && oldP) removeProp(oldNode, oldP.id);
      state.extraRows.delete(col);
      if (t.value) {
        const target = t.value.startsWith('n:') ? nodeById(t.value.slice(2)) : createNode(t.value.slice(2));
        const np = newProp(target, col);
        target.props.push(np);
        if (oldP) { np.userEntered = oldP.userEntered; }
        if (target.naming.mode === 'auto' && np.propIri && NAMEISH.test(localName(np.propIri))) {
          target.naming.mode = 'template'; target.naming.template = `{${col}}`; target.naming.ui = 'column';
        }
      }
      syncLinkCandidates();
      mappingChanged({ rerender: true });
      return;
    }
    if (t.dataset.cf === 'attr' && p) {
      p.propIri = t.value;
      const info = ontoIndex.props.get(t.value);
      if (info) { p.datatype = rangeDatatype(info, state.csv.profile[p.column]?.type); p.format = defaultFormat(p.datatype, state.csv.profile[p.column]); }
      mappingChanged({ rerender: true });
      return;
    }
    if (t.dataset.pf && p) {
      const val = t.type === 'checkbox' ? t.checked : t.value;
      if (t.dataset.pf === 'datatype') { p.datatype = val; p.format = defaultFormat(val, state.csv.profile[p.column]); mappingChanged({ rerender: true }); return; }
      p[t.dataset.pf] = val;
      if (t.dataset.pf === 'userEntered') t.closest('.user-toggle').classList.toggle('on', val);
      if (t.dataset.pf === 'propIri') { const info = ontoIndex.props.get(val); if (info) p.datatype = rangeDatatype(info); }
      mappingChanged();
      return;
    }
    // step 2: naming
    if (t.dataset.nf && node) {
      const n = node.naming, f = t.dataset.nf, val = t.type === 'checkbox' ? t.checked : t.value;
      let rerender = !isInput;
      if (f === 'how') {
        n.ui = val === 'pattern' ? 'pattern' : val === 'column' ? 'column' : undefined;
        if (val === 'numbered') n.mode = 'auto';
        else if (val === 'column') { n.mode = 'template'; const m = (n.template || '').match(COLUMN_TPL); n.template = m ? n.template : `{${bestNameColumn(node)}}`; }
        else if (val === 'pattern') { n.mode = 'template'; if (!n.template) n.template = `{@class}_{@n}`; }
        else { n.mode = n.mode === 'hybrid' ? 'hybrid' : 'list'; }
      } else if (f === 'namecol') { const m = (n.template || '').match(COLUMN_TPL); n.template = `{${val}${m ? m[2] : ''}}`; }
      else if (f === 'style') { const m = (n.template || '').match(COLUMN_TPL); if (m) n.template = `{${m[1]}${val}}`; }
      else if (f === 'match') { if (val === 'order') n.listMatch = 'order'; else { n.listMatch = 'key'; n.listKey = val.slice(4); } }
      else if (f === 'fallback') { n.mode = val; if (val === 'hybrid' && !n.template) n.template = `{${bestNameColumn(node)}}`; }
      else if (f === 'label') { node.label = val; rerender = false; }
      else if (f === 'scope' || f === 'requireData') node[f] = val;
      else n[f] = val;
      if (f === 'label' && !isInput) { mappingChanged({ rerender: true }); return; }
      if (rerender) { renderNameList(); if (['how', 'namecol'].includes(f)) renderColumnTable(); }
      mappingChanged();
    }
  };
  view.addEventListener('input', (e) => {
    const t = e.target;
    if (t.tagName === 'SELECT' || t.type === 'checkbox' || e.target.closest('#settings-panel')) return;
    onField(t, true);
  });
  view.addEventListener('change', (e) => {
    const t = e.target;
    if (t.closest('#settings-panel')) return;
    if (t.dataset.insert !== undefined) { const { node } = rowCtx(t); if (t.value && node) insertToken(node, t.value); t.value = ''; return; }
    if (t.dataset.act === 'toggle-link') {
      const key = t.closest('[data-key]').dataset.key; const [from, prop, to] = key.split('|');
      if (t.checked) state.mapping.links.push({ id: 'l' + Date.now(), from, prop, to });
      else state.mapping.links = state.mapping.links.filter((l) => candKey(l) !== key);
      renderLinkList(); renderSummary(); mappingChanged();
      return;
    }
    if (t.tagName === 'SELECT' || t.type === 'checkbox') onField(t, false);
    else if (t.dataset.nf === 'label') onField(t, false);
  });
  view.addEventListener('click', (e) => {
    const t = e.target.closest('button, [data-copy], [data-goto]'); if (!t) return;
    const act = t.dataset.act;
    if (t.dataset.copy) { navigator.clipboard?.writeText(t.dataset.copy).then(() => toast(`Copied ${t.dataset.copy}`), () => toast(t.dataset.copy)); return; }
    if (t.dataset.filter) { state.colFilter = t.dataset.filter; renderColumnTable(); return; }
    if (act === 'automap') { autoMap(); return; }
    if (act === 'toggle-checks') { const c = $('#checks'); c.hidden = !c.hidden; t.setAttribute('aria-expanded', String(!c.hidden)); return; }
    if (act === 'close-settings') { $('#settings-panel').hidden = true; return; }
    if (act === 'add-class') {
      const iri = $('#add-class-select').value; if (!iri) { toast('Choose a class first.'); return; }
      const node = createNode(iri, false); state.openNames.add(node.id); syncLinkCandidates(); mappingChanged({ rerender: true });
      return;
    }
    if (act === 'add-custom-link') {
      const from = $('#cl-from').value, prop = $('#cl-prop').value, to = $('#cl-to').value;
      if (!from || !prop || !to || from === to) { toast('Choose two different classes and a relationship.'); return; }
      if (!state.mapping.links.some((l) => candKey(l) === `${from}|${prop}|${to}`)) state.mapping.links.push({ id: 'l' + Date.now(), from, prop, to });
      renderLinkList(); mappingChanged({ rerender: true });
      return;
    }
    const { node, p, col } = rowCtx(t);
    if (act === 'row-more' && col) {
      const key = `${col}|${p?.id || ''}`; state.openRows.has(key) ? state.openRows.delete(key) : state.openRows.add(key); renderColumnTable();
    } else if (act === 'map-again' && col) { state.extraRows.add(col); state.colFilter = 'all'; renderColumnTable(); }
    else if (act === 'unmap' && node && p) { removeProp(node, p.id); mappingChanged({ rerender: true }); }
    else if (act === 'name-more' && node) { state.openNames.has(node.id) ? state.openNames.delete(node.id) : state.openNames.add(node.id); renderNameList(); }
    else if (act === 'add-const' && node) { const np = newProp(node, ''); np.source = 'constant'; node.props.push(np); renderNameList(); mappingChanged(); }
    else if (act === 'remove-const' && node && p) { node.props = node.props.filter((x) => x !== p); renderNameList(); mappingChanged(); }
    else if (act === 'remove-node' && node) { removeNode(node); mappingChanged({ rerender: true }); }
  });

  // settings
  const sp = $('#settings-panel');
  const onSetting = (e) => {
    const t = e.target; if (!t.dataset.s) return;
    setPath(state.mapping.settings, t.dataset.s, t.type === 'checkbox' ? t.checked : t.value);
    if (t.dataset.srender !== undefined) { setPath(state.mapping.settings, t.dataset.s.replace('.mode', '.value'), ''); renderSettings(); }
    if (t.tagName === 'SELECT') { renderColumnTable(); renderSummary(); }
    mappingChanged();
  };
  sp.addEventListener('change', onSetting);
  sp.addEventListener('input', (e) => { if (e.target.tagName === 'INPUT' && e.target.type === 'text') onSetting(e); });

  // overflow menu
  const menu = $('#map-menu');
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-menu]'); if (!b) return;
    menu.open = false;
    if (b.dataset.menu === 'settings') { $('#settings-panel').hidden = false; $('#settings-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    if (b.dataset.menu === 'export') {
      api('/api/mapping/compact', { json: { mapping: state.mapping } })
        .then((c) => downloadText('mapping.json', JSON.stringify(c, null, 2), 'application/json'))
        .catch((err) => toast(err.message, 'error'));
    }
    if (b.dataset.menu === 'export-full') downloadText('mapping-full.json', JSON.stringify(state.mapping, null, 2), 'application/json');
    if (b.dataset.menu === 'clear') {
      const settings = state.mapping.settings; state.mapping = emptyMapping(); state.mapping.settings = settings;
      state.preview = null; state.seenCand = new Set(); mappingChanged({ rerender: true }); toast('Mapping cleared.');
    }
  });
  $('#file-mapping').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    menu.open = false;
    try {
      let m = JSON.parse(await f.text());
      if (m.classes && !m.nodes) m = await api('/api/mapping/expand', { json: { mapping: m } });
      if (!Array.isArray(m.nodes)) throw new Error('This file has neither "classes" nor "nodes", so it is not a Graphwright mapping.');
      state.mapping = normaliseMapping(m); state.seenCand = new Set(); markCandidatesSeen();
      mappingChanged({ rerender: true });
      toast(`Imported ${m.nodes.length} classes from ${f.name}`);
    } catch (err) { toast(err.message, 'error'); }
    e.target.value = '';
  });
}

// ------------------------------------------------------------------ generate
async function generate() {
  const btn = $('#btn-generate');
  btn.disabled = true; btn.textContent = 'Running…';
  $$('[data-act="run-pipeline"]').forEach((b) => { b.disabled = true; b.textContent = 'Running…'; });
  try {
    const res = await api('/api/generate', { json: { mapping: state.mapping } });
    state.preview = res;
    if (!res.generated) {
      const provErr = res.issues.find((i) => i.code === 'prov');
      if (provErr) { toast(provErr.message, 'error'); showTab('pipeline'); return; }
      const n = res.issues.filter((i) => i.level === 'error').length;
      toast(`Fix ${n} error${n > 1 ? 's' : ''} in Checks before running the pipeline.`, 'error');
      showTab('mapping');
      return;
    }
    state.pipeline = res.pipeline || null; state.validation = res.validation || null;
    state.graphStats = res.graph; state.stale = false; state.graphLoaded = false;
    state.reason = res.reasoning || null; syncReasonControls(); renderReasonPanel();
    updateStatus();
    const warn = res.issues.filter((i) => i.level === 'warning').length;
    const incons = res.reasoning ? res.reasoning.issues.filter((i) => i.level === 'error').length : 0;
    const viol = res.validation ? res.validation.counts.violation : 0;
    const stepErr = (res.pipeline || []).some((st) => st.status === 'error');
    toast(`Graph ready: ${fmtNum(res.graph.triples)} triples, ${fmtNum(res.graph.individuals)} individuals${res.reasoning ? `, ${fmtNum(res.reasoning.inferred)} inferred` : ''}${incons ? `, ${incons} inconsistenc${incons === 1 ? 'y' : 'ies'}` : ''}${viol ? `, ${viol} validation violation${viol === 1 ? '' : 's'}` : ''}${stepErr ? ', a transform step failed' : ''}${warn ? `, ${warn} mapping warnings` : ''}.`, stepErr ? 'error' : '');
    if (state.tab === 'pipeline' || stepErr) { showTab('pipeline'); } else showTab('graph');
  } catch (e) { toast(e.message, 'error'); }
  finally {
    btn.textContent = 'Run pipeline'; updateStepMarks();
    $$('[data-act="run-pipeline"]').forEach((b) => { b.disabled = false; b.textContent = 'Run pipeline'; });
  }
}

// ------------------------------------------------------------------ graph tab
let graphData = null;
const hiddenClasses = new Set();
function cyStyle() {
  const ink = cssVar('--ink'), muted = cssVar('--muted'), surface = cssVar('--surface'), line = cssVar('--line-strong'),
    accent = cssVar('--accent'), amber = cssVar('--amber'), s3 = cssVar('--surface-3'), s2 = cssVar('--surface-2');
  const font = cssVar('--font-body') || 'sans-serif', mono = cssVar('--font-mono') || 'monospace';
  return [
    { selector: 'node', style: {
      'background-color': 'data(color)', label: 'data(label)', color: ink, 'font-family': font, 'font-size': 10,
      'text-valign': 'bottom', 'text-margin-y': 5, width: 26, height: 26, 'border-width': 2, 'border-color': surface,
      'text-background-color': surface, 'text-background-opacity': 0.85, 'text-background-padding': 2, 'text-background-shape': 'roundrectangle',
      'min-zoomed-font-size': 6, 'text-max-width': 140, 'text-wrap': 'ellipsis',
    } },
    { selector: 'node[edited > 0]', style: { 'border-color': amber, 'border-width': 3 } },
    { selector: 'node[warnings > 0]', style: { 'border-color': cssVar('--warn'), 'border-width': 3, 'border-style': 'dashed' } },
    { selector: 'node[violations > 0]', style: { 'border-color': cssVar('--danger'), 'border-width': 4, 'border-style': 'solid' } },
    { selector: 'node[kind = "class"]', style: {
      shape: 'round-rectangle', 'background-color': s3, 'border-color': 'data(color)', 'border-width': 2,
      width: 'label', height: 26, padding: 8, 'text-valign': 'center', 'text-margin-y': 0, 'font-weight': 600, 'text-background-opacity': 0,
    } },
    { selector: 'node[kind = "literal"]', style: {
      shape: 'round-rectangle', 'background-color': s2, 'border-color': line, 'border-width': 1, width: 'label', height: 18, padding: 4,
      'text-valign': 'center', 'text-margin-y': 0, 'font-family': mono, 'font-size': 8, color: muted, 'text-background-opacity': 0,
    } },
    { selector: 'edge', style: {
      width: 1.3, 'line-color': line, 'target-arrow-color': line, 'target-arrow-shape': 'triangle', 'arrow-scale': 0.8,
      'curve-style': 'bezier', label: 'data(label)', 'font-size': 8, color: muted, 'font-family': mono,
      'text-rotation': 'autorotate', 'text-background-color': surface, 'text-background-opacity': 0.9, 'text-background-padding': 1,
      'min-zoomed-font-size': 9,
    } },
    { selector: 'edge[kind = "type"], edge[kind = "subclass"]', style: { 'line-style': 'dashed', 'line-dash-pattern': [4, 3] } },
    { selector: 'edge[kind = "inferred"]', style: { 'line-style': 'dashed', 'line-dash-pattern': [5, 4], 'line-color': cssVar('--info'), 'target-arrow-color': cssVar('--info'), color: cssVar('--info'), width: 1.2 } },
    { selector: 'edge[kind = "literal"]', style: { 'target-arrow-shape': 'none', width: 1 } },
    { selector: '.faded', style: { opacity: 0.12 } },
    { selector: '.gone', style: { display: 'none' } },
    { selector: 'node.hit', style: { 'border-color': accent, 'border-width': 4 } },
    { selector: 'node:selected', style: { 'border-color': accent, 'border-width': 4, 'overlay-opacity': 0 } },
    { selector: 'edge.hl', style: { 'line-color': accent, 'target-arrow-color': accent, width: 2, color: ink } },
  ];
}
function recolorGraph() {
  if (!state.cy) return;
  state.cy.nodes().forEach((n) => { if (n.data('cls')) n.data('color', classColor(n.data('cls'))); });
}
async function ensureGraph() {
  $('#graph-empty').hidden = !!state.graphStats;
  if (!state.graphStats) { if (state.cy) { state.cy.destroy(); state.cy = null; } $('#graph-legend').innerHTML = ''; return; }
  if (state.graphLoaded && state.cy) { state.cy.resize(); return; }
  await loadGraph();
}
async function loadGraph() {
  try {
    const q = `?classes=${$('#graph-classes').checked}&literals=${$('#graph-literals').checked}&inferred=${showInferred()}`;
    graphData = await api('/api/graph' + q);
    state.graphLoaded = true;
    for (const n of graphData.elements.nodes) n.data.color = n.data.cls ? classColor(n.data.cls) : cssVar('--faint');
    if (state.cy) state.cy.destroy();
    state.cy = cytoscape({ container: $('#cy'), elements: graphData.elements, style: cyStyle(), wheelSensitivity: 0.25, minZoom: 0.08, maxZoom: 3 });
    hiddenClasses.forEach((c) => state.cy.nodes(`[cls = "${c}"]`).addClass('gone'));
    runLayout();
    wireCy();
    renderLegend();
    if (graphData.truncated) toast(`Showing the first 2,500 of ${fmtNum(graphData.individualCount)} individuals. Use SPARQL for the rest.`);
  } catch (e) { toast(e.message, 'error'); }
}
function runLayout() {
  const name = $('#graph-layout').value;
  const opts = { name, animate: false, padding: 40, fit: true };
  if (name === 'cose') Object.assign(opts, { nodeRepulsion: () => 9000, idealEdgeLength: () => 80, gravity: 0.35, numIter: 1500, randomize: true, componentSpacing: 60 });
  if (name === 'breadthfirst') Object.assign(opts, { directed: true, spacingFactor: 1.15 });
  if (name === 'concentric') Object.assign(opts, { concentric: (n) => n.degree(), levelWidth: () => 2, minNodeSpacing: 18 });
  state.cy.layout(opts).run();
}
function wireCy() {
  const cy = state.cy;
  cy.on('tap', 'node', (e) => {
    const n = e.target;
    const id = n.data('kind') === 'literal' ? n.data('owner') : n.id();
    focusNode(id, false);
    showDetail(id);
  });
  cy.on('tap', (e) => { if (e.target === cy) { cy.elements().removeClass('faded hl'); } });
  cy.on('dbltap', 'node', (e) => cy.animate({ fit: { eles: e.target.closedNeighborhood(), padding: 60 }, duration: 300 }));
}
function focusNode(id, center = true) {
  const cy = state.cy; if (!cy) return;
  const n = cy.getElementById(id); if (!n || !n.length) return;
  cy.elements().removeClass('faded hl');
  const hood = n.closedNeighborhood();
  cy.elements().not(hood).addClass('faded');
  n.connectedEdges().addClass('hl');
  cy.$(':selected').unselect(); n.select();
  if (center) cy.animate({ center: { eles: n }, zoom: Math.max(cy.zoom(), 1.1), duration: 300 });
}
function renderLegend() {
  const el = $('#graph-legend');
  if (!graphData || !state.graphStats) { el.innerHTML = ''; return; }
  el.innerHTML = graphData.classes.map((c) => `<button data-cls="${esc(c.iri)}" aria-pressed="${!hiddenClasses.has(c.iri)}" title="Show or hide ${esc(c.label)}"><span class="dot" style="background:${classColor(c.iri)}"></span>${esc(c.label)} <span class="n">${fmtNum(c.count)}</span></button>`).join('')
    + `<span class="chip chip-amber" title="Individuals with an amber ring hold user-entered values">Amber ring = user-entered values</span>`
    + (state.validation && !state.validation.conforms ? `<span class="chip chip-danger" title="Individuals that fail a SHACL shape">Red ring = fails validation</span>` : '');
}

async function showDetail(iri) {
  const panel = $('#detail');
  try {
    const d = await api('/api/node?iri=' + encodeURIComponent(iri) + '&inferred=' + showInferred());
    panel.hidden = false;
    panel.innerHTML = d.kind === 'class' ? classDetail(d) : individualDetail(d);
    state.cy?.resize();
  } catch (e) { toast(e.message, 'error'); }
}
function displayValue(v) {
  if (['xsd:decimal', 'xsd:integer', 'xsd:double', 'xsd:float'].includes(v.datatype) && v.value !== '' && !isNaN(Number(v.value))) {
    return Number(v.value).toLocaleString('en-GB', { maximumFractionDigits: 6 });
  }
  return v.value;
}
const prettyTime = (s) => String(s || '').replace('T', ' ').replace(/(\+00:00|Z)$/, ' UTC');
function linkBtn(iri, text) { return `<button data-goto-node="${esc(iri)}">${esc(text)}</button>`; }
function individualDetail(d) {
  const types = d.types.map((t) => `<span class="chip"><span class="dot" style="background:${classColor(t.iri)}"></span>${esc(t.short)}${t.inferred ? ' · inferred' : ''}</span>`).join('');
  const values = d.values.length ? d.values.map((v) => `
    <div class="val-row${v.userEdited ? ' user' : ''}">
      <span class="val-prop">${esc(v.short)}</span>
      <span class="val-value" title="${esc(v.value)}">${esc(displayValue(v))}</span>
      <span class="val-meta"><span class="chip mono">${esc(v.datatype)}${v.lang ? '@' + esc(v.lang) : ''}</span>${v.userEdited ? '<span class="chip chip-amber">user-entered</span>' : ''}${v.inferred ? '<span class="chip chip-inferred" title="Derived by the reasoner, not stated in the data">inferred</span>' : ''}</span>
      ${v.edits?.length ? `<span class="edit-trail">${v.edits.map((e) => `Edited by <b>${esc(e.by || 'unknown')}</b>${e.at ? ' · ' + esc(prettyTime(e.at)) : ''}`).join('<br>')}</span>` : ''}
    </div>`).join('') : '<p class="muted">No data values.</p>';
  const infTag = (l) => (l.inferred ? '<span class="chip chip-inferred" title="Derived by the reasoner, not stated in the data">inferred</span>' : '');
  const out = d.outgoing.map((l) => `<div class="link-item${l.inferred ? ' inferred' : ''}"><span class="p">${esc(l.short)} →</span>${linkBtn(l.iri, l.label)}${infTag(l)}</div>`).join('');
  const inc = d.incoming.map((l) => `<div class="link-item${l.inferred ? ' inferred' : ''}">${linkBtn(l.iri, l.label)}<span class="p">→ ${esc(l.short)}</span>${infTag(l)}</div>`).join('');
  const other = d.other.map((l) => `<div class="link-item"><span class="p">${esc(l.short)}</span><span class="mono">${esc(l.target)}</span></div>`).join('');
  const m = d.meta;
  const methodText = { template: 'naming rule', list: 'name list', auto: 'generic name', fallback: 'generic fallback (rule had empty values)' };
  const meta = m ? `<dl class="kv" style="padding:0">
      <dt>Mapping node</dt><dd>${esc(m.nodeLabel)} <span class="muted mono">@node:${esc(m.node)}</span></dd>
      <dt>Named by</dt><dd>${esc(methodText[m.naming] || m.naming)}</dd>
      <dt>CSV rows</dt><dd class="mono">${esc(m.rows.join(', '))}${m.rowCount > m.rows.length ? ` … (${fmtNum(m.rowCount)})` : ''}</dd>
      <dt>Triples</dt><dd>${fmtNum(d.tripleCount)}</dd></dl>` : `<dl class="kv" style="padding:0"><dt>Origin</dt><dd>Not from the mapping (ontology or a SPARQL update)</dd><dt>Triples</dt><dd>${fmtNum(d.tripleCount)}</dd></dl>`;
  return `
    <div class="detail-head">
      <div class="detail-top"><h2>${esc(d.label)}</h2><button class="x-btn" data-act="close-detail" aria-label="Close details">×</button></div>
      <div class="iri-line"><code>${esc(d.iri)}</code><button class="btn btn-sm btn-ghost" data-copy-iri="${esc(d.iri)}">Copy</button></div>
      <div class="field-row">${types}</div>
    </div>
    <div class="detail-sec"><h3>Data values <span class="chip">${d.values.length}</span></h3>${values}</div>
    ${d.userEdited.length ? `<div class="detail-sec"><h3>User-edited fields</h3><div class="field-row">${d.userEdited.map((u) => `<span class="chip chip-amber mono">${esc(u.short)}</span>`).join('')}</div></div>` : ''}
    <div class="detail-sec"><h3>Links out <span class="chip">${d.outgoing.length}</span></h3>${out || '<p class="muted">None.</p>'}${other}</div>
    <div class="detail-sec"><h3>Links in <span class="chip">${d.incoming.length}</span></h3>${inc || '<p class="muted">None.</p>'}</div>
    ${d.validation && d.validation.length ? `<div class="detail-sec"><h3>Validation <span class="chip chip-danger">${d.validation.length}</span></h3>${d.validation.map((r) => `<div class="val-item ${r.severity}"><b>${esc(r.pathLabel || r.constraint)}</b>: ${esc(r.message)}${r.value ? ` <span class="muted">(${esc(r.value)})</span>` : ''}</div>`).join('')}</div>` : ''}
    <div class="detail-sec"><h3>Metadata</h3>${meta}</div>
    <div class="detail-actions"><button class="btn btn-sm" data-act="center" data-iri="${esc(d.iri)}">Centre in graph</button><button class="btn btn-sm" data-act="query-node" data-iri="${esc(d.iri)}">Query in SPARQL</button></div>`;
}
function classDetail(d) {
  return `
    <div class="detail-head">
      <div class="detail-top"><h2><span class="dot" style="background:${classColor(d.iri)}"></span> ${esc(d.label)}</h2><button class="x-btn" data-act="close-detail" aria-label="Close details">×</button></div>
      <div class="iri-line"><code>${esc(d.iri)}</code></div><span class="chip">Class</span>
      ${d.comment ? `<p class="muted">${esc(d.comment)}</p>` : ''}
    </div>
    <div class="detail-sec"><h3>Hierarchy</h3>
      <dl class="kv" style="padding:0"><dt>Parents</dt><dd>${d.parents.map((p) => esc(p.short)).join(', ') || '—'}</dd><dt>Children</dt><dd>${d.children.map((p) => esc(p.short)).join(', ') || '—'}</dd></dl></div>
    <div class="detail-sec"><h3>Properties with this domain</h3>${d.properties.map((p) => `<div class="link-item"><span class="p">${p.kind === 'object' ? '→' : '·'}</span><span class="mono">${esc(p.short)}</span><span class="muted">${esc(p.range.join(', '))}</span></div>`).join('') || '<p class="muted">None.</p>'}</div>
    <div class="detail-sec"><h3>Individuals <span class="chip">${fmtNum(d.instanceCount)}</span></h3>${d.instances.map((i) => `<div class="link-item">${linkBtn(i.iri, i.short)}</div>`).join('') || '<p class="muted">None.</p>'}</div>`;
}
function wireGraph() {
  $('#graph-layout').addEventListener('change', () => state.cy && runLayout());
  $('#graph-classes').addEventListener('change', loadGraph);
  $('#graph-literals').addEventListener('change', loadGraph);
  $('#graph-fit').addEventListener('click', () => { if (state.cy) { state.cy.elements().removeClass('faded hl'); state.cy.fit(undefined, 40); } });
  const search = $('#graph-search');
  search.addEventListener('input', () => {
    const cy = state.cy; if (!cy) return;
    const q = search.value.trim().toLowerCase();
    cy.nodes().removeClass('hit');
    if (!q) { cy.elements().removeClass('faded'); return; }
    const hits = cy.nodes().filter((n) => String(n.data('label')).toLowerCase().includes(q) || n.id().toLowerCase().includes(q));
    cy.elements().addClass('faded'); hits.removeClass('faded').addClass('hit');
  });
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !state.cy) return;
    const hit = state.cy.nodes('.hit')[0];
    if (hit) { focusNode(hit.id()); showDetail(hit.id()); }
  });
  $('#graph-legend').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cls]'); if (!b || !state.cy) return;
    const c = b.dataset.cls;
    if (hiddenClasses.has(c)) hiddenClasses.delete(c); else hiddenClasses.add(c);
    state.cy.nodes(`[cls = "${c}"]`).toggleClass('gone', hiddenClasses.has(c));
    b.setAttribute('aria-pressed', String(!hiddenClasses.has(c)));
  });
  const updateExport = () => { $('#btn-export').href = `/api/export?format=${$('#export-format').value}&scope=${$('#export-scope').value}`; };
  $('#export-format').addEventListener('change', updateExport);
  $('#export-scope').addEventListener('change', updateExport);
  $('#btn-export').addEventListener('click', (e) => { if (!state.graphStats) { e.preventDefault(); toast('Run the pipeline first.'); } });
  updateExport();
  $('#detail').addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.gotoNode) { focusNode(t.dataset.gotoNode); showDetail(t.dataset.gotoNode); }
    else if (t.dataset.act === 'close-detail') { $('#detail').hidden = true; state.cy?.resize(); state.cy?.elements().removeClass('faded hl'); }
    else if (t.dataset.act === 'center') focusNode(t.dataset.iri);
    else if (t.dataset.copyIri) navigator.clipboard?.writeText(t.dataset.copyIri).then(() => toast('IRI copied'), () => toast(t.dataset.copyIri));
    else if (t.dataset.act === 'query-node') {
      cm.setValue(`# Everything stated about this individual, plus who edited each field\nSELECT ?property ?value ?editedBy ?editedAt WHERE {\n  <${t.dataset.iri}> ?property ?value .\n  FILTER(?property != rdf:type)\n  OPTIONAL {\n    ?ax owl:annotatedSource <${t.dataset.iri}> ;\n        owl:annotatedTarget ?property ;\n        ${ontoPrefix().label}editedBy ?u ;\n        ${ontoPrefix().label}editedAt ?editedAt .\n    OPTIONAL { ?u ${ontoPrefix().label}userId ?editedBy }\n  }\n}\nORDER BY ?property`);
      showTab('sparql'); runQuery();
    }
  });
}

// ------------------------------------------------------------------ reasoner
state.reason = null;
const PROFILE_TEXT = {
  rdfs: ['RDFS', 'Superclass types, plus types from property domains and ranges. Fastest.'],
  owlrl: ['OWL 2 RL', 'Adds inverse links, equivalent classes and properties, sameAs, transitive and symmetric properties, property chains, and disjointness checks.'],
  'rdfs-owlrl': ['RDFS + OWL 2 RL', 'Both rule sets together. Most complete and slowest; worth it when the ontology mixes both styles.'],
};
const showInferred = () => !!state.reason && $('#graph-inferred').checked;
function reasonerSettings() {
  const s = state.mapping.settings;
  s.reasoner = { auto: false, profile: 'owlrl', ...(s.reasoner || {}) };
  return s.reasoner;
}
function syncReasonControls() {
  const has = !!state.reason;
  for (const id of ['#graph-inferred', '#sparql-inferred']) {
    const el = $(id); el.disabled = !has; if (!has) el.checked = false;
    el.closest('label').title = has ? '' : 'Run the reasoner on the Graph tab to enable';
  }
  $$('#export-scope option[value$="inferred"]').forEach((o) => { o.disabled = !has; });
  if (!has && $('#export-scope').value.endsWith('inferred')) { $('#export-scope').value = 'data'; $('#export-scope').dispatchEvent(new Event('change')); }
  const btn = $('#btn-reasoner');
  const errs = has ? state.reason.issues.filter((i) => i.level === 'error').length : 0;
  btn.textContent = has ? (errs ? `Reasoner · ${errs} problem${errs === 1 ? '' : 's'}` : 'Reasoner · consistent') : 'Reasoner';
  btn.classList.toggle('btn-warn', errs > 0);
}
function groupText(g) {
  if (g.category === 'types') return `${fmtNum(g.count)} individual${g.count === 1 ? ' is' : 's are'} also <b>${esc(g.objectLabel)}</b>`;
  if (g.category === 'links') return `${fmtNum(g.count)} <span class="mono">${esc(g.propertyLabel)}</span> link${g.count === 1 ? '' : 's'}`;
  if (g.category === 'values') return `${fmtNum(g.count)} <span class="mono">${esc(g.propertyLabel)}</span> value${g.count === 1 ? '' : 's'}`;
  if (g.category === 'schema') return `${fmtNum(g.count)} ontology statement${g.count === 1 ? '' : 's'} (<span class="mono">${esc(g.propertyLabel)}</span>)`;
  return `${fmtNum(g.count)} × <span class="mono">${esc(g.propertyLabel)}</span>`;
}
function renderReasonPanel() {
  const panel = $('#reasoner-panel');
  if (!state.onto) { panel.innerHTML = ''; return; }
  const rs = reasonerSettings();
  const r = state.reason;
  const errs = r ? r.issues.filter((i) => i.level === 'error') : [];
  const warns = r ? r.issues.filter((i) => i.level !== 'error') : [];
  const issueHtml = (i) => `<li class="issue ${i.level}"><div>${esc(i.message)}${i.subject ? ` <button class="link-btn" data-goto-node="${esc(i.subject)}">Show</button>` : ''}</div></li>`;
  const groups = r ? r.groups.filter((g) => g.category !== 'schema') : [];
  const schema = r ? r.groups.filter((g) => g.category === 'schema') : [];
  panel.innerHTML = `
    <div class="rp-head">
      <div><h2>Reasoner</h2><p class="muted">Derives the facts your ontology implies but the data doesn't state, and checks the graph for contradictions. Inferred facts are kept apart from your data, shown with a dashed line, and only exported if you ask.</p></div>
      <button class="x-btn" data-act="close-reasoner" aria-label="Close reasoner">×</button>
    </div>
    <div class="rp-controls">
      <label class="field"><span>Rules</span><select id="rp-profile">${Object.entries(PROFILE_TEXT).map(([k, [l]]) => `<option value="${k}"${rs.profile === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <p class="muted small rp-desc">${esc(PROFILE_TEXT[rs.profile]?.[1] || '')}</p>
      <div class="rp-buttons">
        <button class="btn btn-primary" data-act="run-reasoner"${state.graphStats ? '' : ' disabled'}>${r ? 'Run again' : 'Run reasoner'}</button>
        ${r ? '<button class="btn btn-ghost" data-act="clear-reasoner">Remove inferences</button>' : ''}
      </div>
      <label class="toggle"><input type="checkbox" id="rp-auto"${rs.auto ? ' checked' : ''}><span>Run on every pipeline run</span></label>
    </div>
    ${!state.graphStats ? '<p class="muted pad">Generate the graph first.</p>' : !r ? '' : `
    <div class="rp-stats">
      <span class="status-chip ${errs.length ? 'bad' : 'good'}">${errs.length ? `${errs.length} inconsistenc${errs.length === 1 ? 'y' : 'ies'}` : 'Consistent'}</span>
      <span><b>${fmtNum(r.inferred)}</b> facts inferred</span>
      <span><b>${fmtNum(r.categories.types || 0)}</b> types</span>
      <span><b>${fmtNum(r.categories.links || 0)}</b> links</span>
      <span><b>${fmtNum(r.categories.values || 0)}</b> values</span>
      <span class="muted">${esc(r.profileName)} · ${r.ms} ms</span>
    </div>
    <div class="rp-cols">
      <div><h3>Problems <span class="chip">${r.issues.length}</span></h3>
        ${r.issues.length ? `<ul class="issue-list">${errs.map(issueHtml).join('')}${warns.map(issueHtml).join('')}</ul>` : '<p class="issue-ok">No contradictions found.</p>'}</div>
      <div><h3>What was inferred</h3>
        ${groups.length ? `<ul class="rp-groups">${groups.map((g) => `<li><div>${groupText(g)}</div><div class="rp-ex">e.g. ${g.examples.map((e) => `<button class="link-btn" data-goto-node="${esc(e.subject)}">${esc(e.subjectLabel)}</button>`).join(', ')}</div></li>`).join('')}</ul>` : '<p class="muted">Nothing new about individuals. The ontology has no rules that apply to this data.</p>'}
        ${schema.length ? `<p class="muted small">Plus ${fmtNum(schema.reduce((a, g) => a + g.count, 0))} statements about the ontology itself (e.g. inherited domains).</p>` : ''}</div>
    </div>`}`;
}
async function runReasoner() {
  const rs = reasonerSettings();
  const btn = $('[data-act="run-reasoner"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Reasoning…'; }
  try {
    const res = await api('/api/reason', { json: { profile: rs.profile } });
    state.reason = res; state.graphStats = res.graph;
    syncReasonControls(); updateStatus();
    $('#graph-inferred').checked = true;
    renderReasonPanel();
    await loadGraph();
    const errs = res.issues.filter((i) => i.level === 'error').length;
    toast(`${fmtNum(res.inferred)} facts inferred${errs ? `, ${errs} inconsistenc${errs === 1 ? 'y' : 'ies'} found` : ', no contradictions'}.`, errs ? 'error' : '');
  } catch (e) { toast(e.message, 'error'); renderReasonPanel(); }
}
function wireReasoner() {
  $('#btn-reasoner').addEventListener('click', (e) => {
    const p = $('#reasoner-panel'); p.hidden = !p.hidden; e.currentTarget.setAttribute('aria-expanded', String(!p.hidden));
    if (!p.hidden) renderReasonPanel();
  });
  const panel = $('#reasoner-panel');
  panel.addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.act === 'run-reasoner') runReasoner();
    else if (t.dataset.act === 'close-reasoner') { panel.hidden = true; $('#btn-reasoner').setAttribute('aria-expanded', 'false'); }
    else if (t.dataset.act === 'clear-reasoner') {
      const r = await api('/api/reason', { method: 'DELETE' });
      state.reason = null; state.graphStats = r.graph; syncReasonControls(); updateStatus(); renderReasonPanel(); loadGraph();
    } else if (t.dataset.gotoNode) {
      if (!state.cy) await loadGraph();
      focusNode(t.dataset.gotoNode); showDetail(t.dataset.gotoNode);
    }
  });
  panel.addEventListener('change', (e) => {
    const rs = reasonerSettings();
    if (e.target.id === 'rp-profile') { rs.profile = e.target.value; renderReasonPanel(); }
    if (e.target.id === 'rp-auto') rs.auto = e.target.checked;
    schedulePreview(); // keeps the server's copy of the mapping (and exports) in step
  });
  $('#graph-inferred').addEventListener('change', () => { loadGraph(); if (!$('#detail').hidden) { const iri = $('#detail [data-copy-iri]')?.dataset.copyIri; if (iri) showDetail(iri); } });
}

// ------------------------------------------------------------------ SPARQL tab
let cm = null;
function examples() {
  const { label: p, decl } = ontoPrefix();
  const pre = state.provInfo?.prefixes;
  const head = () => (pre || [decl, 'PREFIX owl: <http://www.w3.org/2002/07/owl#>', 'PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>', 'PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>'].filter(Boolean).join('\n')) + '\n\n';
  const o = state.onto;
  const firstNode = state.mapping.nodes.find((n) => n.props.length) || state.mapping.nodes[0];
  const cls = firstNode ? (firstNode.classIri.startsWith(o?.namespace || '§') ? p + localName(firstNode.classIri) : `<${firstNode.classIri}>`) : `${p}SomeClass`;
  // provenance queries are built from the active pattern's read pattern, so they follow whatever pattern is configured
  const body = state.provInfo?.readBody;
  const ind = (txt, n) => txt.split('\n').map((l) => ' '.repeat(n) + l).join('\n');
  const prov = body ? [
    { t: 'User-entered fields', s: 'Values recorded as user-entered', q: head() + `SELECT ?individual ?field ?value WHERE {\n  {\n    SELECT DISTINCT (?subject AS ?individual) (?property AS ?field) WHERE {\n${ind(body, 6)}\n    }\n  }\n  ?individual ?field ?value .\n}\nORDER BY ?individual ?field` },
    { t: 'Who edited what, and when', s: 'Uses the provenance pattern from the Pipeline tab', q: head() + `SELECT ?individual ?field ?value ?user ?time WHERE {\n  {\n    SELECT DISTINCT (?subject AS ?individual) (?property AS ?field) ?user ?time WHERE {\n${ind(body, 6)}\n    }\n  }\n  ?individual ?field ?value .\n}\nORDER BY DESC(?time) ?individual ?field` },
    { t: 'System-sourced values', s: 'Datatype values not entered by a user', q: head() + `SELECT ?individual ?field ?value WHERE {\n  ?individual ?field ?value .\n  ?field a owl:DatatypeProperty .\n  MINUS {\n    SELECT (?subject AS ?individual) (?property AS ?field) WHERE {\n${ind(body, 6)}\n    }\n  }\n}\nORDER BY ?individual ?field` },
  ] : [];
  return [
    { t: 'Individuals per class', s: 'How many of each class the mapping created', q: head() + `SELECT ?class (COUNT(DISTINCT ?s) AS ?individuals) WHERE {\n  ?s a ?class .\n  ?class a owl:Class .\n}\nGROUP BY ?class\nORDER BY DESC(?individuals)` },
    { t: `All values of ${localName(cls)}`, s: 'Every datatype value on one class', q: head() + `SELECT ?individual ?property ?value WHERE {\n  ?individual a ${cls} ;\n              ?property ?value .\n  FILTER(isLiteral(?value))\n}\nORDER BY ?individual ?property` },
    ...prov,
    { t: 'Missing values', s: 'Individuals without a property their class defines', q: head() + `SELECT ?class ?individual ?missing WHERE {\n  ?missing a owl:DatatypeProperty ;\n           rdfs:domain ?class .\n  ?individual a ?class .\n  FILTER NOT EXISTS { ?individual ?missing ?any }\n}\nORDER BY ?class ?individual ?missing` },
    { t: 'Conflicting values', s: 'Single-value attributes with several values', q: head() + `SELECT ?individual ?attribute (COUNT(DISTINCT ?value) AS ?values) (GROUP_CONCAT(DISTINCT STR(?value); separator=" | ") AS ?found) WHERE {\n  ?attribute a owl:FunctionalProperty .\n  ?individual ?attribute ?value .\n}\nGROUP BY ?individual ?attribute\nHAVING (COUNT(DISTINCT ?value) > 1)` },
    { t: 'Relationships', s: 'Every object-property link', q: head() + `SELECT ?source ?property ?target WHERE {\n  ?source ?property ?target .\n  ?property a owl:ObjectProperty .\n}\nORDER BY ?property ?source` },
    { t: 'Coverage per property', s: 'Values and individuals per property', q: head() + `SELECT ?property (COUNT(?value) AS ?values) (COUNT(DISTINCT ?s) AS ?individuals) WHERE {\n  ?s ?property ?value .\n  FILTER(isLiteral(?value))\n}\nGROUP BY ?property\nORDER BY ?property` },
    { t: 'Subgraph as Turtle', s: 'CONSTRUCT returns triples', q: head() + `CONSTRUCT { ?s ?p ?o } WHERE {\n  ?s a ${cls} ;\n     ?p ?o .\n}` },
    ...(body ? [{ t: 'Is anything user-entered?', s: 'ASK returns yes or no', q: head() + `ASK {\n${ind(body, 2)}\n}` }] : []),
  ];
}
function renderExamples() {
  const ex = examples();
  $('#example-list').innerHTML = ex.map((e, i) => `<li><button data-ex="${i}">${esc(e.t)}<span class="ex-sub">${esc(e.s)}</span></button></li>`).join('');
  const pq = state.mapping.settings.queries || [];
  $('#pq-head').hidden = $('#pq-list').hidden = !pq.length;
  $('#pq-list').innerHTML = pq.map((q, i) => `<li><button data-pq="${i}"><span class="mono">${esc(q.name)}</span><span class="ex-sub">${esc(q.description || 'Saved in the pipeline')}</span></button></li>`).join('');
  const hist = store.get('gw-history', []);
  $('#history-list').innerHTML = hist.length ? hist.map((q, i) => `<li><button data-hist="${i}" title="${esc(q)}">${esc(q.replace(/^(PREFIX[^\n]*\n)+\s*/i, '').replace(/\s+/g, ' ').slice(0, 80))}</button></li>`).join('') : '<li class="muted pad" style="padding:6px 10px">Queries you run appear here.</li>';
  const prefixes = state.onto ? Object.entries(state.onto.prefixes).map(([k, v]) => `<span class="chip mono" title="${esc(v)}">${esc(k || '(default)')}:</span>`).join('') : '';
  $('#prefix-line').innerHTML = prefixes ? `<span class="muted" style="font-size:var(--fs-xs)">Prefixes ready:</span>${prefixes}` : '';
  if (cm && !cm.getValue().trim()) cm.setValue(ex[0].q);
}
async function runQuery() {
  const q = cm.getValue();
  if (!q.trim()) return;
  const btn = $('#btn-run'); btn.disabled = true;
  const out = $('#results'); const meta = $('#result-meta');
  try {
    const res = await api('/api/sparql', { json: { query: q, allowUpdate: $('#allow-update').checked, includeInferred: $('#sparql-inferred').checked } });
    const hist = store.get('gw-history', []).filter((x) => x !== q); hist.unshift(q); store.set('gw-history', hist.slice(0, 15));
    renderExamples();
    state.lastResult = res;
    $('#btn-results-csv').hidden = res.kind !== 'select';
    if (res.error) { out.innerHTML = `<div class="error-box">${esc(res.error)}</div>`; meta.textContent = ''; return; }
    if (res.kind === 'select') {
      meta.textContent = `${fmtNum(res.total)} row${res.total === 1 ? '' : 's'} · ${res.ms} ms${res.truncated ? ' · showing first 5,000' : ''}${res.inferred ? ' · includes inferred facts' : ''}`;
      out.innerHTML = res.rows.length ? `<table class="data"><thead><tr>${res.vars.map((v) => `<th>?${esc(v)}</th>`).join('')}</tr></thead><tbody>${res.rows.map((r) => `<tr>${r.map(termCell).join('')}</tr>`).join('')}</tbody></table>` : '<p class="muted pad">No results.</p>';
    } else if (res.kind === 'ask') {
      meta.textContent = `${res.ms} ms`;
      out.innerHTML = `<div class="ask-answer ${res.boolean ? 'yes' : 'no'}">${res.boolean ? 'Yes' : 'No'}</div>`;
    } else if (res.kind === 'graph') {
      meta.textContent = `${fmtNum(res.count)} triples · ${res.ms} ms`;
      out.innerHTML = `<pre class="turtle">${esc(res.turtle)}</pre>`;
    } else if (res.kind === 'update') {
      meta.textContent = `${res.ms} ms`;
      const diff = res.after - res.before;
      out.innerHTML = `<p class="pad">Update applied. The graph went from ${fmtNum(res.before)} to ${fmtNum(res.after)} triples (${diff >= 0 ? '+' : ''}${fmtNum(diff)}). Regenerating from the mapping discards these changes.</p>`;
      state.graphStats = res.graph; state.graphLoaded = false; state.reason = null; updateStatus(); syncReasonControls();
    }
  } catch (e) { out.innerHTML = `<div class="error-box">${esc(e.message)}</div>`; meta.textContent = ''; }
  finally { btn.disabled = false; }
}
function termCell(t) {
  if (!t) return '<td class="muted">—</td>';
  if (t.type === 'uri') return `<td><span class="term-uri" data-iri="${esc(t.value)}" title="${esc(t.value)}">${esc(t.short)}</span></td>`;
  if (t.type === 'bnode') return `<td><span class="term-bnode">${esc(t.short)}</span></td>`;
  return `<td title="${esc(t.value)}">${esc(t.value)}${t.lang ? `<span class="term-dt">@${esc(t.lang)}</span>` : t.datatype && t.datatype !== 'xsd:string' ? `<span class="term-dt">${esc(t.datatype)}</span>` : ''}</td>`;
}
function resultsCsv() {
  const r = state.lastResult; if (!r || r.kind !== 'select') return;
  const cell = (t) => { const v = t ? t.value : ''; return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  downloadText('query-results.csv', [r.vars.join(','), ...r.rows.map((row) => row.map(cell).join(','))].join('\n'), 'text/csv');
}
function wireSparql() {
  cm = CodeMirror.fromTextArea($('#sparql-editor'), {
    mode: 'application/sparql-query', lineNumbers: true, indentUnit: 2, tabSize: 2, matchBrackets: true, lineWrapping: true,
    extraKeys: { 'Ctrl-Enter': runQuery, 'Cmd-Enter': runQuery },
  });
  $('#btn-run').addEventListener('click', runQuery);
  $('#btn-results-csv').addEventListener('click', resultsCsv);
  $('#pq-list').addEventListener('click', (e) => { const b = e.target.closest('[data-pq]'); if (b) { cm.setValue(withPrefixes(state.mapping.settings.queries[Number(b.dataset.pq)].sparql)); runQuery(); } });
  $('#example-list').addEventListener('click', (e) => { const b = e.target.closest('[data-ex]'); if (b) { cm.setValue(examples()[Number(b.dataset.ex)].q); cm.focus(); runQuery(); } });
  $('#history-list').addEventListener('click', (e) => { const b = e.target.closest('[data-hist]'); if (b) { cm.setValue(store.get('gw-history', [])[Number(b.dataset.hist)]); cm.focus(); } });
  $('#results').addEventListener('click', (e) => {
    const t = e.target.closest('[data-iri]'); if (!t || !state.graphStats) return;
    showTab('graph');
    setTimeout(() => { focusNode(t.dataset.iri); showDetail(t.dataset.iri); }, 250);
  });
}

// ------------------------------------------------------------------ boot
async function boot() {
  const saved = store.get('gw-theme', null);
  if (saved) document.documentElement.dataset.theme = saved;
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onThemeChange);
  $('#btn-theme').addEventListener('click', () => applyTheme(isDark() ? 'light' : 'dark'));

  $$('.step').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) showTab(g.dataset.goto); });
  wireDrop('drop-onto', 'file-onto', '/api/ontology');
  wireDrop('drop-csv', 'file-csv', '/api/csv');
  $('#file-shapes').addEventListener('change', async (e) => { await uploadShapes(e.target.files[0]); e.target.value = ''; });
  const dz = $('#drop-shapes');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('drag'); uploadShapes(e.dataTransfer.files[0]); });
  $('#btn-sample').addEventListener('click', async () => {
    try {
      const s = await api('/api/sample', { method: 'POST' });
      state.preview = null; state.graphStats = null; state.stale = false;
      applyServerState(s);
      toast('Loaded the valuation sample: ontology, 10 rows and a full mapping.');
      schedulePreview();
      showTab('mapping');
    } catch (e) { toast(e.message, 'error'); }
  });
  $('#btn-generate').addEventListener('click', generate);
  wireMapping();
  wireExplorer();
  wireGraph();
  wireSparql();
  wireReasoner();
  wirePipeline();
  await loadPresets();

  try { applyServerState(await api('/api/state')); const r = await api('/api/reason'); state.reason = r.report; syncReasonControls(); renderReasonPanel(); } catch (e) { toast('Could not reach the server: ' + e.message, 'error'); }
  const hash = location.hash.replace('#', '');
  const start = ['sources', 'mapping', 'graph', 'sparql'].includes(hash) ? hash : (state.onto && state.csv ? 'mapping' : 'sources');
  showTab(start);
  if (state.onto && state.csv) schedulePreview();
}
document.addEventListener('DOMContentLoaded', boot);
