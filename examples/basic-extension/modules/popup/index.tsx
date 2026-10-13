import React from "react";
import { createRoot } from "react-dom/client";
import "./popup.css";

function App() {
  return (
    <section className="min-w-[300px] bg-slate-900 p-6 text-slate-50">
      <h1 className="text-xl font-bold">Extension smoke test</h1>
      <p className="mt-2 text-slate-300">The Vite plugin generated this popup.</p>
    </section>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");
createRoot(root).render(<App />);
