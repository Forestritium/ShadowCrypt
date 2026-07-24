/**
 * QRCodeDataUrl — renders a QR code for any string using the `qrcode` library.
 * Returns a <canvas>-backed <img> so it works in all browsers without SVG quirks.
 */
import { useEffect, useRef } from 'react';
import QRCode from 'qrcode';

interface QRCodeDataUrlProps {
  value: string;
  size?: number;
  className?: string;
}

export function QRCodeDataUrl({ value, size = 200, className }: QRCodeDataUrlProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current || !value) return;
    QRCode.toCanvas(canvasRef.current, value, {
      width: size,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    }).catch(console.error);
  }, [value, size]);

  return <canvas ref={canvasRef} className={className} width={size} height={size} />;
}
