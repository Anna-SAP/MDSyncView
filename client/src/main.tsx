import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './components/App.tsx';
import { bootstrap } from './store.ts';
import './styles/app.css';
import './styles/prose.css';
import 'katex/dist/katex.min.css';

bootstrap();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
