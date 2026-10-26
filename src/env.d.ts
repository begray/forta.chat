/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BASE_URL: string;
  readonly VITE_DEFAULT_PRIVATEKEY: string;
  readonly VITE_BUG_REPORT_TOKEN: string;
  /** Commit the bundle was built from (upload log header); optional. */
  readonly VITE_BUILD_COMMIT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
