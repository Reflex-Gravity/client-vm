// SPDX-License-Identifier: Apache-2.0
export default defineEventHandler(async (event) => {
  await new Promise((r) => setTimeout(r, 5));
  return { message: `server says hi to ${getRequestURL(event).pathname}` };
});
