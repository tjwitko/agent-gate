import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app } from "../src/app.js";

test("POST /users creates a user", async () => {
  const res = await request(app).post("/users").send({ name: "Ada", email: "ada@example.com" });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, "Ada");
  assert.ok(res.body.id);
});

test("POST /users rejects missing email", async () => {
  const res = await request(app).post("/users").send({ name: "Ada" });
  assert.equal(res.status, 400);
});

test("GET /users/:id 404s for unknown id", async () => {
  const res = await request(app).get("/users/999999");
  assert.equal(res.status, 404);
});

test("GET /users lists created users", async () => {
  await request(app).post("/users").send({ name: "Grace", email: "grace@example.com" });
  const res = await request(app).get("/users");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length >= 1);
});

test("PUT /users/:id updates a user", async () => {
  const created = await request(app).post("/users").send({ name: "Temp", email: "temp@example.com" });
  const res = await request(app).put(`/users/${created.body.id}`).send({ name: "Renamed" });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, "Renamed");
});

test("DELETE /users/:id removes a user", async () => {
  const created = await request(app).post("/users").send({ name: "ToDelete", email: "del@example.com" });
  const res = await request(app).delete(`/users/${created.body.id}`);
  assert.equal(res.status, 204);
  const getRes = await request(app).get(`/users/${created.body.id}`);
  assert.equal(getRes.status, 404);
});
