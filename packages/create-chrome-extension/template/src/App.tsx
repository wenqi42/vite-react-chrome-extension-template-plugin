export default function App() {
  return (
    <main className="app">
      <span className="eyebrow">Vite + React + Chrome</span>
      <h1>Your extension is ready.</h1>
      <p>
        Edit <code>src/App.tsx</code> and load <code>dist</code> in Chrome.
      </p>
      <button
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
