import type { NormalizedEvent, Status } from "./status.ts";

export type DelayAssessment = {
  /** Início do relógio: primeiro evento de postagem ou movimento. null = ainda não postado. */
  transit_started_at: string | null;
  /** Fim do relógio: entrega, se houve. */
  delivered_at: string | null;
  limit_hours: number;
  transit_hours: number | null;
  state: "not_started" | "on_time" | "delayed" | "delivered_on_time" | "delivered_late";
};

const HOUR = 3_600_000;
const MOVING: Status[] = ["posted", "in_transit", "out_for_delivery", "delivered", "exception"];

/**
 * Atraso = tempo em trânsito acima do limite, medido entre o primeiro evento da
 * transportadora e a entrega (pelo occurred_at do evento, não pela hora em que
 * ficamos sabendo) ou, sem entrega, o agora.
 * - Não postado: o relógio não começou, não é atraso de trânsito.
 * - Entregue dentro do limite nunca é atraso, mesmo que a consulta chegue dias depois.
 * - Exatamente no limite ainda está no prazo.
 */
export function assessDelay(events: NormalizedEvent[], limitHours: number, now: Date): DelayAssessment {
  const known = events.filter((event) => MOVING.includes(event.status as Status));
  const start = known.map((event) => event.occurred_at).sort()[0] ?? null;
  const delivered = known.filter((event) => event.status === "delivered").map((event) => event.occurred_at).sort()[0] ?? null;
  if (!start) return { transit_started_at: null, delivered_at: null, limit_hours: limitHours, transit_hours: null, state: "not_started" };

  const end = delivered ? Date.parse(delivered) : now.getTime();
  const hours = Math.max(0, (end - Date.parse(start)) / HOUR);
  const late = hours > limitHours;
  return {
    transit_started_at: start,
    delivered_at: delivered,
    limit_hours: limitHours,
    transit_hours: Math.round(hours * 100) / 100,
    state: delivered ? (late ? "delivered_late" : "delivered_on_time") : late ? "delayed" : "on_time",
  };
}
