# Catalog candidate + pinned media preview — 03.10.2026

Implemented explicit local review only. Default `defaultManifest` remains `2026-10-01-derived-build`; no owner acceptance, default activation, remote access, deployment, commit or push. `productionReady=false`, `freshness=unknown`, `dataAsOf=null`. Darina candidate displays 22 000 ₽ for 150 cm and 46 000 ₽ for 230 cm; these CSV values remain **unconfirmed**. Active flags, promo terms and gallery order also require owner review. Archived route descriptions remain existing source descriptions; no invented text.

## Explicit build

From repository root, use a **new**, nonexistent directory outside the repository; its parent must already exist:

```sh
node storefront/build.mjs --mode=preview \
  --input-manifest=storefront/catalog-import/candidates/2026-10-03-public-feed/manifest.json \
  --media-manifest=storefront/catalog-media/2026-10-03-public-feed/manifest.json \
  --output=/tmp/lady-elka-candidate-review-NEW
```

Both manifests and isolated output are mandatory together. Production mode rejects candidate input before output modification. Existing candidate output is refused. Output paths and resolved parent cannot be inside repository. All candidate/media checks occur before output clearing/copy. Default builds retain existing behavior; explicit output also isolates the generated report.

CSV provenance is pinned to media manifest `candidateFiles` and review checksum, with CSV schema, full raw-row validation, feed checksum/count, regular-file and realpath containment. All **142 assets / 1166 references** are checked: asset bytes/checksum/MIME/provenance, exact raw feed/product/variant/active/index/URL/localPath order, including inactive rows. Duplicate URL mapping, missing mapping, mismatched order/provenance and path/symlink escapes fail clearly. Files are copied offline to `/media/catalog-pinned/<full-sha256>.<mime-extension>`, deduplicated by output URL; no fetching or rewriting source assets/CSV/manifests. Raw variant photo repetitions/order are preserved. Rows with an empty raw photo list retain that empty list; no mapping fallback is invented.

Output includes mapped offline CSV at `__offline/catalog/*.csv`, all raw tree/decor rows (248/9), promos (10), and extra `previewMedia` marker consumed by the model. Runtime product normalization preserves the marker and current variant gallery, avoiding captured route main/secondary image precedence for candidate variants. Default presentation and cards retain their prior route image behavior. Inactive variants remain in CSV/mapping audit, excluded from selectable offers; fully inactive products remain unavailable.

## Changes

- `storefront/products/build-feed.mjs`: explicit build input context, provenance/containment/coverage checks, raw rows mapped to pinned URLs.
- `storefront/products/build-assets.mjs`: unchanged; existing offline validator checks copied assets.
- `storefront/products/model.mjs`: carry preview presentation marker through shared normalization.
- `storefront/products/presentation.mjs`: exact variant main + gallery for marked preview data; default route presentation preserved.
- `storefront/build.mjs`: explicit input/media/output options, validation before output mutation, offline copy/CSV emission, manifest proof.
- Authorized additional touchpoints: `storefront/products/catalog-cards.mjs` selects candidate variant first photo; `storefront/generate-products.mjs` directs isolated reports into output and reports actual input snapshot ID.
- New tests: `storefront/tests/catalog-media-preview.test.mjs`, `storefront/tests/catalog-media-preview-browser.mjs`.

Blog modules, source catalog, payment/Supabase functions, app editor and existing public/media input files were not edited. Existing dirty work preserved.

## Evidence and runner boundary

11/11 targeted tests passed (`catalog-media-preview`, `product-rules`, `refactor`): actual 142/1166 coverage, 14 inactive rows, main/gallery order, default Oct1/Darina price, tampering/symlink rejection, isolated offline candidate/default builds with global fetch forbidden, production rejection before output clear, shared report byte equality. Both builds generated **42 product URLs and 57 search records**, preserving blog integration.

Chrome QA used existing local Chrome, fresh temporary profile, dead external proxy and DNS fail-closed; a read-only static HTTP harness served the isolated artifact with the same restrictive CSP as the existing preview server. No wildcard CSP. Results: Miranda **18** variants (including lighting combinations), Darina **6**, Vita **10**, decor basket **1**; each selection checked main image and exact secondary list. Kamila/Gracia both had zero selectable variants and unavailable state. Gallery open/close tested; displayed gallery images decoded successfully. **0 external requests, 0 JavaScript exceptions, 0 write requests**. No checkout submission or real provider side effects.

```sh
node --test storefront/tests/catalog-media-preview.test.mjs \
  storefront/tests/product-rules.test.mjs storefront/tests/refactor.test.mjs
node storefront/tests/catalog-media-preview-browser.mjs /tmp/le-candidate-preview-final-1003
```

The ordinary `storefront/server.mjs` still serves shared dist and the default Oct1 feed; it must **not** be used to claim candidate review. This change verifies candidate artifacts using its isolated test harness, not a changed production/preview server. Optional future manual runner integration must explicitly choose the isolated artifact and its bundled CSV. Verified artifact in this run: `/tmp/le-candidate-preview-final-1003` (temporary, not published; later source-id reporting change verified in regression builds).
