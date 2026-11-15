# Lady Elka

Интернет-магазин новогодних ёлок, декора и туй ([lady-elka.ru](https://lady-elka.ru)).

## Где что лежит (архитектура)

| Часть | Технология | Файлы |
|---|---|---|
| **Сайт** | конструктор **Taptop** | разметка блоков → `taptop/Кода блоков.html` |
| **Каталог / корзина / оплата** (фронт) | JS + CSS, грузятся на Taptop как файлы | исходники в `src/`, сборка в `dist/` |
| **Бэкенд** (платежи + уведомления) | **Supabase Edge Function** (Deno) | `supabase/functions/pay/index.ts` (деплой: `supabase/DEPLOY.md`) |
| **Товары и цены** | CSV-фиды в Supabase Storage (Ёлки+туи, Декор, Промокоды), ведутся через кабинет `app/` | ссылки в `src/catalog/config.js` |
| **Оплата** | PayKeeper | секреты — только в `supabase secrets` |
| **Уведомления менеджеров** | Telegram Bot | секреты — только в `supabase secrets` |

## Структура репозитория

```
src/
  catalog/          # модули каталога (раньше — один catalog.js на 3600 строк)
    index.js        # точка входа: импортирует и запускает всё
    config.js       # URL CSV-фидов, PAYMENT_ENDPOINT, селекторы, категории
    utils.js        # мелкие хелперы ($$, num, rub, norm, parseCSV …)
  styles/
    catalog.css     # стили каталога
taptop/
  Кода блоков.html  # справочник HTML-разметки блоков из Taptop
dist/               # СБОРКА (не в git) — то, что грузишь на Taptop
  catalog.js
  catalog.css
build.mjs           # сборщик (esbuild)
```

> Реальные значения env-переменных лежат локально в `Переменные окружения.ini`
> (этот файл в `.gitignore`, в репо не попадает) и в `supabase secrets`.

## Как собрать и обновить сайт

```bash
npm install        # один раз
npm run build      # собирает dist/catalog.js + dist/catalog.css
# затем загрузи dist/catalog.js и dist/catalog.css на Taptop (как и раньше)
```

`npm run watch` — пересобирать автоматически при каждом сохранении файла в `src/`.

> Важно: на Taptop по-прежнему грузятся **два** файла — `catalog.js` и `catalog.css`.
> Редактируешь ты модули в `src/`, а на Taptop уходит собранный `dist/`.

## Товары (CSV-фиды)

- **Ёлки и туи** (`trees.csv`): `id, title, category, height_cm, price, diameter_cm, branches, offer, discount_pct, photos, active, description`. Строка скипается без `category/height/price` или при `active=нет`.
- **Декор** (`decor.csv`): варианты размера группируются по одному `id`.
- **Туи**: добавляются в фид **ёлок** с `category=Туя`. Скрипт сам прячет дропдаун категории, если она одна.

## Бэкенд (Supabase)

Функция `supabase/functions/pay/index.ts`: создание счёта PayKeeper и webhook → Telegram.
Секреты: `PK_HOST, PK_USER, PK_PASS, HOOK_SECRET, TG_BOT_TOKEN, TG_CHAT_IDS, CORS_ORIGIN` (`supabase secrets set`).
Деплой: `supabase functions deploy pay --no-verify-jwt`.

## Сервис управления каталогом

Кабинет управления каталогом: `npm run start:app` → http://localhost:4180/app.
Данные и фотографии хранятся в Supabase. Подробности, CSV-ссылки и подготовка домена — [app/README.md](app/README.md).
Сайт читает CSV-фиды из Supabase Storage (см. `src/catalog/config.js`).
