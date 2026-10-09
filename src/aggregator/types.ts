// Fronteira com o agregador de rastreio. Só este diretório conhece o formato dele;
// o resto do código vê apenas CarrierEvent, com o status cru da transportadora.

export type CarrierEvent = {
  /** Identidade estável do evento: id do agregador ou hash do conteúdo. */
  key: string;
  carrier: string;
  /** Código ou texto de status exatamente como a transportadora mandou. */
  raw_status: string;
  description: string | null;
  location: string | null;
  occurred_at: string;
};

export type TrackingSnapshot = { tracking_code: string; carrier: string; events: CarrierEvent[] };

export interface TrackingAggregator {
  /** Cadastra o código para o agregador começar a acompanhar. Idempotente. */
  register(trackingCode: string, carrier: string | null): Promise<void>;
  /** Consulta o histórico completo atual. Pode vir repetido e fora de ordem. */
  fetch(trackingCode: string): Promise<TrackingSnapshot>;
  /** Traduz o corpo de um webhook do agregador. */
  parseWebhook(body: unknown): TrackingSnapshot;
}

export class AggregatorError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}
