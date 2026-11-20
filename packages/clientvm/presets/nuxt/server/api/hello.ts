// Nitro API route: GET /api/hello
export default defineEventHandler((event) => {
  return { message: `Hello from the Nitro server at ${getRequestURL(event).pathname}` };
});
