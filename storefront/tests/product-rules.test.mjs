import test from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogNumber,
  checkoutTotal,
  csvRecords,
  decorProducts,
  findPromo,
  hasPromoBenefit,
  isCatalogActive,
  lineTotal,
  normalizePromoCode,
  parseCSV,
  promoDetails,
  treeProducts,
} from '../../supabase/functions/_shared/product-rules.mjs';
import { cartTotal, discountTotal } from '../client/order-payload.js';

test('shared CSV parser keeps quoted commas, multiline text, escaped quotes, CRLF, and empty cells', () => {
  const input = '\uFEFFid,title,description,empty\r\n1,"Корзина, 1","строка 1\r\nстрока ""2""",\r\n2,,,x\r\n';
  assert.deepEqual(parseCSV(input), [
    ['id', 'title', 'description', 'empty'],
    ['1', 'Корзина, 1', 'строка 1\r\nстрока "2"', ''],
    ['2', '', '', 'x'],
  ]);
  assert.deepEqual(csvRecords(input), [
    { id: '1', title: 'Корзина, 1', description: 'строка 1\r\nстрока "2"', empty: '' },
    { id: '2', title: '', description: '', empty: 'x' },
  ]);
  assert.deepEqual(parseCSV('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
});

test('catalog active flags, numbers, and product models preserve actual tree and decor IDs', () => {
  for (const value of ['1', 'TRUE', 't', 'да', 'yes', 'Y', 'on', 'ok', '✓']) assert.equal(isCatalogActive(value), true);
  for (const value of ['', '0', 'false', 'no', 'off']) assert.equal(isCatalogActive(value), false);
  assert.equal(catalogNumber('31 000 ₽'), 31000);
  assert.equal(catalogNumber('-30%'), -30);
  assert.equal(catalogNumber('1,25'), 1.25);

  const trees = treeProducts([
    { id: '  1 ', title: 'Миранда', active: 'TRUE', category: 'Зелёная', height_cm: '180', price: '1 200 ₽',
      diameter_cm: '80 см', branches: '300 шт', offer: '1 500 ₽', discount_pct: '-20%', description: '-', photos: ' a.jpg | | b.jpg ' },
    { id: '1', title: 'Миранда', active: 'false', category: 'Заснеженная', height_cm: '215', price: '2 000' },
    { id: '1', title: 'Миранда', active: '1', category: 'Зелёная', height_cm: '0', price: '900' },
    { id: '2', title: 'Нет цены', active: '1', category: 'Зелёная', height_cm: '180', price: '0' },
  ]);
  assert.deepEqual(trees.get('1').variants.map(variant => variant.id), ['1:Зелёная:180']);
  assert.equal(trees.get('1').variants[0].price, 1200);
  assert.equal(trees.get('1').variants[0].diameter, 80);
  assert.equal(trees.get('1').variants[0].description, '');
  assert.deepEqual(trees.get('1').variants[0].photos, ['a.jpg', 'b.jpg']);
  assert.deepEqual(trees.get('2').variants, []);

  const decor = decorProducts([
    { id: '1d', title: 'Корзина', category: '', active: 'TRUE', variants: '-', price: '7 500 ₽' },
    { id: '2d', title: 'Венок', category: 'Венок', active: 'yes', variants: '100x50Х10', price: '2 000' },
    { id: '2d', title: 'Венок', category: 'Венок', active: '0', variants: '120x50x10', price: '3 000' },
  ]);
  assert.equal(decor.get('1d').variants[0].id, '1d::');
  assert.equal(decor.get('1d').variants[0].label, '');
  assert.equal(decor.get('1d').variants[0].size, '');
  assert.equal(decor.get('2d').variants[0].id, '2d:Венок:100x50Х10');
  assert.equal(decor.get('2d').variants[0].size, '100х50х10');
  assert.throws(() => treeProducts([
    { id: '1', active: '1', category: 'Зелёная', height_cm: '180', price: '1000' },
    { id: '1', active: 'да', category: 'Зелёная', height_cm: '180', price: '1100' },
  ]), /Duplicate tree variant/);
  assert.throws(() => decorProducts([
    { id: '1d', active: '1', category: 'Венок', variants: '100x50x10', price: '1000' },
    { id: '1d', active: '1', category: 'Венок', variants: '100x50x10', price: '1100' },
  ]), /Duplicate decor variant/);
});

test('promo aliases, code normalization, gift rules, and checkout math are shared', () => {
  const rows = csvRecords('PROMOCODE,Комментарий,RUBLE-OFFER,percent-offer,gift-offer\r\n" Ёлка   2026 ",note,100,25,Сумка для хранения\r\n');
  const row = findPromo(rows, 'ёлКа 2026');
  assert.ok(row);
  assert.equal(normalizePromoCode(' ЁЛКА   2026 '), 'елка 2026');
  const promo = promoDetails(row);
  assert.deepEqual(promo, { rub: 100, pct: 25, gift: true, giftText: 'Сумка для хранения' });
  assert.equal(hasPromoBenefit(promo), true);
  assert.equal(hasPromoBenefit({ rub: 0, pct: 0, gift: false }), false);
  assert.equal(promoDetails({ код: 'код', руб: '50', '%': '0', подарок: '' }).rub, 50);

  const mixed = [
    { kind: 'tree', price: 1000, quantity: 1 },
    { kind: 'decor', price: 500, quantity: 1 },
  ];
  assert.equal(lineTotal(mixed[0]), 1000);
  assert.equal(cartTotal(mixed), 1500);
  assert.equal(discountTotal(mixed, promo), 1400); // fixed-ruble offer keeps priority over percent
  assert.equal(checkoutTotal(mixed, { rub: 0, pct: 10 }), 1350);
  assert.equal(checkoutTotal([{ kind: 'tree', price: 105, quantity: 1 }], { rub: 0, pct: 10 }), 95);
  assert.equal(checkoutTotal([{ kind: 'tree', price: 100, quantity: 1 }], { rub: 1000 }), 0);
  assert.equal(discountTotal([{ kind: 'decor', price: 500, quantity: 1 }], promo), 500);
  assert.equal(checkoutTotal([{ kind: 'tree', price: 500, quantity: 1 }], { gift: true }), 500);
  assert.equal(discountTotal(mixed, null), 1500);
});
