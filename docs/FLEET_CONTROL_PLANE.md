# Fleet-level project control plane

The fleet layer sits above the existing workspace, project-index and Run/Task
machinery. It turns many software projects into independently schedulable
units without putting all repositories into one model context.

Control flow:

workspace
  -> fleet registry
  -> project dependency graph
  -> fair scheduler
  -> leased dispatch
  -> existing Run/Task execution
  -> project index + context compiler
  -> governed runner
  -> verification
  -> health/cost feedback
  -> rescheduling

Each project has an explicit lifecycle, priority, concurrency ceiling, token
and compute budgets, source/revision association, health state, and tags.

Dependencies form a DAG. Cycles are rejected. A dependent project is released
only after the latest upstream dispatch succeeds.

Workers claim dispatches with PostgreSQL row locks and SKIP LOCKED. Leases allow
work to be reclaimed after a worker disappears. Stable project hashing can
partition projects across worker pools. Priority uses aging and failure
penalties to reduce starvation and repeated failure storms.

A fleet dispatch contains only a run id, task id, and bounded request object.
The fleet worker re-authorizes the owner, reloads the server-owned Run/Task, and
delegates to the existing executeNext path. The fleet layer never marks a task
complete by itself.

Fleet capacity adapts to queue depth and system pressure. This layer is above
task-level parallelism: task dependencies and exact-revision write isolation
still win.
