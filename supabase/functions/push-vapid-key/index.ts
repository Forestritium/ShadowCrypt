
Deno.
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

  const vapidPublic = Deno.env.get('VAPID_PUBLIC_KEY');
  if (!vapidPublic) {
    return new Response(JSON.stringify({ error: 'Push notifications are not configured on this server.' }), {
      status: 503,
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ publicKey: vapidPublic }), {
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  });
});
