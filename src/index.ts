import { serve } from "@hono/node-server";
import { FakeRastreiaJa } from "./aggregator/fake-rastreiaja.ts";
import { RastreiaJaClient } from "./aggregator/rastreiaja.ts";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";

// Sem RASTREIAJA_URL, o cliente HTTP real roda sobre o agregador simulado em memória.
const fake = new FakeRastreiaJa();
const aggregator = process.env.RASTREIAJA_URL
  ? new RastreiaJaClient(process.env.RASTREIAJA_URL, process.env.RASTREIAJA_API_KEY ?? "")
  : new RastreiaJaClient("https://api.rastreiaja.invalid", "dev", fake.fetch);

if (!process.env.RASTREIAJA_URL) {
  fake.push(
    "QB123456789BR",
    "correios",
    { id: "ck_1", checkpoint_time: "2026-05-04T10:12:00-03:00", status_code: "PO", message: "Objeto postado", city: "São Paulo", state: "SP" },
    { id: "ck_2", checkpoint_time: "2026-05-05T08:40:00-03:00", status_code: "RO", message: "Objeto em trânsito - por favor aguarde", city: "Cajamar", state: "SP" },
  );
}

const db = openDatabase(process.env.DB_PATH ?? "data/rastreio.sqlite");
const port = Number(process.env.PORT ?? 3007);
const limitHours = Number(process.env.TRANSIT_LIMIT_HOURS ?? 7 * 24);

serve({ fetch: createApp(db, { aggregator, defaultTransitLimitHours: limitHours }).fetch, port }, (info) => {
  console.log(`rastreio em http://127.0.0.1:${info.port}`);
});
