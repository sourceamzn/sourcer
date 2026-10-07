# 03 · Flujos e integridad (contrato)

---

## 1. Flujo · Alta pública → Lead
1. Usuario rellena formulario en `wh-selfinvest.html`.
2. Web Pública → `POST /api/clients` con `source = "web"` (o endpoint público de lead).
3. Backend crea **Lead** (o Client directo, a decidir) y lo pone en cola para el CRM.
4. El CRM lo ve en su pipeline con `statusId = st-new`.

Sin datos de prueba: primer registro real crea el primer Lead/Client real.

## 2. Flujo · CRM: Lead → Client
1. Staff abre lead (`L-####`) y pulsa **Convertir**.
2. CRM → `POST /api/clients/{clientId}/convert` (o `POST /api/clients` con `leadId`).
3. Backend genera el **`clientId` canónico `C######`** (no `C-2001`).
4. Lead `statusId = st-conv`; se conserva su historial.
5. El nuevo Client queda **sin** cuenta de trading (0 cuentas).

## 3. Flujo · Solicitud de cuenta (primera = Essential)
Origen CRM o Client Area:
1. `POST /api/account-requests`
   `{ clientId, accountTypeId: "at-essential" (o el elegido), currency }`.
2. Backend valida: cliente existe, KYC, y **no tiene ya una cuenta real**.
3. Estado `received → in_review`.
4. Se notifica al Trading Manager.

## 4. Flujo · Provisioning (solo Trading Manager)
1. TM revisa `GET /api/clients/{clientId}/account-requests`.
2. Aprueba: `POST /api/account-requests/{requestId}/approve`.
3. Backend/TM: `POST /api/trading/accounts` → genera `accountId` (`acc_…`) y
   `number` (entero 6 dígitos desde `100000`, único).
4. `AccountRequest.status = provisioned`, `provisionedAccountId = acc_…`.
5. TradingAccount `status = pending → active`.
6. El cliente ya ve la cuenta en el Client Area (`/api/clients/{clientId}/accounts`)
   y puede abrir el Terminal.

**Regla dura**: una solicitud `provisioned` ⇒ exactamente una TradingAccount. Idempotente.

## 5. Flujo · Login y sesión
- **Client Area**: `POST /api/auth/login` (email+contraseña). El backend emite sesión
  (token o cookie `HttpOnly`). `GET /api/auth/me` devuelve `clientId`. F5 mantiene la sesión
  porque el origen es real y la cookie/token no vive en `localStorage`.
- **CRM**: staff login; permisos por rol/ámbito (superadmin, manager, sales_agent, …).
- **Trading Terminal**: sesión de trading separada; lee solo la cuenta autorizada.
- Credenciales del Client Area **≠** credenciales del Terminal.

## 6. Autorización (invariantes)
- El backend resuelve el actor desde el token; **ignora** cualquier `clientId` del frontend
  para autorizar.
- `client` solo accede a sus propios recursos (`self`). Cualquier otro → `403`.
- `staff` opera según permisos y ámbito (departamento/desk). No crea cuentas.
- Solo `tm`/`system` crean cuentas de trading.

## 7. Integridad y límites
- **Una cuenta real por cliente** (`UNIQUE(clientId) WHERE archived = false`).
- `accountNumber` único global; `email` de Client único.
- Órdenes/posiciones/trades/transacciones cuelgan de la **cuenta**, no del cliente.
- Ningún ID lo genera el frontend. El email **no** es ID.
- Sin cuentas ficticias ni seeds: base vacía en el primer arranque.
- Auditoría: cada mutación relevante genera un `AuditEvent` con actor y objeto.

## 8. Migración de las apps (sin tocar UI/diseño)

| Punto actual | Cambio de contrato |
|---|---|
| `crm.html` `accountForm` (`:1351`) | Deja de crear cuentas → crea **AccountRequest**. |
| `crm.html` `convertLead` (`:1332`) | `clientId` pasa de `C-2001` → `C######` (backend). |
| `client-cabinet.html` espejo `TM.db` (`:349`) | Consume API; elimina espejo de `wh.tm.v1`. |
| `client-cabinet.html` `config.js` 404 (`:252`) | Se resuelve publicando `config.js` con `baseUrl` de API. |
| `assets/js/shared/config.js` types (`:75`) | Unifica a `at-*` (catálogo del backend). |
| `terminal.html` store `wh.selfinvest.db.v2` | Lee operativa vía API con IDs canónicos. |
| Apps: `localStorage` como sesión | Prohibido; sesión por token/cookie. |

El diseño visual y la estructura de cada app se conservan; solo cambia la **fuente de datos**.

## 9. Criterios de aceptación de Fase 1 (este contrato)
- [ ] Todas las apps usan los mismos IDs canónicos (`C######`, `acc_…`, `number 100xxx`).
- [ ] Existe una única fuente de verdad para Client y TradingAccount (el backend).
- [ ] El CRM crea solicitudes, no cuentas.
- [ ] La primera cuenta se provisiona como `at-essential`.
- [ ] Ningún secreto ni sesión en `localStorage`; sin mock/demo; base inicial vacía.
