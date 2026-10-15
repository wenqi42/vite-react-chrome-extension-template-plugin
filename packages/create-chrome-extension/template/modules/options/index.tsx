import React from 'react'
import { createRoot } from 'react-dom/client'
import './options.css'

function Options() {
  return (
    <main className="min-h-screen min-w-[360px] bg-slate-900 p-8 font-sans text-slate-50">
      <span className="text-xs uppercase tracking-widest text-blue-300">
        Vite + React + Chrome
      </span>
      <h1 className="my-3 text-3xl font-bold">Extension options</h1>
      <p className="text-slate-300">
        Edit modules/options/index.tsx to configure this page.
      </p>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Options />
  </React.StrictMode>,
)
