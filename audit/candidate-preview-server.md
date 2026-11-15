# Candidate preview via ordinary local server — 03.10.2026

Only `storefront/server.mjs` and new `candidate-preview-server*.test.mjs` changed, plus this report. Candidate stays explicit; default remains the existing dist + Oct1 feed. Prices are unconfirmed; `productionReady=false`. No shared dist writes, remote services, payments, commits, push or deployment.

## Reproduce

Run from repository root. Choose a new nonexistent output outside the repository (parent must exist):

```sh
node storefront/build.mjs --mode=preview \
  --input-manifest=storefront/catalog-import/candidates/2026-10-03-public-feed/manifest.json \
  --media-manifest=storefront/catalog-media/2026-10-03-public-feed/manifest.json \
  --output=/tmp/le-candidate-server-review-NEW
STOREFRONT_PORT=4175 node storefront/server.mjs --mode=preview \
  --root=/tmp/le-candidate-server-review-NEW
```

Open http://localhost:4175/tree/darina or http://localhost:4175/tree/miranda, including direct navigation and reload. `--root DIRECTORY` also works. Duplicate/missing root flags and combining root with `--artifact` fail. Without root, standard launch remains `node storefront/server.mjs --mode=preview`; existing `--artifact=production` still permits local safe preview of that artifact.

## Validation and constraints

Explicit root requires contained regular `build-manifest.json`, preview mode, offlineBuild=true, productionReady=false, unaccepted candidate, local catalog endpoints and payment=null. Snapshot id can contain only letters, digits and hyphens. Bundled feed paths are exactly `__offline/catalog/{trees,decor,promos}.csv`; no upstream or Oct1 fallback exists for explicit root.

Current build manifest stores **raw source CSV** checksums, not checksums of mapped CSV. Without changing build or input manifests, server verifies the local pinned candidate/media manifests selected by snapshot id, checks media checksum against build manifest and candidate provenance, checks raw CSV checksum/count, deterministically reconstructs mapped CSV serialization, and compares it to artifact bytes. Thus this runner requires the pinned inputs in this project; the artifact alone is not portable. Source inputs are validation evidence only; HTTP feed responses always read bundled artifact CSV. Each feed request repeats containment and checksum checking, with 503 on later deletion/tampering and no fallback. Startup failures are explicit and occur before listening.

Static files and manifests use lexical and realpath containment. Traversal and network-path requests are rejected; symlinks escaping root cannot expose neighboring files. Only GET/HEAD allowed (405 otherwise), payment config always null, local CSP and local redirects preserved, bind 127.0.0.1, no-store cache. This is a local review runner, not a publication server.

## Verification

Fresh isolated build verified at `/tmp/le-candidate-server-review-1003`:

```sh
CANDIDATE_PREVIEW_ROOT=/tmp/le-candidate-server-review-1003 \
  node --test storefront/tests/candidate-preview-server.test.mjs
node storefront/tests/candidate-preview-server-browser.test.mjs \
  /tmp/le-candidate-server-review-1003
```

2/2 integration tests passed, none skipped: default/candidate feed and Darina prices differ; exact artifact CSV response; GET/HEAD and empty HEAD bodies; 405 write methods; direct product URLs; local redirect/CSP/config; pinned image; invalid root/manifest; CSV corruption/deletion before startup and while running; feed/static symlink escapes. Fixtures copied to temporary directories and cleaned.

Browser runner launches the actual `storefront/server.mjs` child (no static harness), isolated Chrome profile, external proxy/DNS fail-closed and CDP external-request rejection. Darina 6 variants (first 22,000 rubles), Miranda 18 including lighting choices: each variant's main image and secondary gallery order checked, gallery opening/closing and image decoding checked, direct pages and Page.reload checked. Zero external requests, runtime exceptions or write requests; no checkout submitted. Original catalog-media browser harness unchanged.
