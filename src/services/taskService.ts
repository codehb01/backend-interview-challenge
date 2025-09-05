import { v4 as uuidv4 } from 'uuid';
import { Task } from '../types';
import { Database } from '../db/database';

export class TaskService {
  constructor(private db: Database) {}

  async createTask(taskData: Partial<Task>): Promise<Task> {
    const id = uuidv4();
    const nowIso = new Date().toISOString();

    const title = (taskData.title || '').trim();
    if (!title) {
      throw new Error('Title is required');
    }

    const description = taskData.description ?? null;
    const completed = taskData.completed ? 1 : 0;
    const isDeleted = 0;
    const syncStatus: 'pending' = 'pending';

    await this.db.run(
      `INSERT INTO tasks (id, title, description, completed, created_at, updated_at, is_deleted, sync_status, server_id, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      [id, title, description, completed, nowIso, nowIso, isDeleted, syncStatus]
    );

    // Add to sync queue (create)
    const queueId = uuidv4();
    await this.db.run(
      `INSERT INTO sync_queue (id, task_id, operation, data)
       VALUES (?, ?, ?, ?)`,
      [queueId, id, 'create', JSON.stringify({ id, title, description, completed: !!completed })]
    );

    const created: Task = {
      id,
      title,
      description: description ?? undefined,
      completed: !!completed,
      created_at: new Date(nowIso),
      updated_at: new Date(nowIso),
      is_deleted: false,
      sync_status: 'pending',
      server_id: undefined,
      last_synced_at: undefined,
    };
    return created;
  }

  async updateTask(id: string, updates: Partial<Task>): Promise<Task | null> {
    const existing = await this.db.get('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!existing) return null;

    const nowIso = new Date().toISOString();

    const newTitle = updates.title !== undefined ? updates.title : existing.title;
    const newDescription = updates.description !== undefined ? updates.description : existing.description;
    const newCompleted = updates.completed !== undefined ? (updates.completed ? 1 : 0) : existing.completed;

    await this.db.run(
      `UPDATE tasks SET title = ?, description = ?, completed = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`,
      [newTitle, newDescription, newCompleted, nowIso, id]
    );

    // Add to sync queue (update)
    const queueId = uuidv4();
    await this.db.run(
      `INSERT INTO sync_queue (id, task_id, operation, data) VALUES (?, ?, 'update', ?)`,
      [queueId, id, JSON.stringify({ id, title: newTitle, description: newDescription ?? undefined, completed: !!newCompleted })]
    );

    return this.getTask(id);
  }

  async deleteTask(id: string): Promise<boolean> {
    const existing = await this.db.get('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!existing) return false;

    const nowIso = new Date().toISOString();
    await this.db.run(
      `UPDATE tasks SET is_deleted = 1, updated_at = ?, sync_status = 'pending' WHERE id = ?`,
      [nowIso, id]
    );

    // Add to sync queue (delete)
    const queueId = uuidv4();
    await this.db.run(
      `INSERT INTO sync_queue (id, task_id, operation, data) VALUES (?, ?, 'delete', ?)`,
      [queueId, id, JSON.stringify({ id })]
    );

    return true;
  }

  async getTask(id: string): Promise<Task | null> {
    const row = await this.db.get('SELECT * FROM tasks WHERE id = ? AND is_deleted = 0', [id]);
    if (!row) return null;
    const task: Task = {
      id: row.id,
      title: row.title,
      description: row.description ?? undefined,
      completed: !!row.completed,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      is_deleted: !!row.is_deleted,
      sync_status: row.sync_status,
      server_id: row.server_id ?? undefined,
      last_synced_at: row.last_synced_at ? new Date(row.last_synced_at) : undefined,
    };
    return task;
  }

  async getAllTasks(): Promise<Task[]> {
    const rows = await this.db.all('SELECT * FROM tasks WHERE is_deleted = 0');
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description ?? undefined,
      completed: !!row.completed,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      is_deleted: !!row.is_deleted,
      sync_status: row.sync_status,
      server_id: row.server_id ?? undefined,
      last_synced_at: row.last_synced_at ? new Date(row.last_synced_at) : undefined,
    }));
  }

  async getTasksNeedingSync(): Promise<Task[]> {
    const rows = await this.db.all("SELECT * FROM tasks WHERE sync_status IN ('pending','error')");
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description ?? undefined,
      completed: !!row.completed,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      is_deleted: !!row.is_deleted,
      sync_status: row.sync_status,
      server_id: row.server_id ?? undefined,
      last_synced_at: row.last_synced_at ? new Date(row.last_synced_at) : undefined,
    }));
  }
}