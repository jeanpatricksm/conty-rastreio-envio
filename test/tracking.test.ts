import { beforeEach, describe, expect, it } from "vitest";
import { FakeRastreiaJa } from "../src/aggregator/fake-rastreiaja.ts";
import { type RawCheckpoint, RastreiaJaClient, toSnapshot } from "../src/aggregator/rastreiaja.ts";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { assessDelay } from "../src/delay.ts";
import { currentStatus, normalize } from "../src/status.ts";

const CODE = "QB123456789BR";
let now: Date;
let fake: FakeRastreiaJa;
let alerts: Array<{ shipment_id: string; message: string }>;
let app: ReturnType<typeof createApp>;

type View = {
  id: string;
  status: string | null;
  status_since: string | null;
  events: Array<{ raw_status: string; status: string }>;
  delay: { state: string; transit_hours: number | null };
  alerts: unknown[];
};

const cp = (id: string, time: string, code: string, message = ""): RawCheckpoint => ({
  id,
  checkpoint_time: time,
  status_code: code,
  message,
  city: "São Paulo",
  state: "SP",
});

async function call<T>(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function createShipment(limitHours = 72): Promise<string> {
  const res = await call<View>("POST", "/shipments", {
    tracking_code: CODE,
    carrier: "correios",
    campaign_id: "cmp_1",
    creator_id: "crt_1",
    transit_limit_hours: limitHours,
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

const refresh = (id: string) => call<{ events_added: number; shipment: View }>("POST", `/shipments/${id}/refresh`);

beforeEach(() => {
  now = new Date("2026-05-04T12:00:00.000Z");
  fake = new FakeRastreiaJa();
  alerts = [];
  app = createApp(openDatabase(), {
    aggregator: new RastreiaJaClient("https://api.rastreiaja.invalid", "test", fake.fetch),
    now: () => now,
    notify: (alert) => void alerts.push(alert),
  });
});

describe("normalização", () => {
  it("traduz o dialeto de cada transportadora", () => {
    expect(normalize("correios", "BDE")).toBe("delivered");
    expect(normalize("correios", " oec ")).toBe("out_for_delivery");
    expect(normalize("jadlog", "Em Rota")).toBe("out_for_delivery");
    expect(normalize("loggi", "delivery_failed")).toBe("exception");
  });

  it("status inventado pela transportadora vira unknown, nunca entregue", () => {
    expect(normalize("correios", "ENTREGUE_TALVEZ")).toBe("unknown");
    expect(normalize("correios", "DELIVERED")).toBe("unknown");
    expect(normalize("transportadora-nova", "ENTREGUE")).toBe("unknown");
  });

  it("exemplo de payload bruto e do status normalizado", () => {
    const snapshot = toSnapshot({
      tracking_number: CODE,
      carrier_slug: "Correios",
      checkpoints: [cp("ck_2", "2026-05-05T08:40:00-03:00", "RO", "Objeto em trânsito"), cp("ck_1", "2026-05-04T10:12:00-03:00", "PO", "Objeto postado")],
    });
    expect(snapshot.events[1]).toEqual({
      key: "rj:ck_1",
      carrier: "correios",
      raw_status: "PO",
      description: "Objeto postado",
      location: "São Paulo/SP",
      occurred_at: "2026-05-04T13:12:00.000Z",
    });
    const status = currentStatus(snapshot.events.map((e) => ({ key: e.key, status: normalize(e.carrier, e.raw_status), occurred_at: e.occurred_at })));
    expect(status).toEqual({ status: "in_transit", since: "2026-05-05T11:40:00.000Z", event_key: "rj:ck_2" });
  });
});

describe("histórico", () => {
  it("evento antigo que chega depois não faz o status voltar", async () => {
    const id = await createShipment();
    fake.push(CODE, "correios", cp("ck_3", "2026-05-06T09:00:00-03:00", "OEC"));
    expect((await refresh(id)).body.shipment.status).toBe("out_for_delivery");

    // chegam depois: postagem e trânsito, ambos anteriores
    fake.push(CODE, "correios", cp("ck_1", "2026-05-04T10:00:00-03:00", "PO"), cp("ck_2", "2026-05-05T10:00:00-03:00", "RO"));
    const after = await refresh(id);
    expect(after.body.events_added).toBe(2);
    expect(after.body.shipment.status).toBe("out_for_delivery");
    expect(after.body.shipment.status_since).toBe("2026-05-06T12:00:00.000Z");
  });

  it("entregue é terminal, mesmo se um evento de trânsito posterior chegar", async () => {
    const id = await createShipment();
    fake.push(CODE, "correios", cp("ck_1", "2026-05-04T10:00:00-03:00", "PO"), cp("ck_2", "2026-05-06T10:00:00-03:00", "BDE"));
    await refresh(id);
    fake.push(CODE, "correios", cp("ck_3", "2026-05-06T11:00:00-03:00", "RO"));
    expect((await refresh(id)).body.shipment.status).toBe("delivered");
  });

  it("status inventado fica no histórico como unknown e não muda o status", async () => {
    const id = await createShipment();
    fake.push(CODE, "correios", cp("ck_1", "2026-05-04T10:00:00-03:00", "RO"), cp("ck_2", "2026-05-05T10:00:00-03:00", "XPTO-99", "Objeto entregue ao destinatário (?)"));
    const { body } = await refresh(id);
    expect(body.shipment.status).toBe("in_transit");
    expect(body.shipment.events.map((e) => e.status)).toEqual(["in_transit", "unknown"]);
  });

  it("consultar de novo o mesmo código não duplica o histórico", async () => {
    const id = await createShipment();
    fake.push(CODE, "correios", cp("ck_1", "2026-05-04T10:00:00-03:00", "PO"), cp("ck_2", "2026-05-05T10:00:00-03:00", "RO"));
    expect((await refresh(id)).body.events_added).toBe(2);
    expect((await refresh(id)).body.events_added).toBe(0);
    expect((await refresh(id)).body.shipment.events).toHaveLength(2);
  });

  it("evento sem id do agregador é deduplicado pelo conteúdo", async () => {
    const id = await createShipment();
    const noId = { checkpoint_time: "2026-05-04T10:00:00-03:00", status_code: "PO", message: "Objeto postado", city: "São Paulo", state: "SP" };
    fake.push(CODE, "correios", noId, { ...noId });
    expect((await refresh(id)).body.events_added).toBe(1);
  });

  it("cadastrar o mesmo código duas vezes devolve o mesmo envio", async () => {
    const id = await createShipment();
    const again = await call<View>("POST", "/shipments", { tracking_code: CODE.toLowerCase(), campaign_id: "cmp_1", creator_id: "crt_1" });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(id);
  });

  it("webhook do agregador passa pelo mesmo caminho e também deduplica", async () => {
    const id = await createShipment();
    const payload = { event: "tracking.updated", data: { tracking_number: CODE, carrier_slug: "correios", checkpoints: [cp("ck_1", "2026-05-04T10:00:00-03:00", "PO")] } };
    expect((await call<{ events_added: number }>("POST", "/webhooks/aggregator", payload)).body.events_added).toBe(1);
    expect((await call<{ events_added: number }>("POST", "/webhooks/aggregator", payload)).body.events_added).toBe(0);
    expect((await call<View>("GET", `/shipments/${id}`)).body.status).toBe("posted");
  });

  it("agregador fora do ar responde 502 sem estragar o histórico", async () => {
    const id = await createShipment();
    fake.failNext = 503;
    expect((await refresh(id)).status).toBe(502);
  });
});

describe("atraso (relógio controlado, limite de 72h)", () => {
  it("avisa uma vez quando o trânsito passa do limite", async () => {
    const id = await createShipment(72);
    fake.push(CODE, "correios", cp("ck_1", "2026-05-04T09:00:00-03:00", "PO")); // 12:00Z

    now = new Date("2026-05-07T12:00:00.000Z"); // exatamente 72h: ainda no prazo
    expect((await call<{ alerted: string[] }>("POST", "/jobs/check-delays")).body.alerted).toEqual([]);

    now = new Date("2026-05-07T12:00:00.001Z");
    expect((await call<{ alerted: string[] }>("POST", "/jobs/check-delays")).body.alerted).toEqual([id]);
    expect((await call<{ alerted: string[] }>("POST", "/jobs/check-delays")).body.alerted).toEqual([]);
    expect(alerts).toHaveLength(1);
    expect((await call<View>("GET", `/shipments/${id}`)).body.delay.state).toBe("delayed");
  });

  it("entrega dentro do prazo, descoberta só depois do limite, não é atraso", async () => {
    const id = await createShipment(72);
    fake.push(CODE, "correios", cp("ck_1", "2026-05-04T09:00:00-03:00", "PO"), cp("ck_2", "2026-05-06T15:00:00-03:00", "BDE"));
    now = new Date("2026-05-10T12:00:00.000Z"); // 6 dias depois da postagem
    const { body } = await call<{ alerted: string[] }>("POST", "/jobs/check-delays");
    expect(body.alerted).toEqual([]);
    const view = (await call<View>("GET", `/shipments/${id}`)).body;
    expect(view.delay).toMatchObject({ state: "delivered_on_time", transit_hours: 54 });
    expect(alerts).toEqual([]);
  });

  it("pacote ainda não postado não conta como atraso de trânsito", async () => {
    await createShipment(72);
    now = new Date("2026-05-20T12:00:00.000Z");
    expect((await call<{ alerted: string[] }>("POST", "/jobs/check-delays")).body.alerted).toEqual([]);
  });

  it("o relógio usa o primeiro evento, mesmo quando ele chega por último", () => {
    const events = [
      { key: "b", status: "in_transit" as const, occurred_at: "2026-05-05T12:00:00.000Z" },
      { key: "a", status: "posted" as const, occurred_at: "2026-05-01T12:00:00.000Z" },
    ];
    expect(assessDelay(events, 72, new Date("2026-05-05T12:00:00.000Z"))).toMatchObject({
      transit_started_at: "2026-05-01T12:00:00.000Z",
      transit_hours: 96,
      state: "delayed",
    });
  });
});

describe("exemplo do README", () => {
  it("examples/rastreiaja-tracking.json resulta no status e no histórico documentados", async () => {
    const { readFileSync } = await import("node:fs");
    const raw = JSON.parse(readFileSync(new URL("../examples/rastreiaja-tracking.json", import.meta.url), "utf8"));
    const id = await createShipment(72);
    fake.trackings.set(CODE, raw);
    now = new Date("2026-05-06T12:12:00.000Z");
    const { body } = await refresh(id);
    expect(body.shipment).toMatchObject({ status: "out_for_delivery", status_since: "2026-05-06T12:05:00.000Z" });
    expect(body.shipment.events.map((e) => [e.raw_status, e.status])).toEqual([
      ["PO", "posted"],
      ["RO", "in_transit"],
      ["OEC", "out_for_delivery"],
      ["XPTO-99", "unknown"],
    ]);
    expect(body.shipment.delay).toMatchObject({ state: "on_time", transit_hours: 47 });
  });
});
