import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Icon } from './Icon';

interface QrCodeProps {
  value: string;
  size?: number;
  /** File name (without extension) for the PNG download. */
  fileName?: string;
  showDownload?: boolean;
}

/** QR code rendered in the browser with the `qrcode` package: no third-party image service. */
export function QrCode({ value, size = 168, fileName = 'linkpulse-qr', showDownload = true }: QrCodeProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    QRCode.toString(value, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#17132b', light: '#ffffff' } })
      .then((s) => !cancelled && setSvg(s))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [value]);

  const download = async () => {
    const dataUrl = await QRCode.toDataURL(value, { width: 1024, margin: 2, errorCorrectionLevel: 'M' });
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `${fileName}.png`;
    a.click();
  };

  return (
    <div className="qr">
      <div
        className="qr__img"
        style={{ width: size, height: size }}
        role="img"
        aria-label={`QR code for ${value}`}
        // The SVG string comes from the qrcode library, not from user HTML.
        dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
      >
        {!svg && !failed ? <span className="skeleton" style={{ width: '100%', height: '100%' }} /> : null}
      </div>
      {showDownload && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={download} disabled={!svg}>
          <Icon name="download" size={15} /> Download PNG
        </button>
      )}
    </div>
  );
}
