/* ============================================================================
   map-core — parseStarts / aggregateStarts tests.

   Run:  node test-map-starts.js       (from the blueprint folder; no deps)

   WHY THIS EXISTS
   A Z-prefixed Bldg is a townhome BUILDING SHELL job — slab, block and framing,
   paid a building at a time — and the per-unit rows exist alongside it. The map
   counts home starts, so counting the shell row added a phantom start for every
   townhome building. Townhome communities read high, and nothing errored: the
   numbers looked plausible (Peace Creek TH was a flat 8 every month for eleven
   months) until someone noticed.

   The asymmetry these tests pin down: Takeoff Flow DELIBERATELY keeps the shell
   row — its "{N}-PLEX" line is the shell takeoff, estimated separately from the
   per-unit plan lines. So ingest-core.js's isPlexBldg logic is correct as it
   stands and must NOT be "fixed" to match the map. Two consumers, same column,
   different needs, on purpose. If a future change makes them agree, one of them
   is now wrong.
   ========================================================================== */
const MAPCORE = require("./map-core.js");

let P = 0, F = 0;
const ok = (n, c, d) => { c ? P++ : F++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "   <- " + (d || "")}`); };
const find = () => ({ notes: [], problems: [] });

/* One townhome building in the Orlando "Permit Log" layout: six units plus the
   single Z shell row, all on the same projected start. Plus two single-family
   lots whose Bldg is a phase code, which must NOT be excluded. */
const TH_BUILDING = [
  ...Array.from({ length: 6 }, (_, i) => ({
    Comm: "Brentwood 2 TH", Job: "2638272" + String(101 + i), Bldg: "A07",
    Plan: "H006", EV: "B", Address: `${1573 + i} Plank Pl`, "Start (Prj)": "2026-09-01"
  })),
  { Comm: "Brentwood 2 TH", Job: "26382720099", Bldg: "ZA07",
    Plan: "6-PLEX", EV: "B", Address: "1573 Plank Pl", "Start (Prj)": "2026-09-01" },
  { Comm: "Ranches 50GC", Job: "1114972S001", Bldg: "6",
    Plan: "3216", EV: "J", Address: "100 Rider Rain Ln", "Start (Prj)": "2026-09-02" },
  { Comm: "Ranches 50GC", Job: "1114972S002", Bldg: "R",
    Plan: "3216", EV: "J", Address: "102 Rider Rain Ln", "Start (Prj)": "2026-09-02" }
];

let f = find();
let out = MAPCORE.parseStarts(TH_BUILDING, "Permit Log", f);

ok("the 6 units are counted, the shell is not", out.records.length === 8, `${out.records.length} records`);
const th = out.records.filter(r => r.community === "Brentwood 2 TH");
ok("townhome community counts exactly its units (6, not 7)", th.length === 6, `${th.length}`);
ok("single-family phase codes in Bldg are NOT treated as shells", out.records.filter(r => r.community === "Ranches 50GC").length === 2);
ok("the exclusion is reported in notes", /shell row\(s\) excluded/.test(f.notes.join(" ")), f.notes.join(" | "));
ok("no problems raised on a well-formed sheet", f.problems.length === 0, f.problems.join(" | "));

/* Streets must still see the shell row. A shell is often the FIRST row a brand
   new townhome community has, and streets is the only way such a community gets
   placed on the map. Excluding it from the count must not exclude its address. */
const id = MAPCORE.normCommunityId("26382720099");
ok("the shell row still contributes its street", !!(out.streets[id] && Object.keys(out.streets[id]).length), JSON.stringify(out.streets[id]));
ok("the shell row still contributes the community name", out.idName[id] === "Brentwood 2 TH", out.idName[id]);

/* Case and whitespace: the column is hand-maintained. */
f = find();
out = MAPCORE.parseStarts([
  { Comm: "X TH", Job: "1111111001", Bldg: "za01", Address: "1 A St", "Start (Prj)": "2026-09-01" },
  { Comm: "X TH", Job: "1111111002", Bldg: " Z157 ", Address: "2 A St", "Start (Prj)": "2026-09-01" },
  { Comm: "X TH", Job: "1111111003", Bldg: "A01", Address: "3 A St", "Start (Prj)": "2026-09-01" }
], "Permit Log", f);
ok("lowercase 'za01' is a shell", out.records.length === 1, `${out.records.length} records`);
ok("' Z157 ' with whitespace is a shell", !out.records.some(r => r.id === null) && out.records.length === 1);

/* The Tampa "Start Log" layout goes through the same path. */
f = find();
out = MAPCORE.parseStarts([
  { Project: "TPU - West River TH", Job: "1598971001", Bldg: "Z225", Address: "1 B St", PrjStart: "2026-09-03" },
  { Project: "TPU - West River TH", Job: "1598971002", Bldg: "225", Address: "2 B St", PrjStart: "2026-09-03" }
], "Start Log", f);
ok("shells are excluded in the Project/Start Log layout too", out.records.length === 1, `${out.records.length}`);

/* A missing Bldg column means the fix is silently inert — that must be loud. */
f = find();
out = MAPCORE.parseStarts([
  { Comm: "Y TH", Job: "2222222001", Address: "1 C St", "Start (Prj)": "2026-09-01" }
], "Permit Log", f);
ok("a missing Bldg column is NOTED (visible) ...",
   f.notes.some(n => /no "Bldg" column/.test(n)), f.notes.join(" | "));
ok("... but does NOT block the import (problems -> `blocking` in app.js)",
   f.problems.length === 0, f.problems.join(" | "));

/* End to end: the phantom start must be gone from the monthly aggregate. */
f = find();
const agg = MAPCORE.aggregateStarts(MAPCORE.parseStarts(TH_BUILDING, "Permit Log", find()).records, "2026-09", f);
const thId = MAPCORE.normCommunityId("26382720101");
ok("monthly aggregate shows 6 for the townhome building, not 7",
   (agg.get(thId) || [])[0] === 6, JSON.stringify(agg.get(thId)));

/* Guard the asymmetry: ingest-core must STILL count the shell. */
const ingest = require("fs").readFileSync(__dirname + "/ingest-core.js", "utf8");
ok("ingest-core still has its isPlexBldg shell logic (Takeoff Flow needs it)",
   /const isPlexBldg\s*=\s*b\s*=>\s*!!b\s*&&\s*\/\^z\/i\.test\(b\)/.test(ingest),
   "if this fails, someone 'fixed' the estimating side to match the map — check why");

console.log(`\n${P} passed, ${F} failed`);
process.exit(F ? 1 : 0);
