import init, * as ox from "./vendor/oxigraph/web.js";

const BASE = "https://mpparsley.github.io/hello-semantica/";
const PREFIXES = {
  sem: BASE + "def#",
  kg: BASE + "id/",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  owl: "http://www.w3.org/2002/07/owl#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
  dct: "http://purl.org/dc/terms/",
};
const SEM = PREFIXES.sem, KG = PREFIXES.kg;
const RDF_TYPE = PREFIXES.rdf + "type";

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const state = { meta: null, asserted: null, full: null, labels: new Map(), assertedKeys: new Set(), graph: null };

// ---------------------------------------------------------------- helpers

function shorten(iri) {
  for (const [p, ns] of Object.entries(PREFIXES)) if (iri.startsWith(ns)) return `${p}:${iri.slice(ns.length)}`;
  return iri;
}

function pageFor(iri) {
  if (iri.startsWith(KG)) return `id/${iri.slice(KG.length)}/`;
  if (iri.startsWith(SEM)) return `def/#${iri.slice(SEM.length)}`;
  return null;
}

function labelOf(iri) {
  return state.labels.get(iri) || shorten(iri);
}

function termHtml(t) {
  if (!t) return "";
  if (t.termType === "NamedNode") {
    const href = pageFor(t.value) || t.value;
    const lab = state.labels.get(t.value);
    const text = lab ? `${esc(lab)} <span class="muted">${esc(shorten(t.value))}</span>` : esc(shorten(t.value));
    return `<a href="${esc(href)}" title="${esc(t.value)}">${text}</a>`;
  }
  if (t.termType === "Literal") {
    let suffix = "";
    if (t.language) suffix = `<span class="dt">@${esc(t.language)}</span>`;
    else if (t.datatype && !t.datatype.value.endsWith("#string")) suffix = `<span class="dt">${esc(shorten(t.datatype.value))}</span>`;
    return `<span class="lit">${esc(t.value)}</span>${suffix}`;
  }
  if (t.termType === "BlankNode") return `<span class="muted">_:${esc(t.value)}</span>`;
  return esc(t.value);
}

const tripleKey = (s, p, o) => `${s.value}\u0000${p.value}\u0000${o.termType}:${o.value}`;

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.text();
}

// ---------------------------------------------------------------- data

async function loadStores() {
  const [ont, kg, full] = await Promise.all(
    ["data/ontologie.ttl", "data/kennisgraaf.ttl", "data/volledig.ttl"].map(fetchText));
  const asserted = new ox.Store();
  asserted.load(ont, { format: "text/turtle" });
  asserted.load(kg, { format: "text/turtle" });
  const fullStore = new ox.Store();
  fullStore.load(full, { format: "text/turtle" });
  state.asserted = asserted;
  state.full = fullStore;
  state.assertedKeys = new Set(asserted.match().map((q) => tripleKey(q.subject, q.predicate, q.object)));

  state.labels.clear();
  const rows = fullStore.query(`SELECT ?s ?l WHERE { ?s <${PREFIXES.rdfs}label> ?l }`);
  for (const b of rows) {
    const l = b.get("l");
    if (!state.labels.has(b.get("s").value) || l.language === "nl") state.labels.set(b.get("s").value, l.value);
  }
}

// ---------------------------------------------------------------- overzicht

function renderOverview() {
  const m = state.meta;
  const t = m.triples;
  $("#stats").innerHTML = [
    [t.feiten, "beweerde feiten"],
    [t.afgeleid, "afgeleide feiten"],
    [t.ontologie, "triples in de ontologie"],
    [m.resources, "resources met eigen IRI"],
    [m.shacl.conform ? "✓" : "✗", "SHACL-validatie"],
  ].map(([n, l]) => `<div class="stat"><b>${esc(n)}</b><span>${esc(l)}</span></div>`).join("");
  $("#build-info").textContent =
    `Laatst gebouwd op ${new Date(m.gebouwd).toLocaleString("nl-BE")} in ${m.buildDuur} s.`;
}

// ---------------------------------------------------------------- sparql

function setupSparql() {
  const sel = $("#q-examples");
  sel.innerHTML = state.meta.queries.map((q) => `<option value="${esc(q.id)}">${esc(q.titel)}</option>`).join("");
  sel.addEventListener("change", () => { selectQuery(sel.value); history.replaceState(null, "", `#sparql/${sel.value}`); });
  $("#q-run").addEventListener("click", runQuery);
  $("#q-reason").addEventListener("change", (e) => {
    e.target.nextElementSibling.textContent = e.target.checked ? "redeneerder aan" : "redeneerder uit";
    runQuery();
  });
  $("#q-text").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runQuery(); }
  });
  $("#q-reset").addEventListener("click", async () => {
    $("#q-status").textContent = "Data wordt herladen…";
    await loadStores();
    state.graph = null;
    $("#q-status").textContent = "Data herladen.";
  });
  selectQuery(state.meta.queries[0].id, false);
}

function selectQuery(id, run = true) {
  const q = state.meta.queries.find((x) => x.id === id);
  if (!q) return;
  $("#q-examples").value = id;
  $("#q-text").value = q.query;
  if (run) runQuery();
}

function isUpdate(text) {
  const body = text.split("\n").filter((l) => !/^\s*(#|PREFIX\b|BASE\b)/i.test(l)).join("\n");
  return /^\s*(INSERT|DELETE|LOAD|CLEAR|DROP|CREATE|ADD|MOVE|COPY|WITH)\b/i.test(body);
}

function runQuery() {
  const text = $("#q-text").value;
  const reason = $("#q-reason").checked;
  const store = reason ? state.full : state.asserted;
  const out = $("#q-result");
  const status = $("#q-status");
  const t0 = performance.now();
  try {
    if (isUpdate(text)) {
      // Schrijf naar beide stores zodat de schakelaar consistent blijft.
      state.asserted.update(text);
      state.full.update(text);
      state.graph = null;
      status.textContent = `Update uitgevoerd in ${(performance.now() - t0).toFixed(1)} ms. Alleen in je browser.`;
      out.innerHTML = `<p class="ok">✓ Data gewijzigd. De graaf bevat nu ${state.full.size} triples.</p>`;
      return;
    }
    const res = store.query(text);
    const ms = (performance.now() - t0).toFixed(1);
    if (typeof res === "boolean") {
      out.innerHTML = `<p class="ask">${res ? "ja (true)" : "nee (false)"}</p>`;
      status.textContent = `ASK in ${ms} ms`;
    } else if (res.length && res[0].subject) {
      out.innerHTML = tableHtml(["onderwerp", "eigenschap", "waarde"],
        res.map((q) => [q.subject, q.predicate, q.object]));
      status.textContent = `${res.length} triples in ${ms} ms`;
    } else {
      const vars = res.length ? [...res[0].keys()] : selectVars(text);
      out.innerHTML = res.length
        ? tableHtml(vars, res.map((b) => vars.map((v) => b.get(v))))
        : `<p class="empty">Geen resultaten.${reason ? "" : " De redeneerder staat uit: probeer het eens met de redeneerder aan."}</p>`;
      status.textContent = `${res.length} ${res.length === 1 ? "rij" : "rijen"} in ${ms} ms · ${reason ? "met" : "zonder"} afgeleide feiten`;
    }
  } catch (e) {
    out.innerHTML = `<pre class="error">${esc(e.message || e)}</pre>`;
    status.textContent = "Fout in de query";
  }
}

function selectVars(text) {
  const m = text.match(/SELECT\s+(?:DISTINCT\s+|REDUCED\s+)?([\s\S]*?)\s*WHERE/i);
  if (!m) return [];
  return [...m[1].matchAll(/\?(\w+)(?![^(]*\bAS\b)|AS\s+\?(\w+)/gi)].map((x) => x[1] || x[2]);
}

function tableHtml(head, rows) {
  return `<div class="table-scroll"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${termHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

// ---------------------------------------------------------------- validatie

async function renderValidation() {
  const m = state.meta;
  $("#v-status").innerHTML = m.shacl.conform
    ? `<p class="ok big">✓ De kennisgraaf voldoet aan alle ${m.shacl.vormen} SHACL-vormen.</p>`
    : `<p class="error big">✗ De kennisgraaf voldoet niet.</p>`;
  const [bad, shapes] = await Promise.all([fetchText("data/ongeldig.ttl"), fetchText("data/vormen.ttl")]);
  $("#v-bad").textContent = bad;
  $("#v-shapes").textContent = shapes;
  $("#v-report").innerHTML = `<div class="table-scroll"><table><thead><tr><th>Waar</th><th>Wat</th><th>Waarde</th></tr></thead><tbody>${
    m.ongeldigVoorbeeld.map((r) => `<tr><td><code>${esc(shorten(r.focus))}</code><br><span class="muted">${esc(shorten(r.pad))}</span></td>
      <td>${esc(r.bericht)}<br><span class="muted">${esc(r.regel)}</span></td><td>${r.waarde ? `<code>${esc(shorten(r.waarde))}</code>` : ""}</td></tr>`).join("")
  }</tbody></table></div>`;
}

// ---------------------------------------------------------------- verkenner

const CLASS_ORDER = ["Persoon", "Rivier", "Land", "Gewest", "Provincie", "Stad", "Gemeente"];
const FILTERS = {
  alles: ["ligtIn", "heeftHoofdstad", "grenstAan", "stroomtDoor", "mondtUitIn", "behoortTotStroomgebiedVan", "geborenIn"],
  bestuur: ["ligtIn", "heeftHoofdstad"],
  water: ["stroomtDoor", "mondtUitIn", "behoortTotStroomgebiedVan"],
  grenzen: ["grenstAan"],
  personen: ["geborenIn", "ligtIn"],
};

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function graphData() {
  const filter = $("#g-filter").value;
  const showInferred = $("#g-inferred").checked;
  const preds = FILTERS[filter];
  const edges = [];
  const seenPairs = new Set();
  const rows = state.full.query(`SELECT ?s ?p ?o WHERE { ?s ?p ?o FILTER(STRSTARTS(STR(?s), "${KG}") && STRSTARTS(STR(?o), "${KG}") && STRSTARTS(STR(?p), "${SEM}")) }`);
  for (const b of rows) {
    const s = b.get("s"), p = b.get("p"), o = b.get("o");
    const local = p.value.slice(SEM.length);
    if (!preds.includes(local)) continue;
    const inferred = !state.assertedKeys.has(tripleKey(s, p, o));
    if (inferred && !showInferred) continue;
    if (local === "grenstAan") {
      const pair = [s.value, o.value].sort().join("|");
      if (seenPairs.has(pair)) continue;
      seenPairs.add(pair);
    }
    edges.push({ s: s.value, o: o.value, p: local, inferred });
  }
  let personFilter = null;
  if (filter === "personen") {
    // Alleen ligging tonen vanaf geboorteplaatsen en hoger.
    const keep = new Set();
    const born = edges.filter((e) => e.p === "geborenIn");
    born.forEach((e) => { keep.add(e.s); keep.add(e.o); });
    let grew = true;
    while (grew) {
      grew = false;
      for (const e of edges) if (e.p === "ligtIn" && keep.has(e.s) && !keep.has(e.o)) { keep.add(e.o); grew = true; }
    }
    personFilter = keep;
  }
  const visible = edges.filter((e) => !personFilter || (personFilter.has(e.s) && personFilter.has(e.o)));
  const nodeIds = new Set();
  visible.forEach((e) => { nodeIds.add(e.s); nodeIds.add(e.o); });

  const types = new Map();
  for (const q of state.asserted.match(null, ox.namedNode(RDF_TYPE), null)) {
    const cls = q.object.value.slice(SEM.length);
    const cur = types.get(q.subject.value);
    if (!cur || CLASS_ORDER.indexOf(cls) < CLASS_ORDER.indexOf(cur)) types.set(q.subject.value, cls);
  }
  return {
    nodes: [...nodeIds].map((id) => ({ data: { id, label: labelOf(id), cls: types.get(id) || "Plaats" } })),
    edges: visible.map((e, i) => ({ data: { id: `e${i}`, source: e.s, target: e.o, label: labelOfProp(e.p), inferred: e.inferred ? 1 : 0 } })),
  };
}

function labelOfProp(local) {
  return state.labels.get(SEM + local) || local;
}

function classColor(cls) {
  return css(`--c-${cls.toLowerCase()}`) || css("--muted");
}

function graphStyle() {
  return [
    { selector: "node", style: {
      "background-color": (n) => classColor(n.data("cls")),
      label: "data(label)", color: css("--fg"), "font-size": 11, "text-valign": "bottom", "text-margin-y": 4,
      "text-outline-color": css("--bg"), "text-outline-width": 2, width: 18, height: 18, "min-zoomed-font-size": 7 } },
    { selector: "node[cls = 'Land'], node[cls = 'Gewest']", style: { width: 30, height: 30, "font-weight": "bold" } },
    { selector: "node[cls = 'Provincie']", style: { width: 24, height: 24 } },
    { selector: "node:selected", style: { "border-width": 3, "border-color": css("--accent") } },
    { selector: "edge", style: {
      width: 1.5, "line-color": css("--edge"), "target-arrow-color": css("--edge"), "target-arrow-shape": "triangle",
      "arrow-scale": 0.8, "curve-style": "bezier", label: "", "font-size": 9, color: css("--muted"),
      "text-outline-color": css("--bg"), "text-outline-width": 2 } },
    { selector: "edge[inferred = 1]", style: { "line-style": "dashed", "line-color": css("--inferred"), "target-arrow-color": css("--inferred") } },
    { selector: "edge:selected, edge.hl", style: { label: "data(label)", width: 2.5 } },
  ];
}

function renderGraph() {
  const el = $("#graph");
  const data = graphData();
  if (state.graph) state.graph.destroy();
  const cy = cytoscape({
    container: el,
    elements: [...data.nodes, ...data.edges],
    style: graphStyle(),
    layout: { name: "cose", animate: false, nodeRepulsion: 400000, idealEdgeLength: 110, edgeElasticity: 80, gravity: 0.2, nodeOverlap: 20, numIter: 2500, randomize: true, padding: 30 },
    wheelSensitivity: 0.3,
    minZoom: 0.2,
    maxZoom: 3,
  });
  if (cy.zoom() > 1.1) { cy.zoom(1.1); cy.center(); }
  cy.on("tap", "node", (e) => {
    cy.edges().removeClass("hl");
    e.target.connectedEdges().addClass("hl");
    showDetails(e.target.id());
  });
  cy.on("tap", (e) => { if (e.target === cy) cy.edges().removeClass("hl"); });
  state.graph = cy;
  const used = new Set(data.nodes.map((n) => n.data.cls));
  $("#g-legend").innerHTML = CLASS_ORDER.filter((c) => used.has(c))
    .map((c) => `<span><i style="background:${classColor(c)}"></i>${esc(c)}</span>`).join("") +
    `<span><i class="line"></i>beweerd</span><span><i class="line dashed"></i>afgeleid</span>`;
}

function showDetails(iri) {
  const rows = state.full.query(`SELECT ?p ?o WHERE { <${iri}> ?p ?o }`);
  rows.sort((a, b) => (a.get("p").value === RDF_TYPE ? -1 : 0) - (b.get("p").value === RDF_TYPE ? -1 : 0)
    || labelOf(a.get("p").value).localeCompare(labelOf(b.get("p").value)));
  const s = ox.namedNode(iri);
  const items = rows.map((b) => {
    const inferred = !state.assertedKeys.has(tripleKey(s, b.get("p"), b.get("o")));
    return `<li class="${inferred ? "inferred" : ""}"><span class="p">${esc(labelOf(b.get("p").value))}</span> ${termHtml(b.get("o"))}</li>`;
  }).join("");
  const nInf = rows.filter((b) => !state.assertedKeys.has(tripleKey(s, b.get("p"), b.get("o")))).length;
  $("#details").innerHTML = `
    <h2>${esc(labelOf(iri))}</h2>
    <p><code>${esc(shorten(iri))}</code></p>
    <p class="muted">${rows.length} feiten, waarvan ${nInf} afgeleid <span class="tag inferred">zo</span></p>
    <ul class="facts">${items}</ul>
    <p><a href="${esc(pageFor(iri))}">Linked Data-pagina →</a></p>`;
}

function setupExplorer() {
  $("#g-inferred").addEventListener("change", renderGraph);
  $("#g-filter").addEventListener("change", renderGraph);
  $("#g-fit").addEventListener("click", () => state.graph && state.graph.fit(undefined, 20));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => state.graph && state.graph.style(graphStyle()));
}

// ---------------------------------------------------------------- router

function route() {
  const [tab, arg] = (location.hash.slice(1) || "overzicht").split("/");
  const id = document.getElementById(tab)?.classList.contains("panel") ? tab : "overzicht";
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.id !== id));
  document.querySelectorAll("#tabs a").forEach((a) => a.setAttribute("aria-current", a.getAttribute("href") === `#${id}` ? "page" : "false"));
  if (!state.meta) return;
  if (id === "verkenner" && !state.graph) renderGraph();
  if (id === "sparql") {
    if (arg) selectQuery(arg);
    else if (!$("#q-result").innerHTML) runQuery();
  }
  window.scrollTo(0, 0);
}

function measureTopbar() {
  document.documentElement.style.setProperty("--topbar-h", `${document.querySelector(".topbar").offsetHeight}px`);
}

async function main() {
  measureTopbar();
  window.addEventListener("resize", measureTopbar);
  window.addEventListener("hashchange", route);
  route();
  try {
    const [meta] = await Promise.all([fetch("data/meta.json").then((r) => r.json()), init()]);
    state.meta = meta;
    await loadStores();
    renderOverview();
    setupSparql();
    setupExplorer();
    await renderValidation();
    route();
  } catch (e) {
    console.error(e);
    document.querySelector("main").insertAdjacentHTML("afterbegin",
      `<p class="error wrap">Laden mislukt: ${esc(e.message || e)}</p>`);
  }
}

main();
