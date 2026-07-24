import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

function jsonResponse(req: Request, body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    status,
  });
}


export function getCorsHeaders(req: Request) {
  // The breach check is unauthenticated and returns public HIBP data, so we
  // reflect the caller's origin (or allow any origin if none is provided) so
  // preview deployments and local dev work without an allow-list maintenance burden.
  const origin = req.headers.get('origin');
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'X-Content-Type-Options': 'nosniff',
  };
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: getCorsHeaders(req) });

  try {
    const { prefix } = await req.json();
    if (typeof prefix !== 'string' || prefix.length !== 5) {
      return jsonResponse(req, { error: '5-character prefix is required.' }, 400);
    }

    const resp = await fetch(`https://api.pwnedpasswords.com/range/${prefix.toUpperCase()}`, {
      headers: { 'Add-Padding': 'true' },
    });
    if (!resp.ok) {
      // Fail open on HIBP errors so users are not locked out if the API is down.
      return jsonResponse(req, { text: '', error: 'Breach service unavailable.' }, 200);
    }

    const text = await resp.text();
    return jsonResponse(req, { text }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return jsonResponse(req, { error: msg }, 500);
  }
});
