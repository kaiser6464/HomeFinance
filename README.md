# Household Money

A private money dashboard for one household: spending by category and person, subscriptions, budgets.

- `web/` – the app (static, served by GitHub Pages). Contains only the public Supabase URL and publishable key; all data is protected by row-level security behind a login.
- `supabase/functions/sync` – Starling sync (runs 4× a day on a schedule, or from "Sync now").
- Other banks and cards are added by uploading CSV statements in the Accounts tab.
