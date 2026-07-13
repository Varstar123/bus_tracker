/**
 * razorpay-webhook -- the authoritative record of whether a fee was paid.
 *
 * Set up at Razorpay Dashboard -> Settings -> Webhooks:
 *   URL:    https://<project>.functions.supabase.co/razorpay-webhook
 *   Events: payment_link.paid, payment_link.expired
 *   Secret: the same value as RAZORPAY_WEBHOOK_SECRET
 *
 * Deploy with --no-verify-jwt: Razorpay is not a Supabase user and sends no
 * bearer token. The HMAC signature below is what authenticates the request, and
 * it is strictly stronger than a JWT here.
 *
 *   supabase functions deploy razorpay-webhook --no-verify-jwt
 *
 * Why this and not the client telling us it paid: a client can lie, can be
 * killed mid-payment, or can lose signal on the way back from the checkout page.
 * The gateway's signed webhook is the only source that is both truthful and
 * guaranteed to arrive -- Razorpay retries it until we answer 2xx.
 */
import { adminClient, cors, hmacSha256Hex, json, requireEnv, timingSafeEqual } from '../_shared/util.ts';

type RazorpayEvent = {
  event: string;
  payload: {
    payment_link?: { entity: { id: string; reference_id: string; amount: number; status: string } };
    payment?: { entity: { id: string; amount: number; status: string } };
  };
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  // The signature is computed over the EXACT bytes Razorpay sent. Parsing to
  // JSON and re-serialising would reorder keys and change whitespace, and the
  // HMAC would never match -- so read the raw text first and parse it after.
  const raw = await req.text();
  const signature = req.headers.get('x-razorpay-signature') ?? '';
  const secret = requireEnv('RAZORPAY_WEBHOOK_SECRET');

  const expected = await hmacSha256Hex(secret, raw);
  if (!timingSafeEqual(expected, signature)) {
    return json({ error: 'invalid signature' }, 401);
  }

  const event = JSON.parse(raw) as RazorpayEvent;
  const link = event.payload?.payment_link?.entity;
  if (!link) return json({ skipped: 'no payment_link entity' });

  const admin = adminClient();

  // Look the payment up by the link WE created. An event for a link we never
  // issued is either a misrouted webhook or an attack; either way, ignore it.
  const { data: row, error } = await admin
    .from('payments')
    .select('id, invoice_id, amount_paise, status')
    .eq('provider_order_id', link.id)
    .maybeSingle();

  if (error) return json({ error: error.message }, 500);
  if (!row) return json({ skipped: 'unknown payment link' }, 404);

  // Razorpay retries until it gets a 2xx, so the same event can and will arrive
  // more than once. Acknowledge and change nothing.
  if (row.status === 'captured') {
    return json({ ok: true, idempotent: true });
  }

  if (event.event === 'payment_link.paid') {
    // Defence in depth: the amount is compared against our OWN invoice, never
    // taken from the webhook body. Even a forged-but-somehow-signed event cannot
    // settle a ₹1,200 fee with ₹1.
    if (link.amount !== row.amount_paise) {
      console.error(
        `amount mismatch on link ${link.id}: gateway ${link.amount} vs invoice ${row.amount_paise}`,
      );
      return json({ error: 'amount mismatch' }, 409);
    }

    // The on_payment_captured trigger settles the invoice and queues the receipt.
    const { error: upErr } = await admin
      .from('payments')
      .update({
        status: 'captured',
        provider_payment_id: event.payload.payment?.entity.id ?? link.id,
        captured_at: new Date().toISOString(),
        raw: event.payload,
      })
      .eq('id', row.id);

    if (upErr) return json({ error: upErr.message }, 500);
    return json({ ok: true, captured: link.id });
  }

  if (event.event === 'payment_link.expired') {
    await admin.from('payments').update({ status: 'failed', raw: event.payload }).eq('id', row.id);
    return json({ ok: true, expired: link.id });
  }

  return json({ skipped: event.event });
});
