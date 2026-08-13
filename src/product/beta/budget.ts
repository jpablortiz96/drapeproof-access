import type { TryOnCategory } from "../live/types.js";
import type { DatabaseClient } from "../production/db.js";

export type BudgetReservationDecision = "AVAILABLE" | "DUPLICATE" | "BUDGET_EXHAUSTED";
export type BudgetReservationState = "RESERVED" | "SUBMITTED" | "UNCERTAIN" | "RELEASED";

export interface BudgetReservation {
  decision: BudgetReservationDecision;
  state: BudgetReservationState | null;
  unitsReserved: number;
  remainingUnits: number;
}

export interface ProviderBudgetStatus {
  utcDay: string;
  configuredBudget: number;
  reservedUnits: number;
  remainingUnits: number;
}

export interface ProviderBudgetGuard {
  reserve(input: { reservationKey: string; sessionId: string; category: TryOnCategory; expectedUnits: number; budget: number; utcDay?: string }): Promise<BudgetReservation>;
  markSubmitted(reservationKey: string, providerTaskId: string): Promise<void>;
  markUncertain(reservationKey: string): Promise<void>;
  releaseDefinitePreAcceptance(reservationKey: string): Promise<boolean>;
  status(budget: number, utcDay?: string): Promise<ProviderBudgetStatus>;
}

function day(value = new Date()): string { return value.toISOString().slice(0, 10); }

interface ReservationRow {
  decision: BudgetReservationDecision;
  reservation_state: BudgetReservationState | null;
  units_reserved: number;
  remaining_units: number;
}

export class PostgresProviderBudgetGuard implements ProviderBudgetGuard {
  constructor(private readonly database: DatabaseClient) {}

  async reserve(input: { reservationKey: string; sessionId: string; category: TryOnCategory; expectedUnits: number; budget: number; utcDay?: string }): Promise<BudgetReservation> {
    const rows = await this.database.query<ReservationRow>(
      "SELECT * FROM drapeproof_reserve_provider_units($1::date, $2, $3, $4, $5::uuid, $6)",
      [input.utcDay ?? day(), input.budget, input.expectedUnits, input.reservationKey, input.sessionId, input.category],
    );
    const row = rows[0];
    if (!row) throw new Error("Provider budget reservation returned no decision.");
    return { decision: row.decision, state: row.reservation_state, unitsReserved: row.units_reserved, remainingUnits: row.remaining_units };
  }

  async markSubmitted(reservationKey: string, providerTaskId: string): Promise<void> {
    await this.database.query(
      "UPDATE provider_unit_reservations SET state = 'SUBMITTED', provider_task_id = $2, updated_at = now() WHERE reservation_key = $1 AND state IN ('RESERVED','UNCERTAIN')",
      [reservationKey, providerTaskId],
    );
  }

  async markUncertain(reservationKey: string): Promise<void> {
    await this.database.query(
      "UPDATE provider_unit_reservations SET state = 'UNCERTAIN', updated_at = now() WHERE reservation_key = $1 AND state = 'RESERVED'",
      [reservationKey],
    );
  }

  async releaseDefinitePreAcceptance(reservationKey: string): Promise<boolean> {
    const rows = await this.database.query<{ released: boolean }>("SELECT drapeproof_release_provider_units($1) AS released", [reservationKey]);
    return rows[0]?.released === true;
  }

  async status(budget: number, utcDay = day()): Promise<ProviderBudgetStatus> {
    const rows = await this.database.query<{ reserved_units: number }>("SELECT reserved_units FROM provider_budget_days WHERE utc_day = $1::date", [utcDay]);
    const reservedUnits = rows[0]?.reserved_units ?? 0;
    return { utcDay, configuredBudget: budget, reservedUnits, remainingUnits: Math.max(0, budget - reservedUnits) };
  }
}

interface MemoryReservation { day: string; units: number; state: BudgetReservationState; taskId?: string }

export class MemoryProviderBudgetGuard implements ProviderBudgetGuard {
  private readonly reservations = new Map<string, MemoryReservation>();
  private readonly totals = new Map<string, number>();
  private lock: Promise<void> = Promise.resolve();

  private async serialized<T>(operation: () => T | Promise<T>): Promise<T> {
    let unlock!: () => void;
    const previous = this.lock;
    this.lock = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    try { return await operation(); } finally { unlock(); }
  }

  reserve(input: { reservationKey: string; sessionId: string; category: TryOnCategory; expectedUnits: number; budget: number; utcDay?: string }): Promise<BudgetReservation> {
    return this.serialized(() => {
      const utcDay = input.utcDay ?? day();
      const existing = this.reservations.get(input.reservationKey);
      const total = this.totals.get(utcDay) ?? 0;
      if (existing && existing.state !== "RELEASED") return { decision: "DUPLICATE", state: existing.state, unitsReserved: existing.units, remainingUnits: Math.max(0, input.budget - total) };
      if (total + input.expectedUnits > input.budget) return { decision: "BUDGET_EXHAUSTED", state: null, unitsReserved: 0, remainingUnits: Math.max(0, input.budget - total) };
      this.reservations.set(input.reservationKey, { day: utcDay, units: input.expectedUnits, state: "RESERVED" });
      this.totals.set(utcDay, total + input.expectedUnits);
      return { decision: "AVAILABLE", state: "RESERVED", unitsReserved: input.expectedUnits, remainingUnits: input.budget - total - input.expectedUnits };
    });
  }

  async markSubmitted(reservationKey: string, providerTaskId: string): Promise<void> {
    await this.serialized(() => { const item = this.reservations.get(reservationKey); if (item && item.state !== "RELEASED") { item.state = "SUBMITTED"; item.taskId = providerTaskId; } });
  }

  async markUncertain(reservationKey: string): Promise<void> {
    await this.serialized(() => { const item = this.reservations.get(reservationKey); if (item?.state === "RESERVED") item.state = "UNCERTAIN"; });
  }

  releaseDefinitePreAcceptance(reservationKey: string): Promise<boolean> {
    return this.serialized(() => {
      const item = this.reservations.get(reservationKey);
      if (!item || item.state !== "RESERVED") return false;
      item.state = "RELEASED";
      this.totals.set(item.day, Math.max(0, (this.totals.get(item.day) ?? 0) - item.units));
      return true;
    });
  }

  async status(budget: number, utcDay = day()): Promise<ProviderBudgetStatus> {
    const reservedUnits = this.totals.get(utcDay) ?? 0;
    return { utcDay, configuredBudget: budget, reservedUnits, remainingUnits: Math.max(0, budget - reservedUnits) };
  }
}
