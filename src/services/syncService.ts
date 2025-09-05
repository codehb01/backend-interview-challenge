import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { Task, SyncQueueItem, SyncResult, BatchSyncRequest, BatchSyncResponse } from '../types';
import { Database } from '../db/database';
import { TaskService } from './taskService';

export class SyncService {
  private apiUrl: string;
  
  constructor(
    private db: Database,
    private taskService: TaskService,
    apiUrl: string = process.env.API_BASE_URL || 'http://localhost:3000/api'
  ) {
    this.apiUrl = apiUrl;
  }

  async sync(): Promise<SyncResult> {
    const batchSize = Number(process.env.SYNC_BATCH_SIZE || 50);
    const allItems: SyncQueueItem[] = (await this.db.all('SELECT * FROM sync_queue ORDER BY created_at'))
      .map((row) => ({
        id: row.id,
        task_id: row.task_id,
        operation: row.operation,
        data: JSON.parse(row.data),
        created_at: new Date(row.created_at),
        retry_count: row.retry_count,
        error_message: row.error_message || undefined,
      }));

    let synced = 0;
    let failed = 0;
    const errors: { task_id: string; operation: string; error: string; timestamp: Date }[] = [];

    for (let i = 0; i < allItems.length; i += batchSize) {
      const batch = allItems.slice(i, i + batchSize);
      try {
        const response = await this.processBatch(batch);
        for (const processed of response.processed_items) {
          const item = batch.find((b) => b.task_id === processed.client_id);
          if (!item) continue;
          if (processed.status === 'success') {
            await this.updateSyncStatus(item.task_id, 'synced', { server_id: processed.server_id });
            synced += 1;
          } else if (processed.status === 'conflict') {
            // Resolve using last-write-wins
            const local = await this.taskService.getTask(item.task_id);
            const serverTask = processed.resolved_data as unknown as Task | undefined;
            if (local && serverTask) {
              const winner = await this.resolveConflict(local, serverTask);
              // Update local with winner and mark synced
              await this.db.run(
                `UPDATE tasks SET title = ?, description = ?, completed = ?, updated_at = ?, sync_status = 'synced', server_id = ?, last_synced_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [
                  winner.title,
                  winner.description ?? null,
                  winner.completed ? 1 : 0,
                  new Date().toISOString(),
                  serverTask.server_id ?? processed.server_id,
                  local.id,
                ]
              );
              await this.db.run('DELETE FROM sync_queue WHERE task_id = ?', [local.id]);
              synced += 1;
            } else {
              await this.handleSyncError(item, new Error('Conflict without resolvable data'));
              failed += 1;
              errors.push({ task_id: item.task_id, operation: item.operation, error: 'Conflict', timestamp: new Date() });
            }
          } else {
            await this.handleSyncError(item, new Error(processed.error || 'Sync error'));
            failed += 1;
            errors.push({ task_id: item.task_id, operation: item.operation, error: processed.error || 'error', timestamp: new Date() });
          }
        }
      } catch (err: any) {
        // Whole batch failed
        for (const item of batch) {
          await this.handleSyncError(item, err);
          failed += 1;
          errors.push({ task_id: item.task_id, operation: item.operation, error: err?.message || 'error', timestamp: new Date() });
        }
      }
    }

    return {
      success: failed === 0,
      synced_items: synced,
      failed_items: failed,
      errors,
    };
  }

  async addToSyncQueue(taskId: string, operation: 'create' | 'update' | 'delete', data: Partial<Task>): Promise<void> {
    const itemId = uuidv4();
    await this.db.run(
      `INSERT INTO sync_queue (id, task_id, operation, data) VALUES (?, ?, ?, ?)`,
      [itemId, taskId, operation, JSON.stringify(data)]
    );
  }

  private async processBatch(items: SyncQueueItem[]): Promise<BatchSyncResponse> {
    const payload: BatchSyncRequest = {
      items: items,
      client_timestamp: new Date(),
    };
    const { data } = await axios.post(`${this.apiUrl}/batch`, payload);
    return data as BatchSyncResponse;
  }

  private async resolveConflict(localTask: Task, serverTask: Task): Promise<Task> {
    const localUpdated = new Date(localTask.updated_at).getTime();
    const serverUpdated = new Date(serverTask.updated_at).getTime();
    return localUpdated >= serverUpdated ? localTask : serverTask;
  }

  private async updateSyncStatus(taskId: string, status: 'synced' | 'error', serverData?: Partial<Task>): Promise<void> {
    const nowIso = new Date().toISOString();
    const serverId = serverData?.server_id ?? null;
    const fields = status === 'synced'
      ? `sync_status = 'synced', server_id = COALESCE(?, server_id), last_synced_at = ?`
      : `sync_status = 'error'`;
    const params = status === 'synced' ? [serverId, nowIso, taskId] : [taskId];
    await this.db.run(`UPDATE tasks SET ${fields} WHERE id = ?`, params as any[]);
    if (status === 'synced') {
      await this.db.run('DELETE FROM sync_queue WHERE task_id = ?', [taskId]);
    }
  }

  private async handleSyncError(item: SyncQueueItem, error: Error): Promise<void> {
    const newRetry = (item.retry_count || 0) + 1;
    await this.db.run(
      `UPDATE sync_queue SET retry_count = ?, error_message = ? WHERE id = ?`,
      [newRetry, error.message, item.id]
    );
    if (newRetry >= 3) {
      await this.updateSyncStatus(item.task_id, 'error');
    }
  }

  async checkConnectivity(): Promise<boolean> {
    // TODO: Check if server is reachable
    // 1. Make a simple health check request
    // 2. Return true if successful, false otherwise
    try {
      await axios.get(`${this.apiUrl}/health`, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}