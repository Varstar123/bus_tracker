/**
 * send-push -- delivers a `notifications` row to the user's devices.
 *
 * Invoked by a Supabase Database Webhook on INSERT into public.notifications.
 * Wire it up in Dashboard -> Database -> Webhooks:
 *
 *   table:   public.notifications
 *   events:  INSERT
 *   type:    Supabase Edge Function -> send-push
 *   headers: x-webhook-secret: <same value as the WEBHOOK_SECRET env var>
 *
 * Why a webhook and not a direct call from Postgres: pushing from inside the
 * transaction would mean a slow or failing push provider could roll back a
 * confirmed bus arrival. The database records the truth; delivery is a separate,
 * retryable concern.
 */
import { adminClient, cors, json, requireEnv, timingSafeEqual } from '../_shared/util.ts';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

type NotificationRow = {
  id: string;
  profile_id: string;
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'critical';
  data: Record<string, unknown>;
};

type ExpoTicket = {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  // The webhook endpoint is public, so the shared secret is the only thing
  // standing between an attacker and the ability to push arbitrary alerts to
  // every parent in the school.
  const expected = requireEnv('WEBHOOK_SECRET');
  const provided = req.headers.get('x-webhook-secret') ?? '';
  if (!timingSafeEqual(expected, provided)) {
    return json({ error: 'unauthorized' }, 401);
  }

  const payload = (await req.json()) as { type: string; record: NotificationRow };
  if (payload.type !== 'INSERT' || !payload.record) {
    return json({ skipped: true });
  }

  const note = payload.record;
  const admin = adminClient();

  const { data: tokens, error } = await admin
    .from('device_tokens')
    .select('token')
    .eq('profile_id', note.profile_id);

  if (error) return json({ error: error.message }, 500);

  // Perfectly normal: a parent who has not installed the app yet still gets the
  // in-app notification row, they just have no device to push it to.
  if (!tokens?.length) return json({ sent: 0, reason: 'no devices' });

  const critical = note.severity === 'critical';

  const messages = tokens.map((t) => ({
    to: t.token,
    title: note.title,
    body: note.body,
    data: { ...note.data, notification_id: note.id },
    sound: 'default',
    // An SOS must break through a silenced phone; a "bus in 5 min" must not.
    priority: critical ? 'high' : 'normal',
    channelId: 'bus-alerts',
    ...(critical ? { interruptionLevel: 'critical' } : {}),
  }));

  const res = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(messages),
  });

  if (!res.ok) {
    return json({ error: `expo push failed: ${res.status}`, detail: await res.text() }, 502);
  }

  const { data: tickets } = (await res.json()) as { data: ExpoTicket[] };

  // Tokens die when the app is uninstalled or restored onto a new device. If we
  // never prune them, every future send wastes a request on a phone that no
  // longer exists -- and the dead tokens accumulate forever.
  const dead = (tickets ?? [])
    .map((ticket, i) => ({ ticket, token: tokens[i].token }))
    .filter(({ ticket }) => ticket.details?.error === 'DeviceNotRegistered')
    .map(({ token }) => token);

  if (dead.length) {
    await admin.from('device_tokens').delete().in('token', dead);
  }

  return json({
    sent: tickets?.filter((t) => t.status === 'ok').length ?? 0,
    pruned: dead.length,
  });
});
