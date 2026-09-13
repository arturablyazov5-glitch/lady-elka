# Деплой бэкенда на Supabase (переезд с YandexCloud)

Проект: **mgnotvaahftrbifqtahf** (`https://mgnotvaahftrbifqtahf.supabase.co`)
Функция: `supabase/functions/pay/index.ts` — платежи PayKeeper + вебхук → Telegram.

## Что уже готово (в коде)
- [x] Порт логики YC → Deno Edge Function (`functions/pay/index.ts`).
- [x] `config.toml`: `verify_jwt=false` для `pay`.
- [x] Фронт: `window.PAYMENT_ENDPOINT` → `.../functions/v1/pay` (src/catalog/index.js), `dist/catalog.js` пересобран.

## Статус: ЗАДЕПЛОЕНО (2026-07-21)
- [x] Проект залинкован (access-токен владельца), функция `pay` задеплоена.
- [x] Проверено: OPTIONS→204, `?debug=1`→404 (утечка секрета закрыта), POST без секретов→чистый 500.
- [x] Пофикшены 2 бага: 204-с-телом (ломал preflight) и debug-эндпоинт с утечкой HOOK_SECRET.

## Осталось — ТОЛЬКО секреты (у меня их нет)
Значения из старой YC-функции: `PK_HOST`, `PK_USER`, `PK_PASS`, `HOOK_SECRET`,
`TG_BOT_TOKEN`, `TG_CHAT_IDS`, `CORS_ORIGIN`. Без них платёж/Telegram не работают.
Задать командой `supabase secrets set ...` (см. ниже), затем повторный деплой не нужен —
секреты подхватываются на лету.

## Шаги деплоя (когда будет токен + секреты)

```bash
cd "путь/к/Lady Elka"

# 1. Авторизация под нужным аккаунтом (любой из вариантов):
supabase login                       # откроет браузер
#   ИЛИ:
export SUPABASE_ACCESS_TOKEN=sbp_...

# 2. Линк проекта (пароль БД: см. у владельца):
supabase link --project-ref mgnotvaahftrbifqtahf

# 3. Секреты (перенести значения из старой YC-функции):
supabase secrets set \
  PK_HOST=... PK_USER=... PK_PASS=... \
  HOOK_SECRET=... \
  TG_BOT_TOKEN=... TG_CHAT_IDS=... \
  CORS_ORIGIN=https://lady-elka.ru

# 4. Деплой функции (без JWT — вебхук PayKeeper без Supabase-токена):
supabase functions deploy pay --no-verify-jwt

# 5. Проверить логи в реальном времени:
supabase functions logs pay
```

## Тесты после деплоя

```bash
# CORS preflight → ждём 204
curl -i -X OPTIONS https://mgnotvaahftrbifqtahf.supabase.co/functions/v1/pay

# Создание счёта (pay intent) → ждём JSON с {"url": ".../bill/..."}
curl -sS -X POST https://mgnotvaahftrbifqtahf.supabase.co/functions/v1/pay \
  -H 'Content-Type: application/json' \
  -d '{"amount":100,"description":"Тест оплаты","email":"test@test.ru"}'
```

Если вернулся `url` от PayKeeper — платёжка работает.

## Дальше (руками)
- В личном кабинете **PayKeeper** заменить URL вебхука на
  `https://mgnotvaahftrbifqtahf.supabase.co/functions/v1/pay` (секрет — в query `?secret=<HOOK_SECRET>`, как было в YC).
- В **Taptop** обновить код каталога из `dist/catalog.js`.

## На будущее (не блокер)
Дедуп уведомлений сейчас in-memory (живёт в одном инстансе). Раз есть Postgres — можно
завести таблицу `payments` для надёжной дедупликации. Отдельная задача.
