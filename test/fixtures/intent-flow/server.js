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
        <head><title>Intent flow fixture</title></head>
        <body>
          <main>
            <h1>Intent flow fixture</h1>
            <p>Review an item and preview a watch.</p>
            <a href="/watch">Track an item</a>
          </main>
        </body>
      </html>`);
    return;
  }
  if (request.url === "/watch") {
    response.end(`<!doctype html>
      <html>
        <head><title>Intent flow fixture watch</title></head>
        <body>
          <main>
            <h1>Preview a watch</h1>
            <p>Enter public item details for a read-only preview.</p>
            <label>Item URL <input name="item-url" type="url"></label>
            <label>Target value <input name="target-value" type="number"></label>
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
