// SPDX-License-Identifier: Apache-2.0

/** An error raised by the ClientVM controller itself (not by code inside an instance). */
export class ClientVMError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ClientVMError';
    this.code = code;
  }
}

/** The API exists but lands in a later phase (see CLAUDE.md §8). */
export class NotImplementedError extends ClientVMError {
  constructor(feature: string) {
    super(`${feature} is not implemented yet`, 'ERR_NOT_IMPLEMENTED');
    this.name = 'NotImplementedError';
  }
}
