# Постоянный снимок исходников админки с блогом — 04.10.2026

Сохранён `release-candidates/admin-blog/` в основном workspace, без staging/commit/push/publication. Источник — независимо проверенный `/private/tmp/lady-elka-blog-only-20261004-02/candidate`, исходная опубликованная версия `40486e1edfeaf1b2faeb415e53f5f610e0f0c4c9`. Frozen TEMP artifact не изменён и не удалён.

## Состав и происхождение

- `source/app/public/` — все 32 проверенных публичных файла; `source/.github/workflows/pages.yml` — неизменный workflow исходной версии.
- `manifest.json` и `baseline-to-blog-only.patch` — побайтные копии проверенных материалов; patch SHA-256 `10193fdd24a02423bc5602174fdfec413e89532b29589fe9c686fce03a56d1e3`.
- `independent-review-result.json`, `browser-report.json` — сохранённые результаты независимой проверки и ранее выполненного браузерного теста. Это перенос evidence, не новые browser/live проверки.
- `provenance.json` — исходный SHA, путь источника, hashes manifest/patch/review и четырёх audit/assembler references; `verify.py` — повторяемая проверка постоянной копии без сети и без изменения Git refs/worktree.

До копирования `git check-ignore -v` не обнаружил ignore rule для каталога; после копирования проверены public index, manifest и вложенный workflow — не игнорируются (exit 1, без вывода). `.gitignore` не изменялся. В source сохранены только публичные файлы и baseline workflow: env/secrets/server/content stores отсутствуют; verifier проверяет точный состав и отсутствие symlink. Подробные hashes находятся в manifest и provenance, не только в TEMP.

## Фактическая проверка

```sh
python3 release-candidates/admin-blog/verify.py
```

**PASS**: все 32 размера/hash совпадают с manifest и независимо проверенным `result.json`; 28 исходных файлов подтверждены локальными `git show`/`ls-tree` exact SHA. Ровно шесть отличий: index.html, js/app.js, css/blog.css, js/blog.js, js/blog-model.js, js/blog-rich-editor.js. Остальные 26 совпадают побайтно, включая payment CSS/JS, profile JS и платёжные SVG. Generic payment-success CSS исходной версии сохранён; новые payment-success-page/pro-ticket DOM не внесены. Обратное удаление blog navigation из app.js даёт exact original bytes. Patch check/apply в собственной внешней TEMP-копии исходных public blobs прошёл; полученное дерево совпало со snapshot, TEMP очищен. Patch к основному repo не применялся.

Байты не менялись относительно независимой проверки, поэтому браузер/full suite не повторялись; предыдущий browser report — PASS с synthetic API. Реальные sessions/catalog/pay и production не использовались.

## Будущий отдельный Git снимок — команды НЕ выполнялись

Сохранённый `release-candidates/.../source` сам по себе **не попадёт в Pages**: существующий workflow копирует только корневой app/public из выбранного checkout. Подготовка отдельной обратимой source-копии и patch уже поручена пользователем и не требует дополнительного разрешения. Постоянный снимок уже сохранён и проверен; новый worktree ради копирования не нужен. Для release понадобится отдельный Git commit этих байтов, который сейчас не разрешён. Не копировать их в текущий mixed dirty app/public.

Ниже пример будущей подготовки изолированного Git checkout, если он понадобится для release; это не блокирующий запрос разрешения на обратимую подготовку. Сейчас команды не запускать: snapshot уже готов. Из основного корня (выбрать ещё не существующий путь и имя ветки):

```sh
ADMIN_SNAPSHOT='/Users/rafael/Documents/Работа/Проекты/Lady Elka/release-candidates/admin-blog'
ADMIN_CHECKOUT='/private/tmp/lady-elka-admin-blog-git-snapshot-01'
python3 "$ADMIN_SNAPSHOT/verify.py"
git worktree add -b codex/admin-blog-release "$ADMIN_CHECKOUT" 40486e1edfeaf1b2faeb415e53f5f610e0f0c4c9
cp -R "$ADMIN_SNAPSHOT/source/app/public/." "$ADMIN_CHECKOUT/app/public/"
cmp "$ADMIN_SNAPSHOT/source/.github/workflows/pages.yml" "$ADMIN_CHECKOUT/.github/workflows/pages.yml"
git -C "$ADMIN_CHECKOUT" diff --stat
git -C "$ADMIN_CHECKOUT" status --short
git -C "$ADMIN_CHECKOUT" add -- app/public/index.html app/public/js/app.js app/public/css/blog.css app/public/js/blog.js app/public/js/blog-model.js app/public/js/blog-rich-editor.js
git -C "$ADMIN_CHECKOUT" diff --cached --name-only
git -C "$ADMIN_CHECKOUT" diff --cached --check
```

Ожидаемый staged набор — строго шесть перечисленных файлов; workflow/payment/server не staged. Для проверки **всего** подготовленного дерева перед commit:

```sh
python3 - "$ADMIN_SNAPSHOT" "$ADMIN_CHECKOUT" <<'PY'
from pathlib import Path
import hashlib,json,sys
snapshot,checkout=map(Path,sys.argv[1:])
manifest=json.loads((snapshot/'manifest.json').read_text())
actual={p.relative_to(checkout/'app/public').as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in (checkout/'app/public').rglob('*') if p.is_file()}
assert actual=={f['path']:f['sha256'] for f in manifest['files']}
assert (checkout/'.github/workflows/pages.yml').read_bytes()==(snapshot/'source/.github/workflows/pages.yml').read_bytes()
print('Prepared checkout equals reviewed snapshot')
PY
```

**Граница отдельного разрешения — следующая команда commit. Не выполнять без явного разрешения пользователя:**

```sh
git -C "$ADMIN_CHECKOUT" commit -m 'Add blog editor while preserving published admin payment'
git -C "$ADMIN_CHECKOUT" rev-parse HEAD
```

Команды приведены как инструкция на будущее. Обратимая подготовка source-копии и patch уже разрешена и завершена. Если потребуется архивный Git-снимок, выборочный staging ограничить `release-candidates/admin-blog` и этой заметкой; отдельное разрешение требуется перед commit, а не перед подготовкой. Такой архивный commit не является frontend release. В этой задаче ни одна команда git add/commit/branch/worktree/push не выполнялась.

Перед публикацией обновить read-only evidence актуального Pages deployment/main: исходная версия подтверждалась 03.10.2026, с тех пор могла измениться. Если main ушла вперёд, не force push и не переносить snapshot поверх новых изменений вслепую — нужен новый reviewed candidate. После review immutable commit предъявить его SHA/diff/manifest пользователю и получить **отдельное явное разрешение на push и замену Pages**. Push в main запускает pages.yml; он выложит все app/public из release checkout, включая сохранённую исходную оплату. Серверные catalog/pay, le_blog_posts и Edge/SQL в этот workflow не входят. Live CRUD и реальная оплата остаются непроверенными.
