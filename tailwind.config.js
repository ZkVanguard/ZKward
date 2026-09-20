/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      // xs breakpoint (475px) for content that needs to change slightly above
      // the smallest phones (320-374px iPhone SE) but below the standard 640px
      // sm: breakpoint. Used sparingly — mostly for label/full-label swaps.
      screens: {
        xs: '475px',
      },
      fontFamily: {
        // Body/UI — SF system stack (fast, familiar, no web-font cost)
        sans: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Display', 'SF Pro Text', 'system-ui', 'sans-serif'],
        // Display — pure system font stack. Space Grotesk was dropped
        // 2026-09-20 to remove the render-blocking font CSS and the
        // WOFF2 payload. LCP win, near-identical look at heading weights.
        display: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Display', 'system-ui', 'sans-serif'],
      },
      colors: {
        // Apple iOS System Colors - Light Mode.
        // ios.blue was #007AFF (Apple's system blue) but that gives
        // white-text-on-blue only 4.01:1 contrast — fails WCAG AA on
        // every CTA. Darkened to #0069D9 (5.22:1) so primary buttons
        // are readable for low-vision users while staying visually
        // in the iOS blue family.
        ios: {
          blue: '#0069D9',
          blueHover: '#0062CC',
          green: '#34C759',
          orange: '#FF9500',
          red: '#FF3B30',
          gray: '#8E8E93',
          gray2: '#AEAEB2',
          gray3: '#C7C7CC',
          gray4: '#D1D1D6',
          gray5: '#E5E5EA',
          gray6: '#F2F2F7',
        },
        // Chain accent palette — dedicated tokens so we stop sprinkling
        // raw #00A79F throughout the codebase. hedera.teal matches the
        // Hedera brand teal; use `text-teal-700` for small text (WCAG
        // contrast rule same as ios-green).
        hedera: {
          teal: '#00A79F',
          tealHover: '#009288',
        },
        // Text Colors (Light Mode) - Enhanced Contrast
        label: {
          primary: '#1D1D1F',
          secondary: '#424245',
          tertiary: '#6E6E73',
          quaternary: '#86868B',
        },
        // Background Colors (Light Mode)
        'system-bg': {
          primary: '#FFFFFF',
          secondary: '#F5F5F7',
          tertiary: '#FAFAFA',
          grouped: '#F2F2F7',
        },
        // Separator Colors
        separator: {
          opaque: '#C6C6C8',
          nonOpaque: 'rgba(60, 60, 67, 0.29)',
        },
      },
      spacing: {
        // 8pt grid system
        '4.5': '18px',  // 18pt
        '5.5': '22px',  // 22pt (44pt touch target / 2)
        '11': '44px',   // 44pt minimum touch target
        '15': '60px',
        '18': '72px',
      },
      fontSize: {
        // Apple Typography Scale
        'large-title': ['34px', { lineHeight: '41px', letterSpacing: '0.37px', fontWeight: '700' }],
        'title-1': ['28px', { lineHeight: '34px', letterSpacing: '0.36px', fontWeight: '700' }],
        'title-2': ['22px', { lineHeight: '28px', letterSpacing: '0.35px', fontWeight: '700' }],
        'title-3': ['20px', { lineHeight: '25px', letterSpacing: '0.38px', fontWeight: '600' }],
        'headline': ['17px', { lineHeight: '22px', letterSpacing: '-0.41px', fontWeight: '600' }],
        'body': ['17px', { lineHeight: '22px', letterSpacing: '-0.41px', fontWeight: '400' }],
        'callout': ['16px', { lineHeight: '21px', letterSpacing: '-0.32px', fontWeight: '400' }],
        'subheadline': ['15px', { lineHeight: '20px', letterSpacing: '-0.24px', fontWeight: '400' }],
        'footnote': ['13px', { lineHeight: '18px', letterSpacing: '-0.08px', fontWeight: '400' }],
        'caption-1': ['12px', { lineHeight: '16px', letterSpacing: '0px', fontWeight: '400' }],
        'caption-2': ['11px', { lineHeight: '13px', letterSpacing: '0.06px', fontWeight: '400' }],
      },
      borderRadius: {
        'ios': '10px',
        'ios-lg': '12px',
        'ios-xl': '16px',
      },
      boxShadow: {
        // Apple elevation (subtle shadows, no glows)
        'ios-1': '0 1px 3px rgba(0, 0, 0, 0.04)',
        'ios-2': '0 4px 12px rgba(0, 0, 0, 0.08)',
        'ios-3': '0 8px 24px rgba(0, 0, 0, 0.12)',
      },
      animation: {
        'fade-in': 'fadeIn 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94)',
        'shimmer': 'shimmer 2s infinite linear',
        'loading': 'loading 2s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-1000px 0' },
          '100%': { backgroundPosition: '1000px 0' },
        },
        loading: {
          '0%': { width: '30%' },
          '50%': { width: '70%' },
          '100%': { width: '30%' },
        },
      },
    },
  },
  plugins: [],
};
