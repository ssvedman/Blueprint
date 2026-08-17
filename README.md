# Blueprint

Internal hub for a small suite of preconstruction and purchasing web apps.

Blueprint is the front door to those tools. It shows what exists, who maintains each
one, and — for administrators — provides a single place to manage who has access to
what.

## What it does

- **Apps** — a launcher tile for each tool, with its description and author.
- **Users** — administrators manage each person's access per app, including division
  scope, and issue sign-in links for new users.
- **Health** — a read-only status view across the tools.

## Access

Sign-in is restricted to a single configured email domain. Administrative sections are
visible only to administrators; everyone else sees the launcher.

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
