import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { AggregatorError, type TrackingAggregator } from "./aggregator/types.ts";
import { type Notifier, ShipmentService } from "./shipments.ts";

export type AppDeps = {
  aggregator: TrackingAggregator;
  now?: () => Date;
  notify?: Notifier;
  /** Limite padrão de tempo em trânsito. */
  defaultTransitLimitHours?: number;
};

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export function createApp(db: DatabaseSync, deps: AppDeps) {
  const service = new ShipmentService(
    db,
    deps.aggregator,
    deps.now ?? (() => new Date()),
    deps.notify ?? ((alert) => console.log(JSON.stringify({ msg: "alert", ...alert }))),
    deps.defaultTransitLimitHours ?? 7 * 24,
  );
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof AggregatorError) return c.json({ error: error.message }, 502);
    throw error;
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/shipments", async (c) => {
    const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    const trackingCode = text(body.tracking_code).toUpperCase();
    const campaignId = text(body.campaign_id);
    const creatorId = text(body.creator_id);
    const limit = body.transit_limit_hours;
    if (!trackingCode || !campaignId || !creatorId) {
      return c.json({ error: "tracking_code, campaign_id e creator_id são obrigatórios" }, 400);
    }
    if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0)) {
      return c.json({ error: "transit_limit_hours deve ser um inteiro positivo" }, 400);
    }
    const result = await service.create({
      tracking_code: trackingCode,
      carrier: text(body.carrier).toLowerCase() || null,
      campaign_id: campaignId,
      creator_id: creatorId,
      transit_limit_hours: limit as number | undefined,
    });
    return c.json(result.shipment, result.created ? 201 : 200);
  });

  app.get("/shipments/:id", (c) => {
    const view = service.view(c.req.param("id"));
    return view ? c.json(view) : c.json({ error: "envio não encontrado" }, 404);
  });

  app.post("/shipments/:id/refresh", async (c) => {
    const result = await service.refresh(c.req.param("id"));
    return result ? c.json(result) : c.json({ error: "envio não encontrado" }, 404);
  });

  app.post("/webhooks/aggregator", async (c) => {
    const body = await c.req.json().catch(() => null);
    try {
      const result = await service.ingestWebhook(body);
      // Código que não é nosso: 200 para o agregador não reenviar sem fim.
      return c.json(result ? { events_added: result.events_added } : { ignored: true });
    } catch (error) {
      if (error instanceof AggregatorError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  app.post("/jobs/check-delays", async (c) => c.json(await service.checkDelays()));

  return app;
}
