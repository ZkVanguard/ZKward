"use client";

import { useCallback, useMemo } from 'react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  frontmatter: {
    title: string;
    subtitle: string;
    version: string;
    date: string;
  };
  body: string;
}

// Slugify a heading exactly the way react-markdown default renders it, so the
// TOC anchors match. Kept in sync with the plain-text heading extraction below.
const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');

export function WhitepaperClient({ frontmatter, body }: Props) {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://zkward.com';
  // JSON-LD TechArticle for the whitepaper. Constants + validated
  // frontmatter fields only; no user input.
  const articleLd = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: frontmatter.title || 'ZKward Whitepaper',
    description:
      frontmatter.subtitle ||
      'AI-managed USDC vault on SUI with STARK-attested hedge decisions.',
    inLanguage: 'en',
    url: `${baseUrl}/whitepaper`,
    isPartOf: { '@id': `${baseUrl}/#website` },
    author: { '@id': `${baseUrl}/#org` },
    publisher: { '@id': `${baseUrl}/#org` },
    datePublished: frontmatter.date || undefined,
    dateModified: frontmatter.date || undefined,
    keywords: [
      'ZKward', 'ZK-STARK', 'zero knowledge proof', 'SUI', 'DeFi',
      'autonomous vault', 'AI agents', 'prediction markets', 'BlueFin',
    ],
  };

  const handleDownload = useCallback(() => {
    if (typeof window !== 'undefined') window.print();
  }, []);

  // TOC: pull every H2 out of the body. No third-party plugin needed. The
  // markdown structure is stable enough that a one-line regex is enough.
  const toc = useMemo(() => {
    const headings: { text: string; id: string }[] = [];
    for (const line of body.split('\n')) {
      const m = /^##\s+(.+?)\s*$/.exec(line);
      if (m) headings.push({ text: m[1], id: slug(m[1]) });
    }
    return headings;
  }, [body]);

  return (
    <div className="min-h-screen bg-white light-theme" style={{ colorScheme: 'light' }}>
      {/* JSON-LD structured data. `articleLd` is composed of build-time
          constants and frontmatter fields validated by the parent
          server component. No user input reaches this string. Canonical
          Next.js JSON-LD pattern. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleLd) }}
      />
      <style jsx global>{`
        .light-theme, .light-theme * {
          --label-primary: #1D1D1F !important;
          --label-secondary: #424245 !important;
          --label-tertiary: #6E6E73 !important;
        }
        .wp-prose {
          color: #1d1d1f;
          font-size: 1rem;
          line-height: 1.7;
        }
        .wp-prose h2 {
          font-size: 1.75rem;
          font-weight: 700;
          margin-top: 3rem;
          margin-bottom: 1rem;
          scroll-margin-top: 6rem;
          color: #1d1d1f;
        }
        .wp-prose h3 {
          font-size: 1.25rem;
          font-weight: 600;
          margin-top: 2rem;
          margin-bottom: 0.75rem;
          color: #1d1d1f;
        }
        .wp-prose h4 {
          font-size: 1.05rem;
          font-weight: 600;
          margin-top: 1.5rem;
          margin-bottom: 0.5rem;
          color: #1d1d1f;
        }
        .wp-prose p {
          color: #424245;
          margin: 0.75rem 0;
        }
        .wp-prose a {
          color: #0069D9;
          text-decoration: none;
        }
        .wp-prose a:hover { text-decoration: underline; }
        .wp-prose ul, .wp-prose ol {
          padding-left: 1.5rem;
          margin: 0.75rem 0;
          color: #424245;
        }
        .wp-prose li { margin: 0.25rem 0; }
        .wp-prose strong { color: #1d1d1f; }
        .wp-prose code {
          background: #f0f0f2;
          padding: 0.1rem 0.35rem;
          border-radius: 4px;
          font-size: 0.9em;
        }
        .wp-prose pre {
          background: #1d1d1f;
          color: #4ade80;
          padding: 1.25rem;
          border-radius: 0.75rem;
          overflow-x: auto;
          margin: 1.25rem 0;
          font-size: 0.75rem;
          line-height: 1.5;
        }
        .wp-prose pre code {
          background: transparent;
          padding: 0;
          color: inherit;
        }
        .wp-prose table {
          width: 100%;
          border-collapse: collapse;
          margin: 1.25rem 0;
          background: #fafafa;
          border: 1px solid #e5e5e5;
          border-radius: 0.75rem;
          overflow: hidden;
          font-size: 0.9rem;
        }
        .wp-prose thead { background: #f0f0f2; }
        .wp-prose th, .wp-prose td {
          padding: 0.75rem 1rem;
          text-align: left;
          border-bottom: 1px solid #e5e5e5;
        }
        .wp-prose th { color: #1d1d1f; font-weight: 600; }
        .wp-prose td { color: #424245; }
        .wp-prose tr:last-child td { border-bottom: none; }
        .wp-prose blockquote {
          border-left: 4px solid #0069D9;
          padding: 0.75rem 1rem;
          margin: 1rem 0;
          background: rgba(0, 122, 255, 0.04);
          color: #1d1d1f;
        }
        .wp-prose hr {
          border: none;
          border-top: 1px solid #e5e5e7;
          margin: 2rem 0;
        }

        @media print {
          nav, .no-print { display: none !important; }
          main { padding: 0 !important; max-width: 100% !important; }
          .wp-prose h2 { break-before: page; page-break-before: page; }
          .wp-prose h2:first-of-type { break-before: auto; page-break-before: auto; }
          .wp-prose pre {
            background: #f5f5f7 !important;
            color: #1d1d1f !important;
            border: 1px solid #e5e5e7;
          }
          .wp-prose a { color: #1d1d1f !important; text-decoration: none !important; }
          @page { margin: 20mm; }
        }
      `}</style>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 pt-24 sm:pt-32 pb-10 sm:pb-16">
        <div className="text-center mb-10 sm:mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 sm:px-4 sm:py-2 bg-ios-blue/10 rounded-full text-xs sm:text-sm font-medium mb-4 sm:mb-6 text-ios-blue">
            <span>{frontmatter.version}</span>
            <span>•</span>
            <span>{frontmatter.date}</span>
          </div>
          <h1 className="text-3xl sm:text-5xl md:text-6xl font-bold text-label-primary mb-4 sm:mb-6 tracking-tight leading-[1.1]">
            {frontmatter.title}
          </h1>
          <p className="text-base sm:text-xl text-label-quaternary max-w-2xl mx-auto leading-relaxed">
            {frontmatter.subtitle}
          </p>
        </div>

        <div className="no-print flex flex-col sm:flex-row justify-center items-stretch sm:items-center gap-3 mb-10 sm:mb-16">
          <a
            href={toc[0] ? `#${toc[0].id}` : '#'}
            className="inline-flex items-center justify-center gap-2 px-6 sm:px-8 py-3.5 sm:py-4 bg-ios-blue text-white rounded-full font-medium hover:bg-[#0062CC] active:scale-[0.98] transition-all text-sm sm:text-base"
          >
            <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
            Read Whitepaper
          </a>
          <button
            type="button"
            onClick={handleDownload}
            className="inline-flex items-center justify-center gap-2 px-6 sm:px-8 py-3.5 sm:py-4 bg-system-bg-primary border border-separator-opaque text-label-primary rounded-full font-medium hover:bg-system-bg-secondary active:scale-[0.98] transition-all text-sm sm:text-base"
          >
            <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1M12 12V4m0 8l-4-4m4 4l4-4" />
            </svg>
            Download PDF
          </button>
        </div>

        <nav className="bg-system-bg-secondary rounded-2xl p-5 sm:p-8 mb-10 sm:mb-16 no-print">
          <h2 className="text-lg font-semibold text-label-primary mb-6">Table of Contents</h2>
          <ol className="space-y-3">
            {toc.map((h, i) => (
              <li key={h.id}>
                <a href={`#${h.id}`} className="flex items-center gap-4 text-label-secondary hover:text-ios-blue transition-colors">
                  <span className="w-8 h-8 flex items-center justify-center bg-system-bg-primary rounded-lg text-sm font-medium text-label-quaternary">
                    {i + 1}
                  </span>
                  <span>{h.text}</span>
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <article className="wp-prose">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              // Give H2s stable slug IDs matching TOC anchors.
              h2: ({ children, ...props }) => {
                const text = String(children);
                return <h2 id={slug(text)} {...props}>{children}</h2>;
              },
            }}
          >
            {body}
          </ReactMarkdown>
        </article>

        <div className="mt-16 text-center no-print">
          <div className="bg-gradient-to-r from-ios-blue to-[#5AC8FA] rounded-2xl p-8 text-white">
            <h3 className="text-2xl font-bold mb-4">Ready to Ride the Alpha?</h3>
            <p className="text-white/80 mb-6 max-w-xl mx-auto">
              One-click deposit. Autonomous execution. ZK-attested decisions on SUI mainnet.
            </p>
            <div className="flex flex-wrap justify-center gap-4">
              <Link href="/dashboard" className="inline-flex items-center gap-2 px-6 py-3 bg-white text-ios-blue rounded-full font-medium hover:bg-white/90 transition-colors">
                Launch App
              </Link>
              <a href="https://github.com/ZkVanguard/zkward-ethglobal" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 px-6 py-3 bg-white/20 text-white rounded-full font-medium hover:bg-white/30 transition-colors">
                View source
              </a>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
