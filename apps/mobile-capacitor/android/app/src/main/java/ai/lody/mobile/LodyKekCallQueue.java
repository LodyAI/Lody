package ai.lody.android;

import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/** Owns each actual call until return; a cancelled observer cannot release its route. */
final class LodyKekCallQueue {
    static final LodyKekCallQueue SHARED = new LodyKekCallQueue(Executors.newCachedThreadPool(work -> {
        Thread thread = new Thread(work, "LodyKekCall");
        thread.setDaemon(true);
        return thread;
    }));
    private static final class Job {
        final Runnable work, rejected;
        Job(Runnable work, Runnable rejected) { this.work = work; this.rejected = rejected; }
    }
    private final Executor executor;
    private final Map<String, ArrayDeque<Job>> routes = new HashMap<>();
    LodyKekCallQueue(Executor executor) { this.executor = executor; }

    void enqueue(String route, Runnable work) { enqueue(route, work, () -> {}); }
    void enqueue(String route, Runnable work, Runnable rejected) {
        boolean start;
        synchronized (routes) {
            start = !routes.containsKey(route);
            routes.computeIfAbsent(route, ignored -> new ArrayDeque<>()).addLast(new Job(work, rejected));
        }
        if (start) dispatch(route);
    }
    private void dispatch(String route) {
        java.util.concurrent.atomic.AtomicBoolean entered = new java.util.concurrent.atomic.AtomicBoolean();
        try { executor.execute(() -> {
            entered.set(true);
            Job job;
            synchronized (routes) { job = routes.get(route).getFirst(); }
            try { job.work.run(); }
            finally {
                boolean more;
                synchronized (routes) {
                    ArrayDeque<Job> queue = routes.get(route);
                    queue.removeFirst();
                    more = !queue.isEmpty();
                    if (!more) routes.remove(route);
                }
                if (more) dispatch(route);
            }
        }); } catch (RejectedExecutionException rejected) {
            if (entered.get()) throw rejected; // A direct executor's entered task is not a refusal.
            // The executor proves no entry occurred. Fence/remove the abandoned route
            // before notifying callers; never retain or later execute rejected captures.
            ArrayDeque<Job> abandoned;
            synchronized (routes) { abandoned = routes.remove(route); }
            if (abandoned != null) for (Job job : abandoned) job.rejected.run();
        }
    }
}
