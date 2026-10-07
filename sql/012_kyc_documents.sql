-- Documentos de verificacion (KYC) persistidos en el robot.
--
-- Hasta ahora las pestanas "Selfie + ID", "SOF" y "POA" de la ficha de cliente
-- del CRM solo tenian datos en el almacen del prototipo (localStorage), de modo
-- que en MODO LIVE aparecian siempre como "No hecho". Aqui se crea la tabla que
-- guarda los documentos reales de cada cliente y su estado de revision, para
-- que el robot sea la unica fuente de verdad.
--
-- Tipos admitidos: selfie, id, source_funds (SOF) y proof_address (POA).
-- Estados: received (recibido), approved (aprobado) y rejected (rechazado).

CREATE SEQUENCE IF NOT EXISTS kyc_document_number_seq START 1;

CREATE TABLE IF NOT EXISTS kyc_documents (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'received',
  note        TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT kyc_documents_type_chk CHECK (type IN ('selfie','id','source_funds','proof_address')),
  CONSTRAINT kyc_documents_status_chk CHECK (status IN ('received','approved','rejected'))
);

CREATE INDEX IF NOT EXISTS ix_kyc_documents_client ON kyc_documents (client_id, type);
CREATE INDEX IF NOT EXISTS ix_kyc_documents_uploaded ON kyc_documents (uploaded_at DESC);
