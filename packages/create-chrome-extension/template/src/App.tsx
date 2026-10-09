export default function App({
  title = 'Your extension is ready.',
}: { title?: string } = {}) {
  return (
    <main className="app">
      <span className="eyebrow">Vite + React + Chrome</span>
      <h1>{title}</h1>
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
