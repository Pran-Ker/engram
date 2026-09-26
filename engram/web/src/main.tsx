import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './tokens.css'
import { EngramPage } from './pages/EngramPage.tsx'
import { InspectPage } from './pages/InspectPage.tsx'
import { TalkPage } from './pages/TalkPage.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<EngramPage />} />
        <Route path="/e/:slug" element={<EngramPage />} />
        <Route path="/talk" element={<TalkPage />} />
        <Route path="/talk/:slug" element={<TalkPage />} />
        <Route path="/inspect" element={<InspectPage />} />
        <Route path="/inspect/:slug" element={<InspectPage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
