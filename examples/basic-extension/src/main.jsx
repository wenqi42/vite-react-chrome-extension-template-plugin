import React from 'react'
import { createRoot } from 'react-dom/client'

function App() {
  return React.createElement('section', { style: { padding: 24, minWidth: 300 } },
    React.createElement('h1', null, 'Extension smoke tes2万我玩我t'),
    React.createElement('p', null, 'The Vite plugin generated this popup.')
  )
}

createRoot(document.getElementById('root')).render(React.createElement(App))
