import type { DatabaseSync } from "node:sqlite";
import type { TrackingAggregator, TrackingSnapshot } from "./aggregator/types.ts";
import { assessDelay } from "./delay.ts";
import { currentStatus, type EventStatus, normalize, type NormalizedEvent } from "./status.ts";

export type Notifier = (alert: { shipment_id: string; kind: string; message: string }) => void | Promise<void>;

type ShipmentRow = {
  id: string;
  tracking_code: string;
  carrier: string | null;
  campaign_id: string;
  creator_id: string;
  transit_limit_hours: number;
  status: string | null;
  status_since: string | null;
  created_at: string;
  last_checked_at: string | null;
};

type EventRow = {
  event_key: string;
  carrier: string;
  raw_status: string;
  status: EventStatus;
  description: string | null;
  location: string | null;
  occurred_at: string;
  received_at: string;
};

export class ShipmentService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly aggregator: TrackingAggregator,
    private readonly now: () => Date,
    private readonly notify: Notifier,
    private readonly defaultLimitHours: number,
  ) {}

  async create(input: { tracking_code: string; carrier: string | null; campaign_id: string; creator_id: string; transit_limit_hours?: number }) {
    const existing = this.row("tracking_code", input.tracking_code);
    if (existing) return { created: false, shipment: this.view(existing.id)! };
    await this.aggregator.register(input.tracking_code, input.carrier);
    const id = `shp_${crypto.randomUUID()}`;
    this.db
      .prepare(
        "INSERT INTO shipments (id, tracking_code, carrier, campaign_id, creator_id, transit_limit_hours, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.tracking_code, input.carrier, input.campaign_id, input.creator_id, input.transit_limit_hours ?? this.defaultLimitHours, this.now().toISOString());
    return { created: true, shipment: this.view(id)! };
  }

  /** Consulta o agregador e aplica o histórico. */
  async refresh(id: string) {
    const shipment = this.row("id", id);
    if (!shipment) return null;
    const snapshot = await this.aggregator.fetch(shipment.tracking_code);
    return this.apply(shipment, snapshot);
  }

  /** Webhook do agregador: mesmo caminho da consulta. */
  async ingestWebhook(body: unknown) {
    const snapshot = this.aggregator.parseWebhook(body);
    const shipment = this.row("tracking_code", snapshot.tracking_code);
    if (!shipment) return null;
    return this.apply(shipment, snapshot);
  }

  /** Job periódico: avalia atraso de tudo que não foi entregue e avisa uma vez. */
  async checkDelays(options: { refresh: boolean } = { refresh: true }) {
    const open = this.db.prepare("SELECT id FROM shipments WHERE status IS NULL OR status != 'delivered'").all() as Array<{ id: string }>;
    const alerted: string[] = [];
    for (const { id } of open) {
      let alertedOnRefresh = false;
      if (options.refresh) {
        try {
          alertedOnRefresh = (await this.refresh(id))?.alerted ?? false;
        } catch {
          // Agregador fora: avalia com o histórico que já temos.
        }
      }
      if (alertedOnRefresh || (await this.alertIfDelayed(id))) alerted.push(id);
    }
    return { checked: open.length, alerted };
  }

  view(id: string) {
    const shipment = this.row("id", id);
    if (!shipment) return null;
    const events = this.events(id);
    return {
      ...shipment,
      delay: assessDelay(events.map(toNormalized), shipment.transit_limit_hours, this.now()),
      events,
      alerts: this.db.prepare("SELECT kind, message, created_at FROM alerts WHERE shipment_id = ?").all(id),
    };
  }

  private async apply(shipment: ShipmentRow, snapshot: TrackingSnapshot) {
    const at = this.now().toISOString();
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO tracking_events (shipment_id, event_key, carrier, raw_status, status, description, location, occurred_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    let added = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const event of snapshot.events) {
        const status = normalize(event.carrier, event.raw_status);
        added += Number(
          insert.run(shipment.id, event.key, event.carrier, event.raw_status, status, event.description, event.location, event.occurred_at, at).changes,
        );
      }
      const current = currentStatus(this.events(shipment.id).map(toNormalized));
      this.db
        .prepare("UPDATE shipments SET carrier = COALESCE(carrier, ?), status = ?, status_since = ?, last_checked_at = ? WHERE id = ?")
        .run(snapshot.carrier, current?.status ?? null, current?.since ?? null, at, shipment.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const alerted = await this.alertIfDelayed(shipment.id);
    return { events_added: added, alerted, shipment: this.view(shipment.id)! };
  }

  private async alertIfDelayed(id: string): Promise<boolean> {
    const view = this.view(id)!;
    if (view.delay.state !== "delayed") return false;
    const message = `${view.tracking_code} em trânsito há ${view.delay.transit_hours}h, acima do limite de ${view.delay.limit_hours}h`;
    const inserted = this.db
      .prepare("INSERT OR IGNORE INTO alerts (shipment_id, kind, message, created_at) VALUES (?, 'transit_delayed', ?, ?)")
      .run(id, message, this.now().toISOString()).changes;
    if (!inserted) return false;
    await this.notify({ shipment_id: id, kind: "transit_delayed", message });
    return true;
  }

  private row(column: "id" | "tracking_code", value: string): ShipmentRow | undefined {
    return this.db.prepare(`SELECT * FROM shipments WHERE ${column} = ?`).get(value) as ShipmentRow | undefined;
  }

  private events(id: string): EventRow[] {
    return this.db
      .prepare(
        "SELECT event_key, carrier, raw_status, status, description, location, occurred_at, received_at FROM tracking_events WHERE shipment_id = ? ORDER BY occurred_at, event_key",
      )
      .all(id) as EventRow[];
  }
}

const toNormalized = (event: EventRow): NormalizedEvent => ({ key: event.event_key, status: event.status, occurred_at: event.occurred_at });
