import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './tokens.css'
import { EngramPage } from './pages/EngramPage.tsx'
import { InspectPage } from './pages/InspectPage.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<EngramPage />} />
        <Route path="/e/:slug" element={<EngramPage />} />
        <Route path="/inspect" element={<InspectPage />} />
        <Route path="/inspect/:slug" element={<InspectPage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
