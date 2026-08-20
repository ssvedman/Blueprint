/* ============================================================================
   Blueprint — ingest-worker.js
   Reads and parses dropped workbooks off the main thread.

   ── WHY A WORKER ─────────────────────────────────────────────────────────────
   The RE2 export is 7.4 MB and 144,453 rows. SheetJS takes about 15 seconds to
   read it and another 2.6 to convert it, and neither can be broken into chunks.
   On the main thread that is fifteen seconds of frozen tab with no cursor, no
   scrolling and no progress — long enough that Chrome offers to kill the page.

   Everything here is I/O and CPU with no DOM access, so it moves wholesale. The
   main thread keeps a progress bar and stays interactive, and a stuck parse can
   be abandoned by terminating the worker rather than reloading the page.

   ── WHY THE WORKBOOKS ARE READ SHEET BY SHEET ────────────────────────────────
   XLSX.read parses every sheet unless told otherwise. The Tampa log carries a
   month tab with 1,047,079 phantom rows, and reading it costs 12 seconds for a
   result nothing looks at. Reading the names first (bookSheets, ~0.7 s) and then
   re-reading only the needed sheets takes that file from 13.2 s to 1.1 s, with
   byte-identical output.

   This file is loaded as a classic worker via a blob URL, because the site is
   static with no build step and no module bundler. It pulls SheetJS and
   ingest-core.js in through importScripts with absolute URLs handed to it by the
   page — a blob worker has no meaningful base URL of its own, so relative paths
   would resolve against the blob and 404.
   ========================================================================== */
/* eslint-env worker */
"use strict";

let BOOTED = false;

function boot(urls) {
  if (BOOTED) return;
  // Order matters: ingest-core resolves SheetJS from the global at first use.
  // map-core touches no spreadsheet library at all — it takes rows — so it has no
  // ordering requirement, but it is loaded here so the map's parses can run
  // alongside the others off the main thread.
  self.importScripts(urls.xlsx, urls.ingestCore, urls.mapCore);
  self.BPI.setXLSX(self.XLSX);
  BOOTED = true;
}

const post = (type, payload) => self.postMessage(Object.assign({ type }, payload));
const progress = (id, stage, pct) => post("progress", { id, stage, pct });

/* Read only what is needed. Two passes over the same bytes is still far cheaper
   than parsing sheets nobody reads. */
function readScoped(buffer, kind, division) {
  const X = self.XLSX;

  // Pass 1: names only.
  const names = X.read(buffer, { type: "array", bookSheets: true }).SheetNames || [];

  // Pass 2: just the sheets this kind of file needs.
  const wanted = self.BPI.sheetsNeeded(kind, names, division).filter(Boolean);

  // cellFormula/cellNF/cellText off: intake reads values, never formulas or
  // display strings, and switching them off takes the RE2 read from 18.5 s to
  // 15 s. cellDates stays OFF deliberately — both apps' date converters take
  // their numeric branch on serials, which is timezone-free, and both were
  // verified to produce identical output either way.
  const opts = {
    type: "array", cellFormula: false, cellNF: false, cellText: false,
    sheets: wanted.length ? wanted : undefined
  };
  const wb = X.read(buffer, opts);
  return { wb, allSheetNames: names, loadedSheets: wanted };
}

/* Header row of the first sheet, for sniffing. Read with a tiny row cap so an
   enormous sheet costs nothing to identify. */
function headerRow(buffer) {
  const X = self.XLSX;
  try {
    const wb = X.read(buffer, { type: "array", sheetRows: 4, cellFormula: false, cellNF: false });
    const first = wb.SheetNames[0];
    if (!first) return { names: [], headers: [] };
    const ws = self.BPI.fixRange(wb.Sheets[first]);
    const rows = X.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false });

    // Power BI puts an applied-filters block above the table, so the header is
    // not row 1. Prefer the first row that looks like a header — several
    // non-empty string cells — and fall back to row 1 so a normal file is
    // unaffected.
    const looksLikeHeader = r => Array.isArray(r) &&
      r.filter(c => typeof c === "string" && c.trim()).length >= 3;
    const hdr = rows.find(looksLikeHeader) || rows[0] || [];
    return { names: wb.SheetNames, headers: hdr, firstRow: rows[0] || [] };
  } catch (_) {
    return { names: [], headers: [] };
  }
}

self.onmessage = function (e) {
  const msg = e.data || {};

  try {
    if (msg.type === "boot") { boot(msg.urls); post("booted", {}); return; }

    boot(msg.urls);

    /* ---- identify: cheap pass so the UI can label the file immediately ---- */
    if (msg.type === "identify") {
      const { id, buffer, fileName } = msg;
      const { names, headers, firstRow } = headerRow(buffer);
      // sniff() looks at the first cell for the Power BI filter block, so pass
      // row 1 when the detected header row is further down.
      const probe = (firstRow && firstRow.length && firstRow[0] != null &&
                     String(firstRow[0]).trim() && headers !== firstRow)
        ? [firstRow[0]].concat(headers)
        : headers;
      const guess = self.BPI.sniff(names, probe, fileName);
      post("identified", { id, fileName, sheetNames: names, headers: (headers || []).map(String), guess });
      return;
    }

    /* ---- parse: the expensive pass, one message per file ------------------ */
    if (msg.type === "parse") {
      const { id, buffer, kind, division, fileName } = msg;
      progress(id, "reading", 5);
      const { wb, allSheetNames, loadedSheets } = readScoped(buffer, kind, division);
      progress(id, "parsing", 40);

      const out = { id, fileName, kind, division, allSheetNames, loadedSheets };

      if (kind === "re2") {
        const rows = self.BPI.re2Rows(wb);
        progress(id, "grouping", 60);
        const bucket = self.BPI.bucketRE2(rows);
        // The buckets travel back to the page because the vendor payload for each
        // division is built there, against the current published payload. Rows are
        // plain objects, so structured clone handles them.
        out.re2 = { counts: bucket.counts, total: bucket.total, byCode: bucket.byCode };

        /* The map wants the same rows shaped differently — community → trade →
           vendor rather than vendor → communities. Done here rather than on the
           page because it is another pass over 144,000 rows, and because the rows
           are already in memory on this side. Orlando only: the map is
           single-division.

           divCounts is handed in so the wrong-file guard still works even though
           the rows have already been filtered to one division. */
        progress(id, "grouping", 80);
        const mapFind = { notes: [], problems: [] };
        const olh = bucket.byCode.OLH || [];
        const mapRe2 = self.MAPCORE.parseRE2(olh, "OLH", mapFind, bucket.counts);
        // Maps survive structured clone, so they cross intact.
        out.mapRe2 = { byCommunity: mapRe2.byCommunity, nameHint: mapRe2.nameHint,
                       notes: mapFind.notes, problems: mapFind.problems };

      } else if (kind === "starts") {
        out.vp = self.BPI.parseStartsVP(wb);
        progress(id, "parsing", 60);
        out.tf = self.BPI.parseStartsTF(wb, division);

        /* And a third reading of the same sheet, for the map. It differs from the
           other two in what it keeps: one record per lot with its community id,
           which the placeholder filter and the twelve-month aggregation then work
           over. Only Orlando is on the map, so Tampa's log is parsed for the other
           two destinations and skipped here.

           Aggregation is deliberately NOT done here: it needs dataStart, and the
           page owns that decision.

           The same pass also yields the STREETS, community by community, which is
           how a community that arrives with no coordinate gets placed. Every
           permit row carries an Address — a real one for an established
           community, "TBD Sunfish Drive" for a brand-new one — and the street is
           there either way. Collected here because it is the same walk over the
           same rows; thrown away here, and the page has no way to get it back
           without re-reading a 7 MB file. */
        if (division === "orlando") {
          progress(id, "parsing", 80);
          const X = self.XLSX;
          const sheet = self.BPI.pickStartsSheetVP(allSheetNames).sheet;
          const rows = X.utils.sheet_to_json(self.BPI.fixRange(wb.Sheets[sheet]), { defval: null });
          const mapFind = { notes: [], problems: [] };
          const parsed = self.MAPCORE.parseStarts(rows, sheet, mapFind);
          out.mapStarts = { records: parsed.records, idName: parsed.idName,
                            streets: parsed.streets,
                            sheet, notes: mapFind.notes, problems: mapFind.problems };
        }

      } else if (kind === "contacts") {
        // Parsed by the map path, which needs the raw rows rather than a shape of
        // its own; the header row is hunted there because it is below the filter
        // block.
        const X = self.XLSX;
        out.rows = X.utils.sheet_to_json(
          self.BPI.fixRange(wb.Sheets[wb.SheetNames[0]]), { header: 1, defval: null });
      } else if (kind === "flow") {
        out.flowRowsRaw = self.XLSX.utils.sheet_to_json(
          wb.Sheets[self.BPI.findSheet(allSheetNames, self.BPI.FLOW_SHEET)], { defval: null });
      }

      progress(id, "done", 100);
      post("parsed", out);
      return;
    }

    post("error", { id: msg.id, message: `Unknown worker message "${msg.type}"` });
  } catch (err) {
    // A failure on one file must not take the batch down: report it against that
    // file's id and let the page carry on with the others.
    post("error", {
      id: msg.id,
      fileName: msg.fileName,
      message: (err && err.message) || String(err)
    });
  }
};
