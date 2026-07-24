/**
 * ImageCropDialog — canvas-based profile picture cropping tool.
 * No external dependencies: uses the browser's native Canvas 2D API.
 *
 * Features:
 *   - Drag to pan, scroll/pinch to zoom
 *   - Circular preview overlay
 *   - Outputs a square PNG blob at the specified size (default 400×400)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ZoomIn, ZoomOut } from 'lucide-react';

interface ImageCropDialogProps {
  open: boolean;
  imageSrc: string;
  onCrop: (blob: Blob) => void;
  onCancel: () => void;
  outputSize?: number;
}

export function ImageCropDialog({
  open, imageSrc, onCrop, onCancel, outputSize = 400,
}: ImageCropDialogProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });
  const CANVAS_SIZE = 280;

  // Load image
  useEffect(() => {
    if (!imageSrc) return;
    const img = new Image();
    img.src = imageSrc;
    img.onload = () => {
      imgRef.current = img;
      setZoom(1);
      setOffset({ x: 0, y: 0 });
    };
  }, [imageSrc]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // Draw image centered + zoomed + offset
    const scale = (CANVAS_SIZE / Math.min(img.width, img.height)) * zoom;
    const w = img.width * scale;
    const h = img.height * scale;
    const x = (CANVAS_SIZE - w) / 2 + offset.x;
    const y = (CANVAS_SIZE - h) / 2 + offset.y;
    ctx.drawImage(img, x, y, w, h);

    // Darken outside circle
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(CANVAS_SIZE / 2, CANVAS_SIZE / 2, CANVAS_SIZE / 2 - 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Redraw image inside circle only
    ctx.save();
    ctx.beginPath();
    ctx.arc(CANVAS_SIZE / 2, CANVAS_SIZE / 2, CANVAS_SIZE / 2 - 4, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, x, y, w, h);
    ctx.restore();

    // Circle border
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(CANVAS_SIZE / 2, CANVAS_SIZE / 2, CANVAS_SIZE / 2 - 4, 0, Math.PI * 2);
    ctx.stroke();
  }, [zoom, offset]);

  useEffect(() => { draw(); }, [draw]);

  // Drag handlers
  const onPointerDown = (e: React.PointerEvent) => {
    dragging.current = true;
    lastPos.current = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };
    setOffset(o => ({ x: o.x + dx, y: o.y + dy }));
  };
  const onPointerUp = () => { dragging.current = false; };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setZoom(z => Math.min(4, Math.max(0.5, z - e.deltaY * 0.002)));
  };

  const handleCrop = () => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;

    // Render the cropped circle to an output canvas at desired resolution
    const out = document.createElement('canvas');
    out.width = outputSize;
    out.height = outputSize;
    const ctx = out.getContext('2d')!;

    const scale = (CANVAS_SIZE / Math.min(img.width, img.height)) * zoom;
    const w = img.width * scale;
    const h = img.height * scale;
    const x = (CANVAS_SIZE - w) / 2 + offset.x;
    const y = (CANVAS_SIZE - h) / 2 + offset.y;

    // Scale factors from CANVAS_SIZE to outputSize
    const f = outputSize / CANVAS_SIZE;
    ctx.save();
    ctx.beginPath();
    ctx.arc(outputSize / 2, outputSize / 2, outputSize / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, x * f, y * f, w * f, h * f);
    ctx.restore();

    out.toBlob(blob => { if (blob) onCrop(blob); }, 'image/png', 0.9);
  };

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onCancel(); }}>
      <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-sm" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Crop Profile Picture</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4">
          {/* Canvas preview */}
          <canvas
            ref={canvasRef}
            width={CANVAS_SIZE}
            height={CANVAS_SIZE}
            className="rounded-xl cursor-grab active:cursor-grabbing touch-none select-none"
            style={{ width: CANVAS_SIZE, height: CANVAS_SIZE }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onWheel={handleWheel}
          />

          {/* Zoom control */}
          <div className="w-full flex items-center gap-3 px-1">
            <ZoomOut className="w-4 h-4 text-muted-foreground shrink-0" />
            <input
              type="range"
              min={50} max={400} step={5}
              value={zoom * 100}
              onChange={e => setZoom(Number(e.target.value) / 100)}
              className="flex-1 accent-primary h-1.5 cursor-pointer"
            />
            <ZoomIn className="w-4 h-4 text-muted-foreground shrink-0" />
          </div>
          <p className="text-xs text-muted-foreground -mt-2">Drag to reposition · Scroll to zoom</p>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={handleCrop}>Use Photo</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
