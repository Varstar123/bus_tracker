import { useColorScheme } from 'react-native';

/**
 * Deep green + amber. The amber is the "bus" colour and is reserved for the
 * vehicle marker and live state -- if everything is amber, nothing reads as
 * live. Semantic names only, so screens never hardcode a hex.
 */
const palette = {
  green900: '#0B3D2E',
  green700: '#12664B',
  green500: '#1B8F69',
  green100: '#DCF2E9',

  amber600: '#D97706',
  amber500: '#F59E0B',
  amber100: '#FEF3C7',

  red600: '#DC2626',
  red100: '#FEE2E2',

  slate900: '#0F172A',
  slate700: '#334155',
  slate500: '#64748B',
  slate300: '#CBD5E1',
  slate200: '#E2E8F0',
  slate100: '#F1F5F9',
  slate50: '#F8FAFC',
  white: '#FFFFFF',

  ink900: '#0A0F0D',
  ink800: '#131A17',
  ink700: '#1C2622',
  ink600: '#2A3833',
};

export const lightTheme = {
  bg: palette.slate50,
  surface: palette.white,
  surfaceAlt: palette.slate100,
  border: palette.slate200,

  text: palette.slate900,
  textMuted: palette.slate500,
  textInverse: palette.white,

  brand: palette.green700,
  brandDeep: palette.green900,
  brandSoft: palette.green100,

  live: palette.amber500,
  liveDeep: palette.amber600,
  liveSoft: palette.amber100,

  danger: palette.red600,
  dangerSoft: palette.red100,
};

export const darkTheme: typeof lightTheme = {
  bg: palette.ink900,
  surface: palette.ink800,
  surfaceAlt: palette.ink700,
  border: palette.ink600,

  text: '#F1F5F9',
  textMuted: '#94A3B8',
  textInverse: palette.ink900,

  brand: palette.green500,
  brandDeep: palette.green900,
  brandSoft: '#12312599',

  live: palette.amber500,
  liveDeep: palette.amber600,
  liveSoft: '#4A320B',

  danger: '#F87171',
  dangerSoft: '#45191999',
};

export type Theme = typeof lightTheme;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? darkTheme : lightTheme;
}

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 12, lg: 16, xl: 24, pill: 999 } as const;
