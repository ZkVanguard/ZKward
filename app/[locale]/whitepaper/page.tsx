import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Metadata } from 'next';
import { locales, defaultLocale } from '@/i18n/routing';
import { WhitepaperClient } from './WhitepaperClient';

export async function generateMetadata(
  { params }: { params: Promise<{ locale: string }> },
): Promise<Metadata> {
  const { locale } = await params;
  const route = '/whitepaper';
  const canonical = locale === defaultLocale ? route : `/${locale}${route}`;
  return {
    title: 'Whitepaper',
    description: 'The full ZKward thesis: prediction-market alpha, 7-agent architecture, STARK-attested execution, tokenomics, roadmap.',
    alternates: {
      canonical,
      languages: Object.fromEntries(
        locales.map((l) => [l, l === defaultLocale ? route : `/${l}${route}`]),
      ),
    },
    // See agents/layout.tsx — openGraph/twitter omitted so the file-
    // convention OG image survives.
  };
}

interface Frontmatter {
  title: string;
  subtitle: string;
  version: string;
  date: string;
}

// Tiny YAML frontmatter parser — only supports `key: value` lines wrapped in
// `---`, which is all this whitepaper needs. Beats pulling in gray-matter.
function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!match) {
    return {
      frontmatter: { title: '', subtitle: '', version: '', date: '' },
      body: raw,
    };
  }
  const fm: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([a-zA-Z]+):\s*(.+)\s*$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return {
    frontmatter: {
      title: fm.title ?? '',
      subtitle: fm.subtitle ?? '',
      version: fm.version ?? '',
      date: fm.date ?? '',
    },
    body: match[2],
  };
}

export default async function WhitepaperPage() {
  const raw = await readFile(
    path.join(process.cwd(), 'content', 'whitepaper.md'),
    'utf-8',
  );
  const { frontmatter, body } = parseFrontmatter(raw);
  return <WhitepaperClient frontmatter={frontmatter} body={body} />;
}
