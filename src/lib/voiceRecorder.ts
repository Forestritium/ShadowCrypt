import AudioRecorder from 'audio-recorder-polyfill';

// Polyfill MediaRecorder for Safari/iOS if missing
if (typeof window !== 'undefined' && !window.MediaRecorder) {
  window.MediaRecorder = AudioRecorder;
}

/**
 * Voice recording utilities for SylvaCrypt.
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
  if (typeof MediaRecorder === 'undefined') {
    return '';
  }
  if (typeof MediaRecorder.isTypeSupported !== 'function') {
    // Polyfills often don't implement isTypeSupported and usually output audio/wav
    return 'audio/wav';
  }
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
  getStream: () => MediaStream | null;
  getAnalyser: () => AnalyserNode | null;
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

  // Create AudioContext synchronously during user gesture
  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;

  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
    }
  } catch (err) {
    console.warn('[voiceRecorder] Failed to create AudioContext:', err);
  }

  const cleanup = () => {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    mediaRecorder = null;
    chunks = [];
    if (sourceNode) {
      sourceNode.disconnect();
      sourceNode = null;
    }
    if (audioCtx && audioCtx.state !== 'closed') {
      audioCtx.close().catch(() => {});
    }
    audioCtx = null;
    analyser = null;
  };

  return {
    state: () => recorderState,
    getElapsedSeconds: () =>
      recorderState === 'recording' ? Math.floor((Date.now() - startedAt) / 1000) : 0,
    getStream: () => stream,
    getAnalyser: () => analyser,

    start: async () => {
      if (recorderState !== 'idle') return;
      try {
        const constraints = { audio: true };
        
        try {
          if (navigator.permissions && navigator.permissions.query) {
            const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
            console.log('[voiceRecorder] Current microphone permission status:', status.state);
          }
        } catch (e) {
          console.log('[voiceRecorder] Could not query permission status:', e);
        }

        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          console.log('[voiceRecorder] Requesting getUserMedia...');
          stream = await navigator.mediaDevices.getUserMedia(constraints);
          console.log('[voiceRecorder] getUserMedia success!');
        } else {
          const nav = navigator as any;
          const legacyGetUserMedia = nav.getUserMedia || nav.webkitGetUserMedia || nav.mozGetUserMedia || nav.msGetUserMedia;
          if (!legacyGetUserMedia) {
            throw new Error('getUserMedia is not supported on this browser.');
          }
          stream = await new Promise((resolve, reject) => {
            legacyGetUserMedia.call(navigator, constraints, resolve, reject);
          });
        }
      } catch (err: any) {
        console.error('[voiceRecorder] getUserMedia error:', err);
        const name = err?.name || '';
        const msg = err?.message || '';
        
        if (name === 'NotFoundError' || msg.includes('Requested device not found') || msg.includes('device not found')) {
          throw new Error('No microphone found. Please connect a microphone.');
        }
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          const inIframe = window.self !== window.top;
          if (inIframe) {
            throw new Error('Preview environment blocked microphone access. Please open in a new tab.');
          }
          throw new Error('The hosting server is blocking microphone access via security headers. Use the upload button instead.');
        }
        if (name === 'NotReadableError' || name === 'TrackStartError') {
          throw new Error('Microphone is in use by another app.');
        }
        throw new Error(`Microphone error: ${msg || name || 'Unknown error'}`);
      }

      let mimeType: string;
      try {
        mimeType = getSupportedMimeType();
      } catch {
        cleanup();
        throw new Error('Media recording is not supported in this browser.');
      }
      const options: MediaRecorderOptions = {};
      
      // Only set audioBitsPerSecond if we know it's supported (some polyfills/browsers crash if provided)
      if (mimeType && mimeType.includes('opus')) {
        options.audioBitsPerSecond = 32000;
        options.mimeType = mimeType;
      } else if (mimeType) {
        options.mimeType = mimeType;
      }

      if (audioCtx && analyser && stream) {
        try {
          if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
          }
          sourceNode = audioCtx.createMediaStreamSource(stream);
          sourceNode.connect(analyser);
        } catch (err) {
          console.warn('[voiceRecorder] Failed to connect analyser:', err);
        }
      }

      chunks = [];
      recorderState = 'recording';
      startedAt = Date.now();

      try {
        mediaRecorder = new MediaRecorder(stream!, options);
      } catch (e) {
        // Fallback if options cause an error (e.g. Safari iOS strictness)
        console.warn('[voiceRecorder] MediaRecorder failed with options, falling back to defaults', e);
        try {
          mediaRecorder = new MediaRecorder(stream!);
          mimeType = mediaRecorder.mimeType || 'audio/wav'; // Polyfill usually outputs audio/wav
        } catch (e2) {
          cleanup();
          throw new Error('Failed to initialize MediaRecorder: ' + String(e2));
        }
      }
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
