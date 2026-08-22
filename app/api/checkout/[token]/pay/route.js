import { NextResponse } from 'next/server'
import { neon } from '@neondatabase/serverless'
import { Resend } from 'resend'

const sql = neon(process.env.DATABASE_URL)
const resend = new Resend(process.env.RESEND_API_KEY)

const MAX_ORDERS = 6

export async function POST(request, { params }) {
  const { token } = params

  try {
    const body = await request.json()
    const { sourceId, supplies, amount, product, dose, note, review_rating, review_text,
            ship_address, ship_address2, ship_city, ship_state, ship_zip,
            bill_address, bill_city, bill_state, bill_zip } = body

    const rows = await sql`
      SELECT * FROM signups
      WHERE private_token = ${token} OR token = ${token}
      LIMIT 1
    `
    if (!rows.length) return NextResponse.json({ error: 'Invalid token' }, { status: 404 })
    const signup = rows[0]

    const currentOrderCount = parseInt(signup.order_count) || 0

    if (currentOrderCount === 0) {
      return NextResponse.json({ error: 'No existing order found for this account.' }, { status: 404 })
    }

    if (currentOrderCount >= MAX_ORDERS) {
      return NextResponse.json({ error: 'Maximum orders reached' }, { status: 410 })
    }

    if (signup.last_order_date) {
      const last = new Date(signup.last_order_date)
      const now  = new Date()
      const diffDays = (now - last) / (1000 * 60 * 60 * 24)
      if (diffDays < 28) {
        return NextResponse.json({ error: 'Only one order per month is allowed.' }, { status: 429 })
      }
    }

    if (signup.review_required && !signup.review_submitted && !review_rating) {
      return NextResponse.json({ error: 'Please submit your review before ordering again.' }, { status: 403 })
    }

    const finalProduct = product || signup.booster
    const finalDose    = dose || signup.current_dosage || 2.5

    const rawNote = note || `OI Body Chemistry - ${finalProduct} - ${signup.name}`
    const safeNote = rawNote.substring(0, 45)

    const nextOrder = currentOrderCount + 1
    const idempotencyKey = `${token.substring(0, 24)}-${nextOrder}-${Date.now().toString().slice(-8)}`

    const squareEnv = process.env.SQUARE_ENV === 'production'
      ? 'https://connect.squareup.com'
      : 'https://connect.squareupsandbox.com'

    const squareRes = await fetch(`${squareEnv}/v2/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
        'Square-Version': '2024-01-18',
      },
      body: JSON.stringify({
        idempotency_key: idempotencyKey,
        source_id: sourceId,
        amount_money: {
          amount: parseInt(amount) || 5390,
          currency: 'USD',
        },
        location_id: process.env.SQUARE_LOCATION_ID,
        note: safeNote,
        reference_id: `oi-${token.substring(0, 20)}`,
      }),
    })

    const squareData = await squareRes.json()

    if (!squareRes.ok || squareData.errors) {
      const errMsg = squareData.errors?.[0]?.detail || 'Payment failed.'
      console.error('Square payment error:', JSON.stringify(squareData.errors))
      return NextResponse.json({ error: errMsg }, { status: 400 })
    }

    const newOrderCount = currentOrderCount + 1

    const finalShipAddress  = ship_address  || signup.ship_address  || ''
    const finalShipCity     = ship_city     || signup.ship_city     || ''
    const finalShipState    = ship_state    || signup.ship_state    || ''
    const finalShipZip      = ship_zip      || signup.ship_zip      || ''

    await sql`
      UPDATE signups SET
        order_count      = ${newOrderCount},
        last_order_date  = NOW(),
        review_required  = true,
        review_submitted = true,
        review_rating    = ${review_rating || signup.review_rating},
        review_text      = ${review_text || signup.review_text},
        review_submitted_at = NOW(),
        booster          = ${finalProduct},
        current_dosage   = ${finalDose},
        ship_address     = ${finalShipAddress},
        ship_city        = ${finalShipCity},
        ship_state       = ${finalShipState},
        ship_zip         = ${finalShipZip}
      WHERE private_token = ${token} OR token = ${token}
    `

    await resend.emails.send({
      from:    'OI Body Chemistry <orders@oibodychemistry.com>',
      to:      signup.email,
      subject: `Order Confirmed — OI Body Chemistry`,
      html: `
        <p>Hi ${signup.name},</p>
        <p>Your order is confirmed! 🎉</p>
        <p>Booster: ${finalProduct} — ${finalDose}mg</p>
        <p>Amount: $${(parseInt(amount) / 100).toFixed(2)}</p>
        <p>Your order will ship soon. We'll be in touch!</p>
        <p>— OI Body Chemistry Team</p>
      `,
    })

    await resend.emails.send({
      from:    'OI Body Chemistry <orders@oibodychemistry.com>',
      to:      'orishainfinity@gmail.com',
      subject: `Returning Order — ${signup.name}`,
      html: `
        <p><strong>Returning Order</strong></p>
        <p>Name: ${signup.name}</p>
        <p>Email: ${signup.email}</p>
        <p>Booster: ${finalProduct} — ${finalDose}mg</p>
        <p>Supplies: ${supplies}</p>
        <p>Amount: $${(parseInt(amount) / 100).toFixed(2)}</p>
        <p>Ship to: ${finalShipAddress}, ${finalShipCity}, ${finalShipState} ${finalShipZip}</p>
      `,
    })

    return NextResponse.json({ success: true })

  } catch (err) {
    console.error('Pay route error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}