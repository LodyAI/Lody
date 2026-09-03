import { describe, it, expect } from 'vitest';
import { ConcurrentQueue } from '../concurrent-queue';

describe('ConcurrentQueue', () => {
  describe('基本功能', () => {
    it('应该执行单个任务并返回结果', async () => {
      const queue = new ConcurrentQueue(3);
      const result = await queue.enqueue('key1', async () => 'hello');
      expect(result).toBe('hello');
    });

    it('应该正确传递任务的返回值', async () => {
      const queue = new ConcurrentQueue(3);
      const result = await queue.enqueue('key1', async () => ({ foo: 'bar', num: 42 }));
      expect(result).toEqual({ foo: 'bar', num: 42 });
    });

    it('应该正确传递任务抛出的错误', async () => {
      const queue = new ConcurrentQueue(3);
      await expect(
        queue.enqueue('key1', async () => {
          throw new Error('test error');
        })
      ).rejects.toThrow('test error');
    });
  });

  describe('同 key 串行', () => {
    it('应该按顺序串行执行同一 key 的任务', async () => {
      const queue = new ConcurrentQueue(10);
      const order: number[] = [];

      const task = (id: number, delay: number) => async () => {
        order.push(id);
        await new Promise((r) => setTimeout(r, delay));
        order.push(-id); // 负数表示结束
        return id;
      };

      // 同一 key 的 3 个任务
      const p1 = queue.enqueue('A', task(1, 50));
      const p2 = queue.enqueue('A', task(2, 50));
      const p3 = queue.enqueue('A', task(3, 50));

      await Promise.all([p1, p2, p3]);

      // 必须严格按顺序：1开始 -> 1结束 -> 2开始 -> 2结束 -> 3开始 -> 3结束
      expect(order).toEqual([1, -1, 2, -2, 3, -3]);
    });

    it('应该保证前一个任务失败后继续执行后续任务', async () => {
      const queue = new ConcurrentQueue(10);
      const executed: number[] = [];

      const p1 = queue.enqueue('A', async () => {
        executed.push(1);
        throw new Error('task 1 failed');
      });

      const p2 = queue.enqueue('A', async () => {
        executed.push(2);
        return 'success';
      });

      await expect(p1).rejects.toThrow('task 1 failed');
      const result = await p2;

      expect(executed).toEqual([1, 2]);
      expect(result).toBe('success');
    });
  });

  describe('不同 key 并发', () => {
    it('应该并发执行不同 key 的任务', async () => {
      const queue = new ConcurrentQueue(10);
      const running: string[] = [];
      let maxConcurrent = 0;

      const task = (key: string) => async () => {
        running.push(key);
        maxConcurrent = Math.max(maxConcurrent, running.length);
        // Use a longer delay to reduce flakiness on slower CI runners.
        await new Promise((r) => setTimeout(r, 100));
        running.splice(running.indexOf(key), 1);
        return key;
      };

      await Promise.all([
        queue.enqueue('A', task('A')),
        queue.enqueue('B', task('B')),
        queue.enqueue('C', task('C')),
      ]);

      expect(maxConcurrent).toBe(3);
    });
  });

  describe('并发限制', () => {
    it('应该遵守最大并发限制', async () => {
      const maxConcurrency = 2;
      const queue = new ConcurrentQueue(maxConcurrency);
      let currentConcurrent = 0;
      let maxObserved = 0;

      const task = (id: number) => async () => {
        currentConcurrent++;
        maxObserved = Math.max(maxObserved, currentConcurrent);
        await new Promise((r) => setTimeout(r, 50));
        currentConcurrent--;
        return id;
      };

      // 5 个不同 key 的任务
      await Promise.all([
        queue.enqueue('A', task(1)),
        queue.enqueue('B', task(2)),
        queue.enqueue('C', task(3)),
        queue.enqueue('D', task(4)),
        queue.enqueue('E', task(5)),
      ]);

      expect(maxObserved).toBeLessThanOrEqual(maxConcurrency);
      expect(maxObserved).toBe(maxConcurrency); // 应该达到上限
    });

    it('并发限制为 1 时应该完全串行', async () => {
      const queue = new ConcurrentQueue(1);
      const order: number[] = [];

      const task = (id: number) => async () => {
        order.push(id);
        await new Promise((r) => setTimeout(r, 10));
        order.push(-id);
        return id;
      };

      await Promise.all([
        queue.enqueue('A', task(1)),
        queue.enqueue('B', task(2)),
        queue.enqueue('C', task(3)),
      ]);

      // 完全串行
      expect(order).toEqual([1, -1, 2, -2, 3, -3]);
    });
  });

  describe('null key 处理', () => {
    it('null key 应该使用默认 key，串行执行', async () => {
      const queue = new ConcurrentQueue(10);
      const order: number[] = [];

      const task = (id: number) => async () => {
        order.push(id);
        await new Promise((r) => setTimeout(r, 30));
        order.push(-id);
        return id;
      };

      await Promise.all([
        queue.enqueue(null, task(1)),
        queue.enqueue(null, task(2)),
        queue.enqueue(null, task(3)),
      ]);

      // null key 串行
      expect(order).toEqual([1, -1, 2, -2, 3, -3]);
    });

    it('null key 和其他 key 应该并发', async () => {
      const queue = new ConcurrentQueue(10);
      const running: string[] = [];
      let maxConcurrent = 0;

      const task = (name: string) => async () => {
        running.push(name);
        maxConcurrent = Math.max(maxConcurrent, running.length);
        await new Promise((r) => setTimeout(r, 50));
        running.splice(running.indexOf(name), 1);
      };

      await Promise.all([
        queue.enqueue(null, task('null')),
        queue.enqueue('A', task('A')),
        queue.enqueue('B', task('B')),
      ]);

      expect(maxConcurrent).toBe(3);
    });
  });

  describe('drain', () => {
    it('应该等待所有任务完成', async () => {
      const queue = new ConcurrentQueue(2);
      const completed: number[] = [];

      // 不 await，直接入队
      void queue.enqueue('A', async () => {
        await new Promise((r) => setTimeout(r, 50));
        completed.push(1);
      });
      void queue.enqueue('B', async () => {
        await new Promise((r) => setTimeout(r, 50));
        completed.push(2);
      });
      void queue.enqueue('C', async () => {
        await new Promise((r) => setTimeout(r, 50));
        completed.push(3);
      });

      expect(completed).toEqual([]);

      await queue.drain();

      expect(completed.sort()).toEqual([1, 2, 3]);
    });

    it('空队列 drain 应该立即返回', async () => {
      const queue = new ConcurrentQueue(2);
      await queue.drain(); // 不应该卡住
    });
  });

  describe('状态查询', () => {
    it('应该正确报告 active 和 waiting 数量', async () => {
      const queue = new ConcurrentQueue(2);

      let resolve1: () => void;
      let resolve2: () => void;
      let resolve3: () => void;
      let resolve4: () => void;
      const p1 = new Promise<void>((r) => (resolve1 = r));
      const p2 = new Promise<void>((r) => (resolve2 = r));
      const p3 = new Promise<void>((r) => (resolve3 = r));
      const p4 = new Promise<void>((r) => (resolve4 = r));

      void queue.enqueue('A', () => p1);
      void queue.enqueue('B', () => p2);
      void queue.enqueue('C', () => p3);
      void queue.enqueue('D', () => p4);

      // 等待任务开始执行
      await new Promise((r) => setTimeout(r, 10));

      expect(queue.active).toBe(2);
      expect(queue.waiting).toBe(2);

      resolve1!();
      // 等待 C 获取槽位
      await new Promise((r) => setTimeout(r, 10));

      expect(queue.active).toBe(2); // C 顶替了 A
      expect(queue.waiting).toBe(1);

      resolve2!();
      resolve3!();
      resolve4!();
      await queue.drain();

      expect(queue.active).toBe(0);
      expect(queue.waiting).toBe(0);
    });
  });

  describe('边界情况', () => {
    it('任务中再次 enqueue 同一 key 不应死锁', async () => {
      const queue = new ConcurrentQueue(2);
      const results: number[] = [];

      await queue.enqueue('A', async () => {
        results.push(1);
        // 在任务中再次 enqueue 同一 key
        void queue.enqueue('A', async () => {
          results.push(2);
        });
      });

      await queue.drain();
      expect(results).toEqual([1, 2]);
    });

    it('大量任务不应导致栈溢出', async () => {
      const queue = new ConcurrentQueue(10);
      const count = 1000;
      let completed = 0;

      const promises = [];
      for (let i = 0; i < count; i++) {
        promises.push(
          queue.enqueue(`key-${i % 10}`, async () => {
            completed++;
          })
        );
      }

      await Promise.all(promises);
      expect(completed).toBe(count);
    });

    it('同步抛出错误应该被正确处理', async () => {
      const queue = new ConcurrentQueue(2);

      // 注意：这里任务函数本身是 sync 的，但返回的是 rejected promise
      await expect(
        queue.enqueue('A', () => {
          throw new Error('sync error');
        })
      ).rejects.toThrow('sync error');
    });
  });

  describe('混合场景', () => {
    it('复杂混合场景：多 key + 并发限制 + 错误处理', async () => {
      const queue = new ConcurrentQueue(2);
      const log: string[] = [];

      const task =
        (name: string, delay: number, shouldFail = false) =>
        async () => {
          log.push(`${name}:start`);
          await new Promise((r) => setTimeout(r, delay));
          if (shouldFail) {
            log.push(`${name}:error`);
            throw new Error(`${name} failed`);
          }
          log.push(`${name}:end`);
          return name;
        };

      const results = await Promise.allSettled([
        queue.enqueue('A', task('A1', 30)),
        queue.enqueue('A', task('A2', 30, true)), // A2 会失败
        queue.enqueue('A', task('A3', 30)),
        queue.enqueue('B', task('B1', 30)),
        queue.enqueue('B', task('B2', 30)),
      ]);

      // A 系列应该串行
      const aLogs = log.filter((l) => l.startsWith('A'));
      expect(aLogs).toEqual(['A1:start', 'A1:end', 'A2:start', 'A2:error', 'A3:start', 'A3:end']);

      // B 系列应该串行
      const bLogs = log.filter((l) => l.startsWith('B'));
      expect(bLogs).toEqual(['B1:start', 'B1:end', 'B2:start', 'B2:end']);

      // 验证结果
      expect(results[0]).toEqual({ status: 'fulfilled', value: 'A1' });
      expect(results[1]).toMatchObject({ status: 'rejected' });
      expect(results[2]).toEqual({ status: 'fulfilled', value: 'A3' });
      expect(results[3]).toEqual({ status: 'fulfilled', value: 'B1' });
      expect(results[4]).toEqual({ status: 'fulfilled', value: 'B2' });
    });
  });
});
