import { createRoot } from 'react-dom/client';

import App from './App';

import './index.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('AutoCliper could not find its application root.');
}

// The SEO-only fallback lives in <noscript>, so it cannot flash for normal
// users while the app bundle is loading. Keep the React root empty in the
// initial HTML and let the app render into it as soon as the bundle arrives.
const root = createRoot(rootElement);
root.render(<App />);
