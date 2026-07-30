import { createServer } from "node:http";

const port = Number(process.env.PORT || 4321);
const host = "127.0.0.1";

const server = createServer((request, response) => {
  const fixed = new URL(request.url, `http://${request.headers.host}`).searchParams.has(
    "fixed"
  );
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${fixed ? "Feather Shop" : "Feather Sho"}</title>
  </head>
  <body>
    <main>
      <h1>Feather Shop</h1>
      <p>${fixed ? "Checkout ready" : "Checkout temporarily unavailable"}</p>
      <button type="button">Buy a feather</button>
    </main>
    ${fixed ? "" : '<script>console.error("checkout bootstrap failed")</script>'}
  </body>
</html>`);
});

server.listen(port, host, () => {
  console.log(`YellowBird demo target: http://${host}:${port}`);
  console.log(`Broken state: http://${host}:${port}`);
  console.log(`Fixed state:  http://${host}:${port}/?fixed`);
});
