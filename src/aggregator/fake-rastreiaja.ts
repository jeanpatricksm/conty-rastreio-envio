import type { RawCheckpoint, RawTracking } from "./rastreiaja.ts";

/**
 * Servidor do RastreiaJá simulado em memória, no nível do fetch: o cliente HTTP
 * real roda por cima dele. `checkpoints` pode ser editado entre consultas para
 * simular eventos novos, repetidos ou fora de ordem.
 */
export class FakeRastreiaJa {
  readonly trackings = new Map<string, RawTracking>();
  failNext: number | null = null;
  requests: string[] = [];

  push(trackingNumber: string, carrier: string, ...checkpoints: RawCheckpoint[]): this {
    const tracking = this.trackings.get(trackingNumber) ?? { tracking_number: trackingNumber, carrier_slug: carrier, checkpoints: [] };
    tracking.checkpoints.push(...checkpoints);
    this.trackings.set(trackingNumber, tracking);
    return this;
  }

  readonly fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    this.requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (this.failNext) {
      const status = this.failNext;
      this.failNext = null;
      return new Response(JSON.stringify({ error: "falha simulada" }), { status });
    }
    if (init?.method === "POST" && url.pathname === "/v1/trackings") {
      const body = JSON.parse(String(init.body)) as { tracking_number: string; carrier: string | null };
      if (this.trackings.has(body.tracking_number)) return new Response("{}", { status: 409 });
      this.trackings.set(body.tracking_number, { tracking_number: body.tracking_number, carrier_slug: body.carrier ?? "correios", checkpoints: [] });
      return new Response("{}", { status: 201 });
    }
    const match = /^\/v1\/trackings\/(.+)$/.exec(url.pathname);
    const tracking = match ? this.trackings.get(decodeURIComponent(match[1]!)) : undefined;
    if (!tracking) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    // Devolve uma cópia embaralhada: o agregador não garante ordem.
    const shuffled = [...tracking.checkpoints].reverse();
    return Response.json({ ...tracking, checkpoints: shuffled });
  };
}
