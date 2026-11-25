# Hello Semantica

Een demonstrator voor semantische technologie (RDF, OWL, SHACL, SPARQL en Linked Data),
gebouwd met GitHub Actions en gepubliceerd op GitHub Pages.

**Live:** https://mpparsley.github.io/hello-semantica/

## Wat zit erin?

Een kleine kennisgraaf over België: gewesten, provincies, gemeenten, rivieren en bekende personen.
De feiten zijn bewust minimaal; de rest leidt een redeneerder af.

| Onderdeel | Bestand | Technologie |
|---|---|---|
| Ontologie (betekenis) | `data/ontologie.ttl` | OWL / RDFS |
| Feiten | `data/kennisgraaf.ttl` | RDF (Turtle) |
| Regels (kwaliteit) | `data/vormen.ttl` | SHACL |
| Opzettelijk foute data | `data/voorbeelden/ongeldig.ttl` | SHACL-test |
| Voorbeeldvragen | `data/queries/*.rq` | SPARQL 1.1 |
| Bouwscript | `scripts/build.py` | rdflib, pySHACL, owlrl |
| Webapp | `site/` | Oxigraph (WebAssembly), Cytoscape.js |

### Wat de demonstrator laat zien

- **Redeneren (OWL 2 RL):** transitiviteit (`ligtIn`), inverse eigenschappen (`heeftHoofdstad` / `isHoofdstadVan`),
  domein en bereik (wie hoofdstad is van iets, is een `Hoofdstad`), symmetrie (`grenstAan`),
  subklassen en subeigenschappen (`mondtUitIn` ⊑ `behoortTotStroomgebiedVan`).
- **Validatie (SHACL):** de build faalt als de data een regel schendt, en controleert ook dat een fout voorbeeld wél geweigerd wordt.
- **SPARQL in de browser:** elke query kan met en zonder afgeleide feiten draaien, zodat je het effect van de redeneerder ziet.
- **Linked Data:** elke IRI (bv. `https://mpparsley.github.io/hello-semantica/id/gent`) is opvraagbaar als HTML met
  ingebedde JSON-LD, en als Turtle, JSON-LD en N-Triples. De ontologie staat op `/def/`.
- **Verkenner:** een interactieve netwerkweergave waarin afgeleide verbanden gestippeld verschijnen.

## Pijplijn

```
data/*.ttl ──► SHACL-validatie ──► OWL 2 RL-redeneren ──► dist/ ──► GitHub Pages
                 (pySHACL)            (owlrl)               │
                                                            ├─ index.html (webapp)
                                                            ├─ data/  (Turtle, JSON-LD, N-Triples, rapporten)
                                                            ├─ id/<naam>/  (Linked Data-pagina's)
                                                            └─ def/   (ontologiedocumentatie)
```

De workflow `.github/workflows/pages.yml` draait bij elke push en pull request:

1. `pytest`: de kennisgraaf is geldig, het foute voorbeeld wordt geweigerd, de verwachte feiten worden afgeleid.
2. `scripts/build.py`: bouwt de site in `dist/`.
3. `node --test`: draait alle voorbeeldqueries in Oxigraph, dezelfde engine als in de browser.
4. Alleen op `main`: publiceren met `actions/deploy-pages`.

## GitHub Pages inschakelen

Eenmalig in de repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
Daarna publiceert elke push naar `main` de site.

## Lokaal bouwen

```bash
pip install -r requirements.txt
npm ci
pytest
python scripts/build.py          # bouwt dist/
node --test tests/queries.test.mjs
python -m http.server -d dist 8000
```

Open daarna http://localhost:8000/.

## De graaf uitbreiden

Voeg feiten toe aan `data/kennisgraaf.ttl`, of een vraag als `.rq`-bestand in `data/queries/`
(de eerste commentaarregel wordt de titel). Breekt je wijziging een SHACL-regel, dan faalt de build
en wordt er niets gepubliceerd.

Inwonersaantallen zijn afgeronde benaderingen, enkel voor demonstratie.
