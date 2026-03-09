import { createHmac, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { Pool } from 'pg'
import { z } from 'zod'

const app = new Hono()
const port = Number(process.env.PORT || 8000)
const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error('DATABASE_URL belum diset')
}

const pool = new Pool({ connectionString: databaseUrl })

const createPaymentSchema = z.object({
  amount: z.number().int().positive(),
  qrisPayload: z.string().min(20),
  orderId: z.string().trim().min(3).max(64).optional(),
})

const gobizSearchSchema = z
  .object({
    merchantId: z.string().trim().min(3).optional(),
    from: z.number().int().min(0).default(0),
    size: z.number().int().min(1).max(100).default(20),
    fromTimeISO: z.string().datetime().optional(),
    toTimeISO: z.string().datetime().optional(),
    settlementOnly: z.boolean().default(true),
    qrisOnly: z.boolean().default(true),
    includeRaw: z.boolean().default(false),
    rawPayload: z.unknown().optional(),
  })
  .refine(
    data => Boolean(data.rawPayload) || Boolean(data.merchantId && data.fromTimeISO && data.toTimeISO),
    {
      message: 'Isi rawPayload atau kombinasi merchantId + fromTimeISO + toTimeISO',
    },
  )

const gobizMatchSchema = z.object({
  amount: z.number().int().positive(),
  merchantId: z.string().trim().min(3).optional(),
  fromTimeISO: z.string().datetime(),
  toTimeISO: z.string().datetime(),
  size: z.number().int().min(1).max(100).default(20),
})

const statusMap: Record<string, 'PENDING' | 'PAID' | 'EXPIRED' | 'FAILED'> = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  SETTLED: 'PAID',
  SUCCESS: 'PAID',
  EXPIRED: 'EXPIRED',
  FAILED: 'FAILED',
  CANCELED: 'FAILED',
}

function normalizeQrisPayload(rawPayload: string) {
  return String(rawPayload || '').replace(/[\r\n\t]/g, '').trim()
}

function calculateCrc16Ccitt(input: string) {
  let crc = 0xffff
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1)
      crc &= 0xffff
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}

function validateQrisPayload(rawPayload: string):
  | { valid: true; payload: string }
  | { valid: false; error: string } {
  const payload = normalizeQrisPayload(rawPayload)
  if (!payload) {
    return { valid: false, error: 'Payload kosong' }
  }
  if (!payload.startsWith('000201')) {
    return { valid: false, error: 'Header EMV tidak dikenali' }
  }
  const crcTagIndex = payload.lastIndexOf('6304')
  if (crcTagIndex < 0 || crcTagIndex + 8 !== payload.length) {
    return { valid: false, error: 'Tag CRC tidak valid' }
  }
  const expectedCrc = payload.slice(crcTagIndex + 4).toUpperCase()
  const payloadForChecksum = payload.slice(0, crcTagIndex + 4)
  const calculatedCrc = calculateCrc16Ccitt(payloadForChecksum)
  if (expectedCrc !== calculatedCrc) {
    return { valid: false, error: `CRC tidak cocok, seharusnya ${calculatedCrc}` }
  }
  return { valid: true, payload }
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id UUID PRIMARY KEY,
      order_id TEXT,
      amount BIGINT NOT NULL,
      status TEXT NOT NULL,
      qris_payload_hash TEXT NOT NULL,
      qr_string TEXT NOT NULL,
      merchant_name TEXT,
      provider_tx_id TEXT,
      provider_reference TEXT,
      raw_create_response JSONB,
      paid_at TIMESTAMPTZ,
      expired_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id UUID PRIMARY KEY,
      provider_event_id TEXT UNIQUE,
      event_type TEXT,
      signature_valid BOOLEAN NOT NULL,
      payload JSONB NOT NULL,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status);`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments (created_at DESC);`)
}

async function generateDynamicQris(qrisPayload: string, amount: number) {
  const swiftBase = process.env.SWIFTQR_BASE_URL || 'https://api-mininxd.vercel.app'
  const createPath = process.env.SWIFTQR_CREATE_PATH || '/qris'
  const token = process.env.SWIFTQR_API_KEY

  const url = new URL(createPath, swiftBase)
  url.searchParams.set('qris', qrisPayload)
  url.searchParams.set('nominal', String(amount))

  const response = await fetch(url.toString(), {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })

  if (!response.ok) {
    throw new Error(`SwiftQR response ${response.status}`)
  }

  const data = await response.json() as Record<string, string>
  const qrString = data.QR || data.qr || data.qris
  if (!qrString) {
    throw new Error('SwiftQR tidak mengembalikan QR string')
  }

  return {
    qrString,
    merchant: data.merchant || null,
    providerTxId: data.transaction_id || data.txid || data.id || null,
    providerReference: data.reference || data.ref || null,
    raw: data,
  }
}

function sha256(text: string) {
  return createHmac('sha256', 'qris-payload-hash').update(text).digest('hex')
}

function verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined) {
  const secret = process.env.SWIFTQR_WEBHOOK_SECRET
  if (!secret) {
    return true
  }
  if (!signatureHeader) {
    return false
  }

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  const normalizedHeader = signatureHeader.trim().toLowerCase().startsWith('sha256=')
    ? signatureHeader.trim().slice(7)
    : signatureHeader.trim()

  if (!/^[a-fA-F0-9]{64}$/.test(normalizedHeader)) {
    return false
  }

  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(normalizedHeader, 'hex')
  if (a.length !== b.length) {
    return false
  }
  return timingSafeEqual(a, b)
}

async function searchGobizJournals(params: z.infer<typeof gobizSearchSchema>) {
  const baseUrl = process.env.GOBIZ_BASE_URL || 'https://api.gobiz.co.id'
  const endpointPath = process.env.GOBIZ_JOURNALS_SEARCH_PATH || '/journals/search'
  const authType = process.env.GOBIZ_AUTHENTICATION_TYPE || 'go-id'
  const bearerToken = process.env.GOBIZ_BEARER_TOKEN

  if (!bearerToken) {
    throw new Error('GOBIZ_BEARER_TOKEN belum diset di environment')
  }

  const url = new URL(endpointPath, baseUrl)
  const generatedPayload = {
    from: params.from,
    size: params.size,
    sort: { time: { order: 'desc' } },
    included_categories: { incoming: ['transaction_share', 'action'] },
    query: [
      {
        op: 'and',
        clauses: [
          {
            op: 'not',
            clauses: [
              {
                field: 'metadata.transaction.status',
                op: 'in',
                value: ['deny', 'cancel', 'failure', 'expire'],
              },
            ],
          },
          {
            field: 'metadata.transaction.status',
            op: 'in',
            value: params.settlementOnly ? ['settlement'] : ['capture', 'settlement'],
          },
          {
            op: 'or',
            clauses: [
              {
                op: 'or',
                clauses: [
                  {
                    field: 'metadata.transaction.payment_type',
                    op: 'in',
                    value: params.qrisOnly ? ['qris'] : ['qris', 'gopay', 'bank_transfer'],
                  },
                ],
              },
            ],
          },
          {
            field: 'metadata.transaction.transaction_time',
            op: 'gte',
            value: params.fromTimeISO!,
          },
          {
            field: 'metadata.transaction.transaction_time',
            op: 'lte',
            value: params.toTimeISO!,
          },
          {
            field: 'metadata.transaction.merchant_id',
            op: 'equal',
            value: params.merchantId!,
          },
        ],
      },
    ],
  }
  const payload = params.rawPayload ?? generatedPayload

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*, application/vnd.journal.v1+json',
      'content-type': 'application/json',
      'authentication-type': authType,
      authorization: `Bearer ${bearerToken}`,
      origin: process.env.GOBIZ_ORIGIN || 'https://portal.gofoodmerchant.co.id',
      referer: process.env.GOBIZ_REFERER || 'https://portal.gofoodmerchant.co.id/',
    },
    body: JSON.stringify(payload),
  })

  const data = await response.json() as Record<string, unknown>
  if (!response.ok) {
    throw new Error(`GOBIZ request gagal (${response.status}): ${JSON.stringify(data)}`)
  }

  return data
}

function normalizeGobizHits(hits: unknown[]) {
  return hits.map((hit: any) => {
    const transaction = hit?.metadata?.transaction || {}
    const rawAmount = Number(hit?.amount || transaction?.gross_amount || 0)
    const currency = String(hit?.currency || transaction?.currency || 'IDR').toUpperCase()
    const majorAmount = currency === 'IDR' ? rawAmount / 100 : rawAmount
    const gopayTransactionId =
      hit?.metadata?.gopay?.gopay_transaction_id ||
      hit?.metadata?.acquirer_transaction_id ||
      transaction?.metadata?.INTERNAL_CHALLENGE_ID ||
      null

    return {
      id: hit?.id || transaction?.id || null,
      referenceId: hit?.reference_id || null,
      amount: majorAmount,
      rawAmount,
      currency,
      status: transaction?.status || hit?.status || null,
      paymentType: transaction?.payment_type || null,
      orderId: transaction?.order_id || null,
      merchantId: transaction?.merchant_id || hit?.merchant_id || null,
      transactionTime: transaction?.transaction_time || hit?.time || null,
      settlementTime: transaction?.settlement_time || transaction?.transaction_times?.settlement_time || null,
      gopayTransactionId,
      providerEventId: hit?.metadata?.event_id || null,
    }
  })
}

function summarizeGobizNormalized(normalized: ReturnType<typeof normalizeGobizHits>) {
  const totalAmount = normalized.reduce((sum, item) => sum + (Number(item.amount) || 0), 0)
  const totalRawAmount = normalized.reduce((sum, item) => sum + (Number(item.rawAmount) || 0), 0)
  const paidCount = normalized.filter(item => String(item.status || '').toLowerCase() === 'settlement').length
  const latest = normalized[0]?.transactionTime || null
  return {
    count: normalized.length,
    paidCount,
    totalAmount,
    totalRawAmount,
    latestTransactionTime: latest,
  }
}

function findBestGobizMatch(
  normalized: ReturnType<typeof normalizeGobizHits>,
  params: z.infer<typeof gobizMatchSchema>,
) {
  const from = new Date(params.fromTimeISO).getTime()
  const to = new Date(params.toTimeISO).getTime()
  return normalized.find(item => {
    const itemAmount = Number(item.amount || 0)
    const itemRawAmount = Number(item.rawAmount || 0)
    const txTime = item.transactionTime ? new Date(item.transactionTime).getTime() : NaN
    const amountMatched =
      itemAmount === params.amount ||
      itemRawAmount === params.amount ||
      itemRawAmount === params.amount * 100 ||
      itemAmount === params.amount / 100

    return amountMatched && Number.isFinite(txTime) && txTime >= from && txTime <= to
  }) || null
}

app.get('/api/health', c => c.json({ ok: true, service: 'qris-api' }))

app.post('/api/payments/create', async c => {
  try {
    const body = await c.req.json()
    const parsed = createPaymentSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'Payload request tidak valid', detail: parsed.error.flatten() }, 400)
    }

    const qrisValidation = validateQrisPayload(parsed.data.qrisPayload)
    if (!qrisValidation.valid) {
      return c.json({ error: qrisValidation.error }, 400)
    }

    const generated = await generateDynamicQris(qrisValidation.payload, parsed.data.amount)
    const paymentId = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000)

    await pool.query(
      `
      INSERT INTO payments (
        id, order_id, amount, status, qris_payload_hash, qr_string, merchant_name,
        provider_tx_id, provider_reference, raw_create_response, expired_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `,
      [
        paymentId,
        parsed.data.orderId || null,
        parsed.data.amount,
        'PENDING',
        sha256(qrisValidation.payload),
        generated.qrString,
        generated.merchant,
        generated.providerTxId,
        generated.providerReference,
        JSON.stringify(generated.raw),
        expiresAt.toISOString(),
      ],
    )

    return c.json({
      transactionId: paymentId,
      amount: parsed.data.amount,
      status: 'PENDING',
      qrString: generated.qrString,
      merchant: generated.merchant,
      providerTxId: generated.providerTxId,
      providerReference: generated.providerReference,
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
    })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Internal error' }, 500)
  }
})

app.get('/api/payments/:transactionId/status', async c => {
  const { transactionId } = c.req.param()
  const result = await pool.query(
    `SELECT id, amount, status, paid_at, expired_at, created_at, updated_at FROM payments WHERE id = $1`,
    [transactionId],
  )

  if (!result.rowCount) {
    return c.json({ error: 'Transaksi tidak ditemukan' }, 404)
  }

  return c.json(result.rows[0])
})

app.post('/api/gobiz/journals/search', async c => {
  try {
    const body = await c.req.json()
    const parsed = gobizSearchSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'Payload request gobiz tidak valid', detail: parsed.error.flatten() }, 400)
    }

    const result = await searchGobizJournals(parsed.data)
    const hits = Array.isArray(result.hits) ? result.hits : []
    const normalized = normalizeGobizHits(hits)
    const responseData: Record<string, unknown> = {
      success: result.success === true,
      total: result.total ?? hits.length,
      totalRelation: result.total_relation ?? null,
      summary: summarizeGobizNormalized(normalized),
      normalized,
    }

    if (parsed.data.includeRaw) {
      responseData.raw = result
    }

    return c.json(responseData)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Internal error' }, 500)
  }
})

app.post('/api/gobiz/journals/match', async c => {
  try {
    const body = await c.req.json()
    const parsed = gobizMatchSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'Payload request gobiz match tidak valid', detail: parsed.error.flatten() }, 400)
    }

    const merchantId = parsed.data.merchantId || process.env.GOBIZ_MERCHANT_ID
    if (!merchantId) {
      return c.json({ error: 'merchantId wajib diisi atau set GOBIZ_MERCHANT_ID' }, 400)
    }

    const result = await searchGobizJournals({
      merchantId,
      from: 0,
      size: parsed.data.size,
      fromTimeISO: parsed.data.fromTimeISO,
      toTimeISO: parsed.data.toTimeISO,
      settlementOnly: true,
      qrisOnly: true,
      includeRaw: false,
    })

    const hits = Array.isArray(result.hits) ? result.hits : []
    const normalized = normalizeGobizHits(hits)
    const match = findBestGobizMatch(normalized, parsed.data)

    return c.json({
      success: true,
      found: Boolean(match),
      criteria: {
        amount: parsed.data.amount,
        merchantId,
        fromTimeISO: parsed.data.fromTimeISO,
        toTimeISO: parsed.data.toTimeISO,
      },
      match,
      summary: summarizeGobizNormalized(normalized),
    })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Internal error' }, 500)
  }
})

app.post('/api/webhooks/payment', async c => {
  const rawBody = await c.req.text()
  const signature = c.req.header('x-swiftqr-signature')
  const signatureValid = verifyWebhookSignature(rawBody, signature)
  if (!signatureValid) {
    return c.json({ error: 'Signature tidak valid' }, 401)
  }

  let payload: {
    eventId?: string
    eventType?: string
    transactionId?: string
    providerTxId?: string
    status?: string
  }

  try {
    payload = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'Payload webhook bukan JSON valid' }, 400)
  }

  const eventId = payload.eventId || crypto.randomUUID()

  const insertEvent = await pool.query(
    `
      INSERT INTO webhook_events (id, provider_event_id, event_type, signature_valid, payload)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (provider_event_id) DO NOTHING
      RETURNING id
    `,
    [crypto.randomUUID(), eventId, payload.eventType || 'payment.update', true, JSON.stringify(payload)],
  )

  if (!insertEvent.rowCount) {
    return c.json({ ok: true, duplicate: true })
  }

  const mappedStatus = statusMap[(payload.status || '').toUpperCase()] || 'PENDING'

  if (payload.transactionId) {
    await pool.query(
      `
        UPDATE payments
        SET status = $2,
            paid_at = CASE WHEN $2 = 'PAID' THEN now() ELSE paid_at END,
            updated_at = now()
        WHERE id = $1
      `,
      [payload.transactionId, mappedStatus],
    )
  } else if (payload.providerTxId) {
    await pool.query(
      `
        UPDATE payments
        SET status = $2,
            paid_at = CASE WHEN $2 = 'PAID' THEN now() ELSE paid_at END,
            updated_at = now()
        WHERE provider_tx_id = $1
      `,
      [payload.providerTxId, mappedStatus],
    )
  }

  return c.json({ ok: true })
})

app.get('/', serveStatic({ path: './index.html' }))
app.get('*', serveStatic({ root: './' }))

await initDb()

console.log(`QRIS API server jalan di http://localhost:${port}`)

Bun.serve({
  port,
  fetch: app.fetch,
})
