/// <reference types="vite/client" />

import type { TranslatorApi } from '../../preload'

declare global {
  interface Window {
    translator: TranslatorApi
  }
}
