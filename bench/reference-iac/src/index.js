import express from "express";

const app = express();
app.get("/health", (req, res) => res.json({ status: "ok" }));

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`bench-iac-reference listening on :${port}`));
}

export { app };
