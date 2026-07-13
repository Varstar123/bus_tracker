/**
 * create-payment-order -- starts a bus-fee payment.
 *
 * The client sends ONLY an invoice_id. The amount is read from the database.
 * This is the entire security model of the payment flow: if the client could
 * name the amount, the fee would be whatever the user typed.
 *
 * Env:
 *   PAYMENTS_MODE        'razorpay' (default) | 'mock'
 *   RAZORPAY_KEY_ID      required unless mock
 *   RAZORPAY_KEY_SECRET  required unless mock
 *
 * PAYMENTS_MODE=mock settles invoices instantly with no gateway, so the app is
 * demoable without a merchant account. It must never be set in production --
 * anyone could then clear their own fees. The function refuses to start in mock
 * mode if Razorpay keys are also present, on the assumption that having keys
 * means you are live.
 */
import { adminClient, callerFromRequest, cors, json } from '../_shared/util.ts';

type Body = { invoice_id?: string };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const admin = adminClient();

  const caller = await callerFromRequest(req, admin);
  if (!caller) return json({ error: 'unauthorized' }, 401);

  const { invoice_id } = (await req.json()) as Body;
  if (!invoice_id) return json({ error: 'invoice_id is required' }, 400);

  const mode = Deno.env.get('PAYMENTS_MODE') ?? 'razorpay';
  const keyId = Deno.env.get('RAZORPAY_KEY_ID');
  const keySecret = Deno.env.get('RAZORPAY_KEY_SECRET');

  if (mode === 'mock' && keyId) {
    return json({ error: 'PAYMENTS_MODE=mock refused: Razorpay keys are configured' }, 500);
  }

  // ---- Authorisation ------------------------------------------------------
  // The service_role client above bypasses RLS, so we re-check by hand what the
  // `fee_invoices_read` policy would have enforced: you may only pay an invoice
  // belonging to a rider you are allowed to see.
  const { data: invoice, error: invErr } = await admin
    .from('fee_invoices')
    .select('id, org_id, rider_id, amount_paise, currency, status, period_label')
    .eq('id', invoice_id)
    .maybeSingle();

  if (invErr) return json({ error: invErr.message }, 500);
  if (!invoice) return json({ error: 'invoice not found' }, 404);

  const { data: allowed, error: allowErr } = await admin.rpc('can_pay_invoice', {
    p_profile_id: caller.id,
    p_invoice_id: invoice_id,
  });

  if (allowErr) return json({ error: allowErr.message }, 500);
  if (!allowed) return json({ error: 'forbidden' }, 403);

  if (invoice.status === 'paid') {
    return json({ error: 'invoice is already paid' }, 409);
  }
  if (invoice.status === 'cancelled') {
    return json({ error: 'invoice was cancelled' }, 409);
  }

  // ---- Mock -----------------------------------------------------------------
  if (mode === 'mock') {
    const fakePaymentId = `mock_pay_${crypto.randomUUID().slice(0, 12)}`;

    const { error } = await admin.from('payments').insert({
      org_id: invoice.org_id,
      invoice_id: invoice.id,
      profile_id: caller.id,
      amount_paise: invoice.amount_paise,
      currency: invoice.currency,
      provider: 'mock',
      provider_order_id: `mock_order_${crypto.randomUUID().slice(0, 12)}`,
      provider_payment_id: fakePaymentId,
      status: 'captured',
      raw: { mock: true },
      captured_at: new Date().toISOString(),
    });

    if (error) return json({ error: error.message }, 500);

    // The trigger has already flipped the invoice to paid and queued a receipt.
    return json({ mode: 'mock', paid: true, payment_id: fakePaymentId });
  }

  // ---- Razorpay -------------------------------------------------------------
  //
  // A Payment Link, not an Order. Orders require the Razorpay native checkout
  // SDK to be linked into the app; a Payment Link is a hosted page we can open
  // in the system browser. It supports the same UPI / card / netbanking methods
  // the deck asks for, needs no native module, and keeps every rupee of the
  // transaction off our client entirely.
  if (!keyId || !keySecret) {
    return json({ error: 'RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set' }, 500);
  }

  const res = await fetch('https://api.razorpay.com/v1/payment_links', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}`,
    },
    body: JSON.stringify({
      amount: invoice.amount_paise, // Razorpay also counts in paise.
      currency: invoice.currency,
      description: `Bus fee — ${invoice.period_label}`,
      // Echoed back to us on the webhook, and how we find our invoice again.
      reference_id: invoice.id,
      notes: { invoice_id: invoice.id, rider_id: invoice.rider_id },
      // The link is single-use and short-lived; an abandoned checkout should not
      // leave a payable link lying around in someone's browser history.
      expire_by: Math.floor(Date.now() / 1000) + 30 * 60,
      reminder_enable: false,
      notify: { sms: false, email: false },
    }),
  });

  if (!res.ok) {
    return json({ error: 'razorpay payment link failed', detail: await res.text() }, 502);
  }

  const link = (await res.json()) as { id: string; short_url: string };

  // Recorded as 'created', NOT 'captured'. It only becomes captured when the
  // razorpay-webhook function verifies a signed callback. A user who abandons
  // checkout simply leaves a 'created' row behind, and the invoice stays unpaid.
  const { error: payErr } = await admin.from('payments').insert({
    org_id: invoice.org_id,
    invoice_id: invoice.id,
    profile_id: caller.id,
    amount_paise: invoice.amount_paise,
    currency: invoice.currency,
    provider: 'razorpay',
    provider_order_id: link.id, // plink_xxxxx
    status: 'created',
    raw: link,
  });

  if (payErr) return json({ error: payErr.message }, 500);

  return json({ mode: 'razorpay', checkout_url: link.short_url, payment_link_id: link.id });
});
