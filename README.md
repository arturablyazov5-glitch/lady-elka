# Lady Elka

Интернет-магазин новогодних ёлок, декора и туй ([lady-elka.ru](https://lady-elka.ru)).

## Где что лежит (архитектура)

| Часть | Технология | Файлы |
|---|---|---|
| **Сайт** | конструктор **Taptop** | разметка блоков → `taptop/Кода блоков.html` |
| **Каталог / корзина / оплата** (фронт) | JS + CSS, грузятся на Taptop как файлы | исходники в `src/`, сборка в `dist/` |
| **Бэкенд** (платежи + уведомления) | **Yandex Cloud Function** (Node 22) | `backend/index.js` |
| **Товары и цены** | **Google Sheets** (2 листа: Ёлки, Декор) | ссылки в `src/catalog/config.js` |
| **Оплата** | PayKeeper | секреты — только в консоли YC |
| **Уведомления менеджеров** | Telegram Bot | секреты — только в консоли YC |

## Структура репозитория

```
src/
  catalog/          # модули каталога (раньше — один catalog.js на 3600 строк)
    index.js        # точка входа: импортирует и запускает всё
    config.js       # URL Google Sheets, PAYMENT_ENDPOINT, селекторы, категории
    utils.js        # мелкие хелперы ($$, num, rub, norm, parseCSV …)
  styles/
    catalog.css     # стили каталога
backend/
  index.js          # код Yandex Cloud Function (webhook + создание платежей)
taptop/
  Кода блоков.html  # справочник HTML-разметки блоков из Taptop
dist/               # СБОРКА (не в git) — то, что грузишь на Taptop
  catalog.js
  catalog.css
build.mjs           # сборщик (esbuild)
```

> Реальные значения env-переменных лежат локально в `Переменные окружения.ini`
> (этот файл в `.gitignore`, в репо не попадает) и в консоли Yandex Cloud.

## Как собрать и обновить сайт

```bash
npm install        # один раз
npm run build      # собирает dist/catalog.js + dist/catalog.css
# затем загрузи dist/catalog.js и dist/catalog.css на Taptop (как и раньше)
```

`npm run watch` — пересобирать автоматически при каждом сохранении файла в `src/`.

> Важно: на Taptop по-прежнему грузятся **два** файла — `catalog.js` и `catalog.css`.
> Редактируешь ты модули в `src/`, а на Taptop уходит собранный `dist/`.

## Товары (Google Sheets)

- **Ёлки** (gid=0): `id, title, category, height_cm, price, diameter_cm, branches, offer, discount_pct, photos, active, description`. Строка скипается без `category/height/price` или при `active=нет`.
- **Декор** (gid=500105078): варианты размера группируются по одному `id`.
- **Туи**: добавляются в лист **Ёлок** с `category=Туя`. Скрипт сам прячет дропдаун категории, если она одна.

## Бэкенд (Yandex Cloud)

Один файл `backend/index.js`. Переменные окружения задаются в консоли Yandex Cloud
(`TG_BOT_TOKEN`, `PK_HOST`, `TG_CHAT_IDS`, `PK_PASS`, `HOOK_SECRET`, `CORS_ORIGIN`, `PK_USER`).
Точка входа: `index.handler`, runtime Node.js 22.
