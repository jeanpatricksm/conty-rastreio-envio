import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY,
  tracking_code TEXT NOT NULL UNIQUE,
  carrier TEXT,
  campaign_id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  transit_limit_hours INTEGER NOT NULL,
  status TEXT,
  status_since TEXT,
  created_at TEXT NOT NULL,
  last_checked_at TEXT
);

-- Histórico: (envio, chave do evento) é único, consultar de novo não duplica.
CREATE TABLE IF NOT EXISTS tracking_events (
  shipment_id TEXT NOT NULL REFERENCES shipments (id),
  event_key TEXT NOT NULL,
  carrier TEXT NOT NULL,
  raw_status TEXT NOT NULL,
  status TEXT NOT NULL,
  description TEXT,
  location TEXT,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (shipment_id, event_key)
);

-- Um aviso de atraso por envio.
CREATE TABLE IF NOT EXISTS alerts (
  shipment_id TEXT NOT NULL REFERENCES shipments (id),
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (shipment_id, kind)
);
`;

export function openDatabase(path = ":memory:"): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
