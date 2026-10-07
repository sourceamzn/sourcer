ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS event_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_audit_events_event_id ON audit_events (event_id);
