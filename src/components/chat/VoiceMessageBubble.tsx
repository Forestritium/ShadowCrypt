/**
 * VoiceMessageBubble
 *
 * Renders an inline voice message player inside a chat bubble.
 * The audio bytes are fetched on first play (lazy), decrypted with AES-256-GCM,
 * and played back via a blob: URL so plaintext audio never hits the network.
 *
 * Props:
 *   storagePath   — Supabase Storage path of the encrypted blob.
 *   voiceKey      — Base64 AES-256-GCM decryption key.
 *   duration      — Pre-stored duration in seconds (shown before audio loads).
 *   isSelf        — Applies inverted colour styling for own messages.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { Play, Pause, Mic } from 'lucide-react';
import { fetchAndDecryptVoiceMessage } from '@/lib/relay';

interface VoiceMessageBubbleProps {
  storagePath: string;
  voiceKey: string;
  duration: number; // seconds
  isSelf: boolean;
}

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function VoiceMessageBubble({
  storagePath,
  voiceKey,
  duration,
  isSelf,
}: VoiceMessageBubbleProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentSec, setCurrentSec] = useState(0);
  const [totalSec, setTotalSec] = useState(duration);
  const [error, setError] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  // Revoke blob URL on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, []);

  const tickPlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || audio.paused) return;
    setCurrentSec(Math.floor(audio.currentTime));
    rafRef.current = requestAnimationFrame(tickPlayback);
  }, []);

  const loadAndPlay = async () => {
    if (loading) return;

    // If already loaded, just toggle play/pause
    if (blobUrl && audioRef.current) {
      if (playing) {
        audioRef.current.pause();
      } else {
        audioRef.current.play().catch(() => {});
      }
      return;
    }

    setLoading(true);
    setError(false);
    try {
      const url = await fetchAndDecryptVoiceMessage(storagePath, voiceKey);
      blobUrlRef.current = url;
      setBlobUrl(url);
      // Audio element will auto-play via onLoadedMetadata handler
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  const handleAudioLoaded = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (Number.isFinite(audio.duration)) setTotalSec(Math.round(audio.duration));
    audio.play().catch(() => {});
  };

  const handlePlay = () => {
    setPlaying(true);
    rafRef.current = requestAnimationFrame(tickPlayback);
  };

  const handlePause = () => {
    setPlaying(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  };

  const handleEnded = () => {
    setPlaying(false);
    setCurrentSec(0);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (audioRef.current) audioRef.current.currentTime = 0;
  };

  const handleScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value);
    setCurrentSec(val);
    if (audioRef.current) audioRef.current.currentTime = val;
  };

  const progressPct = totalSec > 0 ? (currentSec / totalSec) * 100 : 0;

  // Colour tokens adapt to bubble side (own = primary foreground, other = primary)
  const iconCls = isSelf
    ? 'text-primary-foreground/80 hover:text-primary-foreground'
    : 'text-primary hover:text-primary/80';
  const trackCls = isSelf ? 'bg-primary-foreground/25' : 'bg-primary/20';
  const fillCls = isSelf ? 'bg-primary-foreground/70' : 'bg-primary';
  const timeCls = isSelf ? 'text-primary-foreground/70' : 'text-muted-foreground';

  return (
    <div className="flex items-center gap-2 min-w-[180px] max-w-[240px] py-0.5">
      {/* Hidden audio element */}
      {blobUrl && (
        <audio
          ref={audioRef}
          src={blobUrl}
          onLoadedMetadata={handleAudioLoaded}
          onPlay={handlePlay}
          onPause={handlePause}
          onEnded={handleEnded}
          preload="auto"
        />
      )}

      {/* Play / Pause button */}
      <button
        type="button"
        onClick={loadAndPlay}
        disabled={loading}
        className={`shrink-0 w-8 h-8 flex items-center justify-center rounded-full transition-colors ${iconCls}`}
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
      >
        {loading ? (
          <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
        ) : playing ? (
          <Pause className="w-4 h-4" />
        ) : (
          <Play className="w-4 h-4 translate-x-px" />
        )}
      </button>

      {/* Waveform bar + scrubber */}
      <div className="flex-1 flex flex-col gap-1 min-w-0">
        {error ? (
          <span className={`text-xs ${timeCls} opacity-70`}>Failed to load audio</span>
        ) : (
          <>
            {/* Progress track + invisible scrubber overlay */}
            <div className={`relative h-3 flex items-center rounded-full ${trackCls}`}>
              <div
                className={`absolute inset-y-0 left-0 rounded-full ${fillCls} transition-none`}
                style={{ width: `${progressPct}%` }}
              />
              <input
                type="range"
                min={0}
                max={totalSec}
                value={currentSec}
                onChange={handleScrub}
                className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
                aria-label="Voice message progress"
              />
            </div>
          </>
        )}
        {/* Duration */}
        <div className="flex items-center gap-1">
          <Mic className={`w-2.5 h-2.5 shrink-0 ${timeCls}`} />
          <span className={`text-xs tabular-nums ${timeCls}`}>
            {playing || currentSec > 0
              ? `${formatDuration(currentSec)} / ${formatDuration(totalSec)}`
              : formatDuration(totalSec)}
          </span>
        </div>
      </div>
    </div>
  );
}
