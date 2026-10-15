import React from 'react'
import { createRoot } from 'react-dom/client'
import './popup.css'

function App() {
  return (
    <main className="min-w-[360px] bg-slate-900 p-6 font-sans text-slate-50">
      <span className="text-xs uppercase tracking-widest text-blue-300">
        Vite + React + Chrome
      </span>
      <h1 className="my-3 max-w-64 text-3xl font-bold leading-tight">
        Your extension is ready.
      </h1>
      <p className="mb-5 leading-relaxed text-slate-300">
        Edit <code>modules/popup/index.tsx</code> and load <code>dist</code> in
        Chrome.
      </p>
      <button
        className="cursor-pointer rounded-full bg-blue-200 px-4 py-2.5 text-blue-950 transition hover:bg-blue-100 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-300"
        onClick={() =>
          chrome.tabs.create({
            url: 'https://developer.chrome.com/docs/extensions/',
          })
        }
      >
        Read extension docs
      </button>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
