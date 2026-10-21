// SPDX-License-Identifier: Apache-2.0

/** Node's internal errors carry an enumerable `code`. */
export function codeError<E extends Error>(
  Ctor: new (msg: string) => E,
  code: string,
  message: string,
): E {
  const err = new Ctor(message);
  (err as E & { code: string }).code = code;
  return err;
}
