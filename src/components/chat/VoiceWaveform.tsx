import { useEffect, useRef } from 'react';
import { useWaveformSettings } from '@/hooks/use-waveform-settings';

export function VoiceWaveform({ analyser }: { analyser: AnalyserNode | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | null>(null);
  const { settings } = useWaveformSettings();

  useEffect(() => {
    if (!analyser || !canvasRef.current || !containerRef.current) return;

    const canvas = canvasRef.current;
    const container = containerRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bufferLength = analyser.frequencyBinCount;
    // For legacy style we need time domain data, for modern we use frequency data
    const dataArray = new Uint8Array(bufferLength);

    const resizeCanvas = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      
      ctx.scale(dpr, dpr);
    };

    const resizeObserver = new ResizeObserver(() => resizeCanvas());
    resizeObserver.observe(container);
    resizeCanvas();

    const draw = () => {
      if (!canvasRef.current || !containerRef.current) return;
      
      const w = containerRef.current.clientWidth;
      const h = containerRef.current.clientHeight;

      if (w === 0 || h === 0) {
        animationRef.current = requestAnimationFrame(draw);
        return;
      }

      animationRef.current = requestAnimationFrame(draw);

      if (settings.type === 'legacy') {
        analyser.getByteTimeDomainData(dataArray);
      } else {
        analyser.getByteFrequencyData(dataArray);
      }

      ctx.clearRect(0, 0, w, h);

      const isMobile = window.innerWidth < 768;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      
      let strokeColor = '#10b981';
      if (settings.color !== 'primary' && settings.color !== '') {
        strokeColor = settings.color;
      } else {
        try {
          const rootStyle = getComputedStyle(document.documentElement);
          const primaryRaw = rootStyle.getPropertyValue('--primary').trim();
          strokeColor = primaryRaw.includes(' ') ? `hsl(${primaryRaw})` : (primaryRaw || '#10b981');
        } catch {
          // fallback
        }
      }
      ctx.strokeStyle = strokeColor;

      ctx.beginPath();

      if (settings.type === 'legacy') {
        ctx.lineWidth = isMobile ? 3 : 2;
        const sliceWidth = (w * 1.0) / bufferLength;
        let x = 0;

        const points: {x: number, y: number}[] = [];
        for (let i = 0; i < bufferLength; i++) {
          const v = dataArray[i] / 128.0;
          const scale = 8.0; 
          let y = h / 2 + (v - 1) * (h / 2) * scale;
          y = Math.max(ctx.lineWidth, Math.min(h - ctx.lineWidth, y));
          points.push({ x, y });
          x += sliceWidth;
        }
        
        points.push({ x: w, y: h / 2 });

        if (points.length > 0) {
          ctx.moveTo(points[0].x, points[0].y);
          for (let i = 0; i < points.length - 1; i++) {
            const xMid = (points[i].x + points[i + 1].x) / 2;
            const yMid = (points[i].y + points[i + 1].y) / 2;
            ctx.quadraticCurveTo(points[i].x, points[i].y, xMid, yMid);
          }
          ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
        }
        ctx.stroke();

      } else {
        // Modern Bar-style
        const barWidth = isMobile ? 3 : 2;
        const gap = isMobile ? 3 : 2;
        ctx.lineWidth = barWidth;

        // Limit the rendering to lower active frequencies (first 40%)
        const usableBufferLength = Math.floor(bufferLength * 0.4);
        const totalBars = Math.floor(w / (barWidth + gap));
        const step = Math.max(1, Math.floor(usableBufferLength / totalBars));
        let x = (w - (totalBars * (barWidth + gap))) / 2 + barWidth / 2;

        for (let i = 0; i < totalBars; i++) {
          let sum = 0;
          for (let j = 0; j < step; j++) {
            sum += dataArray[i * step + j] || 0;
          }
          const avg = sum / step;
          const v = avg / 255.0; 
          
          let barHeight = Math.max(barWidth, v * h * 1.5);
          barHeight = Math.min(barHeight, h - barWidth);

          ctx.moveTo(x, h / 2 - barHeight / 2);
          ctx.lineTo(x, h / 2 + barHeight / 2);

          x += barWidth + gap;
        }
        ctx.stroke();
      }
    };

    draw();

    return () => {
      resizeObserver.disconnect();
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [analyser, settings]);

  return (
    <div ref={containerRef} className="w-full h-full flex items-center justify-center">
      <canvas ref={canvasRef} className="block opacity-80" />
    </div>
  );
}
