/**
 * VoiceRecordButton
 *
 * A hold-to-record + tap-to-record voice button for the chat input bar.
 *
 * Behaviour:
 *  - Tap once  → starts recording, button turns red; tap again → stops and submits.
 *  - Hold (pointerdown ≥ 300 ms) → same toggle-on; release → auto-stops and submits.
 *  - While recording a live elapsed timer is shown.
 *  - When the remaining daily quota would be exceeded, the recorder auto-stops at the limit.
 *  - Shows a tooltip with remaining daily minutes on hover.
 *
 * The parent receives { blob, durationSeconds, mimeType } via onRecordingComplete.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { Mic, MicOff, Square } from 'lucide-react';
import { createVoiceRecorder, VOICE_DAILY_LIMIT_SECONDS } from '@/lib/voiceRecorder';
import type { VoiceRecorderHandle } from '@/lib/voiceRecorder';

interface VoiceRecordButtonProps {
  /** Called when a recording is finished and ready to upload. */
  onRecordingComplete: (blob: Blob, durationSeconds: number, mimeType: string) => void;
  /** Seconds already used today — parent fetches this from the server. */
  usedSecondsToday: number;
  disabled?: boolean;
}

function formatElapsed(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function VoiceRecordButton({
  onRecordingComplete,
  usedSecondsToday,
  disabled = false,
}: VoiceRecordButtonProps) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const recorderRef = useRef<VoiceRecorderHandle | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const remainingSeconds = Math.max(0, VOICE_DAILY_LIMIT_SECONDS - usedSecondsToday);
  const quotaExhausted = remainingSeconds <= 0;

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

  // Auto-stop when remaining quota is about to be exceeded
  useEffect(() => {
    if (recording && elapsed >= remainingSeconds) {
      handleStop();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsed, recording, remainingSeconds]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopTimer();
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      if (recorderRef.current?.state() === 'recording') {
        recorderRef.current.cancel();
      }
    };
  }, []);

  const handleStart = useCallback(async () => {
    if (disabled || quotaExhausted || recording) return;
    const recorder = createVoiceRecorder();
    recorderRef.current = recorder;
    try {
      await recorder.start();
      setRecording(true);
      setElapsed(0);
      startTimer(Date.now());
    } catch (err) {
      console.error('[VoiceRecordButton] Failed to start recording:', err);
      recorderRef.current = null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, quotaExhausted, recording]);

  const handleStop = useCallback(async () => {
    if (!recorderRef.current || recorderRef.current.state() !== 'recording') return;
    stopTimer();
    setRecording(false);
    try {
      const result = await recorderRef.current.stop();
      onRecordingComplete(result.blob, result.durationSeconds, result.mimeType);
    } catch (err) {
      console.error('[VoiceRecordButton] Failed to stop recording:', err);
    } finally {
      recorderRef.current = null;
      setElapsed(0);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRecordingComplete]);

  const handleCancel = useCallback(() => {
    if (!recorderRef.current) return;
    recorderRef.current.cancel();
    recorderRef.current = null;
    stopTimer();
    setRecording(false);
    setElapsed(0);
  }, []);

  const handleClick = () => {
    if (recording) {
      handleStop();
    } else {
      handleStart();
    }
  };

  // Hold detection: pointerdown → start, pointerup → stop
  const handlePointerDown = () => {
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      // If recording already started via quick click, ignore
    }, 300);
  };

  const handlePointerUp = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
      // Short press — toggle handled by onClick
    } else if (recording) {
      // Long press release — auto-stop
      handleStop();
    }
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
          onClick={handleStop}
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
          className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-muted transition-colors shrink-0"
          aria-label="Cancel recording"
          title="Cancel"
        >
          <MicOff className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      disabled={disabled || quotaExhausted}
      className={`w-10 h-10 rounded-xl flex items-center justify-center transition-colors shrink-0 ${
        quotaExhausted || disabled
          ? 'text-muted-foreground/40 cursor-not-allowed'
          : 'text-muted-foreground hover:text-primary hover:bg-muted'
      }`}
      aria-label={quotaExhausted ? 'Daily voice limit reached' : 'Record voice message'}
      title={tooltipText}
    >
      <Mic className="w-5 h-5" />
    </button>
  );
}
