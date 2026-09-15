import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const root = document.getElementById('log') ?? document.body;
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
