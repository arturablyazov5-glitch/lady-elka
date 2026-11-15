# Lady Elka weekly Timeweb report

Runs on GitHub each Monday at 07:00 UTC (10:00 Moscow; Actions scheduling may be delayed), independently of the Mac. Only existing `TIMEWEB_API_TOKEN`, `TG_BOT_TOKEN`, `LE_SYNC_TG_CHAT_ID` secrets are used. No site deployment, new credential or write permission required.

Initialize once using workflow_dispatch with bootstrap=true. The bot confirms setup in the configured private chat and stores the first snapshot. Each Monday report shows the current Timeweb account balance in RUB and the snapshot date and time (Moscow time), not weekly expenses. Manual calls within the same UTC Monday week do not resend; run attempts >1 are refused. Rerunning is not recovery for ambiguous Telegram delivery: inspect delivery and encrypted state before any explicit repair.

Timeweb's public finances API exposes account balance and cumulative payments, not a per-app transaction ledger. The existing debit calculation and snapshot storage are unchanged; debit is not shown in the Telegram report. The existing inventory safeguard requires exactly app_frontend 266305, with a complete meta.total. A changed inventory blocks automatic reporting pending manual review; a bootstrap never overwrites existing state. The balance displayed is for the Timeweb account, not a charge attributed to Lady Elka.

Baseline financial data never enters Git history, plaintext logs or plaintext artifacts. `state.enc` uses AES-256-GCM with a random 96-bit nonce, authenticated fixed context and a 256-bit HKDF-derived key from the existing Timeweb API token. Only the encrypted blob is uploaded (90 days). State restoration verifies main branch and workflow path. Token rotation or artifact loss requires manual recovery; no silent baseline reset. Before sending, persist pending state; after confirmed private delivery, advance baseline. An ambiguous response is never retried automatically. As with all bot APIs, a platform failure between successful send and artifact upload may require manual reconciliation.

Public API reference: https://timeweb.cloud/api-docs-data/bundle.json
