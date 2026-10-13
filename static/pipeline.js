/* Graphwright · Pipeline tab. Every stage is configuration stored in state.mapping.settings. */
'use strict';

state.presets = [];
state.provInfo = null;      // {turtle, read, readBody, prefixes} for the current provenance pattern
state.validation = null;
state.pipeline = null;      // last run report
state.shapes = null;

const STEP_TEMPLATE = `# A SPARQL UPDATE run on the graph after it is built.
# The ontology's prefixes (including ':') are added automatically.
INSERT { ?s :someProperty ?value }
WHERE {
  ?s a :SomeClass .
  # ...
}`;
const QUERY_TEMPLATE = `SELECT ?s ?p ?o WHERE {
  ?s a :SomeClass ;
     ?p ?o .
}
LIMIT 100`;
const STAGE_INFO = {
  build: ['Build from mapping', 'Creates individuals, values and relationships from the CSV using the mapping.'],
  provenance: ['Record provenance', 'Writes who entered user-entered values, and when, using the pattern you choose.'],
  steps: ['Transform', 'SPARQL updates that run in order on the built graph: derive values, clean data, add links.'],
  reason: ['Reason', 'Infers the facts the ontology implies and checks for contradictions.'],
  validate: ['Validate', 'Checks the graph against your SHACL shapes.'],
  queries: ['Publish queries', 'Named SPARQL queries that applications fetch as JSON or CSV.'],
};

function pipelineSettings() {
  const s = state.mapping.settings;
  s.provenance = { pattern: 'axiom-text', editedBy: { mode: 'constant', value: '' }, editedAt: { mode: 'now', value: '' }, ...(s.provenance || {}) };
  if (!s.provenance.pattern) s.provenance.pattern = s.provenance.writeAxioms === false ? 'flag-only' : 'axiom-text';
  s.steps = s.steps || [];
  s.queries = s.queries || [];
  s.validation = { auto: true, withInferences: false, ...(s.validation || {}) };
  s.reasoner = { auto: false, profile: 'owlrl', ...(s.reasoner || {}) };
  return s;
}
async function loadPresets() {
  try { state.presets = (await api('/api/provenance/presets')).presets; } catch (e) { toast(e.message, 'error'); }
}
async function fetchProvInfo() {
  if (!state.onto) return null;
  try {
    const r = await api('/api/provenance/preview', { json: { mapping: state.mapping } });
    state.provInfo = r.error ? { error: r.error } : r;
  } catch (e) { state.provInfo = { error: e.message }; }
  return state.provInfo;
}
const refreshProvInfo = debounce(async () => {
  await fetchProvInfo();
  if (!state.provInfo) return;
  const out = $('#prov-preview');
  if (out) out.innerHTML = state.provInfo.error ? `<div class="error-box">${esc(state.provInfo.error)}</div>` : `<pre class="turtle">${esc(state.provInfo.turtle)}</pre>`;
}, 400);

// ............................................................ render
function stageHead(key, n, right = '') {
  const [title, sub] = STAGE_INFO[key];
  const rep = (state.pipeline || []).find((r) => r.stage === key);
  const chip = rep ? `<span class="stage-status ${rep.status}" title="Last run">${esc(rep.summary)}</span>` : '';
  return `<div class="stage-head"><span class="step-badge">${n}</span><div class="stage-title"><h2>${title}</h2><p class="muted">${sub}</p></div>${chip}${right}</div>`;
}
function provenanceStage() {
  const p = pipelineSettings().provenance;
  const cols = (sel) => state.csv.headers.map((h) => `<option value="${esc(h)}"${h === sel ? ' selected' : ''}>${esc(h)}</option>`).join('');
  const preset = state.presets.find((x) => x.id === p.pattern);
  const custom = p.custom || {};
  const userCols = state.mapping.nodes.flatMap((n) => n.props.filter((x) => x.userEntered).map((x) => x.column || localName(x.propIri)));
  return `${stageHead('provenance', 2)}
    <div class="stage-body">
      <p class="small muted">${userCols.length ? `Applies to ${userCols.length} column${userCols.length === 1 ? '' : 's'} marked <b>User</b> in the mapping: ${esc(userCols.slice(0, 6).join(', '))}${userCols.length > 6 ? '…' : ''}.` : 'No columns are marked <b>User</b> in the mapping yet, so nothing will be recorded.'}</p>
      <div class="stage-grid">
        <div class="field"><span>Who entered the values</span>
          <div class="field-row"><select data-ps="provenance.editedBy.mode" data-rerender><option value="constant"${p.editedBy.mode !== 'column' ? ' selected' : ''}>Same user for all</option><option value="column"${p.editedBy.mode === 'column' ? ' selected' : ''}>From a column</option></select>
          ${p.editedBy.mode === 'column' ? `<select data-ps="provenance.editedBy.value"><option value="">Choose column…</option>${cols(p.editedBy.value)}</select>` : `<input type="text" data-ps="provenance.editedBy.value" value="${esc(p.editedBy.value)}" placeholder="e.g. jsmith@firm.com">`}</div></div>
        <div class="field"><span>When they were entered</span>
          <div class="field-row"><select data-ps="provenance.editedAt.mode" data-rerender><option value="now"${p.editedAt.mode !== 'column' ? ' selected' : ''}>Time the pipeline runs</option><option value="column"${p.editedAt.mode === 'column' ? ' selected' : ''}>From a column</option></select>
          ${p.editedAt.mode === 'column' ? `<select data-ps="provenance.editedAt.value"><option value="">Choose column…</option>${cols(p.editedAt.value)}</select>` : ''}</div></div>
        <label class="field"><span>User-edited property (<code>?flag</code>)</span><input type="text" class="mono-input" data-ps="userEditedIri" value="${esc(state.mapping.settings.userEditedIri || '')}" placeholder="${esc(state.onto.namespace)}userEdited"></label>
        <label class="field"><span>Pattern</span><select data-ps="provenance.pattern" data-rerender>
          ${state.presets.map((x) => `<option value="${esc(x.id)}"${x.id === p.pattern ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}
          <option value="custom"${p.pattern === 'custom' ? ' selected' : ''}>Custom…</option></select></label>
      </div>
      <p class="small muted">${p.pattern === 'custom' ? 'Your own pattern. Variables: <code>?subject ?property ?value ?user ?userIri ?time ?flag ?class</code>. A variable with no value leaves out the triples that use it.' : esc(preset?.description || '')}</p>
      ${p.pattern === 'custom' ? `
        <div class="stage-grid two">
          <label class="field"><span>Write (SPARQL INSERT template, one per user-entered value)</span><textarea rows="9" class="mono-input" data-ps="provenance.custom.write" spellcheck="false">${esc(custom.write || '')}</textarea></label>
          <label class="field"><span>Read (pattern that binds ?subject ?property, optionally ?user ?time)</span><textarea rows="9" class="mono-input" data-ps="provenance.custom.read" spellcheck="false">${esc(custom.read || '')}</textarea></label>
          <label class="field span-all"><span>Declarations (Turtle added once if the ontology lacks it)</span><textarea rows="4" class="mono-input" data-ps="provenance.custom.declarations" spellcheck="false">${esc(custom.declarations || '')}</textarea></label>
        </div>` : `<div><button class="btn btn-sm btn-ghost" data-act="customise-pattern">Customise this pattern</button></div>`}
      <div class="field"><span>What one user-entered value looks like</span><div id="prov-preview" class="prov-preview"><p class="muted pad">Loading…</p></div></div>
    </div>`;
}
function stepsStage() {
  const steps = pipelineSettings().steps;
  const rep = (state.pipeline || []).find((r) => r.stage === 'steps')?.steps || [];
  return `${stageHead('steps', 3)}
    <div class="stage-body">
      ${steps.length ? steps.map((st, i) => {
        const r = rep.find((x) => x.name === st.name);
        const res = r ? (r.status === 'ok' ? `<span class="chip chip-accent">${r.delta >= 0 ? '+' : ''}${fmtNum(r.delta)} triples · ${r.ms} ms</span>` : r.status === 'error' ? `<span class="chip chip-danger" title="${esc(r.error)}">failed</span>` : `<span class="chip">${esc(r.reason || 'skipped')}</span>`) : '';
        return `<div class="item-card${st.enabled === false ? ' off' : ''}" data-step="${i}">
          <div class="item-head"><label class="toggle"><input type="checkbox" data-sf="enabled"${st.enabled !== false ? ' checked' : ''}><span class="sr">Run</span></label>
            <input type="text" class="item-name" data-sf="name" value="${esc(st.name)}" aria-label="Step name">${res}
            <span class="spacer"></span>
            <button class="x-btn" data-act="step-up" title="Move up" aria-label="Move up"${i ? '' : ' disabled'}>↑</button>
            <button class="x-btn" data-act="step-down" title="Move down" aria-label="Move down"${i < steps.length - 1 ? '' : ' disabled'}>↓</button>
            <button class="x-btn" data-act="step-remove" aria-label="Remove step">×</button></div>
          ${r?.status === 'error' ? `<div class="error-box">${esc(r.error)}</div>` : ''}
          <textarea rows="${Math.min(14, Math.max(5, (st.sparql || '').split('\n').length + 1))}" class="mono-input code-area" data-sf="sparql" spellcheck="false" aria-label="SPARQL update">${esc(st.sparql)}</textarea>
        </div>`;
      }).join('') : '<p class="muted small">No transform steps. Add one to derive values, fix data or add links after the graph is built.</p>'}
      <div><button class="btn btn-sm" data-act="step-add">Add step</button></div>
    </div>`;
}
function reasonStage() {
  const r = pipelineSettings().reasoner;
  return `${stageHead('reason', 4)}
    <div class="stage-body"><div class="stage-grid">
      <label class="toggle"><input type="checkbox" data-ps="reasoner.auto"${r.auto ? ' checked' : ''}><span>Run on every pipeline run</span></label>
      <label class="field"><span>Rules</span><select data-ps="reasoner.profile">${Object.entries(PROFILE_TEXT).map(([k, [l]]) => `<option value="${k}"${r.profile === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    </div><p class="small muted">Results appear in the Graph tab's Reasoner panel. You can also run it from there at any time.</p></div>`;
}
function validateStage() {
  const v = pipelineSettings().validation;
  const res = state.validation;
  const list = res && res.results.length ? `<ul class="issue-list val-list">${res.results.slice(0, 200).map((r) => `<li class="issue ${r.severity === 'violation' ? 'error' : r.severity === 'warning' ? 'warning' : ''}"><div>
      <b>${esc(r.focusLabel)}</b>${r.pathLabel ? ` · <span class="mono">${esc(r.pathLabel)}</span>` : ''}: ${esc(r.message)}${r.value ? ` <span class="muted">(value: ${esc(r.value)})</span>` : ''}
      ${r.focus ? ` <button class="link-btn" data-show-node="${esc(r.focus)}">Show</button>` : ''}</div></li>`).join('')}</ul>` : '';
  return `${stageHead('validate', 5)}
    <div class="stage-body">
      <div class="shapes-line">${state.shapes ? `<span class="chip chip-accent">${esc(state.shapes.filename)} · ${fmtNum(state.shapes.shapes)} shapes</span> <button class="btn btn-sm btn-ghost" data-act="remove-shapes">Remove</button>` : '<span class="muted small">No shapes loaded.</span>'}
        <label class="btn btn-sm" for="file-shapes-2">${state.shapes ? 'Replace shapes…' : 'Load SHACL shapes…'}<input type="file" id="file-shapes-2" accept=".ttl,.rdf,.owl,.jsonld,.xml" hidden></label></div>
      <div class="stage-grid">
        <label class="toggle"><input type="checkbox" data-ps="validation.auto"${v.auto ? ' checked' : ''}><span>Run on every pipeline run</span></label>
        <label class="toggle"><input type="checkbox" data-ps="validation.withInferences"${v.withInferences ? ' checked' : ''}><span>Validate together with inferred facts (needs the Reason stage)</span></label>
      </div>
      ${state.shapes && state.graphStats ? '<div><button class="btn btn-sm" data-act="validate-now">Validate now</button></div>' : ''}
      ${res ? `<div class="val-summary"><span class="status-chip ${res.conforms ? 'good' : 'bad'}">${res.conforms ? 'Conforms' : `${res.counts.violation} violation${res.counts.violation === 1 ? '' : 's'}`}</span>${res.counts.warning ? `<span>${res.counts.warning} warning${res.counts.warning === 1 ? '' : 's'}</span>` : ''}<span class="muted small">${esc(res.shapes || '')} · ${res.ms} ms${res.withInferences ? ' · with inferred facts' : ''}</span></div>${list}` : ''}
    </div>`;
}
function queriesStage() {
  const qs = pipelineSettings().queries;
  return `${stageHead('queries', 6)}
    <div class="stage-body">
      <p class="small muted">Applications fetch these with <code>GET /api/queries/&lt;name&gt;</code> (add <code>?format=csv</code> for CSV). They also appear on the SPARQL tab.</p>
      ${qs.map((q, i) => `<div class="item-card" data-query="${i}">
        <div class="item-head"><input type="text" class="item-name mono" data-qf="name" value="${esc(q.name)}" aria-label="Query name">
          <input type="text" class="item-desc" data-qf="description" value="${esc(q.description || '')}" placeholder="What it returns" aria-label="Description">
          <button class="btn btn-sm btn-ghost" data-act="query-open">Run</button>
          <button class="x-btn" data-act="query-remove" aria-label="Remove query">×</button></div>
        <textarea rows="${Math.min(14, Math.max(4, (q.sparql || '').split('\n').length + 1))}" class="mono-input code-area" data-qf="sparql" spellcheck="false" aria-label="SPARQL query">${esc(q.sparql)}</textarea>
      </div>`).join('') || '<p class="muted small">No saved queries yet.</p>'}
      <div><button class="btn btn-sm" data-act="query-add">Add query</button></div>
    </div>`;
}
function renderPipeline() {
  const ready = !!(state.onto && state.csv);
  $('#pipe-empty').hidden = ready;
  $('#pipe-stages').hidden = !ready;
  if (!ready) return;
  pipelineSettings();
  const pv = state.preview;
  const build = `${stageHead('build', 1)}<div class="stage-body"><p class="small">${state.mapping.nodes.length} classes · ${pv ? fmtNum(pv.instanceCount) + ' individuals' : '…'} · ${state.mapping.links.length} relationships <button class="link-btn" data-goto="mapping">Edit mapping</button></p></div>`;
  $('#pipe-stages').innerHTML = [build, provenanceStage(), stepsStage(), reasonStage(), validateStage(), queriesStage()]
    .map((h, i) => `<li class="stage panel" data-stage="${Object.keys(STAGE_INFO)[i]}">${h}</li>`).join('');
  refreshProvInfo();
}

// ............................................................ events
function pipelineChanged(rerender) {
  mappingChanged();
  refreshProvInfo();
  if (rerender) renderPipeline();
}
function wirePipeline() {
  const root = $('#pipe-stages');
  const onField = (t, fromInput) => {
    const s = pipelineSettings();
    const val = t.type === 'checkbox' ? t.checked : t.value;
    if (t.dataset.ps) {
      setPath(s, t.dataset.ps, val);
      if (t.dataset.ps.endsWith('.mode')) setPath(s, t.dataset.ps.replace('.mode', '.value'), '');
      if (t.dataset.ps === 'provenance.pattern' && val === 'custom' && !s.provenance.custom) s.provenance.custom = { write: '', read: '', declarations: '' };
      if (t.dataset.ps.startsWith('reasoner.') && typeof renderReasonPanel === 'function') renderReasonPanel();
      pipelineChanged(t.dataset.rerender !== undefined && !fromInput);
      if (t.dataset.ps.includes('editedBy') || t.dataset.ps.includes('editedAt')) { if (state.tab === 'mapping') renderColumnTable(); }
    } else if (t.dataset.sf) {
      const i = Number(t.closest('[data-step]').dataset.step);
      s.steps[i][t.dataset.sf] = val;
      if (t.dataset.sf === 'enabled') t.closest('.item-card').classList.toggle('off', !val);
      pipelineChanged(false);
    } else if (t.dataset.qf) {
      const i = Number(t.closest('[data-query]').dataset.query);
      s.queries[i][t.dataset.qf] = val;
      pipelineChanged(false);
      if (state.tab === 'sparql') renderExamples();
    }
  };
  root.addEventListener('input', (e) => { if (e.target.tagName !== 'SELECT' && e.target.type !== 'checkbox') onField(e.target, true); });
  root.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'file-shapes-2') { await uploadShapes(t.files[0]); t.value = ''; return; }
    if (t.tagName === 'SELECT' || t.type === 'checkbox') onField(t, false);
  });
  root.addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t) return;
    const s = pipelineSettings();
    const act = t.dataset.act;
    if (t.dataset.showNode) { showTab('graph'); setTimeout(() => { focusNode(t.dataset.showNode); showDetail(t.dataset.showNode); }, 300); return; }
    if (act === 'customise-pattern') {
      const preset = state.presets.find((x) => x.id === s.provenance.pattern) || state.presets[0];
      s.provenance.custom = { write: preset.write, read: preset.read, declarations: preset.declarations };
      s.provenance.pattern = 'custom'; pipelineChanged(true);
    } else if (act === 'step-add') { s.steps.push({ name: `Step ${s.steps.length + 1}`, enabled: true, sparql: STEP_TEMPLATE }); pipelineChanged(true); }
    else if (act === 'query-add') { s.queries.push({ name: `query-${s.queries.length + 1}`, description: '', sparql: QUERY_TEMPLATE }); pipelineChanged(true); }
    else if (act && act.startsWith('step-')) {
      const i = Number(t.closest('[data-step]').dataset.step);
      if (act === 'step-remove') s.steps.splice(i, 1);
      if (act === 'step-up' && i > 0) [s.steps[i - 1], s.steps[i]] = [s.steps[i], s.steps[i - 1]];
      if (act === 'step-down' && i < s.steps.length - 1) [s.steps[i + 1], s.steps[i]] = [s.steps[i], s.steps[i + 1]];
      pipelineChanged(true);
    } else if (act === 'query-remove') { s.queries.splice(Number(t.closest('[data-query]').dataset.query), 1); pipelineChanged(true); }
    else if (act === 'query-open') {
      const q = s.queries[Number(t.closest('[data-query]').dataset.query)];
      cm.setValue(withPrefixes(q.sparql)); showTab('sparql'); if (state.graphStats) runQuery();
    } else if (act === 'remove-shapes') {
      const r = await api('/api/shapes', { method: 'DELETE' }); state.shapes = r.shapes; state.validation = null; renderSources(); renderPipeline();
    } else if (act === 'validate-now') { await validateNow(); }
  });
  $('#view-pipeline').addEventListener('click', (e) => { if (e.target.closest('[data-act="run-pipeline"]')) generate(); });
}
async function uploadShapes(file) {
  if (!file) return;
  try {
    const s = await upload('/api/shapes', file);
    state.shapes = s.shapes; state.validation = null;
    renderSources(); if (state.tab === 'pipeline') renderPipeline();
    toast(`Loaded ${file.name}: ${s.shapes.shapes} shapes.`);
  } catch (e) { toast(e.message, 'error'); }
}
async function validateNow() {
  try {
    const v = await api('/api/validate', { json: { withInferences: !!pipelineSettings().validation.withInferences } });
    state.validation = v; state.graphStats = v.graph; updateStatus(); renderPipeline();
    state.graphLoaded = false;
    toast(v.conforms ? 'The graph conforms to the shapes.' : `${v.counts.violation} violations, ${v.counts.warning} warnings.`, v.conforms ? '' : 'error');
  } catch (e) { toast(e.message, 'error'); }
}
function withPrefixes(q) {
  const pre = state.provInfo?.prefixes || '';
  const declared = new Set([...q.matchAll(/^\s*PREFIX\s+([\w-]*):/gim)].map((m) => m[1]));
  return pre.split('\n').filter((l) => l && !declared.has(l.split(/\s+/)[1].slice(0, -1))).join('\n') + '\n\n' + q;
}
