# Backend de Sourcing (Amazon FBA)

Servidor que da **datos reales** al módulo `sourcing.html`. Trabaja por
**adaptadores**: el frontend llama siempre al mismo contrato y cada fuente
responde lo suyo.

Contrato único:

```
POST   {backend}/sourcing/{fuente}/{accion}
GET    {backend}/health
GET    {backend}/alerts
POST   {backend}/alerts/watch
POST   {backend}/alerts/watch/:id
DELETE {backend}/alerts/watch/:id
POST   {backend}/alerts/dismiss
POST   {backend}/alerts/run
```

Fuentes: `outletpc`, `lidl`, `iherb`, `amazon`, `keepa`, `web`.

## Arranque local

```bash
npm install
copy .env.example .env
npm start
```

Abre `http://localhost:3000/health`. Debe responder `{"ok":true,...}` aunque no
hayas puesto ninguna clave. Sin claves, el servidor arranca igual y cada fuente
reporta `false`/`not_configured`; no hay datos reales hasta configurarla.

## Pruebas

```bash
npm test
```

Prueba de humo real (`node --test`, sin frameworks): comprueba que el servidor
arranca, que `/health` responde `ok: true`, que las cinco fuentes están
registradas y que las peticiones mal formadas devuelven 404. Se ejecuta también
en cada push/PR mediante GitHub Actions (`.github/workflows/ci.yml`).

## Subir a GitHub

1. `git init` en esta carpeta y primer commit (`git add . && git commit -m "Backend de sourcing"`).
2. Crea el repositorio `sourcing-backend` (privado) en GitHub y conecta:
   `git remote add origin https://github.com/TU-USUARIO/sourcing-backend.git`.
3. `git branch -M main` y `git push -u origin main`.
4. GitHub Actions ejecutará `npm install` y `npm test` en cada cambio.

El archivo `.env` **no** se sube (está en `.gitignore`). Versión de Node fijada
en `.nvmrc`.

Paso a paso con Railway incluido: `../desplegar.html`.

## Endpoints

- `GET /health` — estado del servicio y de cada fuente.
- `POST /sourcing/:fuente/:accion` — cuerpo JSON de entrada.

Acciones por fuente:

| Fuente    | Acciones |
|-----------|----------|
| outletpc  | `ping`, `feed`, `search`, `browse` |
| lidl      | `ping`, `feed`, `search`, `browse` |
| iherb     | `ping`, `feed`, `search` |
| amazon    | `ping`, `catalog`, `item`, `offers`, `pricing`, `fees`, `listing` |
| keepa     | `ping`, `history`, `product`, `search`, `find` |
| web       | `ping`, `read`, `search` |

`listing` (Amazon) junta catálogo + ofertas + precio competitivo + fees.

`browse` (Outlet PC, Lidl) es el **barrido sin palabra clave** del paso 1 del
proceso: recorre el catálogo de la fuente (Outlet PC por novedades, Lidl por
surtido general) y devuelve los productos con descuento. El servidor compara
cada barrido con el anterior y marca `isNew` (alta nueva) y `dropPct`
(bajada de precio) usando la tabla/colección `catalog_seen`.

## Vigilante de precios (alertas)

Marca productos en el módulo (**Vigilar**) y el servidor revisa su precio de
compra **cada 12 h** (configurable). Cuando la bajada supera el umbral del
producto (5 % por defecto), crea un aviso que la herramienta muestra en la vista
**Alertas**.

- Almacén: si existe `DATABASE_URL` usa **Postgres** (tablas `watches`,
  `price_history`, `alerts`, `catalog_seen`); si no, un fichero JSON local
  (`data/alerts.json`).
- Revisión: Outlet PC y Lidl se reconsultan gratis (sin tokens). Con ASIN, el
  precio se toma de Keepa.
- `POST /alerts/run` fuerza una comprobación inmediata (no hay que esperar las
  12 h). El correo electrónico queda para una fase posterior.

## Variables de entorno

Todas opcionales al arrancar. Ver `.env.example`.

| Variable | Para qué |
|----------|----------|
| `PORT` | Puerto (Railway lo inyecta solo) |
| `ALLOWED_ORIGINS` | CORS. `*` al inicio |
| `VAULT_KEY` | Cifra los tokens en el servidor (`openssl rand -hex 32`) |
| `MARKETPLACE_ID` | ES = `A1RKKUPIHCS9HS` |
| `SPAPI_REGION` | `eu-west-1` para Europa |
| `LWA_CLIENT_ID` / `LWA_CLIENT_SECRET` | App de Amazon (Login with Amazon) |
| `SPAPI_REFRESH_TOKEN` | Token de la autorización OAuth |
| `SPAPI_SELLER_ID` | Selling Partner ID |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Firma SigV4 |
| `KEEPA_API_KEY` | BSR e histórico de precios |
| `KEEPA_DOMAIN` | ES = `9` |
| `FEED_OUTLETPC` / `FEED_LIDL` / `FEED_IHERB` | URL de feed CSV de cada fuente |
| `DATABASE_URL` | Postgres del vigilante (en Railway: servicio Postgres → Variables) |
| `ALERTS_ENABLED` | `false` desactiva el vigilante |
| `ALERT_INTERVAL_HOURS` | Horas entre revisiones (por defecto `12`) |
| `ALERT_TARGET_PCT` | Umbral de bajada por defecto en % (por defecto `5`) |
| `ALERTS_DATA_FILE` | Ruta del fichero de respaldo sin Postgres |

## Seguridad

- Primer nivel **solo lectura** en SP-API.
- Los secretos viven en el servidor (variables de entorno / vault), nunca en el
  navegador.
- No subas `.env` a GitHub (ya está en `.gitignore`).

Guía completa de despliegue: `../desplegar.html`.
