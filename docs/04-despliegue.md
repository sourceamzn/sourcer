# 04 · Despliegue en api.toolsnexora.world

Requisitos: **Node.js >= 20**, **PostgreSQL >= 14**, un **SMTP** y el (sub)dominio
`api.toolsnexora.world` apuntando al servidor.

---

## 1. Variables de entorno

Partir de `.env.example` y completar en el servidor (nunca versionar `.env`):

- `DATABASE_URL` — cadena de conexion PostgreSQL.
- `JWT_SECRET` y `COOKIE_SECRET` — secretos largos y distintos (32+ bytes aleatorios).
- `CORS_ORIGINS` — lista exacta separada por comas:
  `https://clientarea.toolsnexora.world,https://crm.toolsnexora.world,https://manager.toolsnexora.world,https://trading.toolsnexora.world`
- `SMTP_HOST/PORT/USER/PASS/MAIL_FROM` — credenciales del correo.
- `API_PUBLIC_URL=https://api.toolsnexora.world`
- `COOKIE_DOMAIN=.toolsnexora.world`, `COOKIE_SECURE=true` (produccion HTTPS).
- `DATA_ENCRYPTION_KEY` — clave **AES-256** en base64 (32 bytes) para cifrar en
  reposo IBAN/BIC, comentarios, notas y el contenido de documentos. **Obligatoria
  en produccion**: `assertConfig()` aborta el arranque si falta. Generarla con
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
  y guardarla en el gestor de secretos del hosting. **No cambiarla** sin
  recifrar los datos (si se pierde, los datos cifrados son irrecuperables).
- `TRUST_PROXY=1` (Railway/proxy inverso) — sin esto se confia en la IP del
  proxy o, peor, en una cabecera `X-Forwarded-For` falsificable.
- `CSRF_ENABLED=true` (por defecto) y `ALLOW_BODY_TOKEN=false` (por defecto) —
  el token de sesion viaja solo en cookie HttpOnly y las escrituras exigen la
  cabecera `X-CSRF-Token`.
- `PGSSL=true` y `PGSSL_REJECT_UNAUTHORIZED` — el certificado TLS de PostgreSQL
  se **verifica** por defecto en produccion. Con una CA privada (Railway)
  aportar su certificado en `PGSSL_CA`; sin el, la conexion falla a proposito
  (fail-closed) antes que viajar sin verificar.
- `JWT_EXPIRES_IN=12h` (por defecto) — acorta la vida de una sesion robada sin
  romper el flujo normal. La sesion es revocable por `jti`.

En produccion `assertConfig()` aborta el arranque si falta alguna variable critica.

## 2. Base de datos

```bash
createdb toolsnexora
npm run migrate        # aplica sql/001_init.sql y 002_catalog_account_types.sql
npm run migrate:status # comprueba que estan aplicadas
```

La base arranca **sin clientes ni cuentas**. Solo se carga el catalogo `at-*`.

## 3. Servicio de la API

Opcion A · systemd:

```ini
[Unit]
Description=ToolsNexora API
After=network.target postgresql.service

[Service]
WorkingDirectory=/opt/toolsnexora/backend
EnvironmentFile=/opt/toolsnexora/backend/.env
ExecStart=/usr/bin/node src/server.js
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

Opcion B · PM2: `pm2 start src/server.js --name toolsnexora-api`.

Opcion C · Docker: `docker compose up -d` (ver `Dockerfile` y `docker-compose.yml`).

## 4. Proxy inverso + TLS

Nginx delante de la API (Node escucha en `127.0.0.1:3000`):

```nginx
server {
  server_name api.toolsnexora.world;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Certificado con `certbot --nginx -d api.toolsnexora.world`. Definir
`TRUST_PROXY=1` para que la cookie `Secure` y la IP real funcionen sin aceptar
`X-Forwarded-For` de cualquiera (por defecto en produccion es `1`).

## 5. Primer administrador

```bash
npm run create-staff -- admin@toolsnexora.world 'ClaveFuerte123' 'Admin' superadmin crm
```

Crea un `user` con rol `superadmin` y su credencial en realm `crm`. No hay credenciales por defecto.

## 6. Verificacion

```bash
curl https://api.toolsnexora.world/api/health
# -> {"status":"ok","database":"up","time":"..."}
```

## 7. Pendiente para el despliegue real

- [ ] Contratar/servir servidor con Node 20 + PostgreSQL 14+.
- [ ] Crear la base `toolsnexora` y ejecutar las migraciones.
- [ ] Definir secretos reales (`JWT_SECRET`, `COOKIE_SECRET`) y credenciales SMTP.
- [ ] Apuntar DNS `api.toolsnexora.world` al servidor y emitir TLS.
- [ ] Configurar `CORS_ORIGINS` con los subdominios reales de las apps.
- [ ] Crear el primer usuario staff (CRM) y, si aplica, el usuario TM.
- [ ] Conectar las apps al API (sustituir espejos `wh.tm.v1`, `TM.db`, `wh.selfinvest.db.v2`,
      `accountForm`/`convertLead` del CRM y los tipos `essential…` por `at-*`).
- [ ] Definir el flujo de reapertura de cuenta tras archivar (autorizacion explicita en TM).

## 8. Notas de seguridad

- Contrasenas con bcrypt (coste 12); sesiones JWT con `jti` revocable en `sessions`.
- Tokens de un solo uso (email/reset) guardados **hasheados** (SHA-256) con caducidad.
- `register`, `login`, `password/forgot` y `password/reset` limitados por `@fastify/rate-limit` (20/min por IP por defecto).
- El token de sesion vive **solo** en la cookie `HttpOnly` (`tn_sid_<realm>`); no se devuelve en el cuerpo del login salvo `ALLOW_BODY_TOKEN=true`.
- Defensa **CSRF** por doble envio: cookie `tn_csrf` legible + cabecera `X-CSRF-Token` en toda escritura con sesion.
- Cifrado en reposo **AES-256-GCM** de campos sensibles (`iban`, `bic`, `beneficiary`, `comment` de `cash_requests`; `note` y contenido de `kyc_documents`).
- Subida de documentos: MIME en lista blanca, tope de 10 MB, servido como JSON/base64 con `Cache-Control: no-store` y `Content-Disposition: attachment` (nunca inline).
- El backend **ignora** cualquier `clientId` que envie el frontend para autorizar; lo resuelve del token.
- Ningun ID (`clientId`, `accountId`, `number`, `requestId`) lo genera el frontend.

## 9. Copias de seguridad y cifrado en reposo

El cifrado del volumen y de los backups lo aporta el proveedor de base de datos
(capa de disco). Ademas, la aplicacion cifra los campos sensibles con
**AES-256-GCM** y una clave externa (`DATA_ENCRYPTION_KEY`), de modo que un
volcado de PostgreSQL o un backup **aunque no este cifrado por el proveedor**
no expone IBAN/BIC, comentarios, notas ni documentos.

En el proveedor (Railway u otro):

- [ ] Activar **cifrado del volumen** de datos en reposo.
- [ ] Activar **cifrado de backups** y definir la **retencion** (p. ej. 7-30 dias).
- [ ] Programar backups automaticos (diarios) y **probar la restauracion** al menos una vez.
- [ ] Guardar `DATA_ENCRYPTION_KEY` en el gestor de secretos del hosting, separada
      de la base de datos. Si se pierde, los datos cifrados son irrecuperables; si
      se cambia, hay que recifrar antes los datos existentes.
