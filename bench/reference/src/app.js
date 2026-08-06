import express from "express";
import { usersRouter } from "./resources/users.js";
import { projectsRouter } from "./resources/projects.js";
import { tasksRouter } from "./resources/tasks.js";

export const app = express();
app.use(express.json());
app.use("/users", usersRouter);
app.use("/projects", projectsRouter);
app.use("/tasks", tasksRouter);

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`bench-reference listening on :${port}`));
}
