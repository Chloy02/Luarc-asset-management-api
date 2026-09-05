import { type Kysely, sql } from 'kysely';

// Every constraint is named explicitly. src/lib/problem.ts maps pg errors to HTTP
// problems by these names, so renaming one here means updating that map.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('users')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('email', 'text', (c) => c.notNull())
    .addColumn('password_hash', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('users_email_key', ['email'])
    .execute();

  await db.schema
    .createTable('refresh_tokens')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (c) => c.notNull())
    .addColumn('token_hash', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('revoked_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('refresh_tokens_token_hash_key', ['token_hash'])
    .addForeignKeyConstraint('refresh_tokens_user_id_fkey', ['user_id'], 'users', ['id'], (cb) =>
      cb.onDelete('cascade'),
    )
    .execute();
  await db.schema.createIndex('refresh_tokens_user_id_idx').on('refresh_tokens').column('user_id').execute();

  await db.schema
    .createTable('coupons')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('code', 'text', (c) => c.notNull())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('description', 'text')
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('active'))
    .addColumn('total_quantity', 'integer', (c) => c.notNull())
    .addColumn('claimed_count', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('expires_at', 'timestamptz')
    .addColumn('version', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('created_by', 'uuid', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('coupons_code_key', ['code'])
    .addForeignKeyConstraint('coupons_created_by_fkey', ['created_by'], 'users', ['id'])
    .addCheckConstraint('coupons_status_check', sql`status IN ('active', 'disabled')`)
    .addCheckConstraint('coupons_total_quantity_positive', sql`total_quantity > 0`)
    // The oversell backstop: even a buggy application cannot push the counter past total.
    .addCheckConstraint('coupons_claimed_within_total', sql`claimed_count >= 0 AND claimed_count <= total_quantity`)
    .execute();
  // Pool listing filters by status and pages by code.
  await db.schema.createIndex('coupons_status_code_idx').on('coupons').columns(['status', 'code']).execute();

  await db.schema
    .createTable('claims')
    // bigint identity: monotonic, exact, and the keyset cursor for /me/claims.
    .addColumn('id', 'bigint', (c) => c.primaryKey().generatedAlwaysAsIdentity())
    .addColumn('coupon_id', 'uuid', (c) => c.notNull())
    .addColumn('user_id', 'uuid', (c) => c.notNull())
    .addColumn('claimed_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    // One claim per user per coupon, enforced across concurrent transactions by the unique index.
    .addUniqueConstraint('claims_coupon_id_user_id_key', ['coupon_id', 'user_id'])
    .addForeignKeyConstraint('claims_coupon_id_fkey', ['coupon_id'], 'coupons', ['id'])
    .addForeignKeyConstraint('claims_user_id_fkey', ['user_id'], 'users', ['id'])
    .execute();
  // History: WHERE user_id = $1 AND id < $cursor ORDER BY id DESC — one backward index scan.
  await db.schema.createIndex('claims_user_id_id_idx').on('claims').columns(['user_id', 'id']).execute();
  await db.schema.createIndex('claims_coupon_id_idx').on('claims').column('coupon_id').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('claims').execute();
  await db.schema.dropTable('coupons').execute();
  await db.schema.dropTable('refresh_tokens').execute();
  await db.schema.dropTable('users').execute();
}
