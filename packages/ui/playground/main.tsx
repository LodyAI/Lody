import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './playground.css';
import { IconPlayground } from './icon-playground';

const host = document.getElementById('root');
if (!host) throw new Error('the playground has no #root to mount on');

createRoot(host).render(
  <StrictMode>
    <IconPlayground />
  </StrictMode>
);
