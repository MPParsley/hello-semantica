// Draait elke voorbeeldquery in Oxigraph (dezelfde engine als in de browser)
// tegen de gebouwde data, met en zonder afgeleide feiten.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import oxigraph from "oxigraph";

const dist = new URL("../dist/data/", import.meta.url);
const read = (f) => readFileSync(new URL(f, dist), "utf8");
const meta = JSON.parse(read("meta.json"));

const full = new oxigraph.Store();
full.load(read("volledig.ttl"), { format: "text/turtle" });
const asserted = new oxigraph.Store();
asserted.load(read("ontologie.ttl"), { format: "text/turtle" });
asserted.load(read("kennisgraaf.ttl"), { format: "text/turtle" });

for (const q of meta.queries) {
  test(`${q.id} geeft resultaten met redeneerder`, () => {
    const res = full.query(q.query);
    assert.ok(res.length > 0, "geen resultaten");
  });
}

test("redeneren maakt het verschil", () => {
  const q = meta.queries.find((x) => x.id === "01-steden-in-vlaanderen").query;
  assert.equal(asserted.query(q).length, 0);
  assert.equal(full.query(q).length, 10);
});
