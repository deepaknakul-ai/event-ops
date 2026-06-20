import React, { useEffect, useRef } from 'react';
import { Html5Qrcode, Html5QrcodeScannerState } from 'html5-qrcode';

// Thin wrapper around html5-qrcode's camera scanner. Calls onScan(decodedText)
// for each successful decode (caller is responsible for debouncing duplicates).
//
// NOTE: html5-qrcode's stop() throws SYNCHRONOUSLY ("Cannot stop, scanner is
// not running or paused") if the camera has not finished its async start() yet.
// A raw throw inside an effect-cleanup escapes into React's error boundary and
// crashes the page. So every stop() here is state-guarded AND wrapped so neither
// a synchronous throw nor a promise rejection can surface.
const QrScanner = ({ onScan, onError }) => {
  const containerRef = useRef(null);
  const scannerRef = useRef(null);

  useEffect(() => {
    const elId = 'qr-reader-' + Math.random().toString(36).slice(2);
    if (!containerRef.current) return undefined;
    containerRef.current.id = elId;

    let cancelled = false; // set when the component unmounts mid-startup

    // Safely stop + release the camera regardless of the scanner's current state.
    const teardown = (s) => {
      if (!s) return;
      try {
        const state = s.getState ? s.getState() : null;
        const running = state === Html5QrcodeScannerState.SCANNING
          || state === Html5QrcodeScannerState.PAUSED;
        if (running) {
          s.stop()
            .then(() => { try { s.clear(); } catch { /* element already gone */ } })
            .catch(() => {});
        } else {
          try { s.clear(); } catch { /* nothing to clear */ }
        }
      } catch {
        /* scanner was never running — nothing to stop */
      }
    };

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
        .then(() => {
          // Unmounted while the camera was still spinning up — release it now
          // that start() has actually completed.
          if (cancelled) teardown(scanner);
        })
        .catch((err) => { if (!cancelled && onError) onError(err); });
    } catch (err) {
      if (onError) onError(err);
    }

    return () => {
      cancelled = true;
      teardown(scannerRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={containerRef} className="mx-auto w-full max-w-sm overflow-hidden rounded-xl border border-slate-300 bg-black" />;
};

export default QrScanner;
