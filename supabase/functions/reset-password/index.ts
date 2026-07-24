import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { argon2id } from 'npm:hash-wasm';


// ─── Rate-limit constants ─────────────────────────────────────────────────────
const RATE_WINDOW_MS = 15 * 60 * 1000; // 15-minute sliding window
const MAX_ATTEMPTS   = 5;               // failed attempts before lockout
const LOCKOUT_MS     = 60 * 60 * 1000; // 1-hour lockout after threshold

// ─── Hash constants (must match client-side mnemonic.ts) ───────────────────
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEY_BYTES  = 32;
const ARGON2ID_PREFIX   = '$argon2id$';
const ARGON2ID_V2_PREFIX = '$argon2id$v2$';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Derive PBKDF2-SHA256(mnemonic, salt, 100 000 iters, 32 bytes) → Uint8Array. */
async function hashMnemonicPBKDF2(mnemonic: string, saltBase64: string): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(normalizeMnemonic(mnemonic)),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const saltBytes = Uint8Array.from(atob(saltBase64), c => c.charCodeAt(0));
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: PBKDF2_ITERATIONS },
    keyMaterial,
    PBKDF2_KEY_BYTES * 8
  );
  return new Uint8Array(derived);
}

/** Derive Argon2id(mnemonic, salt, 3 iters, 64 MB, 32 bytes) → hex string. */
async function hashMnemonicArgon2id(mnemonic: string, saltBase64: string, v2 = false): Promise<string> {
  const raw = await argon2id({
    password: normalizeMnemonic(mnemonic),
    salt: Uint8Array.from(atob(saltBase64), c => c.charCodeAt(0)),
    parallelism: v2 ? 4 : 1,
    iterations: v2 ? 4 : 3,
    memorySize: v2 ? 262144 : 65536,
    hashLength: 32,
    outputType: 'binary',
  });
  return Array.from(raw as Uint8Array).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time hex string comparison — guards against timing side-channels. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** SHA-256 hex of a string — keys rate-limit rows without storing plaintext usernames. */
async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-1 hex of a string — used for HIBP k-anonymity breach checks. */
async function sha1Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Response helpers ─────────────────────────────────────────────────────────

function jsonResponse(req: Request, body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    status,
  });
}

// ─── Main handler ─────────────────────────────────────────────────────────────


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
    const { username, mnemonic, newPassword } = await req.json();
    if (!username || !mnemonic || !newPassword) {
      return jsonResponse(req, { error: 'Missing required fields: username, mnemonic, newPassword' }, 400);
    }

    // ── Server-side password validation ──────────────────────────────────────
    // The client enforces this too, but a direct API caller bypasses the UI.
    // The reset path is unauthenticated, making enforcement here critical.
    if (typeof newPassword !== 'string' || newPassword.length < 12) {
      throw new Error('Password must be at least 12 characters.');
    }
    if (!/[A-Za-z]/.test(newPassword)) {
      throw new Error('Password must contain at least one letter.');
    }
    if (!/[0-9]/.test(newPassword)) {
      throw new Error('Password must contain at least one number.');
    }

    // ── Server-side breach check (HIBP k-anonymity) ────────────────────────────
    const fullSha1 = await sha1Hex(newPassword);
    const breachCheck = await fetch('https://api.pwnedpasswords.com/range/' + fullSha1.slice(0, 5).toUpperCase(), {
      headers: { 'Add-Padding': 'true' },
    });
    if (breachCheck.ok) {
      const suffix = fullSha1.slice(5).toUpperCase();
      const breaches = await breachCheck.text();
      const matched = breaches.split('\r\n').find(line => line.split(':')[0]?.toUpperCase() === suffix);
      if (matched) {
        const count = parseInt(matched.split(':')[1], 10) || 0;
        throw new Error(`This password has appeared in ${count.toLocaleString()} known data breaches. Please choose a different password.`);
      }
    }

    const normalizedUsername = username.trim().toLowerCase();
    const usernameHash = await sha256hex(normalizedUsername);
    const now = new Date();

    // ── Step 1: Read rate-limit record and reject if currently locked ─────────
    const { data: rl } = await adminClient
      .from('password_reset_rate_limit')
      .select('id, attempts, window_start, locked_until')
      .eq('username_hash', usernameHash)
      .maybeSingle();

    if (rl?.locked_until && new Date(rl.locked_until) > now) {
      return jsonResponse(req, { error: 'Too many attempts. Please try again later.' }, 429);
    }

    // ── Step 2: Profile lookup ────────────────────────────────────────────────
    const { data: profile, error: profileErr } = await adminClient
      .from('profiles')
      .select('id, mnemonic_hash, mnemonic_salt')
      .eq('username', normalizedUsername)
      .maybeSingle();

    // ── Step 3: Mnemonic hash verification (runs even on missing user to equalise timing) ──
    // Using a dummy salt when the user doesn't exist prevents username enumeration
    // via response-time differences between "not found" and "wrong phrase".
    const dummySalt = 'AAAAAAAAAAAAAAAAAAAAAA=='; // 16 zero-bytes, base64
    const lookupFailed = !!(profileErr || !profile);
    const saltToUse    = lookupFailed ? dummySalt : (profile.mnemonic_salt ?? dummySalt);

    const isArgon2idV2 = !lookupFailed && (profile.mnemonic_hash ?? '').startsWith(ARGON2ID_V2_PREFIX);
    const isArgon2id = !isArgon2idV2 && !lookupFailed && (profile.mnemonic_hash ?? '').startsWith(ARGON2ID_PREFIX);
    
    let incomingHashHex: string;
    if (isArgon2idV2) {
      incomingHashHex = await hashMnemonicArgon2id(mnemonic, saltToUse, true);
    } else if (isArgon2id) {
      incomingHashHex = await hashMnemonicArgon2id(mnemonic, saltToUse, false);
    } else {
      incomingHashHex = Array.from(await hashMnemonicPBKDF2(mnemonic, saltToUse)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    const storedHashHex = lookupFailed
      ? ''
      : (profile.mnemonic_hash ?? '').replace(ARGON2ID_V2_PREFIX, '').replace(ARGON2ID_PREFIX, '');

    // Inner helper: increment the failure counter, then throw with the given message.
    // Applies lockout when the threshold is reached.
    async function failWithCount(message: string): Promise<never> {
      if (!rl) {
        // First recorded failure for this username
        await adminClient
          .from('password_reset_rate_limit')
          .insert({ username_hash: usernameHash, attempts: 1, window_start: now.toISOString() });
      } else {
        const windowStart  = new Date(rl.window_start);
        const windowExpired = (now.getTime() - windowStart.getTime()) > RATE_WINDOW_MS;
        const newAttempts   = windowExpired ? 1 : rl.attempts + 1;
        const lockedUntil   = newAttempts >= MAX_ATTEMPTS
          ? new Date(now.getTime() + LOCKOUT_MS).toISOString()
          : null;

        await adminClient
          .from('password_reset_rate_limit')
          .update({
            attempts:     newAttempts,
            window_start: windowExpired ? now.toISOString() : rl.window_start,
            locked_until: lockedUntil,
          })
          .eq('id', rl.id);
      }
      throw new Error(message);
    }

    // ── Step 4: Check lookup result ───────────────────────────────────────────
    if (lookupFailed) {
      await failWithCount('User not found.');
    }

    // Reject legacy accounts that have no salt (unsalted SHA-256 stored pre-migration).
    // Counter is NOT incremented here — this isn't a wrong-phrase attempt, it's a
    // configuration state that the user must resolve by logging in and regenerating.
    if (!profile!.mnemonic_salt) {
      throw new Error(
        'Your recovery phrase was stored with an older format. ' +
        'Please log in and regenerate it from Settings before using password reset.'
      );
    }

    if (!profile!.mnemonic_hash) {
      throw new Error('No recovery phrase on file for this account.');
    }

    // ── Step 5: Constant-time comparison ─────────────────────────────────────
    if (!timingSafeEqualHex(incomingHashHex, storedHashHex)) {
      await failWithCount('Recovery phrase does not match. Please check each word carefully.');
    }

    // ── Step 6: Reset password ────────────────────────────────────────────────
    const { error: updateErr } = await adminClient.auth.admin.updateUserById(profile!.id, {
      password: newPassword,
    });
    if (updateErr) throw new Error(`Failed to reset password: ${updateErr.message}`);

    // ── Step 7: On success — reset rate-limit record ──────────────────────────
    await adminClient
      .from('password_reset_rate_limit')
      .delete()
      .eq('username_hash', usernameHash);

    // Mark profile as using the new password format (non-fatal if it fails)
    const { error: profileUpdateErr } = await adminClient
      .from('profiles')
      .update({ password_version: 1 })
      .eq('id', profile!.id);
    if (profileUpdateErr) {
      console.error('Failed to update password_version after reset:', profileUpdateErr);
    }

    return jsonResponse(req, { success: true }, 200);

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    // Use 429 for rate-limit messages, 400 for all other errors
    const status = msg.startsWith('Too many') ? 429 : 400;
    return jsonResponse(req, { error: msg }, status);
  }
});
