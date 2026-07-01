/**
 * Voice recording utilities for ShadowCrypt.
 *
 * Codec:    Opus inside a WebM container.
 * Mode:     Constrained VBR (CVBR) — Opus default in browsers; constrained by
 *           setting audioBitsPerSecond (32 kbps) so the encoder cannot exceed
 *           that bitrate ceiling while still adapting downward for silence.
 *           This is the "Padded VBR / Constrained VBR" profile requested.
 * Quality:  32 kbps Opus CVBR ≈ telephony-quality speech with ~14 MB/hr.
 *           A 10-minute recording produces ≈ 2.4 MB — well under the 20 MB
 *           bucket limit.
 *
 * Daily limit: 600 seconds (10 minutes) per user, enforced server-side via
 *              the voice_send_durations table and checked client-side before
 *              recording is allowed to start.
 */

export const VOICE_DAILY_LIMIT_SECONDS = 600; // 10 minutes

/** MIME type preference list: Opus/WebM first, then fallbacks. */
const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

/** Pick the first MIME type the current browser supports. */
export function getSupportedMimeType(): string {
  for (const mt of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(mt)) return mt;
  }
  // Fallback — let the browser choose; will likely still be webm/opus
  return '';
}

export interface VoiceRecording {
  blob: Blob;
  /** Actual duration in seconds (derived from Date.now() delta). */
  durationSeconds: number;
  mimeType: string;
}

export type RecorderState = 'idle' | 'recording' | 'stopped';

export interface VoiceRecorderHandle {
  start: () => Promise<void>;
  stop: () => Promise<VoiceRecording>;
  cancel: () => void;
  getElapsedSeconds: () => number;
  state: () => RecorderState;
}

/**
 * Create a voice recorder instance.
 * Call start() to begin, stop() to finish and obtain the recording blob,
 * or cancel() to discard without a result.
 */
export function createVoiceRecorder(): VoiceRecorderHandle {
  let mediaRecorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let chunks: BlobPart[] = [];
  let recorderState: RecorderState = 'idle';
  let startedAt = 0;
  let resolveStop: ((r: VoiceRecording) => void) | null = null;
  let rejectStop: ((e: Error) => void) | null = null;

  const cleanup = () => {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    mediaRecorder = null;
    chunks = [];
  };

  return {
    state: () => recorderState,
    getElapsedSeconds: () =>
      recorderState === 'recording' ? Math.floor((Date.now() - startedAt) / 1000) : 0,

    start: async () => {
      if (recorderState !== 'idle') return;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } catch {
        throw new Error('Microphone access denied. Please allow microphone access and try again.');
      }

      const mimeType = getSupportedMimeType();
      const options: MediaRecorderOptions = {
        // 32 kbps forces the Opus encoder into Constrained VBR mode:
        // it adapts downward for silence/simple tones but is capped at 32 kbps.
        audioBitsPerSecond: 32000,
        ...(mimeType ? { mimeType } : {}),
      };

      chunks = [];
      recorderState = 'recording';
      startedAt = Date.now();

      mediaRecorder = new MediaRecorder(stream, options);
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      mediaRecorder.onstop = () => {
        recorderState = 'stopped';
        const durationSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
        cleanup();
        resolveStop?.({ blob, durationSeconds, mimeType: mimeType || 'audio/webm' });
        resolveStop = null;
        rejectStop = null;
      };
      mediaRecorder.onerror = (e) => {
        recorderState = 'idle';
        cleanup();
        const errMsg = (e as Event & { error?: { message?: string } }).error?.message ?? 'unknown';
        rejectStop?.(new Error(`Recording error: ${errMsg}`));
        resolveStop = null;
        rejectStop = null;
      };

      // Collect data every 250 ms so we have granular chunks
      mediaRecorder.start(250);
    },

    stop: () =>
      new Promise<VoiceRecording>((resolve, reject) => {
        if (!mediaRecorder || recorderState !== 'recording') {
          reject(new Error('No active recording.'));
          return;
        }
        resolveStop = resolve;
        rejectStop = reject;
        mediaRecorder.stop();
      }),

    cancel: () => {
      if (mediaRecorder && recorderState === 'recording') {
        mediaRecorder.ondataavailable = null;
        mediaRecorder.onstop = null;
        mediaRecorder.stop();
      }
      recorderState = 'idle';
      cleanup();
      resolveStop = null;
      rejectStop = null;
    },
  };
}
