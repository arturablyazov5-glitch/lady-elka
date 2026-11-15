# Portable candidate preview — 03.10.2026

Candidate artifact can now be relocated without project CSV/media inputs. Only build/server, candidate server tests/standalone browser runner and the new portability test/report were edited. No publication, push, production access or backend changes. Candidate remains explicit, ownerAccepted=false, productionReady=false; prices remain unconfirmed. Standard server without --root retains its previous feed behavior.

## Manifest and validation

`snapshot.feeds` retains raw input hashes/counts as provenance. New `bundled.feeds` records exact transformed CSV path, SHA-256, byte length and row count (trees 248 / decor 9 / promos 10). `bundled.assets` inventories emitted image/font/video files, with path, bytes and SHA-256; aggregate inventory hash/count/bytes are recorded separately. Verified build: 484 files, 401587963 bytes (includes 142 pinned catalog assets plus existing storefront media).

Explicit root server validates only contained artifact files, with no reads of project catalog-import/catalog-media and no network fallback. Startup verifies manifest constraints, inventory aggregate, each inventory file, CSV counts/bytes/checksums and photo inventory coverage. Requests repeat manifest integrity, CSV checksum and inventoried static asset checksum checks. Missing/corrupt manifest and files, invalid metadata, and escaping symlinks fail before listen; mutations after listen return explicit error status (manifest/feed 503; corrupted static asset 500). Default behavior remains separate.

Checksums provide artifact consistency, not a publisher signature: an intentionally rewritten manifest plus correspondingly rewritten files is not authenticated by this local review runner.

## Exact commands

Run from repository root, with a new nonexistent output outside repository:

```sh
node storefront/build.mjs --mode=preview \
  --input-manifest=storefront/catalog-import/candidates/2026-10-03-public-feed/manifest.json \
  --media-manifest=storefront/catalog-media/2026-10-03-public-feed/manifest.json \
  --output=/tmp/le-portable-NEW
STOREFRONT_PORT=4175 node storefront/server.mjs --mode=preview --root=/tmp/le-portable-NEW
node storefront/tests/candidate-preview-server-browser.mjs /tmp/le-portable-NEW
node --test storefront/tests/candidate-preview-server.test.mjs storefront/tests/artifact-portability.test.mjs
npm run test:storefront
```

Browser runner is now standalone `candidate-preview-server-browser.mjs`; the previous `.test.mjs` command in the earlier report is superseded. Both integration test files generate isolated fixtures automatically; no CANDIDATE_PREVIEW_ROOT preparation or skips.

## Evidence

Full storefront suite: 89 passed, zero failed/skipped. Targeted candidate/portability tests: 3 passed. Logs: `/tmp/le-portability-suite-final.log`, `/tmp/le-portability-targeted.log`.

Portability test builds into TEMP, copies only artifact to a new directory, deletes original build, then starts ordinary server --root with a preload that throws on source input filesystem access and network requests. Checks HTTP product/feed/image responses and missing/tampered image/manifest and image symlink escape. Existing candidate tests cover missing/corrupt CSV and feed symlink escape before/after startup, standard preview comparison, CSP/HEAD/redirect/write-method boundaries.

Browser tested artifact `/tmp/le-portable-1003-a`, then copied only artifact into a fresh TEMP directory with a source-input filesystem denial preload inherited by ordinary server. Chrome uses isolated profile and fail-closed external proxy/DNS plus CDP interception. Miranda 18 variants and Darina 6: every variant main/secondary gallery order, gallery open/close, image decoding and direct-page reload/F5 passed. External requests 0, runtime errors 0, write requests 0. Relocated browser log: `/tmp/le-portability-relocated-browser.log`; relocated artifact path is stored in `/tmp/le-relocated-artifact-path`.

Earlier artifacts without bundled proofs must be rebuilt; no provenance-based fallback is supported.
