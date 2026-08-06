import { Router } from "express";
import { createStore } from "../store.js";

export const usersStore = createStore();

function validateUser(data, { partial = false } = {}) {
  const errors = [];
  if (!partial || data.name !== undefined) {
    if (typeof data.name !== "string" || data.name.trim().length === 0) {
      errors.push("name is required and must be a non-empty string");
    }
  }
  if (!partial || data.email !== undefined) {
    if (typeof data.email !== "string" || !data.email.includes("@")) {
      errors.push("email is required and must contain '@'");
    }
  }
  return errors;
}

export const usersRouter = Router();

usersRouter.get("/", (req, res) => {
  res.json(usersStore.list());
});

usersRouter.get("/:id", (req, res) => {
  const user = usersStore.get(req.params.id);
  if (!user) return res.status(404).json({ error: "user not found" });
  res.json(user);
});

usersRouter.post("/", (req, res) => {
  const errors = validateUser(req.body || {});
  if (errors.length > 0) return res.status(400).json({ errors });
  res.status(201).json(usersStore.create({ name: req.body.name, email: req.body.email }));
});

usersRouter.put("/:id", (req, res) => {
  const errors = validateUser(req.body || {}, { partial: true });
  if (errors.length > 0) return res.status(400).json({ errors });
  const updated = usersStore.update(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: "user not found" });
  res.json(updated);
});

usersRouter.delete("/:id", (req, res) => {
  const removed = usersStore.remove(req.params.id);
  if (!removed) return res.status(404).json({ error: "user not found" });
  res.status(204).end();
});
