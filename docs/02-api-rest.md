
# 02 · API REST (contrato)

Base: `https://api.toolsnexora.world` · Prefijo: `/api` · Formato: JSON UTF-8.

---

## 1. Convenciones

- **Auth**: `Authorization: Bearer <token>` para apps SPA/CRM/Terminal. El Client Area puede
  usar además cookie `HttpOnly; Secure; SameSite=Lax`. Nunca `localStorage` como sesión.
- **Autorización**: el backend resuelve el actor desde el token. **Nunca** confía en el
  `clientId` que envía el frontend para decidir permisos.
- **Roles**: `client` (Client Area/Terminal), `staff` (CRM, con perms), `tm` (Trading Manager), `system`.
- **Errores**: `{ "error": { "code", "message", "details? } }`, HTTP 400/401/403/404/409/422/429/500.
  Códigos: `invalid_credentials`, `unauthorized`, `forbidden`, `not_found`, `conflict`,
  `validation_error`, `rate_limited`, `account_request_not_allowed`.
- **Idempotencia**: `POST` sensibles aceptan `Idempotency-Key`. Reintento devuelve el mismo recurso.
- **Paginación**: `?limit=&cursor=` → `{ "items": [...], "nextCursor": "…" }`.
- **Fechas**: ISO-8601 UTC. **Dinero**: decimal string o entero en céntimos (fijar al implementar).

---

## 2. Salud

| Método | Ruta | Auth |
|---|---|---|
| GET | `/api/health` | no |

---

## 3. Autenticación

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/auth/register` | Alta de cliente (Client Area). Crea Client + credencial. |
| POST | `/api/auth/login` | Login cliente (Client Area). Devuelve token/cookie. |
| POST | `/api/auth/logout` | Revoca la sesión. |
| GET | `/api/auth/me` | Actor actual: `{ actorType, clientId?, userId?, email, name }`. |
| POST | `/api/auth/password/forgot` | Inicia recuperación por email. |
| POST | `/api/auth/password/reset` | Completa recuperación con token de un uso. |
| POST | `/api/auth/password/change` | Cambio autenticado. |

`register` / `password/reset` están **rate-limited**. Contraseñas con hash+salt (Argon2id/bcrypt).

Credenciales **separadas**: la del Client Area no es la del Trading Terminal.

---

## 4. Clientes

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/api/clients` | staff/system | Crea Client. Genera `clientId` canónico. |
| GET | `/api/clients/{clientId}` | staff/system/`self` | Ficha. |
| PATCH | `/api/clients/{clientId}` | staff/system/`self`* | Edita (campos permitidos por rol). |
| GET | `/api/clients` | staff | Listado/paginado/búsqueda. |
| POST | `/api/clients/{clientId}/convert` | staff (perm `clients.convert`) | Convierte un Lead. |

- Un cliente autenticado solo puede acceder a **su** `clientId`.
- `POST /api/clients` es idempotente por email: si existe, devuelve el existente (o 409, a decidir).

**Request `POST /api/clients`**
```json
{ "firstName": "…", "lastName": "…", "email": "…", "phone": "…",
  "country": "…", "source": "web|crm|manual", "leadId": "L-1001" }
```
**Response 201**
```json
{ "clientId": "C000123", "status": "active", "kycStatus": "pending",
  "createdAt": "2026-09-27T00:00:00Z" }
```

---

## 5. Catálogo de tipos de cuenta

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/account-types` | autenticado | Catálogo `at-*` (autoridad TM). |
| GET | `/api/account-types/{accountTypeId}` | autenticado | Un tipo. |

Reemplaza los espejos locales (`client-cabinet.html`, `assets/js/shared/config.js`).

---

## 6. Solicitudes de cuenta (AccountRequest)

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/api/account-requests` | client (self) / staff | Crea solicitud. Primera cuenta: `at-essential`. |
| GET | `/api/account-requests/{requestId}` | self/staff/tm | Estado de la solicitud. |
| GET | `/api/clients/{clientId}/account-requests` | self/staff/tm | Historial. |
| POST | `/api/account-requests/{requestId}/approve` | tm | Aprueba y **provisiona** (crea la cuenta). |
| POST | `/api/account-requests/{requestId}/reject` | tm | Rechaza con motivo. |

**Request**
```json
{ "clientId": "C000123", "accountTypeId": "at-essential", "currency": "EUR", "notes": "" }
```
Respeta la regla de **una cuenta real por cliente**; si ya existe, `409 conflict`.

---

## 7. Cuentas de trading

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/api/trading/accounts` | tm/system | Crea la cuenta real (provisioning). |
| GET | `/api/trading/accounts/{accountId}` | self/tm | Detalle. |
| GET | `/api/clients/{clientId}/accounts` | self/tm | Cuentas del cliente (0..1 real). |
| GET | `/api/trading/accounts/{accountId}/positions` | self/tm | Posiciones. |
| GET | `/api/trading/accounts/{accountId}/orders` | self/tm | Órdenes. |
| GET | `/api/trading/accounts/{accountId}/trades` | self/tm | Historial. |
| GET | `/api/trading/accounts/{accountId}/transactions` | self/tm | Movimientos. |
| POST | `/api/trading/accounts/{accountId}/positions` | self/tm | Abre posición. Acepta `price`/`openPrice`. |
| POST | `/api/trading/accounts/{accountId}/orders` | self/tm | Coloca orden pendiente. |
| PATCH | `/api/trading/positions/{positionId}` | self/tm | Modifica `sl`, `tp` y **`openPrice`** (recalcula P&L). |
| PATCH | `/api/trading/orders/{orderId}` | self/tm | Modifica `price`, `sl`, `tp` de una orden pendiente. |
| POST | `/api/trading/positions/{positionId}/close` | self/tm | Cierra (total o parcial). |
| DELETE | `/api/trading/orders/{orderId}` | self/tm | Cancela la orden pendiente. |

- `self` = el `clientId` del token es el titular de la cuenta. Si no, `403`.
- El **Trading Terminal no crea cuentas**: solo lee operativa de la cuenta autenticada.
- `accountId` con formato `acc_<32 hex>`; `positionId` `p_<32 hex>`; `orderId` `o_<32 hex>`.

### 7.1 Movimientos de dinero

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/api/trading/accounts/{accountId}/deposit` | tm/staff/system | Ingreso. Sube `balance`. |
| POST | `/api/trading/accounts/{accountId}/withdraw` | tm/staff/system | Retirada. Valida saldo suficiente. |
| POST | `/api/trading/accounts/{accountId}/bonus` | tm/staff/system | Añade bono (campo `bonus`, separado del saldo). |
| POST | `/api/trading/accounts/{accountId}/bonus/remove` | tm/staff/system | Retira bono. Valida bono disponible. |
| POST | `/api/trading/accounts/{accountId}/transfer` | tm/staff/system | Transfiere a otra cuenta (`toNumber` o `toAccountId`). |
| POST | `/api/trading/accounts/{accountId}/adjust` | tm/staff/system | Ajuste de balance, positivo o negativo (no puede ser 0). |

Reglas comunes:

- Solo se permite mover dinero con la cuenta en estado `active` o `pending` (suspendida/cerrada/archivada → `409`).
- Cada movimiento es **idempotente** por `idempotencyKey`: un reintento devuelve el mismo `txId` sin duplicar.
- Todo se registra en `transactions` y en `audit_events` (`money.<tipo>`), con `balanceAfter`.
- El saldo se bloquea con `FOR UPDATE` durante la operación (sin carreras).

**Request `deposit` / `withdraw`**
```json
{ "amount": 1000.00, "method": "bank", "reference": "TRF-88213",
  "comment": "Ingreso inicial", "idempotencyKey": "dep-C000123-0001" }
```
**Request `bonus` / `bonus/remove`**
```json
{ "amount": 50.00, "reason": "Promoción" }
```
**Request `adjust`**
```json
{ "amount": -12.50, "reason": "Corrección manual" }
```
**Request `transfer`**
```json
{ "toNumber": 50001234, "amount": 250.00, "comment": "Reparto", "idempotencyKey": "tr-0001" }
```
**Response 201** (un movimiento)
```json
{ "txId": "tx_1204", "accountNumber": 50001234, "type": "deposit",
  "amount": "1000.00", "currency": "EUR", "balanceAfter": "1000.00",
  "ref": null, "note": "bank · TRF-88213 · Ingreso inicial",
  "createdAt": "2026-09-29T10:00:00Z" }
```

Tipos de movimiento: `deposit`, `withdrawal`, `bonus`, `bonus_removal`, `transfer_out`,
`transfer_in`, `adjustment`. En `transfer` la respuesta es el movimiento de **entrada**
(`transfer_in`) de la cuenta destino.

---

## 8. Eventos (audit sink del Trading Manager)

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/api/events` | tm/system | Ingesta por lotes del **outbox** del Trading Manager. |

- Idempotente por `id` de evento (`ON CONFLICT (event_id) DO NOTHING`): un reintento del
  `flush()` del TM no duplica registros. Responde `202 { "accepted", "duplicates" }`.
- El actor se resuelve del token; `clientId`/`accountId` se guardan como contexto, **nunca**
  sustituyen la autorización.

**Request** (lo que ya envía `trading-manager.html` → `Integration.flush()`)
```json
{ "clientId": "C000123", "accountId": "acc_…",
  "events": [
    { "id": "ev-…", "type": "account.created", "at": 1758931200000,
      "payload": { "object": "acc_…", "before": null, "after": { … } }, "meta": {} }
  ] }
```
El lote completo (≤50) se persiste en `audit_events` con `details` = `{ eventId, at, payload, meta, clientId, accountId, source }`.

---

## 9. Autorización — matriz resumida

| Recurso | client (self) | staff (CRM) | tm | system |
|---|---|---|---|---|
| Client propio | R/W | R/W (perm) | R | R/W |
| Otro Client | ✗ | según perm/ámbito | R | R/W |
| AccountType | R | R | R/W | R/W |
| AccountRequest crear | ✔ | ✔ | ✔ | ✔ |
| AccountRequest aprobar | ✗ | ✗ | ✔ | ✔ |
| TradingAccount crear | ✗ | ✗ | ✔ | ✔ |
| Operativa (pos/ord/trades/tx) | R (self) | R (perm) | R/W | R/W |

---

## 10. Notas de integración

- El CRM llama `POST /api/clients` y `POST /api/account-requests`; **nunca** crea cuentas.
- El Client Area llama `POST /api/account-requests` (primera = `at-essential`) y lee
  `/api/clients/{clientId}/accounts`.
- El Trading Manager es el único que llama `POST /api/trading/accounts` (o lo expone internamente).
- El Trading Manager vuelca su outbox con `POST /api/events`; en la UI, `Integration.baseUrl` debe ser
  `https://api.toolsnexora.world/api` (no la raíz), porque el prefijo `/api` forma parte de la URL.
- El deep-link actual del Client Area → Terminal
  (`?clientId=&accountId=&accountNumber=`) pasa a resolverse contra el backend; los IDs son los canónicos.
- El Trading Manager, con `config.js` (`API_BASE_URL`), llama en **LIVE** a los endpoints de dinero
  (`/deposit`, `/withdraw`, `/bonus`, `/bonus/remove`, `/transfer`, `/adjust`) y de operativa
  (abrir/cerrar/modificar posiciones y órdenes); sin `config.js` opera en local. Reenvía
  cada `idempotencyKey` para no duplicar movimientos si se repite el envío.

---

## 11. Captación pública y afiliados / IB

La web pública no usa el `POST /leads` interno (que es solo para el personal del CRM). Tiene su
propio endpoint sin sesión, con límite de envíos y un campo trampa, y lo asocia a un afiliado si
el visitante llega con un código de referido.

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/public/leads` | ninguna | Alta de interesado desde el formulario de la web. |
| GET | `/public/affiliates/:code` | ninguna | Valida un código de referido y devuelve el nombre del afiliado. |

`POST /public/leads` acepta `firstName`, `email` y `consent` (`true`) obligatorios; opcionales
`lastName`, `phone`, `country`, `age`, `message`, `referral`, `campaignId`, `source` y `utm`
(`source|medium|campaign|content|term`). El campo `website` es el **honeypot**: si viene relleno se
responde `201 { "ok": true }` sin guardar nada. El lead entra como estado `st-new` con origen
`web`; si el correo ya existe se actualiza el lead anterior (no se duplica). Límite por defecto:
5 envíos cada 10 minutos por IP (`PUBLIC_RATE_LIMIT_*`). Nunca devuelve el `leadId`.

El CRM puede gestionar los afiliados desde su sesión de staff:

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/affiliates` | staff / tm / system | Listado con contadores (leads, cuentas, depósitos, comisión). |
| POST | `/affiliates` | staff / tm / system | Crea un afiliado (genera el código a partir del nombre si no se indica). |
| GET | `/affiliates/:affiliateId` | staff / tm / system | Ficha del afiliado con sus conversiones. |
| PATCH | `/affiliates/:affiliateId` | staff / tm / system | Edita datos, estado o comisión. |

Cada alta captada con `?ref=CODIGO` deja una conversión tipo `lead` en `affiliate_conversions`.
El enlace que se comparte es `https://whselfinvests.com/captura.html?ref=CODIGO`.
