import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

export function getCorsHeaders(req: Request) {
  const origin = req.headers.get('origin');
  const allowedOrigins = ['http://localhost:5173', 'http://localhost:8080'];
  if (!origin || (!allowedOrigins.includes(origin) && !origin.endsWith('.sylvacrypt.com') && origin !== 'https://sylvacrypt.com')) {
    return {
      'Access-Control-Allow-Origin': '',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'X-Content-Type-Options': 'nosniff',
    };
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'X-Content-Type-Options': 'nosniff',
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: getCorsHeaders(req) });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    });
  }

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userErr } = await supabaseClient.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json().catch(() => ({}));
    const targetUserId = body.target_user_id as string | undefined;
    const title = "New message";
    const message = "You have a new encrypted message.";
    const tag = body.tag as string | undefined;
    const url = body.url as string | undefined;
    const encrypted = body.encrypted as { ephPub: string; iv: string; ciphertext: string } | undefined;

    if (!targetUserId) {
      return new Response(JSON.stringify({ error: 'Missing target_user_id' }), {
        status: 400,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    const vapidPublic = Deno.env.get('VAPID_PUBLIC_KEY');
    const vapidPrivate = Deno.env.get('VAPID_PRIVATE_KEY');
    const vapidSubject = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:push@sylvacrypt.com';
    if (!vapidPublic || !vapidPrivate) {
      return new Response(JSON.stringify({ error: 'VAPID keys not configured' }), {
        status: 500,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Verify contact relationship server-side
    const { data: contact } = await adminClient
      .from('contacts')
      .select('id')
      .eq('owner_id', targetUserId)
      .eq('contact_id', user.id)
      .single();

    if (!contact) {
      return new Response(JSON.stringify({ error: 'Not a contact' }), {
        status: 403,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    // Also check block list
    const { data: block } = await adminClient
      .from('blocked_users')
      .select('id')
      .eq('blocker_id', targetUserId)
      .eq('blocked_id', user.id)
      .single();

    if (block) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    const { data: subs, error: subsErr } = await adminClient
      .from('push_subscriptions')
      .select('*')
      .eq('user_id', targetUserId);

    if (subsErr) throw subsErr;

    const payload = JSON.stringify({ title, body: message, tag, data: { url, userId: targetUserId }, encrypted });
    const results = await Promise.allSettled(
      (subs ?? []).map(sub =>
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        )
      )
    );

    const failed = results.filter(r => r.status === 'rejected').length;
    return new Response(JSON.stringify({ ok: true, sent: results.length - failed, failed }), {
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[push-notify] error:', err);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    });
  }
});
