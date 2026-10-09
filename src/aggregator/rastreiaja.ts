import { createHash } from "node:crypto";
import { AggregatorError, type CarrierEvent, type TrackingAggregator, type TrackingSnapshot } from "./types.ts";

// Cliente HTTP do agregador fictício "RastreiaJá".
//
//   POST {base}/v1/trackings            { "tracking_number": "...", "carrier": "correios" | null }
//   GET  {base}/v1/trackings/{number}   → RawTracking
//   webhook                             → { "event": "tracking.updated", "data": RawTracking }

export type RawCheckpoint = {
  id?: string | null;
  checkpoint_time: string;
  status_code: string;
  message?: string | null;
  city?: string | null;
  state?: string | null;
};

export type RawTracking = {
  tracking_number: string;
  carrier_slug: string;
  checkpoints: RawCheckpoint[];
};

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

function eventKey(trackingNumber: string, checkpoint: RawCheckpoint): string {
  if (checkpoint.id) return `rj:${checkpoint.id}`;
  const content = [trackingNumber, checkpoint.checkpoint_time, checkpoint.status_code, checkpoint.city ?? "", checkpoint.message ?? ""].join("|");
  return `hash:${createHash("sha256").update(content).digest("hex").slice(0, 32)}`;
}

export function toSnapshot(raw: RawTracking): TrackingSnapshot {
  if (!raw || typeof raw.tracking_number !== "string" || !Array.isArray(raw.checkpoints)) {
    throw new AggregatorError("payload do RastreiaJá em formato inesperado", null);
  }
  const carrier = (raw.carrier_slug ?? "unknown").toLowerCase();
  const events: CarrierEvent[] = [];
  for (const checkpoint of raw.checkpoints) {
    const at = Date.parse(checkpoint.checkpoint_time);
    if (Number.isNaN(at) || typeof checkpoint.status_code !== "string") continue; // checkpoint ilegível não entra
    const place = [checkpoint.city, checkpoint.state].filter(Boolean).join("/");
    events.push({
      key: eventKey(raw.tracking_number, checkpoint),
      carrier,
      raw_status: checkpoint.status_code,
      description: checkpoint.message ?? null,
      location: place || null,
      occurred_at: new Date(at).toISOString(),
    });
  }
  return { tracking_code: raw.tracking_number, carrier, events };
}

export class RastreiaJaClient implements TrackingAggregator {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: Fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async register(trackingCode: string, carrier: string | null): Promise<void> {
    const res = await this.request("/v1/trackings", {
      method: "POST",
      body: JSON.stringify({ tracking_number: trackingCode, carrier }),
    });
    // 409 = já cadastrado: para nós é sucesso.
    if (!res.ok && res.status !== 409) throw new AggregatorError(`cadastro falhou: HTTP ${res.status}`, res.status);
  }

  async fetch(trackingCode: string): Promise<TrackingSnapshot> {
    const res = await this.request(`/v1/trackings/${encodeURIComponent(trackingCode)}`, { method: "GET" });
    if (!res.ok) throw new AggregatorError(`consulta falhou: HTTP ${res.status}`, res.status);
    return toSnapshot((await res.json()) as RawTracking);
  }

  parseWebhook(body: unknown): TrackingSnapshot {
    const data = (body as { data?: RawTracking } | null)?.data;
    if (!data) throw new AggregatorError("webhook sem data", null);
    return toSnapshot(data);
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new AggregatorError(`agregador indisponível: ${error instanceof Error ? error.message : String(error)}`, null);
    }
  }
}
