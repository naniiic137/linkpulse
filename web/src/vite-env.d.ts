/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the short-link host when it differs from the dashboard origin (dev: http://localhost:3501). */
  readonly VITE_SHORT_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
