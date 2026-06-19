import React, { useEffect, useRef } from 'react';
import { Html5Qrcode } from 'html5-qrcode';

// Thin wrapper around html5-qrcode's camera scanner. Calls onScan(decodedText)
// for each successful decode (caller is responsible for debouncing duplicates).
const QrScanner = ({ onScan, onError }) => {
  const containerRef = useRef(null);
  const scannerRef = useRef(null);

  useEffect(() => {
    const elId = 'qr-reader-' + Math.random().toString(36).slice(2);
    if (!containerRef.current) return undefined;
    containerRef.current.id = elId;
    let scanner;
    try {
      scanner = new Html5Qrcode(elId);
      scannerRef.current = scanner;
      scanner
        .start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 220, height: 220 } },
          (decodedText) => { if (decodedText) onScan(decodedText); },
          () => { /* ignore per-frame decode misses */ },
        )
        .catch((err) => { if (onError) onError(err); });
    } catch (err) {
      if (onError) onError(err);
    }
    return () => {
      const s = scannerRef.current;
      if (s) {
        s.stop().then(() => s.clear()).catch(() => {});
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={containerRef} className="mx-auto w-full max-w-sm overflow-hidden rounded-xl border border-slate-300 bg-black" />;
};

export default QrScanner;
