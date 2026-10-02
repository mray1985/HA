import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import { registerLicense } from '@syncfusion/ej2-base';
import '@fontsource-variable/inter';
import PreparerApp from './PreparerApp';
import './styles/globals.css';

// Syncfusion Essential JS 2 — Community License (free for <$1M revenue / <5 devs)
// Get your own key at https://www.syncfusion.com/account/claim-license-key
if (import.meta.env.VITE_SYNCFUSION_LICENSE_KEY) {
  registerLicense(import.meta.env.VITE_SYNCFUSION_LICENSE_KEY);
}

// A build for testers says so in the window title and on every screen.
const TEST_BUILD = import.meta.env.MODE === 'testbuild';
if (TEST_BUILD) document.title = 'HA Tax Preparer — Test build';

// A file dropped outside a drop target would open it in place of the app.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <PreparerApp />
      {TEST_BUILD && (
        <div className="fixed bottom-2 left-2 z-[9999] pointer-events-none rounded-md border border-amber-500/40 bg-amber-500/15 px-2 py-1 text-[11px] font-medium text-amber-300">
          Test build: not for filing returns
        </div>
      )}
      <Toaster
        position="top-right"
        theme="dark"
        toastOptions={{
          style: {
            background: '#1E293B',
            border: '1px solid #334155',
            color: '#E2E8F0',
          },
        }}
      />
    </BrowserRouter>
  </React.StrictMode>,
);
