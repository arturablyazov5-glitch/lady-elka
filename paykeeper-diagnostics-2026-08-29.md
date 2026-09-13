# PayKeeper diagnostics for Alfa-Bank support

Date: 2026-08-29
Merchant PayKeeper host: https://lady-elka2.server.paykeeper.ru
Merchant site: https://lady-elka.ru
INN: 672304120248

## Integration mode

The site creates a PayKeeper payment by direct browser POST to:

https://lady-elka2.server.paykeeper.ru/create/

Fields sent:

- sum
- orderid
- clientid
- client_email
- client_phone
- service_name

This follows the PayKeeper HTML form integration flow.

## Test results

### 1. PayKeeper server responds

Request:

GET https://lady-elka2.server.paykeeper.ru/

Result:

HTTP 303

### 2. PayKeeper API credentials work

Request:

GET https://lady-elka2.server.paykeeper.ru/info/settings/token/

Result:

HTTP 200, security token returned.

### 3. Direct /create/ payment page is generated

Request:

POST https://lady-elka2.server.paykeeper.ru/create/

Form fields:

- sum=1.00
- orderid=LE-DIAG-1787991671
- clientid=Diag
- client_email=test@example.com
- client_phone=+70000000000
- service_name=Diag PayKeeper

Result:

HTTP 200, page title: "Выполнить платеж".

### 4. Payment methods list is empty on the new PayKeeper host

The generated HTML contains an empty payment methods container:

```html
<div class="c-buttons-list r-payment-methods">


</div>
```

There are no `input name="pstype"` radio buttons in the generated page.

### 5. Comparison with old PayKeeper host

The same request to the old host:

https://lady-elka.server.paykeeper.ru/create/

returns payment methods:

```html
<input type='radio' name='pstype' id='alfabank_card' value='alfabank'>
<input type='radio' name='pstype' id='sbp_ab' value='sbp_ab'>
<input type='radio' name='pstype' id='ab_pay' value='ab_pay'>
```

### 6. Explicit pstype checks on new PayKeeper host

Tried opening the new PayKeeper bill with explicit payment system values:

- pstype=alfabank -> Runtime error, "Неизвестная ошибка"
- pstype=sbp_ab -> Runtime error, "Неизвестная ошибка"
- pstype=ab_pay -> Runtime error, "Неизвестная ошибка"
- pstype=sberpay -> Runtime error, "Платёжная система не найдена"

## Current conclusion

The order/payment registration request reaches PayKeeper and a bill is created, but the new PayKeeper host does not return any active payment system (`pstype`) for the payment page.

Please check why `lady-elka2.server.paykeeper.ru` has no available payment methods in `/create/` output, and which `pstype` should be active for bank card / SBP / AlfaPay / SberPay payments.
