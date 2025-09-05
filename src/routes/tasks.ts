import { Router, Request, Response } from 'express';
import { TaskService } from '../services/taskService';
import { Database } from '../db/database';

// Whenever we create a router, we pass the db instance to it and when user tries to access any endpoint, we use thta db instace to create service instance
export function createTaskRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);

  // Get all tasks
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const tasks = await taskService.getAllTasks();
      res.json(tasks);
    } catch (_error) {
      res.status(500).json({ error: 'Failed to fetch tasks' });
    }
  });

  // Get single task
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const task = await taskService.getTask(req.params.id);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
      res.json(task);
      return;
    } catch (_error) {
      return res.status(500).json({ error: 'Failed to fetch task' });
    }
  });

  // Create task
  router.post('/', async (req: Request, res: Response) => {
    try {
      const { title, description } = req.body || {};
      if (!title || typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({ error: 'title is required' });
      }
      const task = await taskService.createTask({ title, description });
      res.status(201).json(task);
      return;
    } catch (_error) {
      return res.status(500).json({ error: 'Failed to create task' });
    }
  });

  // Update task
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const { title, description, completed } = req.body || {};
      if (title !== undefined && (typeof title !== 'string' || !title.trim())) {
        return res
          .status(400)
          .json({ error: 'title must be a non-empty string' });
      }
      if (completed !== undefined && typeof completed !== 'boolean') {
        return res.status(400).json({ error: 'completed must be boolean' });
      }
      const updated = await taskService.updateTask(req.params.id, {
        title,
        description,
        completed,
      });
      if (!updated) return res.status(404).json({ error: 'Task not found' });
      res.json(updated);
      return;
    } catch (_error) {
      return res.status(500).json({ error: 'Failed to update task' });
    }
  });

  // Delete task
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const ok = await taskService.deleteTask(req.params.id);
      if (!ok) return res.status(404).json({ error: 'Task not found' });
      res.status(204).send();
      return;
    } catch (_error) {
      return res.status(500).json({ error: 'Failed to delete task' });
    }
  });

  return router;
}
