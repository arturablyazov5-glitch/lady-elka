/** @typedef {Record<string, unknown>} JsonRecord */

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value) {
  return isRecord(value) ? value : {};
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return isRecord(value) ? [value] : [];
}

function text(value) {
  return value == null ? '' : String(value);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatAlfaTimestamp(value, timeZone = 'Europe/Moscow') {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid recovery window timestamp');
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${fields.year}${fields.month}${fields.day}${fields.hour}${fields.minute}${fields.second}`;
}

export function alfaRecoveryWindow(createdAt, timeZone = 'Europe/Moscow') {
  const center = new Date(createdAt);
  if (!Number.isFinite(center.getTime())) throw new Error('Order creation time is invalid');
  return {
    from: formatAlfaTimestamp(new Date(center.getTime() - 5 * 60_000), timeZone),
    to: formatAlfaTimestamp(new Date(center.getTime() + 15 * 60_000), timeZone)
  };
}

export function extractAlfaOrders(response) {
  return asArray(asRecord(response).orderStatuses).map(asRecord);
}

export function extractAlfaPaymentId(order) {
  const attributes = asArray(asRecord(order).attributes).map(asRecord);
  const mdOrder = attributes.find(attribute => text(attribute.name).toLowerCase() === 'mdorder');
  return text(mdOrder?.value).trim();
}

function paymentFormUrl(template, paymentId, expectedHost) {
  if (!template) return '';
  if (!template.includes('{paymentId}')) {
    throw new Error('ALFA_PAYMENT_FORM_URL_TEMPLATE must contain {paymentId}');
  }
  const url = new URL(template.replaceAll('{paymentId}', encodeURIComponent(paymentId)));
  if (url.protocol !== 'https:' || url.username || url.password || url.hostname !== expectedHost) {
    throw new Error('Payment form URL must use HTTPS and the configured Alfa API host');
  }
  if (url.searchParams.get('mdOrder') !== paymentId) {
    throw new Error('Payment form URL must pass the recovered ID as mdOrder');
  }
  return url.toString();
}

function stop(reason, details = {}) {
  return { ready: false, reason, ...details };
}

/**
 * Accepts a bank status lookup by merchant order number plus the bank's read-only
 * period report. It returns an apply-ready plan only when the order, amount, and
 * unique payment ID agree. The status endpoint is authoritative for current state.
 */
export function assessAlfaRecovery({
  orderId,
  expectedTotal,
  statusResponse,
  historyRows,
  apiHost,
  paymentUrlTemplate = ''
}) {
  const status = asRecord(statusResponse);
  const errorCode = text(status.errorCode ?? '0');
  if (errorCode !== '' && errorCode !== '0') {
    return errorCode === '6' ? stop('bank_order_not_found') : stop('bank_status_api_error', { errorCode });
  }
  if (text(status.orderNumber) !== orderId) return stop('bank_order_number_mismatch');

  const bankStatus = number(status.orderStatus);
  if (bankStatus === null) return stop('bank_order_not_found');
  const total = Number(expectedTotal);
  const amountKopecks = Math.round(total * 100);
  if (!Number.isSafeInteger(amountKopecks) || Math.abs(total * 100 - amountKopecks) > 0.000001) {
    return stop('stored_amount_invalid');
  }
  const statusAmount = number(status.amount);
  if (statusAmount === null || statusAmount !== amountKopecks) return stop('bank_amount_mismatch');

  // Only a plain registration (0) can resume through a payment form. Holds,
  // 3DS in progress, cancellations, refunds, and declines need manual review.
  if (![0, 2].includes(bankStatus)) {
    return stop('bank_state_requires_manual_review', { bankStatus, amountKopecks });
  }

  const matches = historyRows.map(asRecord).filter(row => text(row.orderNumber) === orderId);
  if (matches.length === 0) return stop('payment_id_not_in_bank_report', { bankStatus, amountKopecks });
  if (matches.length !== 1) return stop('multiple_bank_registrations', { bankStatus, amountKopecks, matchCount: matches.length });

  const paymentId = extractAlfaPaymentId(matches[0]);
  if (!paymentId) return stop('bank_report_missing_mdOrder', { bankStatus, amountKopecks });
  const historyAmount = number(matches[0].amount);
  if (historyAmount !== null && historyAmount !== amountKopecks) return stop('bank_report_amount_mismatch', { paymentId });

  let paymentUrl = '';
  if (bankStatus === 0) {
    if (!paymentUrlTemplate) {
      return stop('payment_form_url_template_required', { bankStatus, paymentId, amountKopecks });
    }
    try {
      paymentUrl = paymentFormUrl(paymentUrlTemplate, paymentId, apiHost);
    } catch (error) {
      return stop('payment_form_url_template_invalid', { bankStatus, paymentId, amountKopecks, detail: String(error) });
    }
  }

  return {
    ready: true,
    reason: bankStatus === 2 ? 'existing_payment_confirmed_paid' : 'existing_payment_confirmed_unpaid',
    orderId,
    paymentId,
    bankStatus,
    amountKopecks,
    paid: bankStatus === 2,
    paymentUrl
  };
}
