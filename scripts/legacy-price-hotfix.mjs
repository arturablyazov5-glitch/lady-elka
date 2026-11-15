import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const out = new URL('../release-candidates/legacy-price-hotfix/', import.meta.url);
await mkdir(out, {recursive:true});
const baseline = await readFile(process.argv[2] || '/tmp/le-incident-catalog.js', 'utf8');
const helper = (await readFile(new URL('../src/catalog/price-recovery.js', import.meta.url), 'utf8')).replaceAll('export ', '');
let patched = baseline;
const edits = [];
function replace(before, after) {
  if (patched.split(before).length !== 2) throw new Error('Expected one exact anchor: ' + before.slice(0,80));
  patched = patched.replace(before, after); edits.push({before,after});
}
replace('  async function loadDict(cache = "default") {', helper + '\n  document.addEventListener("click", guardPricePurchase, true);\n  async function loadDict(cache = "default") {');
replace('await fetch(SHEET_CSV_URL, { cache }).then((r) => r.text())', 'await fetchPriceCSV(SHEET_CSV_URL, cache)');
replace('await fetch(DECOR_SHEET_CSV_URL, { cache }).then((r) => r.text())', 'await fetchPriceCSV(DECOR_SHEET_CSV_URL, cache)');
replace('    markPricesLoading();\n    const neededFeeds', '    markPricesLoading();\n    cards.forEach(card => setPriceStatus(card, "loading"));\n    const neededFeeds');
replace('    if (!dict && !decorDict) {', '    cards.forEach(card => setPriceStatus(card, (isDecorCard(card) ? decorDict : dict) ? "loading" : "error"));\n    if (!dict && !decorDict) {');
replace('          console.warn("нет активных строк для декора", pid || titleNow);', '          setPriceStatus(card, "unavailable");\n          console.warn("нет активных строк для декора", pid || titleNow);');
replace('        initDecorCard(card, entry2, titleEl, titleNow);', '        setPriceStatus(card, "ready");\n        initDecorCard(card, entry2, titleEl, titleNow);');
replace('      console.log("Найдена запись для карточки:",', '      setPriceStatus(card, "ready");\n      console.log("Найдена запись для карточки:",');
replace('        console.warn("нет активных строк для карточки",', '        setPriceStatus(card, "unavailable");\n        console.warn("нет активных строк для карточки",');
replace('else if (trees.status === "rejected") console.error("таблица елок не загрузилась", trees.reason);', 'else if (trees.status === "rejected") { priceDict = null; console.error("таблица елок не загрузилась", trees.reason); }');
replace('else if (decor.status === "rejected") console.error("таблица декора не загрузилась", decor.reason);', 'else if (decor.status === "rejected") { priceDecorDict = null; console.error("таблица декора не загрузилась", decor.reason); }');
const hash = s => createHash('sha256').update(s).digest('hex');
await writeFile(new URL('baseline-catalog.js',out),baseline);
await writeFile(new URL('catalog.js',out),patched);
await writeFile(new URL('patch.json',out),JSON.stringify({baselineSHA256:hash(baseline),candidateSHA256:hash(patched),edits},null,2)+'\n');
console.log(JSON.stringify({baselineSHA256:hash(baseline),candidateSHA256:hash(patched),edits:edits.length}));
