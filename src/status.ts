// Tradução dos dialetos das transportadoras para o conjunto estável da Conty,
// e a regra de qual é o status atual a partir do histórico.

export const STATUSES = ["posted", "in_transit", "out_for_delivery", "delivered", "exception"] as const;
export type Status = (typeof STATUSES)[number];
export type EventStatus = Status | "unknown";

/** Status cru (maiúsculo, sem espaços nas pontas) → status normalizado, por transportadora. */
const DIALECTS: Record<string, Record<string, Status>> = {
  correios: {
    PO: "posted",
    RO: "in_transit",
    DO: "in_transit",
    PAR: "in_transit",
    OEC: "out_for_delivery",
    BDE: "delivered",
    BDI: "delivered",
    BDR: "exception",
    LDI: "exception",
    FC: "exception",
  },
  jadlog: {
    COLETADO: "posted",
    EMISSAO: "posted",
    TRANSFERENCIA: "in_transit",
    "EM TRANSITO": "in_transit",
    "EM ROTA": "out_for_delivery",
    ENTREGUE: "delivered",
    DEVOLUCAO: "exception",
    AVARIA: "exception",
    EXTRAVIO: "exception",
  },
  loggi: {
    PICKED_UP: "posted",
    IN_TRANSIT: "in_transit",
    OUT_FOR_DELIVERY: "out_for_delivery",
    DELIVERED: "delivered",
    DELIVERY_FAILED: "exception",
    RETURNED: "exception",
  },
};

/**
 * Status desconhecido vira "unknown": fica no histórico, mas nunca muda o status
 * do envio. Em especial, nunca vira "delivered" por palpite em cima do texto.
 */
export function normalize(carrier: string, rawStatus: string): EventStatus {
  return DIALECTS[carrier.toLowerCase()]?.[rawStatus.trim().toUpperCase()] ?? "unknown";
}

const RANK: Record<Status, number> = { posted: 1, in_transit: 2, out_for_delivery: 3, exception: 3, delivered: 4 };

export type NormalizedEvent = { key: string; status: EventStatus; occurred_at: string };

/**
 * O status atual sai do histórico inteiro, não da ordem de chegada:
 * - entregue é terminal;
 * - senão vale o evento conhecido de maior occurred_at;
 * - empate de instante: o de maior avanço (e exceção vence saiu para entrega).
 * Como depende só do conjunto de eventos, um evento antigo que chega depois não faz o status voltar.
 */
export function currentStatus(events: NormalizedEvent[]): { status: Status; since: string; event_key: string } | null {
  const known = events.filter((event): event is NormalizedEvent & { status: Status } => event.status !== "unknown");
  if (!known.length) return null;
  const delivered = known.filter((event) => event.status === "delivered").sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))[0];
  if (delivered) return { status: "delivered", since: delivered.occurred_at, event_key: delivered.key };
  const latest = [...known].sort(
    (a, b) =>
      b.occurred_at.localeCompare(a.occurred_at) ||
      RANK[b.status] - RANK[a.status] ||
      (b.status === "exception" ? 1 : 0) - (a.status === "exception" ? 1 : 0) ||
      a.key.localeCompare(b.key),
  )[0]!;
  return { status: latest.status, since: latest.occurred_at, event_key: latest.key };
}
