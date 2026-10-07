-- Endurecimiento de seguridad (auditoria 2026-10).
--
-- 1) Contenido de documentos KYC cifrado en reposo.
--    Hasta ahora kyc_documents solo guardaba METADATOS (nombre, tipo, estado):
--    no habia bytes de archivo. Al habilitar la subida real se decide guardar
--    el binario CIFRADO (AES-256-GCM) en la propia fila, con su MIME, tamano y
--    hash SHA-256 para integridad. La clave vive fuera de la base de datos
--    (DATA_ENCRYPTION_KEY), de modo que un volcado de PostgreSQL no basta para
--    leer un pasaporte o una nomina.
--
-- 2) Los campos sensibles de cash_requests (iban, bic, beneficiary, comment) y
--    la nota de kyc_documents se guardan ahora como texto cifrado con prefijo
--    "enc.v1:". Las columnas siguen siendo TEXT: no se cambia el esquema para
--    no romper consultas existentes. Las filas antiguas en claro se leen tal
--    cual (migracion perezosa); se recifran cuando se vuelven a escribir.
--    Nota: estas columnas son mas largas que el valor original, pero TEXT no
--    tiene limite practico.

ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS content_enc BYTEA;
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS content_mime TEXT;
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS content_size INTEGER;
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS content_sha256 TEXT;

CREATE INDEX IF NOT EXISTS ix_kyc_documents_has_content
  ON kyc_documents (client_id) WHERE content_enc IS NOT NULL;
