// One-time migration script: copies all rows from the OLD (production) signups
// table into the NEW (oi-order) signups table.
//
// Usage:
//   1. npm install @neondatabase/serverless
//   2. node migrate.js

const { neon } = require('@neondatabase/serverless')

// OLD = production database (oi-funnel) — source of truth, read-only here
const OLD_DB_URL = 'postgresql://neondb_owner:npg_pBmhb0zC6AxF@ep-late-union-apm9kq4u-pooler.c-7.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require'

// NEW = oi-order's own database — destination
const NEW_DB_URL = 'postgresql://neondb_owner:npg_BR0oZgezpCn8@ep-young-meadow-ayhj35qf-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require'

const oldSql = neon(OLD_DB_URL)
const newSql = neon(NEW_DB_URL)

async function migrate() {
  console.log('Fetching all rows from production signups table...')
  const rows = await oldSql`SELECT * FROM signups ORDER BY id ASC`
  console.log(`Found ${rows.length} customers to migrate.`)

  let inserted = 0
  let skipped = 0

  for (const row of rows) {
    try {
      await newSql`
        INSERT INTO signups (
          id, name, phone, email, created_at, token, booster,
          ship_address, ship_address2, ship_city, ship_state, ship_zip,
          bill_address, bill_city, bill_state, bill_zip,
          checked_out, paid, private_token,
          review_required, review_submitted, last_order_date, order_count,
          review_rating, review_text, current_product, current_dosage,
          months_active, review_submitted_at,
          tracking_number, tracking_carrier, shipped_at
        ) VALUES (
          ${row.id}, ${row.name}, ${row.phone}, ${row.email}, ${row.created_at}, ${row.token}, ${row.booster},
          ${row.ship_address}, ${row.ship_address2}, ${row.ship_city}, ${row.ship_state}, ${row.ship_zip},
          ${row.bill_address}, ${row.bill_city}, ${row.bill_state}, ${row.bill_zip},
          ${row.checked_out}, ${row.paid}, ${row.private_token},
          ${row.review_required}, ${row.review_submitted}, ${row.last_order_date}, ${row.order_count},
          ${row.review_rating}, ${row.review_text}, ${row.current_product}, ${row.current_dosage},
          ${row.months_active}, ${row.review_submitted_at},
          ${row.tracking_number}, ${row.tracking_carrier}, ${row.shipped_at}
        )
        ON CONFLICT (id) DO NOTHING
      `
      inserted++
    } catch (err) {
      console.error(`Failed to insert customer id ${row.id} (${row.email}):`, err.message)
      skipped++
    }
  }

  const maxIdResult = await newSql`SELECT MAX(id) as max_id FROM signups`
  const maxId = maxIdResult[0]?.max_id || 0
  await newSql`SELECT setval('signups_id_seq', ${maxId})`

  console.log(`Done. Inserted: ${inserted}, Skipped/failed: ${skipped}`)
}

migrate().catch(err => {
  console.error('Migration failed:', err)
  process.exit(1)
})