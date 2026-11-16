'use client';

import { useEffect } from 'react';

// Static export has no server redirect: send "/" to the default language.
export default function RootRedirect() {
  const base = process.env.NEXT_PUBLIC_BASE_PATH || '';
  useEffect(() => {
    const saved = (() => {
      try {
        return localStorage.getItem('sam-locale');
      } catch {
        return null;
      }
    })();
    const locale = saved === 'en' || saved === 'ar' ? saved : navigator.language.startsWith('en') ? 'en' : 'ar';
    window.location.replace(`${base}/${locale}/`);
  }, [base]);
  return (
    <noscript>
      <meta httpEquiv="refresh" content={`0;url=${base}/ar/`} />
    </noscript>
  );
}
