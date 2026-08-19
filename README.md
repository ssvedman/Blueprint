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

Several tools are built from the same spreadsheets. A division's starts log feeds two of
them; the vendor export feeds three, across both divisions at once. Uploading each file
separately in each tool is how those tools ended up disagreeing about which communities
exist.

Drop the workbooks here as they arrive and each is recognised on its own. Every
destination shows what it would change, and becomes publishable only once everything it
needs is present — the source files arrive from different people on different days, so a
partial drop is the normal case rather than a mistake. **Publish all** does every ready
destination in one pass, after listing exactly what each will do.

Nothing is written until you press a button, and each destination writes exactly what it
writes when you upload to it directly, including its own change history. They are written
independently: one failing does not undo another, because no transaction spans separate
applications.

Parsing runs off the main thread — the largest export is around 7 MB and 144,000 rows,
which is long enough to freeze a tab.

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
