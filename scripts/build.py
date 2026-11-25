#!/usr/bin/env python3
"""Bouwt de Hello Semantica-site.

Stappen:
  1. Ontologie, kennisgraaf en SHACL-vormen inlezen.
  2. De kennisgraaf valideren met SHACL (build faalt bij schendingen).
  3. Het opzettelijk ongeldige voorbeeld valideren (build faalt als SHACL
     daar géén fouten in vindt).
  4. Redeneren met OWL 2 RL en de afgeleide feiten bewaren.
  5. Alles publiceren: RDF-downloads, JSON voor de webapp en één HTML-pagina
     per resource zodat elke IRI ook echt opvraagbaar is (Linked Data).
"""

from __future__ import annotations

import argparse
import html
import json
import shutil
import sys
import time
from pathlib import Path

import owlrl
from pyshacl import validate
from rdflib import RDF, RDFS, OWL, Graph, Literal, Namespace, URIRef

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SITE = ROOT / "site"

BASE = "https://mpparsley.github.io/hello-semantica/"
SEM = Namespace(BASE + "def#")
KG = Namespace(BASE + "id/")
SH = Namespace("http://www.w3.org/ns/shacl#")

PREFIXES = {
    "sem": SEM,
    "kg": KG,
    "rdf": RDF,
    "rdfs": RDFS,
    "owl": OWL,
    "xsd": Namespace("http://www.w3.org/2001/XMLSchema#"),
    "dct": Namespace("http://purl.org/dc/terms/"),
    "sh": SH,
}


def new_graph() -> Graph:
    g = Graph()
    for p, ns in PREFIXES.items():
        g.bind(p, ns, override=True)
    return g


def load(*paths: Path) -> Graph:
    g = new_graph()
    for p in paths:
        g.parse(p, format="turtle")
    return g


# --------------------------------------------------------------------------
# SHACL
# --------------------------------------------------------------------------

def shacl(data: Graph, shapes: Graph, ontology: Graph) -> tuple[bool, Graph, list[dict]]:
    conforms, report, _ = validate(
        data,
        shacl_graph=shapes,
        ont_graph=ontology,
        inference="rdfs",
        abort_on_first=False,
        allow_warnings=False,
    )
    results = []
    for r in report.subjects(RDF.type, SH.ValidationResult):
        msg = report.value(r, SH.resultMessage)
        results.append({
            "focus": str(report.value(r, SH.focusNode)),
            "pad": str(report.value(r, SH.resultPath) or ""),
            "waarde": str(report.value(r, SH.value) or ""),
            "ernst": str(report.value(r, SH.resultSeverity)).rsplit("#", 1)[-1],
            "bericht": str(msg) if msg is not None else "",
            "regel": str(report.value(r, SH.sourceConstraintComponent)).rsplit("#", 1)[-1],
        })
    results.sort(key=lambda x: (x["focus"], x["pad"], x["regel"]))
    for p, ns in PREFIXES.items():
        report.bind(p, ns, override=True)
    return conforms, report, results


# --------------------------------------------------------------------------
# Redeneren
# --------------------------------------------------------------------------

def is_interesting(s, p, o) -> bool:
    """OWL RL genereert ook veel triviale triples (x owl:sameAs x, x a owl:Thing,
    ...). We houden enkel afgeleide feiten over onze eigen resources in onze eigen
    woordenschat over."""
    if not str(s).startswith(str(KG)):
        return False
    if p == RDF.type:
        return isinstance(o, URIRef) and str(o).startswith(str(SEM))
    return str(p).startswith(str(SEM))


def reason(asserted: Graph) -> Graph:
    closure = new_graph()
    for t in asserted:
        closure.add(t)
    owlrl.DeductiveClosure(owlrl.OWLRL_Semantics).expand(closure)
    inferred = new_graph()
    for s, p, o in closure:
        if (s, p, o) not in asserted and is_interesting(s, p, o):
            inferred.add((s, p, o))
    return inferred


# --------------------------------------------------------------------------
# Linked Data-pagina's
# --------------------------------------------------------------------------

def label(g: Graph, node) -> str:
    if isinstance(node, Literal):
        return str(node)
    best = None
    for lab in g.objects(node, RDFS.label):
        if getattr(lab, "language", None) == "nl":
            return str(lab)
        best = best or str(lab)
    if best:
        return best
    return g.namespace_manager.normalizeUri(node) if isinstance(node, URIRef) else str(node)


def local_href(node, depth: int) -> str | None:
    """Relatieve link naar de pagina van een eigen resource, anders None."""
    s = str(node)
    up = "../" * depth
    if s.startswith(str(KG)):
        return f"{up}id/{s[len(str(KG)):]}/"
    if s.startswith(str(SEM)):
        return f"{up}def/#{s[len(str(SEM)):]}"
    return None


def term_html(g: Graph, node, depth: int) -> str:
    if isinstance(node, Literal):
        dt = ""
        if node.language:
            dt = f'<span class="dt">@{html.escape(node.language)}</span>'
        elif node.datatype:
            dt = f'<span class="dt">^^{html.escape(g.namespace_manager.normalizeUri(node.datatype))}</span>'
        return f'<span class="lit">{html.escape(str(node))}</span>{dt}'
    href = local_href(node, depth) or str(node)
    return f'<a href="{html.escape(href)}" title="{html.escape(str(node))}">{html.escape(label(g, node))}</a>'


PAGE = """<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · Hello Semantica</title>
<link rel="stylesheet" href="{up}style.css">
{alternates}
<script type="application/ld+json">
{jsonld}
</script>
</head>
<body class="resource">
<header class="topbar"><a class="brand" href="{up}">Hello <b>Semantica</b></a></header>
<main class="wrap">
{body}
</main>
</body>
</html>
"""


def resource_page(full: Graph, inferred: Graph, subject: URIRef, depth: int) -> tuple[str, Graph, str]:
    desc = new_graph()
    for t in full.triples((subject, None, None)):
        desc.add(t)
    rows = []
    preds = sorted(set(full.predicates(subject, None)), key=lambda p: (p != RDF.type, p != RDFS.label, label(full, p)))
    for p in preds:
        objs = sorted(full.objects(subject, p), key=lambda o: label(full, o))
        cells = []
        for o in objs:
            afgeleid = (subject, p, o) in inferred
            cls = ' class="inferred" title="afgeleid door de redeneerder"' if afgeleid else ""
            cells.append(f"<li{cls}>{term_html(full, o, depth)}</li>")
        rows.append(f"<tr><th>{term_html(full, p, depth)}</th><td><ul>{''.join(cells)}</ul></td></tr>")
    incoming = []
    for s, p in sorted(full.subject_predicates(subject), key=lambda sp: (label(full, sp[1]), label(full, sp[0]))):
        if isinstance(s, URIRef) and str(s).startswith(str(KG)):
            afgeleid = (s, p, subject) in inferred
            cls = ' class="inferred"' if afgeleid else ""
            incoming.append(f"<li{cls}>{term_html(full, s, depth)} <span class=\"muted\">{html.escape(label(full, p))}</span> dit</li>")
    title = label(full, subject)
    body = f"""<p class="crumbs"><a href="{'../' * depth}#verkenner">Verkenner</a> › resource</p>
<h1>{html.escape(title)}</h1>
<p class="iri"><code>{html.escape(str(subject))}</code></p>
<p class="legend"><span class="tag">beweerd</span> <span class="tag inferred">afgeleid</span>
 · Download: <a href="index.ttl">Turtle</a> · <a href="index.jsonld">JSON-LD</a> · <a href="index.nt">N-Triples</a></p>
<table class="props">{''.join(rows)}</table>
{('<h2>Verwijzingen naar deze resource</h2><ul class="incoming">' + ''.join(incoming) + '</ul>') if incoming else ''}
"""
    return title, desc, body


def write_resource(out_dir: Path, full: Graph, inferred: Graph, subject: URIRef, depth: int):
    title, desc, body = resource_page(full, inferred, subject, depth)
    out_dir.mkdir(parents=True, exist_ok=True)
    desc.serialize(out_dir / "index.ttl", format="turtle")
    desc.serialize(out_dir / "index.nt", format="nt", encoding="utf-8")
    jsonld = desc.serialize(format="json-ld", context={k: str(v) for k, v in PREFIXES.items()}, indent=2)
    (out_dir / "index.jsonld").write_text(jsonld, encoding="utf-8")
    up = "../" * depth
    alternates = "\n".join([
        '<link rel="alternate" type="text/turtle" href="index.ttl">',
        '<link rel="alternate" type="application/ld+json" href="index.jsonld">',
    ])
    page = PAGE.format(title=html.escape(title), up=up, alternates=alternates,
                       jsonld=jsonld.replace("</", "<\\/"), body=body)
    (out_dir / "index.html").write_text(page, encoding="utf-8")


def ontology_page(out_dir: Path, ontology: Graph):
    out_dir.mkdir(parents=True, exist_ok=True)
    ontology.serialize(out_dir / "index.ttl", format="turtle")
    jsonld = ontology.serialize(format="json-ld", context={k: str(v) for k, v in PREFIXES.items()}, indent=2)
    (out_dir / "index.jsonld").write_text(jsonld, encoding="utf-8")

    def section(kind, title):
        items = sorted(set(ontology.subjects(RDF.type, kind)), key=lambda x: str(x))
        parts = []
        for s in items:
            if not str(s).startswith(str(SEM)):
                continue
            local = str(s)[len(str(SEM)):]
            rows = []
            for p, o in sorted(ontology.predicate_objects(s), key=lambda po: (str(po[0]), str(po[1]))):
                if p in (RDFS.label,):
                    continue
                rows.append(f"<tr><th>{term_html(ontology, p, 1)}</th><td>{term_html(ontology, o, 1)}</td></tr>")
            parts.append(f'<section id="{local}" class="term"><h3>{html.escape(label(ontology, s))} '
                         f'<code>sem:{local}</code></h3><table class="props">{"".join(rows)}</table></section>')
        return f"<h2>{title}</h2>" + "".join(parts)

    body = f"""<p class="crumbs"><a href="../">Hello Semantica</a> › ontologie</p>
<h1>{html.escape(label(ontology, URIRef(BASE + 'def')))}</h1>
<p class="iri"><code>{SEM}</code> · Download: <a href="index.ttl">Turtle</a> · <a href="index.jsonld">JSON-LD</a></p>
{section(OWL.Class, 'Klassen')}
{section(OWL.ObjectProperty, 'Objecteigenschappen')}
{section(OWL.DatatypeProperty, 'Data-eigenschappen')}
"""
    page = PAGE.format(title="Ontologie", up="../",
                       alternates='<link rel="alternate" type="text/turtle" href="index.ttl">',
                       jsonld=jsonld.replace("</", "<\\/"), body=body)
    (out_dir / "index.html").write_text(page, encoding="utf-8")


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def vendor(out: Path):
    """Kopieer de browserbibliotheken uit node_modules (npm ci) naar de site."""
    nm = ROOT / "node_modules"
    files = {
        nm / "oxigraph" / "web.js": out / "vendor" / "oxigraph" / "web.js",
        nm / "oxigraph" / "web_bg.wasm": out / "vendor" / "oxigraph" / "web_bg.wasm",
        nm / "cytoscape" / "dist" / "cytoscape.min.js": out / "vendor" / "cytoscape.min.js",
    }
    missing = [str(s.relative_to(ROOT)) for s in files if not s.exists()]
    if missing:
        sys.exit(f"Ontbrekende bibliotheken: {', '.join(missing)}. Voer eerst 'npm ci' uit.")
    for src, dst in files.items():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(ROOT / "dist"), help="uitvoermap (standaard: dist/)")
    args = ap.parse_args()
    out = Path(args.out)

    t0 = time.perf_counter()
    ontology = load(DATA / "ontologie.ttl")
    facts = load(DATA / "kennisgraaf.ttl")
    shapes = load(DATA / "vormen.ttl")
    asserted = ontology + facts
    for p, ns in PREFIXES.items():
        asserted.bind(p, ns, override=True)
    print(f"• ingelezen: {len(ontology)} ontologie-triples, {len(facts)} feiten, {len(shapes)} vorm-triples")

    # 1. Validatie van de echte data
    conforms, report, results = shacl(facts, shapes, ontology)
    if not conforms:
        print("✗ SHACL-validatie van de kennisgraaf faalt:", file=sys.stderr)
        for r in results:
            print(f"  - {r['focus']} {r['pad']}: {r['bericht']} ({r['regel']})", file=sys.stderr)
        return 1
    print("✓ kennisgraaf voldoet aan alle SHACL-vormen")

    # 2. Het ongeldige voorbeeld moet fouten opleveren
    bad = load(DATA / "voorbeelden" / "ongeldig.ttl")
    bad_conforms, bad_report, bad_results = shacl(bad + facts, shapes, ontology)
    bad_results = [r for r in bad_results if r["focus"] in {str(s) for s in bad.subjects()}]
    if bad_conforms or not bad_results:
        print("✗ het ongeldige voorbeeld werd ten onrechte goedgekeurd", file=sys.stderr)
        return 1
    print(f"✓ ongeldig voorbeeld: {len(bad_results)} schendingen gevonden, zoals verwacht")

    # 3. Redeneren
    t1 = time.perf_counter()
    inferred = reason(asserted)
    full = asserted + inferred
    for p, ns in PREFIXES.items():
        full.bind(p, ns, override=True)
    print(f"✓ redeneren (OWL 2 RL): {len(inferred)} nieuwe feiten in {time.perf_counter() - t1:.1f}s")

    # 4. Publiceren
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(SITE, out)
    vendor(out)
    d = out / "data"
    d.mkdir(parents=True, exist_ok=True)
    shutil.copy2(DATA / "ontologie.ttl", d / "ontologie.ttl")
    shutil.copy2(DATA / "kennisgraaf.ttl", d / "kennisgraaf.ttl")
    shutil.copy2(DATA / "vormen.ttl", d / "vormen.ttl")
    shutil.copy2(DATA / "voorbeelden" / "ongeldig.ttl", d / "ongeldig.ttl")
    inferred.serialize(d / "afgeleid.ttl", format="turtle")
    full.serialize(d / "volledig.ttl", format="turtle")
    full.serialize(d / "volledig.nt", format="nt", encoding="utf-8")
    (d / "volledig.jsonld").write_text(
        full.serialize(format="json-ld", context={k: str(v) for k, v in PREFIXES.items()}, indent=2),
        encoding="utf-8")
    report.serialize(d / "shacl-rapport.ttl", format="turtle")
    bad_report.serialize(d / "shacl-rapport-ongeldig.ttl", format="turtle")

    queries = []
    for q in sorted((DATA / "queries").glob("*.rq")):
        text = q.read_text(encoding="utf-8")
        title = text.splitlines()[0].lstrip("# ").strip()
        queries.append({"id": q.stem, "titel": title, "query": text})

    subjects = sorted({s for s in full.subjects() if isinstance(s, URIRef) and str(s).startswith(str(KG))})
    for s in subjects:
        write_resource(out / "id" / str(s)[len(str(KG)):], full, inferred, s, depth=2)
    ontology_page(out / "def", ontology)

    classes = {}
    for k in ontology.subjects(RDF.type, OWL.Class):
        classes[label(ontology, k)] = len(set(full.subjects(RDF.type, k)))

    meta = {
        "gebouwd": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "basis": BASE,
        "triples": {
            "ontologie": len(ontology),
            "feiten": len(facts),
            "afgeleid": len(inferred),
            "totaal": len(full),
        },
        "resources": len(subjects),
        "klassen": dict(sorted(classes.items(), key=lambda kv: -kv[1])),
        "shacl": {"conform": conforms, "vormen": len(set(shapes.subjects(RDF.type, SH.NodeShape)))},
        "ongeldigVoorbeeld": bad_results,
        "queries": queries,
        "buildDuur": round(time.perf_counter() - t0, 2),
    }
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    (out / ".nojekyll").write_text("")
    print(f"✓ site gebouwd in {out} ({len(subjects)} resourcepagina's) in {meta['buildDuur']}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
