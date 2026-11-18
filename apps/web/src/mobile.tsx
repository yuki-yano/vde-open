// The phone reader's entry (ADR-0017). Served as `/` by the phone listener only; it never loads the PC screen.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { MobileReader } from './components/mobile-reader.tsx';
import { createMobileApi } from './lib/mobile-api.ts';
import { applyAppearance, isColorPalette, isTheme, readPreference } from './lib/preferences.ts';
import './index.css';

applyAppearance(
  readPreference('theme', 'system', isTheme),
  readPreference('color-palette', 'standard', isColorPalette),
);

function MobileApp() {
  const [api] = useState(createMobileApi);
  return <MobileReader api={api} />;
}

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');
createRoot(container).render(
  <StrictMode>
    <MobileApp />
  </StrictMode>,
);
