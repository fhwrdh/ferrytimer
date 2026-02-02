/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HOME_ADDRESS: string
  readonly VITE_WSDOT_API_KEY: string
  readonly VITE_GOOGLE_MAPS_API_KEY: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
