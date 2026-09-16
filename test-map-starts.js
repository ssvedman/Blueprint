/* ============================================================================
   map-core — parseStarts / aggregateStarts tests.

   Run:  node test-map-starts.js       (from the blueprint folder; no deps)

   WHY THIS EXISTS
   A townhome BUILDING SHELL job — slab, block and framing, which Lennar pays a
   building at a time — is a row in the starts log that is not a home start. The
   map counts homes, so counting the shell added a phantom start per building and
   townhome communities read high. Nothing errored; the numbers looked plausible.

   THE TRAP, which cost a production regression: the shell is identified by its
   JOB NUMBER, not by Bldg. Every unit in a townhome building carries the
   building's Z code in Bldg — that is what the column is for. A first attempt
   tested Bldg, and Claire Bay 18TH (all townhomes) reported ZERO starts. In the
   Tampa log 1,898 rows have a Z-prefixed Bldg and only 266 are shells: 86% of
   what it dropped were real homes.

   Shapes below are taken from TPU Starts Log 2026, not invented.

   Also pinned: Takeoff Flow DELIBERATELY keeps the shell row — its "{N}-PLEX"
   line is the shell takeoff, estimated separately from the per-unit plan lines.
   ingest-core.js's isPlexBldg logic is therefore correct as it stands and must
   NOT be "fixed" to match the map. Two consumers, one column, different needs.
   ========================================================================== */
const MAPCORE = require("./map-core.js");

let P = 0, F = 0;
const ok = (n, c, d) => { c ? P++ : F++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "   <- " + (d || "")}`); };
const find = () => ({ notes: [], problems: [] });
const proj = "2555761 - Claire Bay 18TH";

/* Claire Bay building Z013, verbatim from the log: six units whose Bldg is the
   building code, plus one shell whose JOB carries the building code. */
const Z013 = [
  { Project: proj, Job: "25557610013", Bldg: "Z013", Plan: "H038", EV: "A", Address: "5314 Maritime Breeze Ln", PrjStart: "2026-09-03" },
  { Project: proj, Job: "25557610014", Bldg: "Z013", Plan: "H039", EV: "A", Address: "5312 Maritime Breeze Ln", PrjStart: "2026-09-03" },
  { Project: proj, Job: "25557610015", Bldg: "Z013", Plan: "H039", EV: "A", Address: "5310 Maritime Breeze Ln", PrjStart: "2026-09-03" },
  { Project: proj, Job: "25557610016", Bldg: "Z013", Plan: "H039", EV: "A", Address: "5308 Maritime Breeze Ln", PrjStart: "2026-09-03" },
  { Project: proj, Job: "25557610017", Bldg: "Z013", Plan: "H039", EV: "A", Address: "5306 Maritime Breeze Ln", PrjStart: "2026-09-03" },
  { Project: proj, Job: "25557610018", Bldg: "Z013", Plan: "H038", EV: "A", Address: "5304 Maritime Breeze Ln", PrjStart: "2026-09-03" },
  { Project: proj, Job: "2555761Z013", Bldg: "Z013", Plan: "TW66", EV: "A", Address: "5314 Maritime Breeze Ln", PrjStart: "2026-09-03" }
];

let f = find();
let out = MAPCORE.parseStarts(Z013, "Start Log", f);

ok("THE REGRESSION: a townhome building counts its 6 units, not 0 and not 7",
   out.records.length === 6, `${out.records.length} records`);
ok("the shell row is the one excluded (Job 2555761Z013)",
   !out.records.some(r => r.id === null) && out.records.length === 6);
ok("the exclusion is reported in notes", /building-shell row\(s\) excluded/.test(f.notes.join(" ")), f.notes.join(" | "));
ok("no problems raised", f.problems.length === 0, f.problems.join(" | "));

const id = MAPCORE.normCommunityId("25557610013");
ok("streets still see the shell row's address", !!(out.streets[id] && Object.keys(out.streets[id]).length), JSON.stringify(out.streets[id]));
ok("idName still resolves from the community", out.idName[id] === "Claire Bay 18TH", out.idName[id]);

/* Digits-vs-raw: community 2553057's units are lots like "2C01" against Bldg
   "ZC01", so the shell is "2553057ZC01". digits() would strip the Z and make the
   shell look like a unit — this is why the raw job string is sliced. */
f = find();
out = MAPCORE.parseStarts([
  { Project: "2553057 - Angeline 2C VIL", Job: "25530572C01", Bldg: "ZC01", Plan: "1585", Address: "1 A St", PrjStart: "2026-09-01" },
  { Project: "2553057 - Angeline 2C VIL", Job: "25530572C02", Bldg: "ZC01", Plan: "1393", Address: "2 A St", PrjStart: "2026-09-01" },
  { Project: "2553057 - Angeline 2C VIL", Job: "2553057ZC01", Bldg: "ZC01", Plan: "BVL1", Address: "1 A St", PrjStart: "2026-09-01" }
], "Start Log", f);
ok("alphanumeric unit lots ('2C01') are kept, 'ZC01' shell dropped", out.records.length === 2, `${out.records.length}`);

/* Single-family: Bldg is a phase code, and S-prefixed lots are model/spec homes.
   Neither is a shell. */
f = find();
out = MAPCORE.parseStarts([
  { Comm: "Ranches 50GC", Job: "1114972S001", Bldg: "6", Plan: "3216", Address: "100 Rider Rain Ln", "Start (Prj)": "2026-09-02" },
  { Comm: "Ranches 50GC", Job: "11149721104", Bldg: "R", Plan: "3216", Address: "102 Rider Rain Ln", "Start (Prj)": "2026-09-02" }
], "Permit Log", f);
ok("single-family phase codes and S-prefixed spec jobs are all counted", out.records.length === 2, `${out.records.length}`);
ok("nothing reported as a shell when there are none", !/shell row/.test(f.notes.join(" ")));

/* Case and whitespace — Job is hand-maintained in places. */
f = find();
out = MAPCORE.parseStarts([
  { Project: "1111111 - X TH", Job: " 1111111z001 ", Bldg: "Z001", Plan: "TW26", Address: "1 B St", PrjStart: "2026-09-01" },
  { Project: "1111111 - X TH", Job: "11111110001", Bldg: "Z001", Plan: "H009", Address: "2 B St", PrjStart: "2026-09-01" }
], "Start Log", f);
ok("lowercase and padded shell job is still a shell", out.records.length === 1, `${out.records.length}`);

/* A job with no lot at all must not be mistaken for a shell. */
f = find();
out = MAPCORE.parseStarts([
  { Project: "1111111 - X TH", Job: "1111111", Bldg: "", Plan: "H009", Address: "3 B St", PrjStart: "2026-09-01" }
], "Start Log", f);
ok("a bare 7-character job is not a shell", out.records.length === 1, `${out.records.length}`);

/* The guard: if the format changes and most rows look like shells, KEEP them.
   Publishing zeros is the worse failure — that is the bug this file exists for.
   Needs >= 40 rows, because a proportion is not evidence on a short file. */
f = find();
const allShells = Array.from({ length: 60 }, (_, i) => ({
  Project: "1111111 - X TH", Job: "1111111Z" + String(i).padStart(3, "0"),
  Bldg: "Z" + String(i).padStart(3, "0"), Plan: "TW26", Address: `${i} C St`, PrjStart: "2026-09-01"
}));
out = MAPCORE.parseStarts(allShells, "Start Log", f);
ok("GUARD: when >25% of a large file look like shells they are counted, not dropped", out.records.length === 60, `${out.records.length}`);
ok("GUARD: and it says so in the notes", /far more than expected/.test(f.notes.join(" ")), f.notes.join(" | "));

/* ...and a SHORT mostly-shell file must not trip it. */
f = find();
out = MAPCORE.parseStarts([
  { Project: "1111111 - X TH", Job: "1111111Z001", Bldg: "Z001", Plan: "TW26", Address: "1 D St", PrjStart: "2026-09-01" },
  { Project: "1111111 - X TH", Job: "11111110001", Bldg: "Z001", Plan: "H009", Address: "2 D St", PrjStart: "2026-09-01" }
], "Start Log", f);
ok("GUARD: a 2-row file with 1 shell still excludes it (ratio needs volume)", out.records.length === 1, `${out.records.length}`);

/* End to end through the monthly aggregate. */
f = find();
const agg = MAPCORE.aggregateStarts(MAPCORE.parseStarts(Z013, "Start Log", find()).records, "2026-09", f);
ok("monthly aggregate shows 6 for the building, not 0 and not 7",
   (agg.get(id) || [])[0] === 6, JSON.stringify(agg.get(id)));

/* Guard the asymmetry with the estimating side. */
const ingest = require("fs").readFileSync(__dirname + "/ingest-core.js", "utf8");
ok("ingest-core still has its isPlexBldg logic (Takeoff Flow needs the shell)",
   /const isPlexBldg\s*=\s*b\s*=>\s*!!b\s*&&\s*\/\^z\/i\.test\(b\)/.test(ingest),
   "if this fails, someone 'fixed' the estimating side to match the map — check why");

/* And guard against the regression itself returning: Bldg must not be the test. */
const mc = require("fs").readFileSync(__dirname + "/map-core.js", "utf8");
ok("parseStarts does not decide shells from the Bldg column",
   !/isShellBldg/.test(mc),
   "testing Bldg drops every townhome unit — see the header of this file");

console.log(`\n${P} passed, ${F} failed`);
process.exit(F ? 1 : 0);
