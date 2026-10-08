import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import { applyAppearance, isColorPalette, isTheme, readPreference } from './lib/preferences.ts';
import './index.css';

applyAppearance(
  readPreference('theme', 'system', isTheme),
  readPreference('color-palette', 'standard', isColorPalette),
);

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
