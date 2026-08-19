# Blueprint

Internal hub for a small suite of preconstruction and purchasing web apps.

Blueprint is the front door to those tools. It shows what exists, who maintains each
one, and — for administrators — provides a single place to manage who has access to
what.

## What it does

- **Apps** — a launcher tile for each tool, with its description and author.
- **Data Intake** — one place to drop the weekly workbooks, which then update every
  tool that needs them.
- **Users** — administrators manage each person's access per app, including division
  scope, and issue sign-in links for new users.
- **Health** — a read-only status view across the tools, open to everyone.

## Data Intake

Several tools are built from the same spreadsheets. A division's starts log feeds both
Vendor Assignments and Takeoff Flow; the RE2 export from E1 feeds Vendor Assignments for
both divisions at once and the Community Map besides. Uploading each file separately in
each tool is how those tools ended up disagreeing about which communities exist.

Drop the workbooks here as they arrive and each one is recognised on its own — there is
no "which file is this" step. Every destination then shows what it would change, and
publishes only when everything it needs is present:

| Destination | Needs |
|---|---|
| Vendor Assignments, per division | the RE2 export **and** that division's starts log |
| Takeoff Flow, per division | that division's starts log |
| Community Map | not published from here yet — the card shows the commands to run |

Because the two starts logs arrive from two permitting managers on different days, a
partial drop is the normal case, not a mistake. A destination missing an input says what
it is waiting for; it never errors and never publishes half an update.

Nothing is written until you press a Publish button, and each destination publishes
independently — one failing does not roll back another, because no transaction spans
three applications and pretending otherwise would misreport what happened.

What each destination writes is exactly what it writes when you upload to it directly,
including its history: Vendor Assignments keeps the replaced version for rollback and
records the diff, and Takeoff Flow writes the entry its "What's New" panel renders.

Publishing rights come from each tool's own role table, not from being a Blueprint
administrator. A destination you cannot publish to is shown read-only with the reason.

Parsing runs in a worker thread. The RE2 export is around 7 MB and 144,000 rows, which
takes roughly fifteen seconds of unbreakable work — on the main thread that is a frozen
tab, so it happens off it with a progress bar per file.

## Access

Sign-in is restricted to a single configured email domain. Everyone can use the
launcher and see the status view; managing other people's access is restricted to
administrators. The status view shows each reader only the figures they have
visibility for, rather than showing a zero where data is hidden from them.

If you need access to a tool, or your access looks wrong, contact an administrator.

## Built with

A static site — plain HTML, CSS and JavaScript, no build step and no framework — hosted
on GitHub Pages and backed by Supabase for sign-in and data. It runs alongside sibling
apps and shares their design language and their sign-in, so one password works across
all of them.

## Repository notes

- This repository contains production files only. The local development server,
  fixture backend and test suites are maintained separately and are not part of a
  deployment.
- Operational documentation is maintained internally rather than here.

---

Internal tool. Not intended for public use.
