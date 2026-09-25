import { ImageResponse } from 'next/og';
import { logoMarkPath } from '@/components/logo';
import { socialImageSize } from './metadata';
import { ogFonts } from './og-fonts';
import { creator } from './shared';

/**
 * The 1200×630 social card behind every page's `og:image` and `twitter:image`, drawn in the site's instrument
 * language: graphite, two rack rails with square holes, a U-numbered unit label, the title in Plex Mono, and one
 * row of GPU sockets on the right, half of them lit in the signal amber.
 */

const { width: W, height: H } = socialImageSize;
const rail = { left: 72, right: W - 72, top: 96, bottom: H - 96 };
const color = {
  background: '#0b0c0f',
  panel: '#101215',
  ink: '#eff1f3',
  secondary: '#99a0aa',
  tertiary: '#6d747e',
  line: '#22262c',
  hole: '#31363d',
  signal: '#ff7f1a',
  signalText: '#ff9838',
};

const mark = logoMarkPath;

/** Rails with holes, unit hairlines, and the GPU socket row, as one SVG under the text. */
function backdrop() {
  const holes = [rail.left - 22, rail.right + 22]
    .flatMap((x) =>
      Array.from({ length: Math.floor(H / 26) }, (_, i) => `M${x - 3} ${10 + i * 26}h6v6h-6z`),
    )
    .join('');
  const cell = 34;
  const gap = 8;
  const cellsX = rail.right - 40 - (8 * cell + 7 * gap + 14);
  const cellsY = rail.top + 48;
  const cells = Array.from({ length: 8 }, (_, i) => {
    const x = cellsX + i * (cell + gap) + (i >= 4 ? 14 : 0);
    const lit = [0, 1, 2, 4].includes(i);
    return `<rect x="${x}" y="${cellsY}" width="${cell}" height="${cell}" fill="${lit ? color.signal : 'none'}" stroke="${lit ? color.signal : color.hole}" stroke-width="2"/>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse" x="${rail.left}" y="${rail.top}">
      <path d="M32 0H0V32" fill="none" stroke="#15171b" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="${W}" height="${H}" fill="${color.background}"/>
  <rect x="${rail.left}" y="${rail.top}" width="${rail.right - rail.left}" height="${rail.bottom - rail.top}" fill="${color.panel}"/>
  <rect x="${rail.left}" y="${rail.top}" width="${rail.right - rail.left}" height="${rail.bottom - rail.top}" fill="url(#grid)"/>
  <path d="${holes}" fill="${color.hole}"/>
  <path d="M${rail.left} 0V${H}M${rail.right} 0V${H}M${rail.left - 36} 0V${H}M${rail.right + 36} 0V${H}M0 ${rail.top}H${W}M0 ${rail.bottom}H${W}" stroke="${color.line}" stroke-width="1"/>
  <rect x="${rail.left - 4}" y="${rail.top - 4}" width="8" height="8" fill="${color.background}" stroke="${color.tertiary}" stroke-width="1.5"/>
  <rect x="${rail.right - 4}" y="${rail.top - 4}" width="8" height="8" fill="${color.background}" stroke="${color.tertiary}" stroke-width="1.5"/>
  <rect x="${rail.left - 4}" y="${rail.bottom - 4}" width="8" height="8" fill="${color.background}" stroke="${color.tertiary}" stroke-width="1.5"/>
  <rect x="${rail.right - 4}" y="${rail.bottom - 4}" width="8" height="8" fill="${color.background}" stroke="${color.tertiary}" stroke-width="1.5"/>
  ${cells}
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

export interface SocialCard {
  /** Where the page sits, shown top right: `['Guides', 'Capacity']`. */
  trail: string[];
  title: string;
  description?: string;
  /** Short monospace tags in the footer, such as the packages a page documents. */
  tags?: string[];
}

function titleSize(title: string) {
  if (title.length <= 20) return 70;
  if (title.length <= 36) return 58;
  return 48;
}

export async function socialCard({ trail, title, description, tags = [] }: SocialCard) {
  const fonts = await ogFonts();
  const size = titleSize(title);
  const mono = 'IBM Plex Mono';
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          position: 'relative',
          background: color.background,
          color: color.ink,
          fontFamily: 'IBM Plex Sans',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={backdrop()} width={W} height={H} alt="" style={{ position: 'absolute' }} />

        <div
          style={{
            position: 'absolute',
            left: rail.left,
            top: 0,
            width: rail.right - rail.left,
            height: rail.top,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 40px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <svg width="36" height="36" viewBox="0 0 24 24">
              <path fill={color.signal} fillRule="evenodd" d={mark} />
            </svg>
            <div
              style={{
                display: 'flex',
                fontFamily: mono,
                fontWeight: 500,
                fontSize: 30,
                letterSpacing: -1.2,
              }}
            >
              <span style={{ color: color.secondary }}>better</span>
              <span style={{ color: color.signalText }}>/</span>
              <span>compute</span>
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              gap: 14,
              fontFamily: mono,
              fontWeight: 500,
              fontSize: 17,
              letterSpacing: 1.5,
              textTransform: 'uppercase',
              color: color.secondary,
            }}
          >
            {trail.map((part, index) => (
              <span key={part} style={{ display: 'flex', gap: 14 }}>
                {index > 0 ? <span style={{ color: color.tertiary }}>/</span> : null}
                {part}
              </span>
            ))}
          </div>
        </div>

        <div
          style={{
            position: 'absolute',
            left: rail.left,
            top: rail.top,
            display: 'flex',
            padding: '4px 12px',
            borderRight: `1px solid ${color.line}`,
            borderBottom: `1px solid ${color.line}`,
            background: color.background,
            fontFamily: mono,
            fontWeight: 500,
            fontSize: 15,
            letterSpacing: 1.5,
            color: color.tertiary,
          }}
        >
          U01
        </div>

        <div
          style={{
            position: 'absolute',
            left: rail.left,
            top: rail.top,
            width: rail.right - rail.left,
            height: rail.bottom - rail.top,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
            padding: '0 40px 40px',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              marginBottom: 18,
              fontFamily: mono,
              fontWeight: 500,
              fontSize: 16,
              letterSpacing: 1.5,
              textTransform: 'uppercase',
              color: color.signalText,
            }}
          >
            <div
              style={{
                width: 10,
                height: 10,
                borderRadius: 999,
                background: color.signal,
                boxShadow: `0 0 10px ${color.signal}`,
              }}
            />
            {trail[0] ?? 'Better Compute'}
          </div>
          <div
            style={{
              display: 'block',
              maxWidth: 760,
              fontFamily: mono,
              fontWeight: 500,
              fontSize: size,
              letterSpacing: size * -0.055,
              lineHeight: 1.06,
              lineClamp: 3,
            }}
          >
            {title}
          </div>
          {description ? (
            <div
              style={{
                display: 'block',
                maxWidth: 720,
                marginTop: 20,
                fontSize: 25,
                lineHeight: 1.42,
                color: color.secondary,
                lineClamp: 2,
              }}
            >
              {description}
            </div>
          ) : null}
        </div>

        <div
          style={{
            position: 'absolute',
            left: rail.left,
            top: rail.bottom,
            width: rail.right - rail.left,
            height: H - rail.bottom,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 40px',
            fontFamily: mono,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 19 }}>
            <span style={{ color: color.tertiary }}>created by</span>
            <span style={{ color: color.ink }}>{creator}</span>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            {tags.slice(0, 3).map((tag) => (
              <div
                key={tag}
                style={{
                  display: 'flex',
                  padding: '5px 14px',
                  border: `1px solid ${color.hole}`,
                  background: color.panel,
                  fontWeight: 500,
                  fontSize: 16,
                  color: '#c5cad1',
                }}
              >
                {tag}
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    { ...socialImageSize, fonts: fonts.length ? fonts : undefined },
  );
}
