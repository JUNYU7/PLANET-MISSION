import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { AppProvider } from './store/AppContext'
import './index.css'

const container = document.getElementById('root')
if (!container) {
  console.error('未找到 #root 容器')
} else {
  createRoot(container).render(
    <StrictMode>
      <AppProvider>
        <App />
      </AppProvider>
    </StrictMode>,
  )
}