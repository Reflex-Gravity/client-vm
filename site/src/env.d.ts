// SPDX-License-Identifier: Apache-2.0
/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Sandbox origin template with `{id}`, e.g. `https://{id}-cvm.joeldsouza.me`. */
  readonly PUBLIC_SANDBOX?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
