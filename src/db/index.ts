import { Kysely, PostgresDialect, type Generated } from 'kysely';
import pg from 'pg';

// pg returns int8 (bigint, and SUM/COUNT results) as strings to avoid precision loss.
// Our ids and counters fit comfortably in 2^53, so parse them to numbers once, globally.
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => Number(v));

export type CouponStatus = 'active' | 'disabled';

export interface UsersTable {
  id: Generated<string>;
  email: string;
  password_hash: string;
  created_at: Generated<Date>;
}

export interface RefreshTokensTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Generated<Date>;
}

export interface CouponsTable {
  id: Generated<string>;
  code: string;
  title: string;
  description: string | null;
  status: Generated<CouponStatus>;
  total_quantity: number;
  claimed_count: Generated<number>;
  expires_at: Date | null;
  version: Generated<number>;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ClaimsTable {
  id: Generated<number>;
  coupon_id: string;
  user_id: string;
  claimed_at: Generated<Date>;
}

export interface Database {
  users: UsersTable;
  refresh_tokens: RefreshTokensTable;
  coupons: CouponsTable;
  claims: ClaimsTable;
}

export type Db = Kysely<Database>;

export function createDb(connectionString: string, poolMax: number): Db {
  const pool = new pg.Pool({ connectionString, max: poolMax, connectionTimeoutMillis: 5000 });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
