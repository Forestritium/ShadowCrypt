/**
 * Notification sound utility — plays Sound.mp3 (base64-embedded, no server fetch needed).
 *
 * Autoplay policy handling:
 *   Call `unlockAudio()` on the first user interaction (click/keydown) to
 *   resume the AudioContext so subsequent sounds can play automatically.
 */

// Sound.mp3 embedded as base64 so it works offline with no asset pipeline config.
const SOUND_B64 =
  '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';

// Decode base64 → ArrayBuffer once, cache the decoded AudioBuffer
let audioCtx: AudioContext | null = null;
let cachedBuffer: AudioBuffer | null = null;
let decodePromise: Promise<void> | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  }
  return audioCtx;
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

async function ensureBuffer(): Promise<void> {
  if (cachedBuffer) return;
  if (decodePromise) return decodePromise;
  decodePromise = (async () => {
    try {
      const ab = base64ToArrayBuffer(SOUND_B64);
      cachedBuffer = await getAudioContext().decodeAudioData(ab);
    } catch {
      // Silently ignore decode failures
    }
  })();
  return decodePromise;
}

/** Call once on any user gesture to satisfy browser autoplay policies. */
export function unlockAudio(): void {
  try {
    const ac = getAudioContext();
    if (ac.state === 'suspended') ac.resume();
    // Pre-decode the buffer on first interaction so playback is instant later
    ensureBuffer();
  } catch {
    // Not critical
  }
}

/**
 * Play the notification sound.
 * Silently no-ops if AudioContext is still suspended or sound decode failed.
 */
export async function playNotificationSound(): Promise<void> {
  try {
    const ac = getAudioContext();
    if (ac.state === 'suspended') return;
    await ensureBuffer();
    if (!cachedBuffer) return;

    const source = ac.createBufferSource();
    source.buffer = cachedBuffer;
    // Slight volume reduction so it isn't jarring
    const gain = ac.createGain();
    gain.gain.value = 0.7;
    source.connect(gain);
    gain.connect(ac.destination);
    source.start(0);
  } catch {
    // Silently ignore — sound is a non-critical enhancement
  }
}

// ── Per-conversation mute preference (localStorage) ──────────────────────────

const MUTE_KEY = 'sylvacrypt_muted_convos';

function getMutedSet(): Set<string> {
  try {
    const raw = localStorage.getItem(MUTE_KEY);
    return raw ? new Set<string>(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveMutedSet(s: Set<string>): void {
  try {
    localStorage.setItem(MUTE_KEY, JSON.stringify([...s]));
  } catch { /* ignore */ }
}

export function isMuted(conversationId: string): boolean {
  return getMutedSet().has(conversationId);
}

export function setMuted(conversationId: string, muted: boolean): void {
  const s = getMutedSet();
  if (muted) s.add(conversationId);
  else s.delete(conversationId);
  saveMutedSet(s);
}

// ── Global Do Not Disturb (localStorage) ─────────────────────────────────────

const DND_KEY = 'sylvacrypt_dnd';

export function isDND(): boolean {
  try { return localStorage.getItem(DND_KEY) === '1'; } catch { return false; }
}

export function setDND(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(DND_KEY, '1');
    else localStorage.removeItem(DND_KEY);
  } catch { /* ignore */ }
}

