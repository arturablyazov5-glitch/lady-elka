import test from 'node:test';
import assert from 'node:assert/strict';
import { alfaRecoveryWindow, assessAlfaRecovery, extractAlfaPaymentId } from '../../supabase/functions/_shared/alfa-recovery.mjs';

const orderId = 'LE-1780000000000-180-abcd1234';
const paymentId = '00dbaf58-b312-74c1-b850-491c0216f21d';
const status = { errorCode: '0', orderNumber: orderId, orderStatus: 0, amount: 159900 };
const history = [{ orderNumber: orderId, orderStatus: 0, amount: 159900,
  attributes: [{ name: 'mdOrder', value: paymentId }] }];

test('Alfa recovery builds a Moscow-time, narrow registration search window', () => {
  assert.deepEqual(alfaRecoveryWindow('2026-10-01T12:00:00.000Z'), {
    from: '20261001145500', to: '20261001151500'
  });
});

test('Alfa recovery accepts only a unique matching existing order and amount', () => {
  assert.equal(extractAlfaPaymentId(history[0]), paymentId);
  const plan = assessAlfaRecovery({ orderId, expectedTotal: 1599, statusResponse: status,
    historyRows: history, apiHost: 'payment.alfabank.ru',
    paymentUrlTemplate: `https://payment.alfabank.ru/payment/merchants/shop/payment_ru.html?mdOrder={paymentId}` });
  assert.equal(plan.ready, true);
  assert.equal(plan.paymentId, paymentId);
  assert.match(plan.paymentUrl, new RegExp(paymentId));
});

test('Alfa recovery refuses missing IDs, duplicate orders, amount mismatches, and unconfigured unpaid URLs', () => {
  const input = { orderId, expectedTotal: 1599, statusResponse: status, historyRows: history,
    apiHost: 'payment.alfabank.ru' };
  assert.equal(assessAlfaRecovery({ ...input, historyRows: [] }).reason, 'payment_id_not_in_bank_report');
  assert.equal(assessAlfaRecovery({ ...input, historyRows: [...history, ...history] }).reason, 'multiple_bank_registrations');
  assert.equal(assessAlfaRecovery({ ...input, expectedTotal: 1700 }).reason, 'bank_amount_mismatch');
  assert.equal(assessAlfaRecovery(input).reason, 'payment_form_url_template_required');
});

test('A verified paid order can be recovered without inventing a payment URL', () => {
  const plan = assessAlfaRecovery({ orderId, expectedTotal: 1599,
    statusResponse: { ...status, orderStatus: 2 }, historyRows: [{ ...history[0], orderStatus: 2 }],
    apiHost: 'payment.alfabank.ru' });
  assert.equal(plan.ready, true);
  assert.equal(plan.paid, true);
  assert.equal(plan.paymentUrl, '');
});

test('Held, challenged, reversed, refunded, and declined orders require manual review', () => {
  for (const orderStatus of [1, 3, 4, 5, 6]) {
    const plan = assessAlfaRecovery({ orderId, expectedTotal: 1599,
      statusResponse: { ...status, orderStatus }, historyRows: history,
      apiHost: 'payment.alfabank.ru',
      paymentUrlTemplate: `https://payment.alfabank.ru/payment?mdOrder={paymentId}` });
    assert.equal(plan.ready, false, `status ${orderStatus} must not be resumed`);
    assert.equal(plan.reason, 'bank_state_requires_manual_review');
  }
});

test('Recovery rejects an untrusted or malformed merchant URL template', () => {
  const plan = assessAlfaRecovery({ orderId, expectedTotal: 1599, statusResponse: status, historyRows: history,
    apiHost: 'payment.alfabank.ru', paymentUrlTemplate: `https://example.invalid/pay?mdOrder={paymentId}` });
  assert.equal(plan.reason, 'payment_form_url_template_invalid');
});
