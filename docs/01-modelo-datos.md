# 01 · Modelo de datos (contrato)

Fuente: convenciones reales extraídas de las apps actuales.

- `trading-manager.html` → `wh.tm.v1`, cuenta autoritativa, `accountTypes` (:363-367), `createTradingAccount` (:639), `seq.account:100000` (:393).
- `client-cabinet.html` → `wh.cabinet.v1` + espejo de `wh.tm.v1`, `clientId = "C"+pad(++seq.client,6)` (:504).
- `crm.html` → `wh.crm.v5`, `convertLead` (`C-2001`, :1332), `accountForm` (`A-3001` / `10201`, :1351), estados (:314-321).

---

## 1. Convenciones de ID

| ID | Formato | Autoridad | Notas |
|---|---|---|---|
| `clientId` | `C` + 6 dígitos → `C000123` | Backend | Canónico. Nunca el email. |
| `accountId` | `acc_` + ULID/UUID | Trading Manager | ID interno estable. |
| `accountNumber` | entero 6 dígitos desde `100000` | Trading Manager | Visible al cliente. Único global. |
| `accountTypeId` | `at-essential` \| `at-advanced` \| `at-elite` \| `at-professional` | Trading Manager | Catálogo. |
| `leadId` | `L-####` (desde `L-1001`) | CRM | Solo CRM. |
| `requestId` | `R-####` (desde `R-1001`) | Backend | Solicitud de cuenta. |
| `orderId` / `ticket` | entero incremental por cuenta | Trading Manager | |
| `positionId` / `ticket` | entero incremental por cuenta | Trading Manager | |
| `tradeId` | `t_` + incremental | Trading Manager | |
| `transactionId` | `tx_` + incremental | Trading Manager | |

Ninguna app genera IDs de cliente o de cuenta por su cuenta. Se **solicitan al backend**.

---

## 2. Entidades

### 2.1 Lead (solo CRM)
```
leadId        L-####
firstName, lastName, phone, email, age, description
statusId      st-new | st-callback | st-call | st-noint | st-reassign | st-conv
agentId, managerId, deskId, campaignId, source
createdAt, updatedAt
```
Al convertir → se crea/actualiza **Client** con el mismo email y `statusId = st-conv`.

### 2.2 Client
```
clientId        C######            (PK)
firstName, lastName
displayName     derivado (no fuente de verdad)
email           único; identificador de login del Client Area
phone, country, age, description
status          active | dormant | blocked | closed
kycStatus       pending | in_review | approved | rejected
source, campaignId, agentId, managerId, deskId   (propiedad CRM)
leadId          lead de origen (opcional)
convertedAt, createdAt, updatedAt
```
- NO almacena cuentas, saldos ni fondos.
- Puede existir **sin** ninguna Trading Account (0 cuentas).

### 2.3 AccountType (catálogo, autoridad = Trading Manager)
```
accountTypeId         at-essential | at-advanced | at-elite | at-professional
name, code            Essential/ESSENTIAL, Advanced, Elite, Professional
spread, leverage, leverageConfigurable
swapType, swapLong, swapShort
marginCall, stopOut, commission
status                active | inactive
description
```
Valores canónicos actuales (tm:363-367): Essential spread 1.4/lev 30 · Advanced 0.9/50 ·
Elite 0.4/100 · Professional 0.1/100 (configurable). Debe exponerse por API y **eliminarse
los espejos** en `client-cabinet.html` y en `assets/js/shared/config.js` (usa `essential…` sin `at-`).

### 2.4 TradingAccount (autoridad = Trading Manager)
```
accountId       acc_…            (PK)
number          entero 6 dígitos desde 100000 (único)
clientId        C######          (FK Client)
accountTypeId   at-*             (FK AccountType)
currency        EUR (default)
leverage        entero
balance, equity, margin, freeMargin
status          pending | active | suspended | closed
archived        bool
createdAt, updatedAt, lastActivity
```
- **Una cuenta real por cliente** (regla confirmada): `UNIQUE(clientId) WHERE archived = false`.
- `group` legacy (`Standard/Premium/VIP/Demo`, `_atMap` tm:422) se conserva solo como dato informativo; el vínculo real es `accountTypeId`.

### 2.5 AccountRequest (solicitud — reemplaza `accountForm` del CRM)
```
requestId              R-####           (PK)
clientId               C######          (FK)
accountTypeId          at-*  (deseada; primera cuenta = at-essential)
currency               EUR (default)
status                 received | in_review | approved | rejected | provisioned
requestedByType        crm | client-area
requestedById          userId (CRM) | clientId (area)
notes
createdAt, decidedAt, decidedById
provisionedAccountId   acc_…  (cuando se aprueba y se crea)
```
- Idempotencia: una solicitud `provisioned` produce **exactamente una** TradingAccount.
- El CRM deja de crear cuentas: crea **solicitudes**.

### 2.6 Instrumentos y operativa (autoridad = Trading Manager)
```
Instrument    id, symbol, name, assetClass, digits, contractSize,
              minVolume, maxVolume, volumeStep, hours, enabled, bid, ask
Order         id, ticket, accountNumber, symbol, type, side, volume, price,
              sl, tp, status, createdAt
Position      id, ticket, accountNumber, symbol, side, volume, openPrice,
              sl, tp, status, openedAt, closedAt
Trade         id, ticket, accountNumber, symbol, side, volume, openPrice,
              closePrice, profit, openedAt, closedAt
Transaction   id, accountNumber, type, amount, currency, balanceAfter, createdAt, note
```
Todas cuelgan de `accountNumber` (cuenta), **nunca** de `clientId` directamente.

### 2.7 AuditEvent
```
id, at, actorType (staff|client|system), actorId, action, object, details
```

---

## 3. Relaciones

```
Lead (L-####) ──convert──▶ Client (C######)

Client (C######) 1 ──── 0..1  TradingAccount (acc_… / number)
AccountType (at-*) 1 ── N     TradingAccount
AccountRequest (R-####) N ─ 1 Client
AccountRequest 0..1 ────── 1 TradingAccount   (provisionedAccountId)

TradingAccount 1 ── N { Order, Position, Trade, Transaction }
```

```
                 ┌───────────────┐
   Lead ───────▶ │    Client     │ ◀───── AccountRequest ───── AccountType
                 │   C######     │
                 └──────┬────────┘
                        │ 0..1 (una cuenta real)
                 ┌──────▼────────┐        cuenta creada por
                 │ TradingAccount │◀───────── Trading Manager
                 │  number 100xxx │
                 └──────┬─────────┘
        ┌────────┬──────┼───────┬──────────┐
      Order   Position Trade  Transaction  …
```

---

## 4. Estados

**Lead** (CRM): `st-new → st-callback/st-call → (st-noint | st-conv)`, `st-reassign` en cualquier punto.
`st-conv` ⇒ existe un Client asociado.

**Client**: `active → dormant → active` · `active → blocked` · cualquier estado `→ closed`.
KYC: `pending → in_review → approved | rejected`. Operar requiere `kycStatus = approved`.

**AccountRequest**:
```
received → in_review → approved → provisioned
                    └→ rejected
```

**TradingAccount**:
```
pending → active → suspended → active
                 └→ closed
```

---

## 5. Reconciliación legacy → canónico

| App | Hoy | Canónico |
|---|---|---|
| CRM | clientId `C-2001` (`:1332`) | `C######` |
| CRM | account `A-3001` + number `10201` (`:1351`) | AccountRequest `R-####` → TradingAccount `number 1000xx` |
| Client Area | clientId `C000001` (seq local, `:504`) | `C######` del backend |
| Trading Manager | `wh.tm.v1` con clientes/cuentas locales | catálogo + cuentas desde backend |
| Trading Terminal | clientId `CL-00001`, cuenta `100023` | `C######` + `number` real |
| `assets/js/shared/config.js` | types `essential/advanced/…` (`:75`) | `at-*` (catálogo único) |
| `client-cabinet.html` | espejo local de `TM.db` (`:349`) | API del backend |

## 6. Persistencia

Una sola instancia de base de datos para clientes/cuentas/solicitudes (la del backend).
Las apps **no** mantienen copias autoritativas de clientes ni cuentas. El `localStorage`
solo puede usarse como caché de presentación, nunca como fuente de verdad ni de sesión.
