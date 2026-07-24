import { assertEquals } from 'https://deno.land/std@0.224.0/testing/asserts.ts';
import { getCorsHeaders } from './index.ts';

Deno.test("expire-messages getCorsHeaders returns allowed origin", () => {
  const req1 = new Request('https://edge.example.com', {
    headers: { 'Origin': 'https://sylvacrypt.com' }
  });
  const headers1 = getCorsHeaders(req1);
  assertEquals(headers1['Access-Control-Allow-Origin'], 'https://sylvacrypt.com');

  const req2 = new Request('https://edge.example.com', {
    headers: { 'Origin': 'https://malicious.com' }
  });
  const headers2 = getCorsHeaders(req2);
  assertEquals(headers2['Access-Control-Allow-Origin'], '');
});

// Since the default export serve() is tricky to unit test directly without 
// triggering the server loop, we can test the expected behavior. 
// A typical unit test for this RPC logic asserts that it calls 
// adminClient.rpc('delete_expired_messages').
