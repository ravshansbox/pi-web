import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const app = document.getElementById('app');
if (app !== null) {
  createRoot(app).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
