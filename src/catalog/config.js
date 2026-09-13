// Конфигурация каталога: источники данных и CSS-селекторы Taptop.

// Google Sheets (опубликованные CSV). Один spreadsheet, два листа:
export const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQBYDczXmGsnVqSrCuzjsMwz6-DZu3Q6pSjb66YUkgPxxt7UDecZLll9QZFHU0BHhKc3GMZ4xFoouXB/pub?gid=0&single=true&output=csv';           // Ёлки (+ туи)
export const DECOR_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQBYDczXmGsnVqSrCuzjsMwz6-DZu3Q6pSjb66YUkgPxxt7UDecZLll9QZFHU0BHhKc3GMZ4xFoouXB/pub?gid=500105078&single=true&output=csv'; // Декор

// Промокоды. Сервис каталога отдаёт тот же формат: .../feeds/promos.csv
export const PROMO_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQBYDczXmGsnVqSrCuzjsMwz6-DZu3Q6pSjb66YUkgPxxt7UDecZLll9QZFHU0BHhKc3GMZ4xFoouXB/pub?gid=301234033&single=true&output=csv';

// Селекторы карточки и обёрток фотографий в разметке Taptop
export const CARD_SEL = '.product-card, .product-wrapper__cms';        // карточка товара
export const IMG_WRAP_SEL = '.product__img, .product__img__cms';      // обёртки главных картинок (по категориям)
export const EXTRA_IMG_WRAP_SEL = '.product__img-dop, .product__img-dop__cms'; // обёртки «Ещё фото»
