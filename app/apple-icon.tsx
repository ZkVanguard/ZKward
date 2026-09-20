import { ImageResponse } from 'next/og';

// 180×180 for iOS home-screen and iPadOS. Solid background — iOS applies
// its own rounded-square mask, so we skip border-radius to avoid the
// double-mask look.
export const runtime = 'nodejs';
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#5372FF',
        }}
      >
        <div
          style={{
            fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
            fontWeight: 900,
            fontSize: 92,
            color: '#FFFFFF',
            letterSpacing: '-0.06em',
            lineHeight: 1,
          }}
        >
          ZK
        </div>
      </div>
    ),
    { ...size },
  );
}
