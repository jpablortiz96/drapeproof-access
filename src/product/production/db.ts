import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

export interface DatabaseClient {
  query<T>(text: string, parameters?: unknown[]): Promise<T[]>;
  health(): Promise<boolean>;
}

export class NeonDatabaseClient implements DatabaseClient {
  private readonly sql: NeonQueryFunction<false, false>;

  constructor(connectionString: string) {
    this.sql = neon(connectionString, { fetchOptions: { cache: "no-store" } });
  }

  async query<T>(text: string, parameters: unknown[] = []): Promise<T[]> {
    return await this.sql.query(text, parameters) as T[];
  }

  async health(): Promise<boolean> {
    try {
      const rows = await this.query<{ ok: number }>("SELECT 1 AS ok");
      return rows[0]?.ok === 1;
    } catch {
      return false;
    }
  }
}
