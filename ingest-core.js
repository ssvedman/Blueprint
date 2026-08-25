/* ============================================================================
   Blueprint — ingest-core.js
   Pure logic for the Data Intake tab: recognising a dropped workbook, parsing it
   the way each destination app already parses it, and deciding what may be
   published. No DOM, no network, no Supabase. Unit-tested in node and reused
   verbatim by the browser and by the parsing worker.

   Loaded in the browser as window.BPI; required in node as module.exports.

   ── WHY THE PARSERS ARE DUPLICATED RATHER THAN UNIFIED ────────────────────────
   The same Starts Log is read by Vendor Assignments and Takeoff Flow, and they do
   not read it identically: Takeoff Flow wants the Permit Log tab for Orlando and
   pulls plan/elevation/building, Vendor Assignments wants Start Log and only needs
   community and date. Handing both apps one merged parse would change what at
   least one of them ingests, and community counts would move on the next upload
   for reasons nobody could trace back to this change.

   So intake parses the one workbook you dropped once per destination, each with
   that destination's own rule, ported here verbatim from its app.js. You upload
   once; each app receives exactly what it would have received had you uploaded to
   it directly. Where the two rules disagree about which sheet to read, the plan
   says so out loud (see sheetDisagreement) rather than silently picking a winner.

   On the real files this has never differed: Orlando's workbook has no Start Log
   tab, so Vendor Assignments' "first sheet" fallback lands on Permit Log, the same
   tab Takeoff Flow names explicitly. That is luck, not design — see the note on
   VP_STARTS_SHEETS.
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BPI = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* SheetJS is a global in the browser and the worker, and a require() in node.
     Resolved lazily so this module can be loaded — and most of it tested —
     without SheetJS present at all. */
  let _XLSX = null;
  function setXLSX(x) { _XLSX = x; }
  function XL() {
    if (_XLSX) return _XLSX;
    if (typeof XLSX !== "undefined") return (_XLSX = XLSX);
    if (typeof self !== "undefined" && self.XLSX) return (_XLSX = self.XLSX);
    if (typeof require === "function") {
      // Plain resolution first, then an explicit path. The tests install SheetJS
      // in blueprint-dev/, which is a *sibling* of this directory rather than an
      // ancestor, so node's upward walk never finds it — the same convention the
      // map's tools use, for the same reason.
      const tries = ["xlsx"];
      if (typeof process !== "undefined" && process.env && process.env.XLSX_PATH) {
        tries.push(process.env.XLSX_PATH.replace(/[\\/]+$/, "") + "/xlsx");
      }
      for (const t of tries) { try { return (_XLSX = require(t)); } catch (_) {} }
    }
    throw new Error(
      "SheetJS is not loaded, so no workbook can be parsed. In the browser it comes "
      + "from the CDN script tag; in node, install it (npm install --no-save xlsx) or "
      + "call BPI.setXLSX() with it.");
  }

  /* ------------------------------------------------------------- primitives */

  const lc     = s => String(s == null ? "" : s).trim().toLowerCase();
  const digits = x => String(x == null ? "" : x).replace(/\D/g, "");
  const S      = s => (s == null ? null : String(s).trim() || null);

  /* Repairs a worksheet whose !ref does not cover its cells. E1 and Power BI both
     export sheets whose dimension record is a single cell, and sheet_to_json
     trusts !ref, so without this the RE2 file reads as one row. Byte-identical to
     the copies in vendor-portal/app.js and lennar-map's importer — this is the
     one that should survive. */
  function fixRange(ws) {
    if (!ws) return ws;
    const X = XL();
    let minR = Infinity, minC = Infinity, maxR = 0, maxC = 0, any = false;
    for (const k in ws) {
      if (k[0] === "!") continue;
      const c = X.utils.decode_cell(k);
      any = true;
      if (c.r < minR) minR = c.r; if (c.c < minC) minC = c.c;
      if (c.r > maxR) maxR = c.r; if (c.c > maxC) maxC = c.c;
    }
    if (any) ws["!ref"] = X.utils.encode_range({ s: { r: minR, c: minC }, e: { r: maxR, c: maxC } });
    return ws;
  }

  /* Two date converters, deliberately kept apart.

     vpDate is the (serial - 25569) epoch arithmetic from vendor-portal/app.js.
     tfDate is the XLSX.SSF.parse_date_code path from Takeoff Flow's app.js.

     They agree on every row of the real files — that was measured, not assumed —
     but they are not the same function, and quietly collapsing them would be a
     silent change to whichever app lost. Each app keeps its own until somebody
     decides which is correct and changes it deliberately. */
  function vpDate(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") {
      const d = new Date(Math.round((v - 25569) * 86400 * 1000));
      return isNaN(d) ? null : d.toISOString().slice(0, 10);
    }
    const d = new Date(v);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }

  function tfDate(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") {
      const X = XL();
      const d = X.SSF ? X.SSF.parse_date_code(v) : null;
      if (d) return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
    }
    const d = new Date(v);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }

  function cleanCommName(desc) {
    if (!desc) return null;
    return desc.replace(/\(.*?\)/g, "").replace(/[-*].*$/, "").trim() || null;
  }

  /* --------------------------------------------------------------- divisions */

  const DIVISIONS = [
    { key: "tampa",   label: "Tampa",   code: "TPU" },
    { key: "orlando", label: "Orlando", code: "OLH" }
  ];
  const divisionByKey = k => DIVISIONS.find(d => d.key === k) || null;

  /* ------------------------------------------------------------------ sniff */

  /* Sheet names each app looks for, in its own order of preference.

     "Permit Log" is last in VP_STARTS_SHEETS, and it is there deliberately.

     Vendor Assignments shipped looking only for "Start Log" and "START SCHEDULE",
     then falling back to the first sheet. The Orlando workbook has neither of
     those tabs, so it reached its data purely through that fallback — and only
     because Permit Log happens to be the first tab in the file. Reorder the tabs
     and Vendor Assignments would have parsed "Drivers", twelve rows, and replaced
     the whole division with it. No error, no warning.

     Naming Permit Log explicitly removes that dependence on tab order. It is
     placed AFTER the other two so the change is a no-op on every real file: a
     workbook with Start Log still resolves to Start Log exactly as before, and
     the Orlando workbook now finds Permit Log by name instead of by luck. The
     same line was added to vendor-portal/app.js so the app and intake stay
     identical.

     Note this still is not the same rule Takeoff Flow uses — for Orlando it
     prefers Permit Log over Start Log, where Vendor Assignments prefers Start
     Log. No file has ever had both tabs, so the two have never disagreed. If one
     ever does, sheetDisagreement() raises it as a warning rather than letting the
     apps quietly diverge. */
  const VP_STARTS_SHEETS = ["Start Log", "START SCHEDULE", "Permit Log"];
  const TF_STARTS_SHEETS = { orlando: "Permit Log", tampa: "Start Log" };
  const TF_STARTS_FALLBACKS = ["Permit Log", "Start Log", "START SCHEDULE"];

  const FLOW_SHEET = "FLOW OF TAKEOFFS";

  // Columns that identify a file even when its sheet is called something unhelpful
  // like "Sheet1", which is what both the E1 and Power BI exports produce.
  const RE2_REQUIRED  = ["Division", "Community", "Supplier Desc"];
  const RE2_TRADE     = ["Trade Desc.", "Trade Desc"];
  const STARTS_OLH    = ["Comm", "Job"];
  const STARTS_TPU    = ["Project", "Job"];

  function findSheet(names, want) {
    return (names || []).find(s => lc(s) === lc(want)) || null;
  }

  /* Which sheets must actually be loaded to handle a file of this kind. Reading a
     workbook sheet-by-sheet rather than whole is the single largest cost saving
     in intake: the Tampa log carries a month tab with 1,047,079 phantom rows, and
     skipping it takes that file from 13.2 s to 1.1 s with byte-identical output. */
  function sheetsNeeded(kind, sheetNames, division) {
    if (kind === "flow")     return [findSheet(sheetNames, FLOW_SHEET)].filter(Boolean);
    if (kind === "re2")      return [sheetNames[0]];
    if (kind === "contacts") return [sheetNames[0]];
    if (kind === "starts") {
      const want = new Set();
      const tf = (division && TF_STARTS_SHEETS[division]) || null;
      if (tf && findSheet(sheetNames, tf)) want.add(findSheet(sheetNames, tf));
      for (const n of TF_STARTS_FALLBACKS) { const f = findSheet(sheetNames, n); if (f) want.add(f); }
      for (const n of VP_STARTS_SHEETS)    { const f = findSheet(sheetNames, n); if (f) want.add(f); }
      // Both apps end at "first sheet", so it is always a candidate.
      if (sheetNames[0]) want.add(sheetNames[0]);
      return [...want];
    }
    return sheetNames.slice(0, 1);
  }

  /* Identify a dropped file from its sheet names plus the header row of its first
     candidate sheet. Header inspection is what makes this work at all: three of
     the four real files arrive as "Sheet1".

     headersOf is injected rather than read here so sniffing stays pure and the
     caller controls how much of the workbook has been loaded. */
  function sniff(sheetNames, headers, fileName) {
    const names = sheetNames || [];
    const H = new Set((headers || []).map(h => String(h == null ? "" : h).trim()));
    const has = c => H.has(c);
    const hasAny = cs => cs.some(has);

    if (findSheet(names, FLOW_SHEET)) {
      return { kind: "flow", division: null, why: `sheet "${FLOW_SHEET}" present` };
    }

    // Power BI writes an applied-filters block above the table, so its real header
    // is not row 1 and the columns carry trailing spaces. Match on the block, or
    // on the trailing-space header pair, before anything else claims it.
    const firstCell = String((headers || [])[0] == null ? "" : (headers || [])[0]);
    const loose = [...H].map(h => lc(h));
    if (/^applied filters/i.test(firstCell) ||
        (loose.some(h => /^communit/.test(h)) && loose.some(h => /e-?mail/.test(h)))) {
      return { kind: "contacts", division: null, why: "Power BI contact export layout" };
    }

    if (RE2_REQUIRED.every(has) && hasAny(RE2_TRADE)) {
      return { kind: "re2", division: null, why: "Division + Community + Supplier Desc columns" };
    }

    /* A starts log is identified by its columns, and those columns also say which
       division wrote it: Orlando's permit log is keyed on Comm, Tampa's start log
       on Project. That is the same discriminator both apps' parsers branch on, so
       inferring from it cannot disagree with how the file is later read. */
    const olh = STARTS_OLH.every(has);
    const tpu = STARTS_TPU.every(has);
    if (olh || tpu) {
      const division = olh && !tpu ? "orlando" : (tpu && !olh ? "tampa" : null);
      return {
        kind: "starts",
        division,
        why: olh && tpu
          ? "has both Comm and Project columns — division is ambiguous, choose one"
          : `${olh ? "Comm" : "Project"} column → ${division}`
      };
    }

    if (findSheet(names, "Permit Log") || findSheet(names, "Start Log") ||
        findSheet(names, "START SCHEDULE")) {
      return { kind: "starts", division: findSheet(names, "Permit Log") ? "orlando" : "tampa",
               why: "recognised sheet name, but the expected columns were not on it" };
    }

    return {
      kind: "unknown",
      division: null,
      why: `no recognised sheet or column set${fileName ? ` in ${fileName}` : ""}`
    };
  }

  /* ============================ VENDOR ASSIGNMENTS ==========================
     Ported from vendor-portal/app.js buildDivision (app.js:1165-1238), split so
     the RE2 workbook is converted to rows ONCE and shared between divisions. The
     file holds every division — 60,105 Orlando rows and 84,348 Tampa rows in the
     current export — and re-running sheet_to_json per division cost 3.4 s a time
     for an identical result.

     The split is a refactor, not a behaviour change: ingest.test.js asserts the
     output is deep-equal to the shipped buildDivision for both divisions against
     the real export.
     ======================================================================== */

  function re2Rows(wb) {
    const X = XL();
    return X.utils.sheet_to_json(fixRange(wb.Sheets[wb.SheetNames[0]]), { defval: null });
  }

  // Bucket once by division code so each division's build scans only its own rows.
  function bucketRE2(rows) {
    const byCode = {};
    const counts = {};
    for (const r of rows || []) {
      const div = S(r["Division"]);
      if (!div) continue;
      const code = div.toUpperCase();
      counts[code] = (counts[code] || 0) + 1;
      (byCode[code] = byCode[code] || []).push(r);
    }
    return { byCode, counts, total: (rows || []).length };
  }

  /* Which tab Vendor Assignments reads, and how it got there.

     Split out from parseStartsVP because this is the part with a bug history —
     Orlando resolved only through the first-sheet fallback until "Permit Log" was
     named — and because it is pure string logic that should be testable without
     loading a spreadsheet library to assert on it. */
  function pickStartsSheetVP(sheetNames) {
    const names = sheetNames || [];
    for (const want of VP_STARTS_SHEETS) {
      const f = findSheet(names, want);
      if (f) return { sheet: f, via: "named" };
    }
    return { sheet: names[0] || null, via: "firstSheet" };
  }

  function parseStartsVP(wb) {
    const X = XL();
    const { sheet, via } = pickStartsSheetVP(wb.SheetNames);

    const rows = X.utils.sheet_to_json(fixRange(wb.Sheets[sheet]), { defval: null });
    const startRecords = [];
    const idName = {};
    for (const r of rows) {
      let comm = null, date = null, kind = "Projected", job = null;
      if (r["Comm"] != null) {
        comm = S(r["Comm"]);
        const p = r["Start (Prj)"], a = r["Start (Act)"];
        date = vpDate(a || p); kind = a ? "Actual" : "Projected"; job = r["Job"];
      } else if (r["Project"] != null) {
        const proj = S(r["Project"]) || "";
        comm = proj.includes(" - ") ? proj.split(" - ").slice(1).join(" - ").trim() : proj;
        const a = r["ActStart"], p = r["PrjStart"];
        date = vpDate(a || p); kind = a ? "Actual" : "Projected"; job = r["Job"];
      }
      if (!comm || !date) continue;
      startRecords.push({ community: comm, date, kind });
      /* Seven digits of community, then a lot number of whatever width — matching
         vendor-portal/app.js, which was changed at the same time and for the same
         reason. The threshold was 11, which skipped the 485 jobs in the Orlando
         permit log that carry a 3-digit lot, so those communities never learned
         their name from the starts log and appeared twice: once under the permit
         log spelling and once under the RE2 Description spelling. */
      const id = digits(job);
      if (id.length >= 7) idName[id.slice(0, 7) + "0000"] = comm;
    }
    return { startRecords, idName, sheet, via, sourceRows: rows.length };
  }

  /* Build one division's payload. `re2ForDivision` is that division's pre-bucketed
     rows, or null when no RE2 file was supplied.

     `current` is the payload already published for this division. It matters more
     than it looks: with no RE2 file the shipped app falls back to state.cache to
     keep the existing vendor matrix, and intake has no such cache. Passing null
     here where the app would have had a cache turns Orlando from 531 communities
     into 94 and drops every vendor — measured against the real files, not
     hypothesised. planVendorPortal() refuses that case outright; this function
     still honours `current` so the behaviour matches the app if it is ever
     called directly. */
  function buildVendorPayload(key, re2ForDivision, starts, current) {
    const div = divisionByKey(key) || { key, label: key, code: key.toUpperCase() };
    const code = div.code;

    const startRecords = starts ? starts.startRecords : [];
    const idName = starts ? starts.idName : {};

    let vendors = [], communities = [], categories = [];
    const commSet = new Map();
    const diag = { unmatched: new Set(), re2Rows: 0, skippedNoCat: 0, skippedExpired: 0, skippedNoCid: 0, code };

    if (re2ForDivision) {
      const today = new Date().toISOString().slice(0, 10);
      const groups = new Map();
      for (const r of re2ForDivision) {
        diag.re2Rows++;
        const vendor = S(r["Supplier Desc"]);
        const cat = S(r["Trade Desc."]) || S(r["Trade Desc"]);
        if (!vendor || !cat || cat === ".") { diag.skippedNoCat++; continue; }
        const exp = vpDate(r["Expired Date"]);
        if (exp && exp < today) { diag.skippedExpired++; continue; }
        const cid = digits(r["Community"]);
        if (!cid) { diag.skippedNoCid++; continue; }
        const cidNorm = cid.length >= 11 ? cid.slice(0, 7) + "0000" : cid;
        const nm = idName[cidNorm] || cleanCommName(S(r["Description"])) || cidNorm;
        commSet.set(cidNorm, nm);
        if (nm === cidNorm) diag.unmatched.add(cidNorm);
        const gk = cat + "|" + vendor;
        if (!groups.has(gk)) {
          groups.set(gk, { category: cat, name: vendor, tradeCode: S(r["Trade Code"]),
                           supplierCode: S(r["Supplier"]), comms: new Set() });
        }
        if (!groups.get(gk).supplierCode) groups.get(gk).supplierCode = S(r["Supplier"]);
        groups.get(gk).comms.add(nm);
      }
      vendors = [...groups.values()].map(g => ({
        category: g.category, billCode: null, tradeCode: g.tradeCode, supplierCode: g.supplierCode,
        name: g.name, totalCommunities: g.comms.size, total2026: null, assigned: [...g.comms].sort()
      }));
      categories = [...new Set(vendors.map(v => v.category))].sort();
    } else if (current) {
      vendors = current.vendors;
      categories = current.categories;
      (current.communities || []).forEach(c => {
        if (c.id) commSet.set(digits(c.id).slice(0, 7) + "0000" || c.id, c.name);
        else commSet.set(c.name, c.name);
      });
    }

    const names = new Set([...commSet.values()]);
    startRecords.forEach(r => names.add(r.community));
    const name2id = {};
    for (const [cid, nm] of commSet.entries()) if (nm && !(nm in name2id)) name2id[nm] = cid;
    for (const cid in idName) { const nm = idName[cid]; if (nm && !(nm in name2id)) name2id[nm] = cid; }
    communities = [...names].sort().map(n => ({ name: n, id: name2id[n] || null, homesites: null }));

    const dr = startRecords.length
      ? { min: startRecords.reduce((a, b) => (b.date < a ? b.date : a), startRecords[0].date),
          max: startRecords.reduce((a, b) => (b.date > a ? b.date : a), startRecords[0].date) }
      : null;

    return {
      division: div.label, code, key,
      communities, categories, vendors, startRecords, startsDateRange: dr,
      _diag: { ...diag, unmatched: [...diag.unmatched] }
    };
  }

  // Verbatim from vendor-portal/app.js:1248-1264. The change_log summary column
  // stores this shape, so the history panel depends on it exactly.
  function diffPayload(prev, next) {
    const names = arr => new Set((arr || []).map(x => x.name));
    const pv = names(prev && prev.vendors), nv = names(next.vendors);
    const pc = names(prev && prev.communities), nc = names(next.communities);
    const pairs = vs => { const s = new Set(); (vs || []).forEach(v => (v.assigned || []).forEach(c => s.add(v.name + "|" + c))); return s; };
    const pp = pairs(prev && prev.vendors), np = pairs(next.vendors);
    const added = (A, B) => [...B].filter(x => !A.has(x));
    const cAdd = added(pc, nc), cRem = added(nc, pc);
    const aAdd = added(pp, np), aRem = added(np, pp);
    return {
      vendors: nv.size, communities: nc.size,
      vendorsAdded: added(pv, nv).length, vendorsRemoved: added(nv, pv).length,
      commsAdded: cAdd.length, commsRemoved: cRem.length,
      commsAddedList: cAdd, commsRemovedList: cRem,
      assignmentsAdded: aAdd.length, assignmentsRemoved: aRem.length,
      assignAddedList: aAdd, assignRemovedList: aRem,
      assignDelta: np.size - pp.size
    };
  }

  /* ================================ TAKEOFF FLOW ============================
     Ported from Takeoff Flow's app.js parseStartSchedule (1531-1586) and the
     planning half of buildImportPreview (1587-1641). The publish half stays in
     db.js because it writes.
     ======================================================================== */

  function parseStartsTF(wb, div) {
    const X = XL();
    const names = wb.SheetNames;
    const want = TF_STARTS_SHEETS[div] || null;
    const sheet = (want && findSheet(names, want))
               || findSheet(names, "Permit Log")
               || findSheet(names, "Start Log")
               || findSheet(names, "START SCHEDULE")
               || names[0];

    const rows = X.utils.sheet_to_json(wb.Sheets[sheet], { defval: null });
    const commNum = r => { const job = digits(r["Job"]); return job.length >= 7 ? job.slice(0, 7) + "0000" : (S(r["Comm"]) || ""); };

    // Only Z-prefixed buildings are plexes. A single-family community's "Bldg" is
    // a phase code spanning many lots, and treating it as a building produced a
    // "42-PLEX".
    const isPlexBldg = b => !!b && /^z/i.test(b);
    const bldgCount = {};
    for (const r of rows) { const b = S(r["Bldg"]); if (isPlexBldg(b)) { const k = commNum(r) + "|" + b; bldgCount[k] = (bldgCount[k] || 0) + 1; } }

    const idName = {}, nameCount = {};
    const groups = new Map();
    const noteName = (num, comm) => { if (num && comm) { (nameCount[num] = nameCount[num] || {})[comm] = (nameCount[num][comm] || 0) + 1; } };

    for (const r of rows) {
      let comm = null, num = "", plan = null, ev = null, trench = null;
      const bldg = S(r["Bldg"]);
      if (r["Comm"] != null || (r["Job"] != null && r["Project"] == null)) {
        comm = S(r["Comm"]); num = commNum(r);
        plan = S(r["Plan"]); ev = S(r["EV"]) || S(r["Elevation"]);
        trench = tfDate(r["TrenchKey"]) || tfDate(r["Start (Prj)"]) || tfDate(r["Start (Act)"]);
        if (num && comm) idName[num] = comm;
        noteName(num, comm);
      } else if (r["Project"] != null) {
        const proj = S(r["Project"]) || "";
        comm = proj.includes(" - ") ? proj.split(" - ").slice(1).join(" - ").trim() : proj;
        num = commNum(r); plan = S(r["Plan"]); ev = S(r["EV"]) || S(r["Elevation"]);
        trench = tfDate(r["ActStart"]) || tfDate(r["PrjStart"]);
        noteName(num, comm);
      } else continue;

      const bp = isPlexBldg(bldg);
      const srcPlan = plan;
      if (bp) { const cnt = bldgCount[num + "|" + bldg]; if (cnt) plan = cnt + "-PLEX"; if (ev) ev = ev.charAt(0); }
      const name = comm || idName[num] || num;
      if (!num || !plan) continue;

      const add = (planLabel, evv) => {
        if (!planLabel) return;
        const key = [num, lc(planLabel), lc(evv || "")].join("|");
        if (!groups.has(key)) groups.set(key, { community_name: name, community_num: num, plan: planLabel, elevation: evv, first_trench_date: trench, last_trench_date: trench });
        else { const g = groups.get(key); if (trench) {
          if (!g.first_trench_date || trench < g.first_trench_date) g.first_trench_date = trench;
          if (!g.last_trench_date  || trench > g.last_trench_date ) g.last_trench_date  = trench;
        } }
      };
      add(plan, ev);
      if (bp && srcPlan && lc(srcPlan) !== lc(plan)) add(srcPlan, ev);
    }

    const canon = {};
    for (const num in nameCount) {
      let best = null, bn = -1;
      for (const nm in nameCount[num]) if (nameCount[num][nm] > bn) { bn = nameCount[num][nm]; best = nm; }
      canon[num] = best;
    }
    const out = [...groups.values()];
    out.forEach(g => { const c = canon[g.community_num]; if (c) g.community_name = c; });
    return { rows: out, sheet, sourceRows: rows.length };
  }

  // Plex plans keep their unit count when matched: collapsing every size to "plex"
  // made a 7-PLEX inherit a smaller building's earliest start.
  const normPlan = p => { const s = lc(p); const m = s.match(/^(\d+)\s*-?\s*plex$/); return m ? m[1] + "-plex" : s; };
  const combo = (num, plan, ev) => [String(num || "").trim(), normPlan(plan), lc(ev || "")].join("|");

  /* Decide what an import would do to flow_rows without writing anything.
     Existing rows are never overwritten wholesale — only a First Trench date that
     moved earlier is touched, which is what makes re-importing a log safe. */
  function planFlowImport(proposed, existRows) {
    const exist = existRows || [];
    const existing = new Set(exist.map(r => combo(r.community_num, r.plan, r.elevation)));
    const existingNumPlan = new Set(exist.map(r => String(r.community_num || "").trim() + "|" + normPlan(r.plan)));
    const existingNums = new Set(exist.map(r => String(r.community_num || "").trim()));
    const numName = {};
    exist.forEach(r => { const n = String(r.community_num || "").trim(); if (n && !(n in numName)) numName[n] = r.community_name; });

    const fresh = proposed.filter(p => {
      const num = String(p.community_num || "").trim();
      if (existing.has(combo(num, p.plan, p.elevation))) return false;
      if (!String(p.elevation || "").trim() && existingNumPlan.has(num + "|" + normPlan(p.plan))) return false;
      return true;
    });
    fresh.forEach(p => { const n = String(p.community_num || "").trim(); if (numName[n]) p.community_name = numName[n]; });

    const existByCombo = new Map(), existByNumPlan = new Map();
    exist.forEach(r => {
      existByCombo.set(combo(r.community_num, r.plan, r.elevation), r);
      const k = String(r.community_num || "").trim() + "|" + normPlan(r.plan);
      if (!existByNumPlan.has(k)) existByNumPlan.set(k, r);
    });
    const findExisting = p => {
      const num = String(p.community_num || "").trim();
      return existByCombo.get(combo(num, p.plan, p.elevation))
          || (!String(p.elevation || "").trim() ? existByNumPlan.get(num + "|" + normPlan(p.plan)) : null)
          || null;
    };

    // Several parsed combos can map to one existing row, so collapse per row and
    // keep the earliest date — otherwise the upsert touches an id twice.
    const freshSet = new Set(fresh), agg = new Map();
    proposed.forEach(p => {
      if (freshSet.has(p)) return;
      const r = findExisting(p); if (!r) return;
      const nt = p.first_trench_date; if (!nt) return;
      const lt = p.last_trench_date || nt;
      const cur = agg.get(r.id);
      if (!cur) agg.set(r.id, { row: r, earliest: nt, latest: lt });
      else { if (nt < cur.earliest) cur.earliest = nt; if (lt > cur.latest) cur.latest = lt; }
    });

    const updates = [];
    // last_trench_date mirrors the CURRENT log's latest start per row — it may move
    // backward when future lots are dropped. The Takeoff Flow Plans tab flags a
    // plan red only when this date is before today, so every Starts Log import
    // refreshes it (matches Takeoff Flow's own admin import).
    const lastUpdates = [];
    agg.forEach(({ row: r, earliest, latest }) => {
      if (earliest !== (r.first_trench_date || null)) {
        updates.push({
          id: r.id,
          community_name: numName[String(r.community_num || "").trim()] || r.community_name,
          community_num: r.community_num, plan: r.plan, elevation: r.elevation || "",
          trFrom: r.first_trench_date || "", trTo: earliest
        });
      }
      if (latest && latest !== (r.last_trench_date || null)) lastUpdates.push({ id: r.id, to: latest });
    });

    const byComm = new Map();
    fresh.forEach(r => byComm.set(r.community_name, (byComm.get(r.community_name) || 0) + 1));
    const newComms = [...new Set(fresh.filter(p => !existingNums.has(String(p.community_num || "").trim())).map(p => p.community_name))];

    return { fresh, updates, lastUpdates, parsed: proposed.length, communities: byComm.size, newCommunities: newComms };
  }

  /* Build the summary and detail written to tf_change_log. The "What's New" panel
     reads both: summary is the headline, detail.added and detail.dateChanges are
     the tables underneath. An import that logs a summary with no detail shows an
     entry that expands into nothing, so this is generated from the same plan the
     publish uses rather than being rebuilt at write time. */
  function flowChangeEntry(plan, div, source) {
    const parts = [];
    if (plan.fresh.length) parts.push(`${plan.fresh.length} new row(s)`);
    if (plan.updates.length) parts.push(`${plan.updates.length} trench update(s)`);
    if (plan.lastUpdates && plan.lastUpdates.length) parts.push(`${plan.lastUpdates.length} latest-start refresh(es)`);
    const summary = `Imported ${parts.join(" + ")} from ${source} → ${div}`
                  + (plan.communities ? ` · ${plan.communities} communities` : "")
                  + (plan.newCommunities.length ? `, ${plan.newCommunities.length} new` : "");
    const detail = {
      source, division: div,
      communities: plan.communities,
      newCommunities: plan.newCommunities,
      added: plan.fresh.map(r => ({ community: r.community_name, plan: r.plan, elevation: r.elevation || "", trench: r.first_trench_date || "" })),
      dateChanges: plan.updates.map(u => ({ community: u.community_name, plan: u.plan, elevation: u.elevation, from: u.trFrom, to: u.trTo }))
    };
    return { summary, detail };
  }

  /* ================================= PLANNING ===============================
     What may be published, per destination, given what was dropped.

     The gating rule is the operator's: Vendor Assignments needs the RE2 export AND
     that division's own starts log; Takeoff Flow needs only the starts log. A
     destination that lacks an input is "waiting", never an error and never a
     partial publish — the starts logs arrive from two different people on
     different days, so an incomplete drop is the normal case, not a mistake.
     ======================================================================== */

  const REQUIREMENTS = {
    vendorPortal: { needs: ["re2", "starts"], label: "Vendor Assignments" },
    takeoffFlow:  { needs: ["starts"],        label: "Takeoff Flow" },
    communityMap: { needs: ["re2", "starts"], label: "Community Map", divisions: ["orlando"], optional: ["contacts"] }
  };

  function missingFor(target, division, present) {
    const req = REQUIREMENTS[target];
    const missing = [];
    for (const need of req.needs) {
      if (need === "re2" && !present.re2) missing.push("the RE2 vendor assignments export");
      if (need === "starts" && !(present.starts || {})[division]) {
        const d = divisionByKey(division);
        missing.push(`the ${d ? d.label : division} starts log`);
      }
    }
    return missing;
  }

  /* present: { re2:bool, starts:{orlando:bool,tampa:bool}, contacts:bool, flow:bool }
     Returns one entry per destination × division, each ready or waiting. */
  function planTargets(present) {
    const out = [];
    for (const [target, req] of Object.entries(REQUIREMENTS)) {
      const divs = req.divisions || DIVISIONS.map(d => d.key);
      for (const division of divs) {
        const missing = missingFor(target, division, present);
        const optionalMissing = (req.optional || []).filter(o => !present[o]);
        out.push({
          target, division,
          label: req.label,
          divisionLabel: (divisionByKey(division) || {}).label || division,
          ready: missing.length === 0,
          missing,
          optionalMissing
        });
      }
    }
    return out;
  }

  /* Guards that should stop a publish rather than merely colour it.

     The thresholds differ between the apps today — Vendor Assignments warns at a
     70% loss, the map importer refuses at 50%. Intake refuses at 50% for both and
     warns below that, because it publishes to several apps at once: a wrong file
     caught here is caught everywhere, and a warning that is routinely clicked
     through is not a guard. */
  const SHRINK_REFUSE = 0.5;
  const SHRINK_WARN   = 0.3;

  function guardVendorPayload(next, current, diag, divisionCode, re2Counts) {
    const blocking = [], warnings = [], notes = [];

    if (re2Counts) {
      const match = re2Counts[divisionCode] || 0;
      const others = Object.keys(re2Counts).filter(c => c !== divisionCode);
      if (match === 0) {
        blocking.push(`No rows in the RE2 export are for division ${divisionCode}. `
                    + `It contains ${others.map(c => `${re2Counts[c].toLocaleString()} ${c}`).join(", ") || "no divisions"} — this looks like the wrong file.`);
      } else if (others.length) {
        notes.push(`The RE2 export covers ${others.length + 1} divisions; the ${match.toLocaleString()} `
                 + `${divisionCode} rows are used here and the rest are ignored.`);
      }
    }

    if (current && current.communities && current.communities.length) {
      const before = current.communities.length, after = next.communities.length;
      const lost = before - after;
      if (after < before * SHRINK_REFUSE) {
        blocking.push(`Would drop ${lost.toLocaleString()} of ${before.toLocaleString()} communities `
                    + `(over ${Math.round((1 - SHRINK_REFUSE) * 100)}%). Check the file before publishing.`);
      } else if (after < before * (1 - SHRINK_WARN)) {
        warnings.push(`Removes ${lost.toLocaleString()} of ${before.toLocaleString()} communities.`);
      }
      const curA = (current.vendors || []).reduce((s, v) => s + v.assigned.length, 0);
      const newA = next.vendors.reduce((s, v) => s + v.assigned.length, 0);
      if (curA && newA < curA * SHRINK_REFUSE) {
        blocking.push(`Would remove over ${Math.round((1 - SHRINK_REFUSE) * 100)}% of trade assignments `
                    + `(${curA.toLocaleString()} → ${newA.toLocaleString()}).`);
      }
    }

    if (diag && (diag.unmatched || []).length) {
      warnings.push(`${diag.unmatched.length} communities could not be matched to a name and will show as IDs.`);
    }
    return { blocking, warnings, notes };
  }

  /* Did the two apps' sheet rules land on different tabs of the same workbook?
     Silent on the current files; loud the day somebody reorders the tabs. */
  function sheetDisagreement(vpSheet, tfSheet, vpVia) {
    if (!vpSheet || !tfSheet) return null;
    if (lc(vpSheet) === lc(tfSheet)) {
      return vpVia === "firstSheet"
        ? { level: "note",
            text: `Both apps read "${vpSheet}". Vendor Assignments found it only because it is the `
                + `first tab — it does not look for "${vpSheet}" by name. Reordering the tabs in this `
                + `workbook would change what it imports.` }
        : null;
    }
    return {
      level: "warn",
      text: `Takeoff Flow reads "${tfSheet}" and Vendor Assignments reads "${vpSheet}" from this same `
          + `workbook, so the two will not agree about which communities and dates exist.`
    };
  }

  return {
    setXLSX,
    lc, digits, S, fixRange, vpDate, tfDate, cleanCommName,
    DIVISIONS, divisionByKey,
    VP_STARTS_SHEETS, TF_STARTS_SHEETS, TF_STARTS_FALLBACKS, FLOW_SHEET,
    findSheet, sheetsNeeded, sniff, pickStartsSheetVP,
    re2Rows, bucketRE2, parseStartsVP, buildVendorPayload, diffPayload,
    parseStartsTF, planFlowImport, flowChangeEntry, normPlan, combo,
    REQUIREMENTS, missingFor, planTargets,
    SHRINK_REFUSE, SHRINK_WARN, guardVendorPayload, sheetDisagreement
  };
});
