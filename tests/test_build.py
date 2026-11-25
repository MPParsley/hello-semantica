"""Tests voor de kennisgraaf: validatie en redeneren."""

import sys
from pathlib import Path

import pytest
from rdflib import RDF

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import build  # noqa: E402

KG, SEM = build.KG, build.SEM


@pytest.fixture(scope="module")
def graphs():
    ontology = build.load(build.DATA / "ontologie.ttl")
    facts = build.load(build.DATA / "kennisgraaf.ttl")
    shapes = build.load(build.DATA / "vormen.ttl")
    inferred = build.reason(ontology + facts)
    return ontology, facts, shapes, inferred


def test_kennisgraaf_is_geldig(graphs):
    ontology, facts, shapes, _ = graphs
    conforms, _, results = build.shacl(facts, shapes, ontology)
    assert conforms, results


def test_ongeldig_voorbeeld_wordt_geweigerd(graphs):
    ontology, facts, shapes, _ = graphs
    bad = build.load(build.DATA / "voorbeelden" / "ongeldig.ttl")
    conforms, _, results = build.shacl(bad + facts, shapes, ontology)
    assert not conforms
    regels = {(r["focus"].rsplit("/", 1)[-1], r["regel"]) for r in results}
    assert ("spookstad", "MinInclusiveConstraintComponent") in regels
    assert ("spookstad", "OrConstraintComponent") in regels
    assert ("spookstad", "QualifiedMaxCountConstraintComponent") in regels
    assert ("provincie-zonder-hoofdstad", "MinCountConstraintComponent") in regels
    assert ("tijdreiziger", "DatatypeConstraintComponent") in regels
    assert ("tijdreiziger", "MaxCountConstraintComponent") in regels


@pytest.mark.parametrize("triple", [
    # transitiviteit
    (KG.gent, SEM.ligtIn, KG.vlaanderen),
    (KG.gent, SEM.ligtIn, KG.belgie),
    # inverse
    (KG.vlaanderen, SEM.omvat, KG.gent),
    (KG.aarlen, SEM.isHoofdstadVan, KG.luxemburg),
    # domein van isHoofdstadVan
    (KG.aarlen, RDF.type, SEM.Hoofdstad),
    # subklasse
    (KG.gent, RDF.type, SEM.Gemeente),
    # symmetrie
    (KG["namen-provincie"], SEM.grenstAan, KG.henegouwen),
    # subeigenschap + transitiviteit
    (KG.zenne, SEM.behoortTotStroomgebiedVan, KG.schelde),
])
def test_redeneerder_leidt_af(graphs, triple):
    _, facts, _, inferred = graphs
    assert triple not in facts, "dit feit hoort afgeleid te worden, niet beweerd"
    assert triple in inferred


def test_geen_onzinnige_afleidingen(graphs):
    _, _, _, inferred = graphs
    assert (KG.schaarbeek, RDF.type, SEM.Stad) not in inferred
    assert (KG.antwerpen, RDF.type, SEM.Hoofdstad) in inferred
    assert (KG.mechelen, RDF.type, SEM.Hoofdstad) not in inferred
    for s, _, _ in inferred:
        assert str(s).startswith(str(KG))


def test_voorbeeldqueries_parsen():
    from rdflib.plugins.sparql import prepareQuery
    queries = sorted((build.DATA / "queries").glob("*.rq"))
    assert queries
    for q in queries:
        prepareQuery(q.read_text(encoding="utf-8"))
