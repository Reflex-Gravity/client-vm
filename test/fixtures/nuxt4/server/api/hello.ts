export default defineEventHandler(async (event) => {
  await new Promise((r) => setTimeout(r, 5));
  return { message: `server says hi to ${getRequestURL(event).pathname}` };
});
