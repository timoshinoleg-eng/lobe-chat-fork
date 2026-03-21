// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { documents, users } from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { TaskModel } from '../task';

const serverDB: LobeChatDatabase = await getTestDB();

const userId = 'task-test-user-id';
const userId2 = 'task-test-user-id-2';

beforeEach(async () => {
  await serverDB.delete(users);
  await serverDB.insert(users).values([{ id: userId }, { id: userId2 }]);
});

afterEach(async () => {
  await serverDB.delete(users);
});

describe('TaskModel', () => {
  describe('constructor', () => {
    it('should create model with db and userId', () => {
      const model = new TaskModel(serverDB, userId);
      expect(model).toBeInstanceOf(TaskModel);
    });
  });

  describe('create', () => {
    it('should create a task with auto-generated identifier', async () => {
      const model = new TaskModel(serverDB, userId);
      const result = await model.create({
        instruction: 'Write a book about AI agents',
        name: 'Write AI Book',
      });

      expect(result).toBeDefined();
      expect(result.identifier).toBe('TASK-1');
      expect(result.seq).toBe(1);
      expect(result.name).toBe('Write AI Book');
      expect(result.instruction).toBe('Write a book about AI agents');
      expect(result.status).toBe('backlog');
      expect(result.createdByUserId).toBe(userId);
    });

    it('should auto-increment seq for same user', async () => {
      const model = new TaskModel(serverDB, userId);

      const task1 = await model.create({ instruction: 'Task 1' });
      const task2 = await model.create({ instruction: 'Task 2' });
      const task3 = await model.create({ instruction: 'Task 3' });

      expect(task1.seq).toBe(1);
      expect(task2.seq).toBe(2);
      expect(task3.seq).toBe(3);
      expect(task1.identifier).toBe('TASK-1');
      expect(task2.identifier).toBe('TASK-2');
      expect(task3.identifier).toBe('TASK-3');
    });

    it('should support custom identifier prefix', async () => {
      const model = new TaskModel(serverDB, userId);
      const result = await model.create({
        identifierPrefix: 'PROJ',
        instruction: 'Build WAKE system',
      });

      expect(result.identifier).toBe('PROJ-1');
    });

    it('should create task with all optional fields', async () => {
      const model = new TaskModel(serverDB, userId);
      const result = await model.create({
        assigneeAgentId: 'agent-1',
        assigneeUserId: userId,
        description: 'A detailed description',
        instruction: 'Do something',
        name: 'Full Task',
        priority: 2,
      });

      expect(result.assigneeAgentId).toBe('agent-1');
      expect(result.assigneeUserId).toBe(userId);
      expect(result.priority).toBe(2);
    });

    it('should create subtask with parentTaskId', async () => {
      const model = new TaskModel(serverDB, userId);
      const parent = await model.create({ instruction: 'Parent task' });
      const child = await model.create({
        instruction: 'Child task',
        parentTaskId: parent.id,
      });

      expect(child.parentTaskId).toBe(parent.id);
    });

    it('should isolate seq between users', async () => {
      const model1 = new TaskModel(serverDB, userId);
      const model2 = new TaskModel(serverDB, userId2);

      const task1 = await model1.create({ instruction: 'User 1 task' });
      const task2 = await model2.create({ instruction: 'User 2 task' });

      expect(task1.seq).toBe(1);
      expect(task2.seq).toBe(1);
    });
  });

  describe('findById', () => {
    it('should find task by id', async () => {
      const model = new TaskModel(serverDB, userId);
      const created = await model.create({ instruction: 'Test task' });

      const found = await model.findById(created.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
    });

    it('should not find task owned by another user', async () => {
      const model1 = new TaskModel(serverDB, userId);
      const model2 = new TaskModel(serverDB, userId2);

      const task = await model1.create({ instruction: 'User 1 task' });
      const found = await model2.findById(task.id);
      expect(found).toBeNull();
    });
  });

  describe('findByIdentifier', () => {
    it('should find task by identifier', async () => {
      const model = new TaskModel(serverDB, userId);
      await model.create({ instruction: 'Test task' });

      const found = await model.findByIdentifier('TASK-1');
      expect(found).toBeDefined();
      expect(found!.identifier).toBe('TASK-1');
    });
  });

  describe('update', () => {
    it('should update task fields', async () => {
      const model = new TaskModel(serverDB, userId);
      const task = await model.create({ instruction: 'Original' });

      const updated = await model.update(task.id, {
        instruction: 'Updated instruction',
        name: 'Updated name',
      });

      expect(updated!.instruction).toBe('Updated instruction');
      expect(updated!.name).toBe('Updated name');
    });

    it('should not update task owned by another user', async () => {
      const model1 = new TaskModel(serverDB, userId);
      const model2 = new TaskModel(serverDB, userId2);

      const task = await model1.create({ instruction: 'User 1 task' });
      const result = await model2.update(task.id, { name: 'Hacked' });
      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('should delete task', async () => {
      const model = new TaskModel(serverDB, userId);
      const task = await model.create({ instruction: 'To be deleted' });

      const deleted = await model.delete(task.id);
      expect(deleted).toBe(true);

      const found = await model.findById(task.id);
      expect(found).toBeNull();
    });

    it('should not delete task owned by another user', async () => {
      const model1 = new TaskModel(serverDB, userId);
      const model2 = new TaskModel(serverDB, userId2);

      const task = await model1.create({ instruction: 'User 1 task' });
      const deleted = await model2.delete(task.id);
      expect(deleted).toBe(false);
    });
  });

  describe('list', () => {
    it('should list tasks for user', async () => {
      const model = new TaskModel(serverDB, userId);
      await model.create({ instruction: 'Task 1' });
      await model.create({ instruction: 'Task 2' });

      const { tasks, total } = await model.list();
      expect(total).toBe(2);
      expect(tasks).toHaveLength(2);
    });

    it('should filter by status', async () => {
      const model = new TaskModel(serverDB, userId);
      const task = await model.create({ instruction: 'Task 1' });
      await model.updateStatus(task.id, 'running', { startedAt: new Date() });
      await model.create({ instruction: 'Task 2' });

      const { tasks } = await model.list({ status: 'running' });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe('running');
    });

    it('should filter root tasks only', async () => {
      const model = new TaskModel(serverDB, userId);
      const parent = await model.create({ instruction: 'Parent' });
      await model.create({ instruction: 'Child', parentTaskId: parent.id });

      const { tasks } = await model.list({ parentTaskId: null });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].parentTaskId).toBeNull();
    });

    it('should paginate results', async () => {
      const model = new TaskModel(serverDB, userId);
      for (let i = 0; i < 5; i++) {
        await model.create({ instruction: `Task ${i}` });
      }

      const { tasks, total } = await model.list({ limit: 2, offset: 0 });
      expect(total).toBe(5);
      expect(tasks).toHaveLength(2);
    });
  });

  describe('findSubtasks', () => {
    it('should find direct subtasks', async () => {
      const model = new TaskModel(serverDB, userId);
      const parent = await model.create({ instruction: 'Parent' });
      await model.create({ instruction: 'Child 1', parentTaskId: parent.id });
      await model.create({ instruction: 'Child 2', parentTaskId: parent.id });

      const subtasks = await model.findSubtasks(parent.id);
      expect(subtasks).toHaveLength(2);
    });
  });

  describe('getTaskTree', () => {
    it('should return full task tree recursively', async () => {
      const model = new TaskModel(serverDB, userId);
      const root = await model.create({ instruction: 'Root' });
      const child = await model.create({ instruction: 'Child', parentTaskId: root.id });
      await model.create({ instruction: 'Grandchild', parentTaskId: child.id });

      const tree = await model.getTaskTree(root.id);
      expect(tree).toHaveLength(3);
    });
  });

  describe('updateStatus', () => {
    it('should update status with timestamps', async () => {
      const model = new TaskModel(serverDB, userId);
      const task = await model.create({ instruction: 'Test' });

      const startedAt = new Date();
      const updated = await model.updateStatus(task.id, 'running', { startedAt });
      expect(updated!.status).toBe('running');
      expect(updated!.startedAt).toBeDefined();
    });
  });

  describe('heartbeat', () => {
    it('should update heartbeat timestamp', async () => {
      const model = new TaskModel(serverDB, userId);
      const task = await model.create({ instruction: 'Test' });

      await model.updateHeartbeat(task.id);
      const found = await model.findById(task.id);
      expect(found!.lastHeartbeatAt).toBeDefined();
    });
  });

  describe('dependencies', () => {
    it('should add and query dependencies', async () => {
      const model = new TaskModel(serverDB, userId);
      const taskA = await model.create({ instruction: 'Task A' });
      const taskB = await model.create({ instruction: 'Task B' });

      await model.addDependency(taskB.id, taskA.id);

      const deps = await model.getDependencies(taskB.id);
      expect(deps).toHaveLength(1);
      expect(deps[0].dependsOnId).toBe(taskA.id);
    });

    it('should check all dependencies completed', async () => {
      const model = new TaskModel(serverDB, userId);
      const taskA = await model.create({ instruction: 'Task A' });
      const taskB = await model.create({ instruction: 'Task B' });
      const taskC = await model.create({ instruction: 'Task C' });

      await model.addDependency(taskC.id, taskA.id);
      await model.addDependency(taskC.id, taskB.id);

      // Neither completed
      let allDone = await model.areAllDependenciesCompleted(taskC.id);
      expect(allDone).toBe(false);

      // Complete A only
      await model.updateStatus(taskA.id, 'completed');
      allDone = await model.areAllDependenciesCompleted(taskC.id);
      expect(allDone).toBe(false);

      // Complete B too
      await model.updateStatus(taskB.id, 'completed');
      allDone = await model.areAllDependenciesCompleted(taskC.id);
      expect(allDone).toBe(true);
    });

    it('should remove dependency', async () => {
      const model = new TaskModel(serverDB, userId);
      const taskA = await model.create({ instruction: 'Task A' });
      const taskB = await model.create({ instruction: 'Task B' });

      await model.addDependency(taskB.id, taskA.id);
      await model.removeDependency(taskB.id, taskA.id);

      const deps = await model.getDependencies(taskB.id);
      expect(deps).toHaveLength(0);
    });

    it('should get dependents (reverse lookup)', async () => {
      const model = new TaskModel(serverDB, userId);
      const taskA = await model.create({ instruction: 'Task A' });
      const taskB = await model.create({ instruction: 'Task B' });
      const taskC = await model.create({ instruction: 'Task C' });

      await model.addDependency(taskB.id, taskA.id);
      await model.addDependency(taskC.id, taskA.id);

      const dependents = await model.getDependents(taskA.id);
      expect(dependents).toHaveLength(2);
    });

    it('should find unlocked tasks after dependency completes', async () => {
      const model = new TaskModel(serverDB, userId);
      const taskA = await model.create({ instruction: 'Task A' });
      const taskB = await model.create({ instruction: 'Task B' });
      const taskC = await model.create({ instruction: 'Task C' });

      // C blocks on A and B
      await model.addDependency(taskC.id, taskA.id);
      await model.addDependency(taskC.id, taskB.id);

      // Complete A — C still blocked by B
      await model.updateStatus(taskA.id, 'completed');
      let unlocked = await model.getUnlockedTasks(taskA.id);
      expect(unlocked).toHaveLength(0);

      // Complete B — C now unlocked
      await model.updateStatus(taskB.id, 'completed');
      unlocked = await model.getUnlockedTasks(taskB.id);
      expect(unlocked).toHaveLength(1);
      expect(unlocked[0].id).toBe(taskC.id);
    });

    it('should not unlock tasks that are not in backlog', async () => {
      const model = new TaskModel(serverDB, userId);
      const taskA = await model.create({ instruction: 'Task A' });
      const taskB = await model.create({ instruction: 'Task B' });

      await model.addDependency(taskB.id, taskA.id);
      // Move B to running manually (not backlog)
      await model.updateStatus(taskB.id, 'running', { startedAt: new Date() });

      await model.updateStatus(taskA.id, 'completed');
      const unlocked = await model.getUnlockedTasks(taskA.id);
      expect(unlocked).toHaveLength(0); // B is already running, not unlocked
    });

    it('should check all subtasks completed', async () => {
      const model = new TaskModel(serverDB, userId);
      const parent = await model.create({ instruction: 'Parent' });
      const child1 = await model.create({ instruction: 'Child 1', parentTaskId: parent.id });
      const child2 = await model.create({ instruction: 'Child 2', parentTaskId: parent.id });

      expect(await model.areAllSubtasksCompleted(parent.id)).toBe(false);

      await model.updateStatus(child1.id, 'completed');
      expect(await model.areAllSubtasksCompleted(parent.id)).toBe(false);

      await model.updateStatus(child2.id, 'completed');
      expect(await model.areAllSubtasksCompleted(parent.id)).toBe(true);
    });
  });

  describe('documents', () => {
    it('should pin and get documents', async () => {
      const model = new TaskModel(serverDB, userId);
      const task = await model.create({ instruction: 'Test' });

      // Create a test document
      const [doc] = await serverDB
        .insert(documents)
        .values({
          content: '',
          fileType: 'text/plain',
          source: 'test',
          sourceType: 'file',
          title: 'Test Doc',
          totalCharCount: 0,
          totalLineCount: 0,
          userId,
        })
        .returning();

      await model.pinDocument(task.id, doc.id);

      const pinned = await model.getPinnedDocuments(task.id);
      expect(pinned).toHaveLength(1);
      expect(pinned[0].documentId).toBe(doc.id);
    });

    it('should unpin document', async () => {
      const model = new TaskModel(serverDB, userId);
      const task = await model.create({ instruction: 'Test' });

      const [doc] = await serverDB
        .insert(documents)
        .values({
          content: '',
          fileType: 'text/plain',
          source: 'test',
          sourceType: 'file',
          title: 'Test Doc',
          totalCharCount: 0,
          totalLineCount: 0,
          userId,
        })
        .returning();

      await model.pinDocument(task.id, doc.id);
      await model.unpinDocument(task.id, doc.id);

      const pinned = await model.getPinnedDocuments(task.id);
      expect(pinned).toHaveLength(0);
    });

    it('should not duplicate pin', async () => {
      const model = new TaskModel(serverDB, userId);
      const task = await model.create({ instruction: 'Test' });

      const [doc] = await serverDB
        .insert(documents)
        .values({
          content: '',
          fileType: 'text/plain',
          source: 'test',
          sourceType: 'file',
          title: 'Test Doc',
          totalCharCount: 0,
          totalLineCount: 0,
          userId,
        })
        .returning();

      await model.pinDocument(task.id, doc.id);
      await model.pinDocument(task.id, doc.id); // duplicate

      const pinned = await model.getPinnedDocuments(task.id);
      expect(pinned).toHaveLength(1);
    });
  });

  describe('checkpoint', () => {
    it('should get and update checkpoint config', async () => {
      const model = new TaskModel(serverDB, userId);
      const task = await model.create({ instruction: 'Test' });

      // Initially empty
      const empty = model.getCheckpointConfig(task);
      expect(empty).toEqual({});

      // Set checkpoint
      const updated = await model.updateCheckpointConfig(task.id, {
        onAgentRequest: true,
        tasks: { afterIds: ['TASK-2'], beforeIds: ['TASK-3'] },
        topic: { after: true },
      });

      const config = model.getCheckpointConfig(updated!);
      expect(config.onAgentRequest).toBe(true);
      expect(config.topic?.after).toBe(true);
      expect(config.tasks?.beforeIds).toEqual(['TASK-3']);
      expect(config.tasks?.afterIds).toEqual(['TASK-2']);
    });

    it('should check shouldPauseBeforeStart', async () => {
      const model = new TaskModel(serverDB, userId);
      const parent = await model.create({ instruction: 'Parent' });

      await model.updateCheckpointConfig(parent.id, {
        tasks: { beforeIds: ['TASK-5'] },
      });

      const parentUpdated = (await model.findById(parent.id))!;
      expect(model.shouldPauseBeforeStart(parentUpdated, 'TASK-5')).toBe(true);
      expect(model.shouldPauseBeforeStart(parentUpdated, 'TASK-6')).toBe(false);
    });

    it('should pause on topic complete by default (no config)', async () => {
      const model = new TaskModel(serverDB, userId);
      const task = await model.create({ instruction: 'Test' });

      // No checkpoint configured → should pause (default behavior)
      expect(model.shouldPauseOnTopicComplete(task)).toBe(true);
    });

    it('should pause on topic complete when topic.after is true', async () => {
      const model = new TaskModel(serverDB, userId);
      const task = await model.create({ instruction: 'Test' });

      await model.updateCheckpointConfig(task.id, {
        topic: { after: true },
      });

      const updated = (await model.findById(task.id))!;
      expect(model.shouldPauseOnTopicComplete(updated)).toBe(true);
    });

    it('should not pause on topic complete when only onAgentRequest is set', async () => {
      const model = new TaskModel(serverDB, userId);
      const task = await model.create({ instruction: 'Test' });

      await model.updateCheckpointConfig(task.id, {
        onAgentRequest: true,
      });

      const updated = (await model.findById(task.id))!;
      // Has explicit config but topic.after is not true → don't auto-pause
      expect(model.shouldPauseOnTopicComplete(updated)).toBe(false);
    });

    it('should not pause on topic complete when topic.after is false', async () => {
      const model = new TaskModel(serverDB, userId);
      const task = await model.create({ instruction: 'Test' });

      await model.updateCheckpointConfig(task.id, {
        topic: { after: false },
      });

      const updated = (await model.findById(task.id))!;
      expect(model.shouldPauseOnTopicComplete(updated)).toBe(false);
    });

    it('should check shouldPauseAfterComplete', async () => {
      const model = new TaskModel(serverDB, userId);
      const parent = await model.create({ instruction: 'Parent' });

      await model.updateCheckpointConfig(parent.id, {
        tasks: { afterIds: ['TASK-2', 'TASK-3'] },
      });

      const parentUpdated = (await model.findById(parent.id))!;
      expect(model.shouldPauseAfterComplete(parentUpdated, 'TASK-2')).toBe(true);
      expect(model.shouldPauseAfterComplete(parentUpdated, 'TASK-3')).toBe(true);
      expect(model.shouldPauseAfterComplete(parentUpdated, 'TASK-4')).toBe(false);
    });
  });

  describe('topic management', () => {
    it('should increment topic count', async () => {
      const model = new TaskModel(serverDB, userId);
      const task = await model.create({ instruction: 'Test' });

      await model.incrementTopicCount(task.id);
      await model.incrementTopicCount(task.id);

      const found = await model.findById(task.id);
      expect(found!.totalTopics).toBe(2);
    });

    it('should update current topic', async () => {
      const model = new TaskModel(serverDB, userId);
      const task = await model.create({ instruction: 'Test' });

      await model.updateCurrentTopic(task.id, 'topic-123');

      const found = await model.findById(task.id);
      expect(found!.currentTopicId).toBe('topic-123');
    });
  });
});
