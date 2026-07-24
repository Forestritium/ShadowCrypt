/**
 * VoiceRecordButton
 *
 * Tap-to-record / tap-again-to-send voice button for the chat input bar.
 *
 * Behaviour:
 *  - Tap once  → starts recording, button turns red; tap again → stops and submits.
 *  - While recording a live elapsed timer is shown.
 *  - When the remaining daily quota would be exceeded, the recorder auto-stops at the limit.
 *  - Shows a tooltip with remaining daily minutes on hover.
 *
 * The parent receives { blob, durationSeconds, mimeType } via onRecordingComplete.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { Mic, MicOff, Square } from 'lucide-react';
import { toast } from 'sonner';
import { createVoiceRecorder, VOICE_DAILY_LIMIT_SECONDS } from '@/lib/voiceRecorder';
import type { VoiceRecorderHandle } from '@/lib/voiceRecorder';

interface VoiceRecordButtonProps {
  /** Called when a recording is finished and ready to upload. */
  onRecordingComplete: (blob: Blob, durationSeconds: number, mimeType: string) => void;
  /** Seconds already used today — parent fetches this from the server. */
  usedSecondsToday: number;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  /** Called when recording starts or stops. */
  onRecordingStateChange?: (isRecording: boolean, analyser?: AnalyserNode) => void;
}

function formatElapsed(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function canAccessMicrophone(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') return true;
  const nav = navigator as any;
  return typeof (nav.getUserMedia || nav.webkitGetUserMedia || nav.mozGetUserMedia || nav.msGetUserMedia) === 'function';
}

export function VoiceRecordButton({
  onRecordingComplete,
  usedSecondsToday,
  disabled = false,
  className,
  style,
  onRecordingStateChange,
}: VoiceRecordButtonProps) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const isStartingRef = useRef(false);
  const recorderRef = useRef<VoiceRecorderHandle | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fallbackInputRef = useRef<HTMLInputElement>(null);

  const remainingSeconds = Math.max(0, VOICE_DAILY_LIMIT_SECONDS - (usedSecondsToday || 0));
  const quotaExhausted = remainingSeconds <= 0;
  const isDisabled = disabled || quotaExhausted;

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const startTimer = (startedAt: number) => {
    stopTimer();
    timerRef.current = setInterval(() => {
      const e = Math.floor((Date.now() - startedAt) / 1000);
      setElapsed(e);
    }, 500);
  };

  const doStart = useCallback(async () => {
    if (isDisabled || recording || isStartingRef.current) return;

    if (!canAccessMicrophone()) {
      toast.error('Microphone access is not available on this browser.', { duration: 6000, id: 'mic-error-pre' });
      return;
    }

    isStartingRef.current = true;
    const recorder = createVoiceRecorder();
    recorderRef.current = recorder;
    try {
      await recorder.start();
      setRecording(true);
      setElapsed(0);
      startTimer(Date.now());
      onRecordingStateChange?.(true, recorder.getAnalyser() ?? undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[VoiceRecordButton] Failed to start recording:', err);
      
      const isDenied = message.toLowerCase().includes('denied');
      const isIframeBlocked = message.toLowerCase().includes('preview environment');
      
      if (isIframeBlocked) {
        toast.error('Microphone Blocked by Preview', {
          description: 'The platform preview iframe blocks microphone access. Open in a new tab to record.',
          action: {
            label: 'Open New Tab',
            onClick: () => window.open(window.location.href, '_blank'),
          },
          duration: 10000,
          id: 'mic-error-iframe'
        });
      } else {
        toast.error(message || 'Could not start recording', {
          description: isDenied ? 'Check OS settings, or upload an audio file.' : 'You can upload an audio file instead.',
          action: {
            label: 'Upload Audio',
            onClick: () => fallbackInputRef.current?.click(),
          },
          duration: 8000,
          id: 'mic-error'
        });
      }
      recorderRef.current = null;
    } finally {
      isStartingRef.current = false;
    }
  }, [isDisabled, recording]);

  const doStop = useCallback(async () => {
    if (!recorderRef.current || recorderRef.current.state() !== 'recording') return;
    stopTimer();
    setRecording(false);
    onRecordingStateChange?.(false);
    try {
      const result = await recorderRef.current.stop();
      onRecordingComplete(result.blob, result.durationSeconds, result.mimeType);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[VoiceRecordButton] Failed to stop recording:', err);
      toast.error(message || 'Failed to finish recording');
    } finally {
      recorderRef.current = null;
      setElapsed(0);
    }
  }, [onRecordingComplete]);

  // Auto-stop when remaining quota is about to be exceeded
  useEffect(() => {
    if (recording && elapsed >= remainingSeconds) {
      doStop();
    }
  }, [elapsed, recording, remainingSeconds, doStop]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopTimer();
      if (recorderRef.current?.state() === 'recording') {
        recorderRef.current.cancel();
      }
    };
  }, []);

  const handleClick = () => {
    if (isDisabled || isStartingRef.current) return;
    if (recording) {
      doStop();
    } else {
      doStart();
    }
  };

  const handleCancel = () => {
    if (!recorderRef.current) return;
    recorderRef.current.cancel();
    recorderRef.current = null;
    stopTimer();
    setRecording(false);
    setElapsed(0);
    onRecordingStateChange?.(false);
  };

  const remainingMin = Math.floor(remainingSeconds / 60);
  const remainingSec = remainingSeconds % 60;
  const tooltipText = quotaExhausted
    ? 'Daily voice limit reached (10 min/day). Resets at midnight UTC.'
    : `Voice message (${remainingMin}:${remainingSec.toString().padStart(2, '0')} remaining today)`;

  if (recording) {
    return (
      <div className="flex items-center gap-1.5">
        {/* Recording indicator */}
        <span className="flex items-center gap-1 text-xs text-destructive font-medium tabular-nums animate-pulse select-none">
          <span className="w-1.5 h-1.5 rounded-full bg-destructive" />
          {formatElapsed(elapsed)}
        </span>
        {/* Stop button */}
        <button
          type="button"
          onClick={doStop}
          style={{ touchAction: 'manipulation' }}
          className="w-10 h-10 rounded-xl flex items-center justify-center bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors shrink-0"
          aria-label="Stop recording"
          title="Stop and send"
        >
          <Square className="w-4 h-4" />
        </button>
        {/* Cancel button */}
        <button
          type="button"
          onClick={handleCancel}
          style={{ touchAction: 'manipulation' }}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-muted transition-colors shrink-0"
          aria-label="Cancel recording"
          title="Cancel"
        >
          <MicOff className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  const handleFallbackUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onRecordingComplete(file, 0, file.type);
    }
    if (fallbackInputRef.current) {
      fallbackInputRef.current.value = '';
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={isDisabled}
        className={className || `w-10 h-10 rounded-xl flex items-center justify-center transition-colors shrink-0 ${
          quotaExhausted || disabled
            ? 'text-muted-foreground/40 cursor-not-allowed'
            : 'text-muted-foreground hover:text-primary hover:bg-muted'
        }`}
        style={{ touchAction: 'manipulation', ...style }}
        aria-label={quotaExhausted ? 'Daily voice limit reached' : 'Record voice message'}
        title={tooltipText}
      >
        <Mic className="w-5 h-5" />
      </button>
      <input
        type="file"
        ref={fallbackInputRef}
        accept="audio/*"
        className="hidden"
        onChange={handleFallbackUpload}
      />
    </>
  );
}
