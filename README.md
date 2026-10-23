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

Fuentes: `outletpc`, `lidl`, `iherb`, `amazon`, `keepa`, `web` y, por perfil de
lectura web, `selectavision`, `yesstyle`, `corteingles`, `zalandoprive`,
`gemimarket`, `norica`, `famosa`, `planafabrega`, `vallesviasat`; más los
canales `storefronts`, `tarifas`, `liquidaciones` y `newsletters`.

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
| selectavision · yesstyle · corteingles · zalandoprive · gemimarket · norica · famosa · planafabrega · vallesviasat | `ping`, `feed`, `search`, `browse` |
| storefronts | `ping`, `seller`, `browse`, `reverse` |
| tarifas · liquidaciones | `ping`, `parse`, `browse`, `search`, `lookup` |
| newsletters | `ping`, `parse`, `browse`, `search` |
| amazon    | `ping`, `catalog`, `item`, `offers`, `pricing`, `fees`, `listing` |
| keepa     | `ping`, `history`, `product`, `search`, `find` |
| web       | `ping`, `read`, `search` |

`listing` (Amazon) junta catálogo + ofertas + precio competitivo + fees.

## Adaptadores por perfil (outlets y mayoristas)

Los outlet y mayoristas/fabricantes del PDF ya no están "declarados": cada uno
tiene adaptador en `backend/src/adapters/sources/catalog.js` (perfiles) que se
generan con `backend/src/adapters/profile.js`. Leen el catálogo de la web por
**JSON-LD (schema.org), microdata o heurística de anclas** (`lib/parse.js`),
reutilizando la cascada proveedor → directo → `r.jina.ai`. Sin claves; con
Cloudflare conviene `SCRAPER_PROVIDER`. `zalandoprive` exige sesión y responde
`requires_auth`.

## Storefronts FBA (búsqueda inversa)

`storefronts/seller` lee el catálogo público de un vendedor (sellerId o URL) y
devuelve sus ASINs. `storefronts/reverse` parte de un ASIN y devuelve los
vendedores que lo ofrecen (SP-API `getItemOffers` cuando hay credenciales) y la
búsqueda de ese ASIN en cada fuente del PDF. Regla fija: nunca crea ASIN.

## Fabricante / distribuidor / mayorista por EAN (v0.29)

`POST /suppliers/start` lanza ahora, en paralelo a la cascada de ofertas, el
buscador de **quien suministra** el producto (`adapters/fabricantes.js` +
`lib/leads.js`). Hace las mismas busquedas que se hacen a mano en Google
(`"<EAN>" mayorista`, `"<EAN>" distribuidor`, `"<EAN>" al por mayor`,
`"<marca>" distribuidor oficial España`, `"<marca>" "<modelo>" mayorista`...),
agrupa los resultados por dominio y los clasifica: fabricante, distribuidor
oficial, mayorista, marketplace B2B, base de datos EAN y minorista (apartado).
Despues abre las mejores paginas para confirmar EAN, precios tras registro,
email/telefono y enlace a "distribuidores/profesionales". No exige precio:
los proveedores B2B casi nunca lo publican. El resultado llega en
`result.leads` y la interfaz lo muestra arriba del todo. Solo esta parte:
`POST /sourcing/inverso/leads`.

## Historial de busquedas (v0.32)

Las busquedas de productos se guardan (30 ultimas). Una busqueda identica de
menos de 24 h se sirve guardada sin gastar tokens; "Refrescar" la repite en
Keepa. Las busquedas de proveedores se guardan por ASIN/EAN (200 ultimas,
validas 14 dias) y se muestran al abrir la ficha. Rutas: `GET /history`,
`GET /history/:kind/:id`, `DELETE /history/:kind/:id`.

## Fabricantes / distribuidores y correo automatico (v0.31-0.32)

`/contacts` guarda los proveedores elegidos en "Buscar proveedores" y busca su
email/telefono/WhatsApp/CIF en su web. `/outreach` envia por SMTP (cPanel) un
correo de bienvenida y seguimientos en el mismo hilo cada 2-3 dias en horario
laboral, hasta 10, y lee el buzon por IMAP: si contestan, para la secuencia,
marca el contacto como favorito y crea una alerta; si piden la baja, para.
Necesita Postgres (`DATABASE_URL`) para no perder contactos ni historial.

## Tarifas, liquidaciones y newsletters (canales)

`tarifa.js` y `newsletters.js` normalizan ficheros/correos al mismo contrato.
`/parse` acepta `csv`/`tsv`/`text`, `rows` ya parseadas o `feed` (URL): tarifas
por EAN + precio neto. Al leer un canal de fichero el servidor **indexa cada
línea por EAN** (tabla/colección `tariff_seen`) y `tarifas/lookup` (o
`liquidaciones/lookup`) devuelve las que coincidan con uno o varios EAN para
**cruzar la tarifa contra el proveedor** en el análisis de cada oportunidad.
`newsletters/parse` extrae productos y precios de un correo EML/HTML/texto
pegado (Gmail OAuth, fase posterior).

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
  `price_history`, `alerts`, `catalog_seen`, `tariff_seen`); si no, un fichero
  JSON local (`data/alerts.json`).
- Revisión: Outlet PC y Lidl se reconsultan gratis (sin tokens). Con ASIN, el
  precio se toma de Keepa.
- `POST /alerts/run` fuerza una comprobación inmediata (no hay que esperar las
  12 h). El correo electrónico queda para una fase posterior.

## Variables de entorno

Todas opcionales al arrancar. Ver `.env.example`.

| Variable | Para qué |
|----------|----------|
| `PORT` | Puerto (Railway lo inyecta solo) |
| `API_KEYS` | Claves separadas por comas. El navegador envía una en `X-API-Key`. Sin ella en producción, `/sourcing`, `/alerts` y `/suppliers` responden 503 |
| `ALLOWED_ORIGINS` | CORS, separados por comas. En producción: `https://tools.bruneagroup.com` (nunca `*`) |
| `RATE_LIMIT_PER_MIN` | Peticiones por minuto y clave/IP (por defecto `60`) |
| `BEACON_RATE_PER_MIN` / `BEACON_MAX_BYTES` / `BEACON_MAX_LINES` | Topes del beacon de diagnóstico (`30`, `16384`, `25`) |
| `BB_SELLER_LOOKUPS` / `BB_MANUFACTURER_MIN` / `BB_THIRD_MAX` / `BB_SINGLE_THIRD` | Regla Buy Box: vendedores a consultar y umbrales (`3`, `95`, `5`, `97`) |
| `VAULT_KEY` | Cifra los tokens en el servidor (`openssl rand -hex 32`) |
| `MARKETPLACE_ID` | ES = `A1RKKUPIHCS9HS` |
| `SPAPI_REGION` | `eu-west-1` para Europa |
| `LWA_CLIENT_ID` / `LWA_CLIENT_SECRET` | App de Amazon (Login with Amazon) |
| `SPAPI_REFRESH_TOKEN` | Token de la autorización OAuth |
| `SPAPI_SELLER_ID` | Selling Partner ID |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Firma SigV4 |
| `KEEPA_API_KEY` | BSR e histórico de precios |
| `KEEPA_DOMAIN` | ES = `9` |
| `FEED_<FUENTE>` | URL de feed CSV de una fuente (`FEED_OUTLETPC`, `FEED_LIDL`, `FEED_IHERB`, `FEED_SELECTAVISION`, `FEED_YESSTYLE`, `FEED_CORTEINGLES`, `FEED_GEMIMARKET`, `FEED_NORICA`, `FEED_FAMOSA`, `FEED_PLANAFABREGA`, `FEED_VALLESVIASAT`) |
| `DATABASE_URL` | Postgres del vigilante (en Railway: servicio Postgres → Variables) |
| `ALERTS_ENABLED` | `false` desactiva el vigilante |
| `ALERT_INTERVAL_HOURS` | Horas entre revisiones (por defecto `12`) |
| `ALERT_TARGET_PCT` | Umbral de bajada por defecto en % (por defecto `5`) |
| `ALERTS_DATA_FILE` | Ruta del fichero de respaldo sin Postgres |

## Seguridad

- Primer nivel **solo lectura** en SP-API.
- Las rutas privadas exigen `X-API-Key`; sin `API_KEYS` en producción fallan cerradas.
- CORS solo acepta los orígenes de `ALLOWED_ORIGINS` (sin `*` en producción).
- Límite de peticiones por minuto y topes de tamaño/frecuencia en `/debug/beacon`.
- Los secretos viven en el servidor (variables de entorno / vault), nunca en el
  navegador.
- No subas `.env` a GitHub (ya está en `.gitignore`).

Guía completa de despliegue: `../desplegar.html`.
