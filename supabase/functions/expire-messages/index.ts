import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';


function jsonResponse(body: unknown, status: number, req: Request) {
  return new Response(JSON.stringify(body), {
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    status,
  });
}


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

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: getCorsHeaders(req) });

  const adminClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  try {
    const { error } = await adminClient.rpc('delete_expired_messages');
    if (error) throw new Error(`Cleanup failed: ${error.message}`);
    return jsonResponse({ success: true }, 200, req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return jsonResponse({ error: msg }, 500, req);
  }
});
