import { createServer } from "node:http";

const server = createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (request.method !== "GET") {
    response.writeHead(405);
    response.end("Method not allowed");
    return;
  }
  if (request.url === "/") {
    response.end(`<!doctype html>
      <html>
        <head><title>Price Scout</title></head>
        <body>
          <main>
            <h1>Price Scout</h1>
            <p>Review a product and preview a price watch.</p>
            <a href="/watch">Track a price</a>
          </main>
        </body>
      </html>`);
    return;
  }
  if (request.url === "/watch") {
    response.end(`<!doctype html>
      <html>
        <head><title>Price Scout watch</title></head>
        <body>
          <main>
            <h1>Preview a price watch</h1>
            <p>Enter public product details for a read-only preview.</p>
            <label>Product URL <input name="product-url" type="url"></label>
            <label>Target price <input name="target-price" type="number"></label>
            <label>Currency
              <select name="currency">
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
              </select>
            </label>
          </main>
        </body>
      </html>`);
    return;
  }
  response.writeHead(404);
  response.end("Not found");
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(
    `${JSON.stringify({ url: `http://127.0.0.1:${address.port}` })}\n`
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
