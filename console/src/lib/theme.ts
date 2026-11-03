export type Theme = 'system' | 'light' | 'dark';

export const THEME_KEY = 'provelox:theme';

export const isTheme = (v: unknown): v is Theme =>
  v === 'system' || v === 'light' || v === 'dark';

/** What a choice looks like on screen. "system" follows the OS. */
export const resolveTheme = (
  theme: Theme,
  systemDark: boolean,
): 'light' | 'dark' =>
  theme === 'dark' || (theme === 'system' && systemDark) ? 'dark' : 'light';

/**
 * Runs in the page head before anything paints, so the right theme is on <html> from the first frame and there is
 * no flash of the wrong one. Kept as a string because it has to run before React does.
 */
export const themeScript = `(function(){try{var t=localStorage.getItem('${THEME_KEY}');if(t!=='light'&&t!=='dark')t='system';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d)}catch(e){}})()`;
