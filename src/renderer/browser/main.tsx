import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toolbar } from './Toolbar'
import './toolbar.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Toolbar />
  </StrictMode>
)
